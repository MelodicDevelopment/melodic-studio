//! Issues, work items and pull requests, through the command-line tools the user has
//! already signed in to: `gh` (GitHub), `az` with the azure-devops extension (Azure
//! DevOps) and `glab` (GitLab). The app keeps no tokens and calls no host API itself;
//! when the tool is missing or signed out it says what to run and the UI falls back
//! to the web page.
//!
//! Rules for every call here:
//! - arguments are separate argv entries, never a shell line, and anything that came
//!   from a person or a remote is passed as `--flag=value` so it cannot be read as an option;
//! - long text goes in on stdin (`gh --body-file=-`) or through a file (`az --flag=@file`);
//! - there is a timeout, so a tool waiting for a browser sign-in cannot wedge the window.

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::git::{self, Git, Host};
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tauri::State;

pub(crate) const STATUS_TIMEOUT: Duration = Duration::from_secs(20);
pub(crate) const LIST_TIMEOUT: Duration = Duration::from_secs(45);
pub(crate) const CREATE_TIMEOUT: Duration = Duration::from_secs(60);
/// How many issues the list shows; the search box narrows it down.
const MAX_ISSUES: usize = 100;
pub(crate) const MAX_BODY_CHARS: usize = 20_000;
/// A tool that prints more than this is not answering the question we asked.
const MAX_OUTPUT_BYTES: u64 = 32 * 1024 * 1024;
/// Azure DevOps refuses longer pull request descriptions and titles.
pub(crate) const AZURE_MAX_DESCRIPTION: usize = 4000;
const AZURE_MAX_TITLE: usize = 400;
/// Longer links are refused by the hosts (and by some browsers).
const MAX_URL_BYTES: usize = 7000;

// ---- where the repository lives ---------------------------------------------

/// The repository in the terms each tool wants. Derived from `Host::web`, which
/// `git::host()` has already normalised from whatever form the remote URL had.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Target {
    /// `repo` is `owner/name`.
    GitHub { domain: String, repo: String },
    Azure { org_url: String, project: String, repo: String },
    /// `path` is `group/sub/name`.
    GitLab { domain: String, path: String },
    /// Bitbucket and hosts we do not recognise: web pages only.
    None,
}

/// A name that is safe to hand to a tool: `-x` would be an option, and az reads `@x` as a file.
pub(crate) fn usable(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && !s.starts_with('@') && !s.chars().any(char::is_control)
}

pub(crate) fn target(host: &Host) -> Target {
    let rest = host.web.strip_prefix("https://").unwrap_or(&host.web);
    let (domain, path) = rest.split_once('/').unwrap_or((rest, ""));
    let parts: Vec<&str> = path.split('/').collect();
    match (host.provider.as_str(), parts.as_slice()) {
        ("github", [owner, name]) if usable(owner) && usable(name) => Target::GitHub { domain: domain.into(), repo: format!("{owner}/{name}") },
        ("azure", [org, project, "_git", name]) => {
            // Project and repository names may hold spaces, which the URL carries as %20.
            let (project, name) = (decode(project), decode(name));
            if usable(org) && usable(&project) && usable(&name) {
                Target::Azure { org_url: format!("https://{domain}/{org}"), project, repo: name }
            } else {
                Target::None
            }
        }
        ("gitlab", [first, .., last]) if usable(first) && usable(last) => Target::GitLab { domain: domain.into(), path: path.into() },
        _ => Target::None,
    }
}

impl Target {
    /// The program that serves this host.
    pub(crate) fn program(&self) -> Option<&'static str> {
        match self {
            Target::GitHub { .. } => Some("gh"),
            Target::Azure { .. } => Some("az"),
            Target::GitLab { .. } => Some("glab"),
            Target::None => None,
        }
    }

    /// The `--repo=` value for gh and glab.
    pub(crate) fn repo_arg(&self) -> String {
        match self {
            Target::GitHub { domain, repo } if domain == "github.com" => format!("--repo={repo}"),
            Target::GitHub { domain, repo } => format!("--repo={domain}/{repo}"),
            Target::GitLab { domain, path } if domain == "gitlab.com" => format!("--repo={path}"),
            Target::GitLab { domain, path } => format!("--repo=https://{domain}/{path}"),
            _ => String::new(),
        }
    }
}

pub(crate) fn remote(g: &Git) -> Result<(Host, Target)> {
    let host = g.default_remote().and_then(|r| g.remote_url(&r)).and_then(|u| git::host(&u)).ok_or_else(|| AppError::msg("This repository has no remote on a host Melodic Studio knows"))?;
    let target = target(&host);
    Ok((host, target))
}

pub(crate) fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let hex = if b[i] == b'%' { s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) } else { None };
        match hex {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(b[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_string()
}

pub(crate) fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// At most `max` characters, never cut inside one.
pub(crate) fn clip(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => s[..at].to_string(),
        None => s.to_string(),
    }
}

/// Branch names go on command lines: nothing that could be an option, a range or a file reference.
pub(crate) fn check_branch(name: &str) -> Result<()> {
    if !usable(name) || name.contains(char::is_whitespace) || name.contains("..") {
        return Err(AppError::msg(format!("\"{name}\" is not a valid branch name")));
    }
    Ok(())
}

// ---- running a tool -----------------------------------------------------------

#[derive(Debug)]
pub(crate) struct Output {
    pub ok: bool,
    pub stdout: String,
    pub stderr: String,
}

pub(crate) fn tool(program: &str, dir: &Path) -> Command {
    let mut c = crate::proc::command(program);
    c.current_dir(dir)
        .env("NO_COLOR", "1")
        // Nothing here can answer a question; the tools must fail instead of asking.
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("NO_PROMPT", "1")
        .env("GLAB_CHECK_UPDATE", "false")
        .env("AZURE_CORE_ONLY_SHOW_ERRORS", "1")
        .env("AZURE_CORE_NO_COLOR", "1")
        .env("AZURE_CORE_DISABLE_CONFIRM_PROMPT", "1")
        // Without the azure-devops extension az would offer to install it. Never on our account.
        .env("AZURE_EXTENSION_USE_DYNAMIC_INSTALL", "no");
    c
}

fn drain(pipe: Option<impl Read + Send + 'static>) -> mpsc::Receiver<Vec<u8>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        if let Some(pipe) = pipe {
            let _ = pipe.take(MAX_OUTPUT_BYTES).read_to_end(&mut buf);
        }
        let _ = tx.send(buf);
    });
    rx
}

/// Run to completion or until `timeout`, whichever is first. `what` names the tool in errors.
pub(crate) fn run(mut c: Command, stdin: Option<Vec<u8>>, timeout: Duration, what: &str) -> Result<Output> {
    c.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| AppError::msg(format!("Could not start {what}: {e}")))?;
    if let (Some(input), Some(mut pipe)) = (stdin, child.stdin.take()) {
        // On its own thread: a tool that never reads must not block us past the timeout.
        std::thread::spawn(move || {
            let _ = pipe.write_all(&input);
        });
    }
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(AppError::msg(format!("{what} did not answer within {} seconds", timeout.as_secs())));
            }
            None => std::thread::sleep(Duration::from_millis(25)),
        }
    };
    // The process is gone; a grandchild holding the pipe open (az is a shim on Windows) gets a moment, no more.
    let grace = Duration::from_secs(2);
    let stdout = out.recv_timeout(grace).unwrap_or_default();
    let stderr = err.recv_timeout(grace).unwrap_or_default();
    Ok(Output { ok: status.success(), stdout: String::from_utf8_lossy(&stdout).to_string(), stderr: String::from_utf8_lossy(&stderr).to_string() })
}

/// The tool's own words for what went wrong, short enough for a toast.
pub(crate) fn failure(what: &str, out: &Output) -> AppError {
    let text = if out.stderr.trim().is_empty() { out.stdout.trim() } else { out.stderr.trim() };
    if what == "az" && az_wants_login(text) {
        return AppError::msg("Azure DevOps is not signed in. Run `az login` in a terminal (or `az devops login` to use a personal access token).");
    }
    let lines: Vec<&str> = text.lines().map(|l| l.trim().trim_start_matches("ERROR: ")).filter(|l| !l.is_empty()).take(3).collect();
    if lines.is_empty() {
        AppError::msg(format!("{what} failed without saying why"))
    } else {
        AppError::msg(format!("{what}: {}", clip(&lines.join(" "), 500)))
    }
}

pub(crate) fn run_ok(dir: &Path, program: &str, args: &[String], stdin: Option<Vec<u8>>, timeout: Duration) -> Result<String> {
    let mut c = tool(program, dir);
    c.args(args);
    let out = run(c, stdin, timeout, program)?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(failure(program, &out))
    }
}

/// Text az reads from a file (`--flag=@path`) instead of the command line: no length
/// limit, no quoting through `az.cmd` on Windows, and a value starting with `-` or `@` stays a value.
pub(crate) struct TempText(PathBuf);

impl TempText {
    pub(crate) fn new(label: &str, text: &str) -> Result<Self> {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        let name = format!("melodic-studio-{label}-{}-{nanos}-{}.txt", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed));
        let path = std::env::temp_dir().join(name);
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        file.write_all(text.as_bytes())?;
        Ok(TempText(path))
    }

    pub(crate) fn arg(&self, flag: &str) -> String {
        format!("{flag}=@{}", self.0.to_string_lossy())
    }
}

impl Drop for TempText {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

// ---- is the tool there and signed in ------------------------------------------

/// Which tool serves this repository's host and whether it can be used right now.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CliStatus {
    /// github | azure | gitlab | bitbucket | other
    pub provider: String,
    pub host_name: String,
    /// "Issues" or "Work items".
    pub issues_label: String,
    /// "Pull requests" or "Merge requests".
    pub pulls_label: String,
    /// gh | az | glab; none when no tool covers this host.
    pub tool: Option<String>,
    pub installed: bool,
    /// Installed, complete (az has its azure-devops extension) and signed in.
    pub signed_in: bool,
    /// What to install or run when it cannot be used.
    pub hint: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Problem {
    Missing,
    /// az without the azure-devops extension.
    Extension,
    SignedOut,
    Other(String),
}

fn hint(target: &Target, problem: &Problem) -> String {
    let at = |domain: &str, usual: &str| if domain == usual { String::new() } else { format!(" --hostname {domain}") };
    match (target, problem) {
        (Target::GitHub { .. }, Problem::Missing) => "Install the GitHub CLI from https://cli.github.com, then run `gh auth login` in a terminal.".into(),
        (Target::GitHub { domain, .. }, Problem::SignedOut) => format!("Run `gh auth login{}` in a terminal to sign in to {domain}.", at(domain, "github.com")),
        (Target::Azure { .. }, Problem::Missing) => "Install the Azure CLI from https://aka.ms/installazurecli, then run `az extension add --name azure-devops` and `az login` in a terminal.".into(),
        (Target::Azure { .. }, Problem::Extension) => "Run `az extension add --name azure-devops` in a terminal, then `az login` if you have not signed in.".into(),
        (Target::Azure { .. }, Problem::SignedOut) => "Run `az login` in a terminal (or `az devops login` to use a personal access token).".into(),
        (Target::GitLab { .. }, Problem::Missing) => "Install the GitLab CLI from https://gitlab.com/gitlab-org/cli, then run `glab auth login` in a terminal.".into(),
        (Target::GitLab { domain, .. }, Problem::SignedOut) => format!("Run `glab auth login{}` in a terminal to sign in to {domain}.", at(domain, "gitlab.com")),
        (_, Problem::Other(why)) => format!("{} is installed but could not be used: {why}", target.program().unwrap_or("The tool")),
        _ => "Melodic Studio has no command-line tool for this host, so its pages open in your browser instead.".into(),
    }
}

/// az says this in several ways depending on how the sign-in went stale.
fn az_wants_login(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    s.contains("az login") || s.contains("az devops login") || s.contains("aadsts") || s.contains("azure-devops-cli-auth")
}

fn az_has_devops(version_json: &str) -> bool {
    serde_json::from_str::<Value>(version_json).ok().is_some_and(|v| v["extensions"].get("azure-devops").is_some())
}

fn sign_in_problem(g: &Git, target: &Target) -> Option<Problem> {
    let check = |program: &str, args: Vec<String>| -> std::result::Result<Output, Problem> {
        let mut c = tool(program, &g.dir);
        c.args(args);
        run(c, None, STATUS_TIMEOUT, program).map_err(|e| Problem::Other(e.to_string()))
    };
    let outcome = match target {
        Target::GitHub { domain, .. } => check("gh", vec!["auth".into(), "status".into(), format!("--hostname={domain}")]).map(|o| o.ok.then_some(()).ok_or(Problem::SignedOut)),
        Target::GitLab { domain, .. } => check("glab", vec!["auth".into(), "status".into(), format!("--hostname={domain}")]).map(|o| o.ok.then_some(()).ok_or(Problem::SignedOut)),
        Target::Azure { org_url, project, .. } => check("az", vec!["version".into(), "--output=json".into()]).and_then(|v| {
            if !az_has_devops(&v.stdout) {
                return Ok(Err(Problem::Extension));
            }
            // `az account show` can succeed on a stale sign-in, so ask Azure DevOps something small instead.
            let o = check("az", vec!["devops".into(), "project".into(), "show".into(), format!("--org={org_url}"), format!("--project={project}"), "--detect=false".into(), "--query=id".into(), "--output=tsv".into()])?;
            Ok(if o.ok {
                Ok(())
            } else if az_wants_login(&o.stderr) {
                Err(Problem::SignedOut)
            } else {
                Err(Problem::Other(failure("az", &o).to_string()))
            })
        }),
        Target::None => return None,
    };
    match outcome {
        Ok(Ok(())) => None,
        Ok(Err(problem)) | Err(problem) => Some(problem),
    }
}

fn status(g: &Git) -> Result<CliStatus> {
    let (host, target) = remote(g)?;
    let mut st = CliStatus { provider: host.provider.clone(), host_name: host.name.clone(), issues_label: host.issues_label.clone(), pulls_label: host.pulls_label.clone(), tool: None, installed: false, signed_in: false, hint: None };
    let Some(program) = target.program() else {
        st.hint = Some(format!("Melodic Studio has no command-line tool for {}, so its pages open in your browser instead.", host.name));
        return Ok(st);
    };
    st.tool = Some(program.into());
    if crate::proc::find(program).is_none() {
        st.hint = Some(hint(&target, &Problem::Missing));
        return Ok(st);
    }
    st.installed = true;
    match sign_in_problem(g, &target) {
        None => st.signed_in = true,
        Some(problem) => st.hint = Some(hint(&target, &problem)),
    }
    Ok(st)
}

/// The tool for this host, or the sentence that says what to install.
pub(crate) fn require(target: &Target) -> Result<&'static str> {
    let program = target.program().ok_or_else(|| AppError::msg(hint(target, &Problem::Missing)))?;
    if crate::proc::find(program).is_none() {
        return Err(AppError::msg(hint(target, &Problem::Missing)));
    }
    Ok(program)
}

// ---- issues and work items ----------------------------------------------------

/// One issue (GitHub, GitLab) or work item (Azure DevOps), in a shape the three share.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// The number people quote: `#123`.
    pub id: String,
    pub title: String,
    /// Plain text or markdown, as the host stores it. Untrusted: the UI shows it as text only.
    pub body: String,
    pub url: String,
    pub labels: Vec<String>,
    pub assignee: Option<String>,
    /// `open`, or the work item's own state (New, Active…).
    pub state: String,
    /// ISO 8601.
    pub updated: String,
    /// `issue`, or the work item type (Bug, Task, User Story).
    pub kind: String,
}

pub(crate) fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

pub(crate) fn unexpected(what: &str) -> AppError {
    AppError::msg(format!("{what} answered with something Melodic Studio could not read"))
}

fn gh_issue_args(target: &Target, query: &str) -> Vec<String> {
    let mut args = vec!["issue".into(), "list".into(), target.repo_arg(), "--state=open".into(), "--limit=50".into(), "--json=number,title,body,url,labels,assignees,state,updatedAt".to_string()];
    if !query.is_empty() {
        args.push(format!("--search={query}"));
    }
    args
}

fn parse_gh_issues(json: &str) -> Result<Vec<Issue>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("gh"))?;
    Ok(items
        .iter()
        .filter_map(|i| {
            Some(Issue {
                id: i["number"].as_u64()?.to_string(),
                title: text(i, "title"),
                body: clip(&text(i, "body"), MAX_BODY_CHARS),
                url: text(i, "url"),
                labels: i["labels"].as_array().map(|l| l.iter().filter_map(|x| x["name"].as_str().map(String::from)).collect()).unwrap_or_default(),
                assignee: i["assignees"].as_array().and_then(|a| a.first()).and_then(|a| a["login"].as_str()).map(String::from),
                state: text(i, "state").to_lowercase(),
                updated: text(i, "updatedAt"),
                kind: "issue".into(),
            })
        })
        .take(MAX_ISSUES)
        .collect())
}

fn glab_issue_args(target: &Target, query: &str) -> Vec<String> {
    let mut args = vec!["issue".into(), "list".into(), target.repo_arg(), "--output=json".into(), "--per-page=50".to_string()];
    if !query.is_empty() {
        args.push(format!("--search={query}"));
    }
    args
}

/// glab prints the GitLab API's issue objects as they are.
fn parse_glab_issues(json: &str) -> Result<Vec<Issue>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("glab"))?;
    Ok(items
        .iter()
        .filter_map(|i| {
            let state = text(i, "state");
            Some(Issue {
                id: i["iid"].as_u64()?.to_string(),
                title: text(i, "title"),
                body: clip(&text(i, "description"), MAX_BODY_CHARS),
                url: text(i, "web_url"),
                labels: i["labels"].as_array().map(|l| l.iter().filter_map(|x| x.as_str().or_else(|| x["name"].as_str()).map(String::from)).collect()).unwrap_or_default(),
                assignee: i["assignees"].as_array().and_then(|a| a.first()).or_else(|| i.get("assignee")).and_then(|a| a["username"].as_str()).map(String::from),
                state: if state == "opened" { "open".into() } else { state },
                updated: text(i, "updated_at"),
                kind: i["issue_type"].as_str().unwrap_or("issue").to_string(),
            })
        })
        .take(MAX_ISSUES)
        .collect())
}

/// Work items worth showing: open ones that are mine or moved lately; with a search,
/// open ones whose title has the words (or whose id is the number typed).
/// `az boards query` runs without a project context, so `@project` is not available.
fn wiql(project: &str, query: &str, repro_steps: bool) -> String {
    let quote = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>().replace('\'', "''");
    let mut fields = vec!["[System.Id]", "[System.Title]", "[System.Description]", "[System.State]", "[System.WorkItemType]", "[System.AssignedTo]", "[System.Tags]", "[System.ChangedDate]"];
    if repro_steps {
        fields.push("[Microsoft.VSTS.TCM.ReproSteps]");
    }
    let query = query.trim();
    let narrow = if query.is_empty() {
        "([System.AssignedTo] = @Me OR [System.ChangedDate] >= @Today - 14)".to_string()
    } else {
        match query.trim_start_matches('#').parse::<u64>() {
            Ok(id) => format!("([System.Id] = {id} OR [System.Title] CONTAINS '{}')", quote(query)),
            Err(_) => format!("[System.Title] CONTAINS '{}'", quote(query)),
        }
    };
    format!(
        "SELECT {} FROM WorkItems WHERE [System.TeamProject] = '{}' AND [System.State] NOT IN ('Closed', 'Done', 'Removed', 'Completed') AND {narrow} ORDER BY [System.ChangedDate] DESC",
        fields.join(", "),
        quote(project)
    )
}

fn az_query_args(org_url: &str, wiql_file: &TempText) -> Vec<String> {
    vec!["boards".into(), "query".into(), format!("--org={org_url}"), wiql_file.arg("--wiql"), "--detect=false".into(), "--output=json".into()]
}

/// Work item descriptions are HTML. The UI shows plain text only, so reduce it to that:
/// block ends become line breaks, list items get a dash, everything else is dropped.
pub(crate) fn html_to_text(html: &str) -> String {
    if !html.contains('<') && !html.contains('&') {
        return html.trim().to_string();
    }
    let mut out = String::with_capacity(html.len());
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        let Some(close) = rest[open..].find('>') else {
            // A stray "<" in what is really plain text.
            out.push_str(&rest[open..]);
            rest = "";
            break;
        };
        let tag = rest[open + 1..open + close].trim().to_ascii_lowercase();
        let name = tag.trim_start_matches('/').split(|c: char| !c.is_ascii_alphanumeric()).next().unwrap_or("");
        // Blocks start and end on a line of their own; only <br> adds an empty one.
        let block = matches!(name, "p" | "div" | "tr" | "ul" | "ol" | "li" | "pre" | "blockquote" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
        if name == "br" || (block && !out.is_empty() && !out.ends_with('\n')) {
            out.push('\n');
        }
        if name == "li" && !tag.starts_with('/') {
            out.push_str("- ");
        }
        rest = &rest[open + close + 1..];
    }
    out.push_str(rest);
    let out = out.replace("&nbsp;", " ").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'").replace("&apos;", "'").replace("&amp;", "&");
    // Tidy the blank lines the dropped tags left behind.
    let mut lines: Vec<&str> = Vec::new();
    for line in out.lines().map(str::trim_end) {
        if !(line.trim().is_empty() && lines.last().is_none_or(|l| l.trim().is_empty())) {
            lines.push(line);
        }
    }
    lines.join("\n").trim().to_string()
}

fn parse_az_items(json: &str, org_url: &str, project: &str) -> Result<Vec<Issue>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("az"))?;
    Ok(items
        .iter()
        .filter_map(|i| {
            let f = &i["fields"];
            let id = i["id"].as_u64().or_else(|| f["System.Id"].as_u64())?;
            let description = text(f, "System.Description");
            let body = if description.trim().is_empty() { text(f, "Microsoft.VSTS.TCM.ReproSteps") } else { description };
            // An identity object, or "Name <mail>" from older servers.
            let who = &f["System.AssignedTo"];
            let assignee = who["displayName"].as_str().or_else(|| who.as_str()).map(|s| s.split(" <").next().unwrap_or(s).to_string()).filter(|s| !s.is_empty());
            Some(Issue {
                id: id.to_string(),
                title: text(f, "System.Title"),
                body: clip(&html_to_text(&body), MAX_BODY_CHARS),
                url: format!("{org_url}/{}/_workitems/edit/{id}", encode(project)),
                labels: text(f, "System.Tags").split(';').map(str::trim).filter(|t| !t.is_empty()).map(String::from).collect(),
                assignee,
                state: text(f, "System.State"),
                updated: text(f, "System.ChangedDate"),
                kind: f["System.WorkItemType"].as_str().unwrap_or("Work item").to_string(),
            })
        })
        .take(MAX_ISSUES)
        .collect())
}

fn list_issues(g: &Git, query: &str) -> Result<Vec<Issue>> {
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    let query = clip(query.trim(), 200);
    match &target {
        Target::GitHub { .. } => parse_gh_issues(&run_ok(&g.dir, program, &gh_issue_args(&target, &query), None, LIST_TIMEOUT)?),
        Target::GitLab { .. } => parse_glab_issues(&run_ok(&g.dir, program, &glab_issue_args(&target, &query), None, LIST_TIMEOUT)?),
        Target::Azure { org_url, project, .. } => {
            let ask = |repro_steps: bool| -> Result<String> {
                let file = TempText::new("wiql", &wiql(project, &query, repro_steps))?;
                run_ok(&g.dir, program, &az_query_args(org_url, &file), None, LIST_TIMEOUT)
            };
            // Bugs keep their text in ReproSteps, a field some process templates do not have.
            let json = match ask(true) {
                Err(e) if e.to_string().contains("ReproSteps") || e.to_string().contains("TF51005") => ask(false)?,
                other => other?,
            };
            parse_az_items(&json, org_url, project)
        }
        Target::None => Ok(vec![]),
    }
}

// ---- pull requests ------------------------------------------------------------

/// What the pull request dialog needs to know before anything is drafted. Git only, no network.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrContext {
    /// The branch the pull request would come from; empty on a detached HEAD.
    pub branch: String,
    /// The remote's default branch, as well as it can be told.
    pub base: String,
    /// Every other branch on the remote, to pick a different base from.
    pub bases: Vec<String>,
    /// The branch is on the remote under its own name.
    pub on_remote: bool,
    /// Commits the remote does not have yet.
    pub unpushed: u32,
}

/// The commits and files a pull request from here into `base` would carry, cut to prompt size.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrChanges {
    pub count: u32,
    /// Newest first, at most 40.
    pub subjects: Vec<String>,
    /// Hash, subject and the start of each body.
    pub log: String,
    /// `git diff --stat` against the merge base.
    pub stat: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub id: String,
    pub title: String,
    pub url: String,
}

/// A page that starts the pull request in the browser, and how much of the draft it carries.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PrWebUrl {
    pub url: String,
    pub title: bool,
    pub body: bool,
}

pub(crate) fn current_branch(g: &Git) -> Option<String> {
    g.run(&["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn has_commit(g: &Git, name: &str) -> bool {
    g.run(&["rev-parse", "--verify", "-q", &format!("{name}^{{commit}}")]).is_ok()
}

fn count(g: &Git, args: &[&str]) -> u32 {
    let mut full = vec!["rev-list", "--count"];
    full.extend_from_slice(args);
    g.run(&full).ok().and_then(|s| s.trim().parse().ok()).unwrap_or(0)
}

/// `refs/heads/main` -> `main`.
fn short_branch(name: &str) -> String {
    name.trim().trim_start_matches("refs/heads/").to_string()
}

/// Ask the host which branch is the default one; only when the clone does not say.
fn asked_default_branch(g: &Git, target: &Target) -> Option<String> {
    let program = target.program().filter(|p| crate::proc::find(p).is_some())?;
    let args: Vec<String> = match target {
        Target::GitHub { domain, repo } => vec!["repo".into(), "view".into(), if domain == "github.com" { repo.clone() } else { format!("{domain}/{repo}") }, "--json=defaultBranchRef".into(), "--jq=.defaultBranchRef.name".into()],
        Target::Azure { org_url, project, repo } => vec!["repos".into(), "show".into(), format!("--org={org_url}"), format!("--project={project}"), format!("--repository={repo}"), "--detect=false".into(), "--query=defaultBranch".into(), "--output=tsv".into()],
        Target::GitLab { .. } => vec!["repo".into(), "view".into(), target.repo_arg().trim_start_matches("--repo=").to_string(), "--output=json".into()],
        Target::None => return None,
    };
    let out = run_ok(&g.dir, program, &args, None, STATUS_TIMEOUT).ok()?;
    let name = match target {
        Target::GitLab { .. } => serde_json::from_str::<Value>(&out).ok()?["default_branch"].as_str()?.to_string(),
        _ => short_branch(&out),
    };
    Some(name).filter(|n| check_branch(n).is_ok())
}

fn pr_context_of(g: &Git) -> Result<PrContext> {
    let remote_name = g.default_remote().ok_or_else(|| AppError::msg("This repository has no remote yet"))?;
    let branch = current_branch(g).unwrap_or_default();
    let prefix = format!("refs/remotes/{remote_name}/");
    let all: Vec<String> = g
        .run(&["for-each-ref", "--sort=-committerdate", "--format=%(refname)", &format!("refs/remotes/{remote_name}")])?
        .lines()
        .filter_map(|l| l.trim().strip_prefix(&prefix))
        .filter(|b| *b != "HEAD")
        .map(String::from)
        .collect();
    let head = g.run(&["symbolic-ref", "-q", &format!("{prefix}HEAD")]).ok().and_then(|s| s.trim().strip_prefix(&prefix).map(String::from));
    let base = head
        .or_else(|| remote(g).ok().and_then(|(_, target)| asked_default_branch(g, &target)))
        .or_else(|| ["main", "master", "develop", "trunk"].iter().find(|n| all.iter().any(|b| b == *n)).map(|n| n.to_string()))
        .or_else(|| all.iter().find(|b| **b != branch).cloned())
        .unwrap_or_else(|| "main".into());
    let tracking = format!("{prefix}{branch}");
    let on_remote = !branch.is_empty() && has_commit(g, &tracking);
    let unpushed = if on_remote { count(g, &[&format!("{tracking}..HEAD")]) } else { count(g, &["HEAD", "--not", &format!("--remotes={remote_name}")]) };
    Ok(PrContext { bases: all.into_iter().filter(|b| *b != branch).collect(), branch, base, on_remote, unpushed })
}

/// The ref to compare against: the remote's copy of `base` when there is one.
pub(crate) fn base_ref(g: &Git, base: &str) -> Result<String> {
    check_branch(base)?;
    let remote_name = g.default_remote().unwrap_or_else(|| "origin".into());
    [format!("refs/remotes/{remote_name}/{base}"), format!("refs/heads/{base}")]
        .into_iter()
        .find(|r| has_commit(g, r))
        .ok_or_else(|| AppError::msg(format!("There is no branch \"{base}\" here to compare with. Fetch, then try again.")))
}

fn pr_changes_of(g: &Git, base: &str) -> Result<PrChanges> {
    let against = base_ref(g, base)?;
    let range = format!("{against}..HEAD");
    let out = g.run(&["log", "--max-count=40", "--format=%x1e%h%x1f%s%x1f%b", &range])?;
    let mut subjects = Vec::new();
    let mut log = String::new();
    for rec in out.split('\x1e').filter(|r| !r.trim().is_empty()) {
        let mut f = rec.split('\x1f');
        let (hash, subject, body) = (f.next().unwrap_or("").trim(), f.next().unwrap_or("").trim(), f.next().unwrap_or("").trim());
        subjects.push(subject.to_string());
        log.push_str(&format!("{hash} {subject}\n"));
        for line in clip(body, 400).lines().filter(|l| !l.trim().is_empty()) {
            log.push_str(&format!("    {}\n", line.trim_end()));
        }
    }
    // Unrelated histories have no merge base; a plain two-sided diff still says what differs.
    let stat = g.run(&["diff", "--stat", "--stat-width=100", "--no-color", &format!("{against}...HEAD")]).or_else(|_| g.run(&["diff", "--stat", "--stat-width=100", "--no-color", &against, "HEAD"]))?;
    Ok(PrChanges { count: count(g, &[&range]), subjects, log: clip(log.trim_end(), 6000), stat: clip_stat(stat.trim_end(), 3000) })
}

/// A long file list loses its middle, never the totals on the last line.
fn clip_stat(stat: &str, max: usize) -> String {
    if stat.chars().count() <= max {
        return stat.to_string();
    }
    let total = stat.lines().last().unwrap_or("");
    format!("{}\n …\n{total}", clip(stat, max).trim_end())
}

pub(crate) fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn gh_pr_create_args(target: &Target, head: &str, base: &str, title: &str, draft: bool) -> Vec<String> {
    // The body arrives on stdin.
    let mut args = vec!["pr".into(), "create".into(), target.repo_arg(), format!("--head={head}"), format!("--base={base}"), format!("--title={title}"), "--body-file=-".to_string()];
    if draft {
        args.push("--draft".into());
    }
    args
}

fn az_pr_create_args(target: &Target, head: &str, base: &str, title: &TempText, description: Option<&TempText>, draft: bool) -> Vec<String> {
    let Target::Azure { org_url, project, repo } = target else { return vec![] };
    let mut args = vec![
        "repos".into(),
        "pr".into(),
        "create".into(),
        format!("--org={org_url}"),
        format!("--project={project}"),
        format!("--repository={repo}"),
        // Full ref names: a bare name starting with `@` would be read as a file.
        format!("--source-branch=refs/heads/{head}"),
        format!("--target-branch=refs/heads/{base}"),
        title.arg("--title"),
        "--detect=false".into(),
        "--output=json".to_string(),
    ];
    if let Some(description) = description {
        args.push(description.arg("--description"));
    }
    if draft {
        args.push("--draft=true".into());
    }
    args
}

fn glab_mr_create_args(target: &Target, head: &str, base: &str, title: &str, body: &str, draft: bool) -> Vec<String> {
    let mut args = vec!["mr".into(), "create".into(), target.repo_arg(), format!("--source-branch={head}"), format!("--target-branch={base}"), format!("--title={title}"), format!("--description={body}"), "--yes".to_string()];
    if draft {
        args.push("--draft".into());
    }
    args
}

/// gh and glab end by printing the new page's address.
fn created_url(output: &str, must_contain: &str) -> Option<String> {
    output.split_whitespace().rev().find(|t| t.starts_with("https://") && t.contains(must_contain)).map(String::from)
}

fn parse_az_pr(json: &str, web: &str) -> Option<PullRequest> {
    let v: Value = serde_json::from_str(json).ok()?;
    let id = v["pullRequestId"].as_u64()?;
    Some(PullRequest { id: id.to_string(), title: text(&v, "title"), url: format!("{web}/pullrequest/{id}") })
}

fn existing_args(target: &Target, branch: &str) -> Vec<String> {
    match target {
        Target::GitHub { .. } => vec!["pr".into(), "list".into(), target.repo_arg(), format!("--head={branch}"), "--state=open".into(), "--limit=1".into(), "--json=number,title,url".into()],
        Target::Azure { org_url, project, repo } => vec![
            "repos".into(),
            "pr".into(),
            "list".into(),
            format!("--org={org_url}"),
            format!("--project={project}"),
            format!("--repository={repo}"),
            format!("--source-branch=refs/heads/{branch}"),
            "--status=active".into(),
            "--top=1".into(),
            "--detect=false".into(),
            "--output=json".into(),
        ],
        Target::GitLab { .. } => vec!["mr".into(), "list".into(), target.repo_arg(), format!("--source-branch={branch}"), "--output=json".into()],
        Target::None => vec![],
    }
}

fn parse_existing(target: &Target, web: &str, json: &str) -> Option<PullRequest> {
    let items: Vec<Value> = serde_json::from_str(json).ok()?;
    let first = items.first()?;
    match target {
        Target::GitHub { .. } => Some(PullRequest { id: first["number"].as_u64()?.to_string(), title: text(first, "title"), url: text(first, "url") }),
        Target::Azure { .. } => {
            let id = first["pullRequestId"].as_u64()?;
            Some(PullRequest { id: id.to_string(), title: text(first, "title"), url: format!("{web}/pullrequest/{id}") })
        }
        Target::GitLab { .. } => Some(PullRequest { id: first["iid"].as_u64()?.to_string(), title: text(first, "title"), url: text(first, "web_url") }),
        Target::None => None,
    }
}

/// The open pull request from the current branch, if the host has one.
fn pr_existing_of(g: &Git) -> Result<Option<PullRequest>> {
    let (host, target) = remote(g)?;
    let Some(branch) = current_branch(g) else { return Ok(None) };
    check_branch(&branch)?;
    let Some(program) = target.program().filter(|p| crate::proc::find(p).is_some()) else { return Ok(None) };
    let json = run_ok(&g.dir, program, &existing_args(&target, &branch), None, STATUS_TIMEOUT)?;
    Ok(parse_existing(&target, &host.web, &json))
}

/// Publish the pull request. Only ever called from the dialog's Create button.
fn pr_create_of(g: &Git, title: &str, body: &str, base: &str, draft: bool) -> Result<PullRequest> {
    let (host, target) = remote(g)?;
    let program = require(&target)?;
    let title = one_line(title);
    if title.is_empty() {
        return Err(AppError::msg("A pull request needs a title"));
    }
    let branch = current_branch(g).ok_or_else(|| AppError::msg("Check out a branch first"))?;
    check_branch(&branch)?;
    check_branch(base)?;
    if branch == base {
        return Err(AppError::msg(format!("{branch} cannot be merged into itself. Pick another base branch.")));
    }
    let ctx = pr_context_of(g)?;
    if !ctx.on_remote || ctx.unpushed > 0 {
        return Err(AppError::msg(format!("Push {branch} first: the remote does not have all of its commits yet.")));
    }
    let body = body.trim();
    match &target {
        Target::GitHub { .. } => {
            let out = run_ok(&g.dir, program, &gh_pr_create_args(&target, &branch, base, &title, draft), Some(body.as_bytes().to_vec()), CREATE_TIMEOUT)?;
            let url = created_url(&out, "/pull/").ok_or_else(|| unexpected("gh"))?;
            let id = url.rsplit('/').next().unwrap_or("").to_string();
            Ok(PullRequest { id, title, url })
        }
        Target::Azure { .. } => {
            let title_file = TempText::new("pr-title", &clip(&title, AZURE_MAX_TITLE))?;
            let description = if body.is_empty() { None } else { Some(TempText::new("pr-description", &clip(body, AZURE_MAX_DESCRIPTION))?) };
            let out = run_ok(&g.dir, program, &az_pr_create_args(&target, &branch, base, &title_file, description.as_ref(), draft), None, CREATE_TIMEOUT)?;
            parse_az_pr(&out, &host.web).ok_or_else(|| unexpected("az"))
        }
        Target::GitLab { .. } => {
            let mut c = tool(program, &g.dir);
            c.args(glab_mr_create_args(&target, &branch, base, &title, body, draft));
            let out = run(c, None, CREATE_TIMEOUT, program)?;
            if !out.ok {
                return Err(failure(program, &out));
            }
            // glab writes its summary to stderr on some versions.
            let url = created_url(&format!("{}\n{}", out.stdout, out.stderr), "/merge_requests/").ok_or_else(|| unexpected("glab"))?;
            let id = url.rsplit('/').next().unwrap_or("").to_string();
            Ok(PullRequest { id, title, url })
        }
        Target::None => Err(AppError::msg(hint(&target, &Problem::Missing))),
    }
}

/// The host's own "new pull request" page, with as much of the draft as its URL takes.
fn web_url(host: &Host, head: &str, base: &str, title: &str, body: &str) -> Option<PrWebUrl> {
    let (h, b, t) = (encode(head), encode(base), encode(&one_line(title)));
    let fits = |url: &str, more: &str| url.len() + more.len() <= MAX_URL_BYTES;
    match host.provider.as_str() {
        "github" => {
            let mut url = format!("{}/compare/{b}...{h}?expand=1", host.web);
            let with_title = !t.is_empty();
            if with_title {
                url.push_str(&format!("&title={t}"));
            }
            let more = format!("&body={}", encode(body.trim()));
            let with_body = fits(&url, &more);
            if with_body && !body.trim().is_empty() {
                url.push_str(&more);
            }
            Some(PrWebUrl { url, title: with_title, body: with_body })
        }
        "gitlab" => {
            let mut url = format!("{}/-/merge_requests/new?merge_request%5Bsource_branch%5D={h}&merge_request%5Btarget_branch%5D={b}", host.web);
            let with_title = !t.is_empty();
            if with_title {
                url.push_str(&format!("&merge_request%5Btitle%5D={t}"));
            }
            let more = format!("&merge_request%5Bdescription%5D={}", encode(body.trim()));
            let with_body = fits(&url, &more);
            if with_body && !body.trim().is_empty() {
                url.push_str(&more);
            }
            Some(PrWebUrl { url, title: with_title, body: with_body })
        }
        // These two take the branches and nothing else.
        "azure" => Some(PrWebUrl { url: format!("{}/pullrequestcreate?sourceRef={h}&targetRef={b}", host.web), title: false, body: false }),
        "bitbucket" => Some(PrWebUrl { url: format!("{}/pull-requests/new?source={h}&dest={b}", host.web), title: false, body: false }),
        _ => None,
    }
}

/// Only pages on the repository's own host are opened, and only over https.
fn same_host(host: &Host, url: &str) -> bool {
    let domain = |u: &str| u.strip_prefix("https://").map(|rest| rest.split(['/', '?', '#']).next().unwrap_or("").to_ascii_lowercase());
    !url.chars().any(|c| c.is_control() || c.is_whitespace()) && matches!((domain(&host.web), domain(url)), (Some(a), Some(b)) if !a.is_empty() && a == b)
}

// ---- a new repository on a host -----------------------------------------------
// For the "open a folder that is not a repository yet" flow. None of this is tied to a
// local repository: the tools run in a temporary folder and nothing local is touched.

/// The Azure DevOps resource a sign-in must be able to get a token for.
const AZURE_DEVOPS_RESOURCE: &str = "499b84ac-1321-427f-aa17-267ca6975798";

/// One host's command-line tool and whether it can be used right now.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostCli {
    /// github | azure | gitlab
    pub provider: String,
    pub name: String,
    /// gh | az | glab
    pub cli: String,
    pub installed: bool,
    pub signed_in: bool,
    pub account: Option<String>,
    /// What to install or run when it cannot be used.
    pub hint: Option<String>,
}

/// Somewhere a new repository can go: a user, an organization, a group, or an Azure DevOps project.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostOwner {
    pub id: String,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostRepo {
    pub web_url: String,
    /// What to give `git remote add`, in the protocol the user's git already uses for that host.
    pub remote_url: String,
}

const PROVIDERS: [(&str, &str); 3] = [("github", "GitHub"), ("azure", "Azure DevOps"), ("gitlab", "GitLab")];

/// The public service behind a provider name, for choosing the tool and wording the hints.
fn provider_target(provider: &str) -> Result<Target> {
    match provider {
        "github" => Ok(Target::GitHub { domain: "github.com".into(), repo: String::new() }),
        "azure" => Ok(Target::Azure { org_url: String::new(), project: String::new(), repo: String::new() }),
        "gitlab" => Ok(Target::GitLab { domain: "gitlab.com".into(), path: String::new() }),
        _ => Err(AppError::msg("Melodic Studio can create repositories on GitHub, Azure DevOps and GitLab")),
    }
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

/// A failed call that never reached the host says nothing about the sign-in.
pub(crate) fn looks_offline(stderr: &str) -> bool {
    let s = stderr.to_ascii_lowercase();
    ["error connecting", "dial tcp", "no such host", "timeout", "timed out", "network is unreachable", "connection refused"].iter().any(|m| s.contains(m))
}

/// `organization = https://dev.azure.com/name` in what `az devops configure --list` prints.
fn parse_az_default_org(listing: &str) -> Option<String> {
    listing.lines().filter_map(|l| l.split_once('=')).find(|(k, _)| k.trim() == "organization").map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty())
}

fn az_default_org(dir: &Path) -> Option<String> {
    parse_az_default_org(&run_ok(dir, "az", &args(&["devops", "configure", "--list"]), None, STATUS_TIMEOUT).ok()?)
}

/// An organization name or its URL (`https://dev.azure.com/name`, `https://name.visualstudio.com`), as the URL az wants.
fn azure_org_url(org: &str) -> Result<String> {
    let o = org.trim().trim_end_matches('/');
    let name = if let Some(rest) = o.strip_prefix("https://dev.azure.com/") {
        rest.split('/').next().unwrap_or("")
    } else if let Some(rest) = o.strip_prefix("https://") {
        rest.split('/').next().unwrap_or("").strip_suffix(".visualstudio.com").unwrap_or("")
    } else {
        o
    };
    let ok = !name.is_empty() && name.len() <= 50 && name.starts_with(|c: char| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !ok {
        return Err(AppError::msg("Enter the Azure DevOps organization as its name or as https://dev.azure.com/<name>"));
    }
    Ok(format!("https://dev.azure.com/{name}"))
}

/// Who is signed in, or why the tool cannot be used. `Ok(None)` is signed in without a name to show.
fn account(target: &Target, dir: &Path) -> std::result::Result<Option<String>, Problem> {
    let ask = |program: &str, list: &[&str]| -> std::result::Result<Output, Problem> {
        let mut c = tool(program, dir);
        c.args(list);
        run(c, None, STATUS_TIMEOUT, program).map_err(|e| Problem::Other(e.to_string()))
    };
    let refused = |program: &str, o: &Output| if looks_offline(&o.stderr) { Problem::Other(failure(program, o).to_string()) } else { Problem::SignedOut };
    match target {
        Target::GitHub { .. } => {
            let o = ask("gh", &["api", "user", "--jq=.login"])?;
            if !o.ok {
                return Err(refused("gh", &o));
            }
            Ok(Some(o.stdout.trim().to_string()).filter(|s| !s.is_empty()))
        }
        Target::GitLab { .. } => {
            let o = ask("glab", &["api", "user"])?;
            if !o.ok {
                return Err(refused("glab", &o));
            }
            Ok(serde_json::from_str::<Value>(&o.stdout).ok().and_then(|v| v["username"].as_str().map(String::from)))
        }
        Target::Azure { .. } => {
            if !az_has_devops(&ask("az", &["version", "--output=json"])?.stdout) {
                return Err(Problem::Extension);
            }
            // Only the expiry is asked for; the token itself never leaves az.
            let token = ask("az", &["account", "get-access-token", &format!("--resource={AZURE_DEVOPS_RESOURCE}"), "--query=expiresOn", "--output=tsv"])?;
            if token.ok {
                let who = ask("az", &["account", "show", "--query=user.name", "--output=tsv"])?;
                return Ok(Some(who.stdout.trim().to_string()).filter(|s| who.ok && !s.is_empty()));
            }
            // A personal access token (`az devops login`) works without an Azure sign-in.
            if std::env::var_os("AZURE_DEVOPS_EXT_PAT").is_some() {
                return Ok(None);
            }
            if let Some(org) = az_default_org(dir).and_then(|o| azure_org_url(&o).ok()) {
                if ask("az", &["devops", "project", "list", &format!("--org={org}"), "--top=1", "--detect=false", "--query=value[0].id", "--output=tsv"])?.ok {
                    return Ok(None);
                }
            }
            Err(if looks_offline(&token.stderr) { Problem::Other(failure("az", &token).to_string()) } else { Problem::SignedOut })
        }
        Target::None => Err(Problem::Missing),
    }
}

fn host_cli_of(provider: &str, name: &str) -> HostCli {
    let target = provider_target(provider).unwrap_or(Target::None);
    let program = target.program().unwrap_or("");
    let mut cli = HostCli { provider: provider.into(), name: name.into(), cli: program.into(), installed: false, signed_in: false, account: None, hint: None };
    if crate::proc::find(program).is_none() {
        cli.hint = Some(hint(&target, &Problem::Missing));
        return cli;
    }
    cli.installed = true;
    match account(&target, &std::env::temp_dir()) {
        Ok(account) => {
            cli.signed_in = true;
            cli.account = account;
        }
        Err(problem) => cli.hint = Some(hint(&target, &problem)),
    }
    cli
}

/// All three, always, asked at the same time so the slowest one sets the wait.
fn host_clis_now() -> Vec<HostCli> {
    std::thread::scope(|scope| {
        let jira = scope.spawn(jira_cli);
        let asked: Vec<_> = PROVIDERS.iter().map(|(provider, name)| scope.spawn(move || host_cli_of(provider, name))).collect();
        let mut all: Vec<HostCli> = asked.into_iter().zip(PROVIDERS).map(|(handle, (provider, name))| handle.join().unwrap_or_else(|_| HostCli { provider: provider.into(), name: name.into(), cli: String::new(), installed: false, signed_in: false, account: None, hint: Some("Could not check this tool.".into()) })).collect();
        all.extend(jira.join().ok());
        all
    })
}

/// Jira, through Atlassian's own CLI (`acli`), which keeps its own sign-in.
fn jira_cli() -> HostCli {
    let mut cli = HostCli { provider: "jira".into(), name: "Jira".into(), cli: "acli".into(), installed: false, signed_in: false, account: None, hint: None };
    if crate::proc::find("acli").is_none() {
        cli.hint = Some(JIRA_MISSING.into());
        return cli;
    }
    cli.installed = true;
    let mut c = tool("acli", &std::env::temp_dir());
    c.args(["jira", "auth", "status"]);
    match run(c, None, STATUS_TIMEOUT, "acli") {
        Ok(out) if out.ok => {
            cli.signed_in = true;
            cli.account = parse_acli_status(&out.stdout);
        }
        Ok(out) if looks_offline(&out.stderr) => cli.hint = Some(failure("acli", &out).to_string()),
        Ok(_) => cli.hint = Some(JIRA_SIGNED_OUT.into()),
        Err(e) => cli.hint = Some(e.to_string()),
    }
    cli
}

const JIRA_MISSING: &str = "Install the Atlassian CLI (acli) from https://developer.atlassian.com/cloud/acli/guides/install-acli/, then run `acli jira auth login --web` in a terminal.";
const JIRA_SIGNED_OUT: &str = "Run `acli jira auth login --web` in a terminal to sign in to Jira.";

/// `acli jira auth status` prints lines like `Site: team.atlassian.net` and `Email: me@example.com`.
fn parse_acli_status(out: &str) -> Option<String> {
    let field = |name: &str| out.lines().filter_map(|l| l.trim().trim_start_matches(['✓', '-', '*', ' ']).split_once(':')).find(|(k, _)| k.trim().eq_ignore_ascii_case(name)).map(|(_, v)| v.trim().to_string()).filter(|v| !v.is_empty());
    match (field("email").or_else(|| field("user")), field("site")) {
        (Some(who), Some(site)) => Some(format!("{who} on {site}")),
        (who, site) => who.or(site),
    }
}

/// The signed-in user first, then the organizations (one login per line, as `--jq` prints them).
fn github_owners(me: &str, orgs: &str) -> Vec<HostOwner> {
    let me = me.trim();
    let mut owners = vec![HostOwner { id: me.to_string(), label: format!("{me} (your account)") }];
    owners.extend(orgs.lines().map(str::trim).filter(|o| !o.is_empty() && *o != me).map(|o| HostOwner { id: o.to_string(), label: o.to_string() }));
    owners.retain(|o| !o.id.is_empty());
    owners
}

/// `glab api user` and `glab api groups`: the user's namespace, then every group by its full path.
fn gitlab_owners(user_json: &str, groups_json: &str) -> Result<Vec<HostOwner>> {
    let user: Value = serde_json::from_str(user_json).map_err(|_| unexpected("glab"))?;
    let me = user["username"].as_str().ok_or_else(|| unexpected("glab"))?;
    let mut owners = vec![HostOwner { id: me.to_string(), label: format!("{me} (your account)") }];
    let groups: Vec<Value> = serde_json::from_str(groups_json).unwrap_or_default();
    owners.extend(groups.iter().filter_map(|g| {
        let path = g["full_path"].as_str()?;
        Some(HostOwner { id: path.to_string(), label: g["full_name"].as_str().unwrap_or(path).to_string() })
    }));
    Ok(owners)
}

/// `az devops project list -o json`: a page object in current versions of the extension, a bare list in old ones.
fn parse_az_projects(json: &str) -> Result<Vec<HostOwner>> {
    let v: Value = serde_json::from_str(json).map_err(|_| unexpected("az"))?;
    let list = v.get("value").and_then(Value::as_array).or_else(|| v.as_array()).ok_or_else(|| unexpected("az"))?;
    let mut owners: Vec<HostOwner> = list.iter().filter_map(|p| p["name"].as_str()).map(|n| HostOwner { id: n.to_string(), label: n.to_string() }).collect();
    owners.sort_by_key(|o| o.label.to_lowercase());
    Ok(owners)
}

fn owners_of(provider: &str, org: Option<&str>) -> Result<Vec<HostOwner>> {
    let target = provider_target(provider)?;
    let program = require(&target)?;
    let dir = std::env::temp_dir();
    match target {
        Target::GitHub { .. } => {
            let me = run_ok(&dir, program, &args(&["api", "user", "--jq=.login"]), None, STATUS_TIMEOUT)?;
            // Without the read:org scope the organizations cannot be listed; the user's own account still can be used.
            let orgs = run_ok(&dir, program, &args(&["api", "user/orgs", "--paginate", "--jq=.[].login"]), None, LIST_TIMEOUT).unwrap_or_default();
            Ok(github_owners(&me, &orgs))
        }
        Target::GitLab { .. } => {
            let me = run_ok(&dir, program, &args(&["api", "user"]), None, STATUS_TIMEOUT)?;
            // Developer access (30) is the least that can create a project in a group.
            let groups = run_ok(&dir, program, &args(&["api", "groups?min_access_level=30&per_page=100"]), None, LIST_TIMEOUT).unwrap_or_default();
            gitlab_owners(&me, &groups)
        }
        _ => {
            let org_url = match org.map(str::trim).filter(|o| !o.is_empty()) {
                Some(org) => azure_org_url(org)?,
                None => match az_default_org(&dir) {
                    Some(org) => azure_org_url(&org)?,
                    None => return Ok(vec![]),
                },
            };
            let json = run_ok(&dir, program, &[args(&["devops", "project", "list"]), vec![format!("--org={org_url}"), "--top=200".into(), "--detect=false".into(), "--output=json".into()]].concat(), None, LIST_TIMEOUT)?;
            parse_az_projects(&json)
        }
    }
}

/// A repository name every host accepts: letters, digits, dot, dash, underscore.
fn check_repo_name(name: &str) -> Result<()> {
    let ok = !name.is_empty()
        && name.len() <= 100
        && name.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
        && !name.ends_with(".git")
        && !name.ends_with('.');
    if !ok {
        return Err(AppError::msg("Name the repository with letters, digits, dots, dashes or underscores, starting with a letter or digit"));
    }
    Ok(())
}

/// The account, organization, group path or Azure DevOps project the repository goes under.
fn check_owner(target: &Target, owner: &str) -> Result<()> {
    let word = |s: &str, extra: &str| s.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_') && s.chars().all(|c| c.is_ascii_alphanumeric() || extra.contains(c));
    let ok = match target {
        Target::GitHub { .. } => owner.len() <= 39 && word(owner, "-_"),
        Target::GitLab { .. } => owner.len() <= 255 && owner.split('/').all(|part| word(part, "._-")),
        Target::Azure { .. } => usable(owner) && owner.len() <= 64 && !owner.starts_with('_') && !owner.ends_with('.') && !owner.chars().any(|c| "\\/:*?\"<>|;#$}{,+=[]".contains(c)),
        Target::None => false,
    };
    if !ok {
        return Err(AppError::msg(format!("\"{owner}\" is not somewhere a repository can be created")));
    }
    Ok(())
}

fn visibility(private: bool) -> String {
    if private { "--private" } else { "--public" }.to_string()
}

/// Only the remote repository: no `--source`, `--push` or `--clone`, so nothing local changes.
fn gh_repo_create_args(name: &str, owner: Option<&str>, private: bool) -> Vec<String> {
    vec!["repo".into(), "create".into(), visibility(private), "--".into(), owner.map(|o| format!("{o}/{name}")).unwrap_or_else(|| name.to_string())]
}

/// A new repository takes its visibility from its project, so there is no private/public here.
fn az_repo_create_args(org_url: &str, project: &str, name: &str) -> Vec<String> {
    vec!["repos".into(), "create".into(), format!("--name={name}"), format!("--org={org_url}"), format!("--project={project}"), "--detect=false".into(), "--output=json".into()]
}

fn glab_repo_create_args(name: &str, owner: Option<&str>, private: bool) -> Vec<String> {
    vec!["repo".into(), "create".into(), visibility(private), "--skipGitInit".into(), "--".into(), owner.map(|o| format!("{o}/{name}")).unwrap_or_else(|| name.to_string())]
}

/// `https://github.com/owner/name` as git wants it for the protocol the user chose in the tool.
fn clone_url(web: &str, protocol: &str) -> Option<String> {
    let rest = web.trim_end_matches('/').strip_prefix("https://")?;
    let (domain, path) = rest.split_once('/')?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    (!domain.is_empty() && !path.is_empty()).then(|| if protocol.trim() == "ssh" { format!("git@{domain}:{path}.git") } else { format!("https://{domain}/{path}.git") })
}

/// The address the tool printed, without the full stop some of them end the sentence with.
fn created_repo_url(output: &str, domain: &str) -> Option<String> {
    created_url(output, &format!("//{domain}/")).map(|u| u.trim_end_matches(['.', ',', ')']).to_string())
}

fn parse_az_repo(json: &str) -> Option<HostRepo> {
    let v: Value = serde_json::from_str(json).ok()?;
    let web_url = v["webUrl"].as_str()?.to_string();
    let remote_url = v["remoteUrl"].as_str().map(String::from).unwrap_or_else(|| web_url.clone());
    Some(HostRepo { web_url, remote_url })
}

/// The two refusals worth rewording; everything else is the tool's own message.
fn create_failure(e: AppError, name: &str) -> AppError {
    let said = e.to_string();
    let lower = said.to_lowercase();
    if lower.contains("already exists") || lower.contains("has already been taken") {
        AppError::msg(format!("A repository named \"{name}\" already exists there. Pick another name."))
    } else if ["permission", "forbidden", "not authorized", "403", "tf401027"].iter().any(|m| lower.contains(m)) {
        AppError::msg(format!("You are not allowed to create a repository there. ({said})"))
    } else {
        e
    }
}

/// An empty folder to run a tool in, removed afterwards: whatever the tool does to "the current directory" lands nowhere.
struct Scratch(PathBuf);

impl Scratch {
    fn new() -> Result<Self> {
        let dir = std::env::temp_dir().join(format!("melodic-studio-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0)));
        std::fs::create_dir_all(&dir)?;
        Ok(Scratch(dir))
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Create the repository on the host and nothing else. Only ever called from the wizard's explicit step.
fn create_repo(provider: &str, name: &str, owner: Option<&str>, private: bool, org: Option<&str>) -> Result<HostRepo> {
    let target = provider_target(provider)?;
    let program = require(&target)?;
    let name = name.trim();
    check_repo_name(name)?;
    let owner = owner.map(str::trim).filter(|o| !o.is_empty());
    if let Some(owner) = owner {
        check_owner(&target, owner)?;
    }
    let scratch = Scratch::new()?;
    let dir = scratch.0.as_path();
    let protocol = |domain: &str, fallback: &str| run_ok(dir, program, &args(&["config", "get", "git_protocol", &format!("--host={domain}")]), None, STATUS_TIMEOUT).map(|p| p.trim().to_string()).ok().filter(|p| p == "ssh" || p == "https").unwrap_or_else(|| fallback.to_string());
    match target {
        Target::GitHub { .. } => {
            let out = run_ok(dir, program, &gh_repo_create_args(name, owner, private), None, CREATE_TIMEOUT).map_err(|e| create_failure(e, name))?;
            let web_url = created_repo_url(&out, "github.com").ok_or_else(|| unexpected("gh"))?;
            let remote_url = clone_url(&web_url, &protocol("github.com", "https")).ok_or_else(|| unexpected("gh"))?;
            Ok(HostRepo { web_url, remote_url })
        }
        Target::GitLab { .. } => {
            let mut c = tool(program, dir);
            c.args(glab_repo_create_args(name, owner, private));
            let out = run(c, None, CREATE_TIMEOUT, program)?;
            if !out.ok {
                return Err(create_failure(failure(program, &out), name));
            }
            let web_url = created_repo_url(&format!("{}\n{}", out.stdout, out.stderr), "gitlab.com").ok_or_else(|| unexpected("glab"))?;
            let remote_url = clone_url(&web_url, &protocol("gitlab.com", "ssh")).ok_or_else(|| unexpected("glab"))?;
            Ok(HostRepo { web_url, remote_url })
        }
        _ => {
            let project = owner.ok_or_else(|| AppError::msg("Choose the Azure DevOps project the repository belongs to"))?;
            let org_url = match org.map(str::trim).filter(|o| !o.is_empty()) {
                Some(org) => azure_org_url(org)?,
                None => azure_org_url(&az_default_org(dir).ok_or_else(|| AppError::msg("Enter the Azure DevOps organization the repository belongs to"))?)?,
            };
            let out = run_ok(dir, program, &az_repo_create_args(&org_url, project, name), None, CREATE_TIMEOUT).map_err(|e| create_failure(e, name))?;
            parse_az_repo(&out).ok_or_else(|| unexpected("az"))
        }
    }
}

// ---- commands -----------------------------------------------------------------

/// These wait on other programs and the network; keep them off the async workers.
pub(crate) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| AppError::msg(format!("That stopped unexpectedly: {e}")))?
}

/// Which command-line tool serves this repository's host, and whether it is installed and signed in.
#[tauri::command]
pub async fn issues_status(state: State<'_, AppState>, id: String) -> Result<CliStatus> {
    let g = repo(&state, &id)?;
    blocking(move || status(&g)).await
}

/// Open issues (work items on Azure DevOps), optionally narrowed by a search.
#[tauri::command]
pub async fn issues_list(state: State<'_, AppState>, id: String, query: Option<String>) -> Result<Vec<Issue>> {
    let g = repo(&state, &id)?;
    blocking(move || list_issues(&g, query.as_deref().unwrap_or(""))).await
}

#[tauri::command]
pub async fn pr_context(state: State<'_, AppState>, id: String) -> Result<PrContext> {
    let g = repo(&state, &id)?;
    blocking(move || pr_context_of(&g)).await
}

#[tauri::command]
pub async fn pr_changes(state: State<'_, AppState>, id: String, base: String) -> Result<PrChanges> {
    let g = repo(&state, &id)?;
    blocking(move || pr_changes_of(&g, base.trim())).await
}

#[tauri::command]
pub async fn pr_existing(state: State<'_, AppState>, id: String) -> Result<Option<PullRequest>> {
    let g = repo(&state, &id)?;
    blocking(move || pr_existing_of(&g)).await
}

/// Create the pull request on the host. This publishes; nothing calls it but the dialog's Create button.
#[tauri::command]
pub async fn pr_create(state: State<'_, AppState>, id: String, title: String, body: String, base: String, draft: bool) -> Result<PullRequest> {
    let g = repo(&state, &id)?;
    blocking(move || pr_create_of(&g, &title, &body, base.trim(), draft)).await
}

/// The address of the host's "new pull request" page for the current branch.
#[tauri::command]
pub async fn pr_web_url(state: State<'_, AppState>, id: String, title: String, body: String, base: String) -> Result<PrWebUrl> {
    let g = repo(&state, &id)?;
    blocking(move || {
        let (host, _) = remote(&g)?;
        let branch = current_branch(&g).ok_or_else(|| AppError::msg("Check out a branch first"))?;
        check_branch(base.trim())?;
        web_url(&host, &branch, base.trim(), &title, &body).ok_or_else(|| AppError::msg(format!("Melodic Studio does not know the pull request page on {}", host.name)))
    })
    .await
}

/// Open an issue or pull request page in the browser.
#[tauri::command]
pub async fn host_open(app: tauri::AppHandle, state: State<'_, AppState>, id: String, url: String) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let g = repo(&state, &id)?;
    let (host, _) = blocking(move || remote(&g)).await?;
    if !same_host(&host, &url) {
        return Err(AppError::msg(format!("That link does not lead to {}", host.name)));
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
}

/// The three host tools and whether each can be used. Not tied to a repository.
#[tauri::command]
pub async fn host_clis() -> Result<Vec<HostCli>> {
    blocking(|| Ok(host_clis_now())).await
}

/// Where a new repository can go: accounts and organizations, groups, or the projects of an Azure DevOps organization.
#[tauri::command]
pub async fn host_owners(provider: String, org: Option<String>) -> Result<Vec<HostOwner>> {
    blocking(move || owners_of(&provider, org.as_deref())).await
}

/// Create a repository on the host. This publishes; it pushes nothing and changes no local repository.
#[tauri::command]
pub async fn host_repo_create(provider: String, name: String, owner: Option<String>, private: bool, org: Option<String>) -> Result<HostRepo> {
    blocking(move || create_repo(&provider, &name, owner.as_deref(), private, org.as_deref())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_of(url: &str) -> Target {
        target(&git::host(url).unwrap())
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn acli_status_names_the_account() {
        assert_eq!(parse_acli_status("✓ Authenticated\n  Site: team.atlassian.net\n  Email: me@example.com\n").as_deref(), Some("me@example.com on team.atlassian.net"));
        assert_eq!(parse_acli_status("Site: team.atlassian.net").as_deref(), Some("team.atlassian.net"));
        assert_eq!(parse_acli_status("ok"), None);
    }

    #[test]
    fn remote_urls_become_targets() {
        let gh = Target::GitHub { domain: "github.com".into(), repo: "owner/repo".into() };
        for url in ["git@github.com:owner/repo.git", "https://github.com/owner/repo", "https://user:token@github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"] {
            assert_eq!(target_of(url), gh, "{url}");
        }
        assert_eq!(gh.repo_arg(), "--repo=owner/repo");
        assert_eq!(gh.program(), Some("gh"));
        let ghe = target_of("git@github.example.com:team/tool.git");
        assert_eq!(ghe, Target::GitHub { domain: "github.example.com".into(), repo: "team/tool".into() });
        assert_eq!(ghe.repo_arg(), "--repo=github.example.com/team/tool");

        let az = Target::Azure { org_url: "https://dev.azure.com/org".into(), project: "My Project".into(), repo: "repo".into() };
        for url in ["https://org@dev.azure.com/org/My%20Project/_git/repo", "git@ssh.dev.azure.com:v3/org/My%20Project/repo", "https://org.visualstudio.com/DefaultCollection/My%20Project/_git/repo"] {
            assert_eq!(target_of(url), az, "{url}");
        }
        assert_eq!(target_of("https://dev.azure.com/org/_git/solo"), Target::Azure { org_url: "https://dev.azure.com/org".into(), project: "solo".into(), repo: "solo".into() });

        let gl = target_of("https://gitlab.com/group/sub/repo.git");
        assert_eq!(gl, Target::GitLab { domain: "gitlab.com".into(), path: "group/sub/repo".into() });
        assert_eq!(gl.repo_arg(), "--repo=group/sub/repo");
        assert_eq!(target_of("git@gitlab.example.com:group/repo.git").repo_arg(), "--repo=https://gitlab.example.com/group/repo");

        assert_eq!(target_of("git@bitbucket.org:team/repo.git"), Target::None);
        assert_eq!(target_of("ssh://git@host.example:2222/owner/repo.git"), Target::None);
        // Nothing that a tool would read as an option or a file reference.
        assert_eq!(target_of("git@github.com:-owner/repo.git"), Target::None);
        assert_eq!(target_of("https://github.com/owner/repo/extra"), Target::None);
        assert_eq!(target_of("https://dev.azure.com/org/@secrets/_git/repo"), Target::None);
    }

    #[test]
    fn hints_say_what_to_run() {
        let gh = target_of("git@github.com:owner/repo.git");
        assert!(hint(&gh, &Problem::Missing).contains("https://cli.github.com"));
        assert_eq!(hint(&gh, &Problem::SignedOut), "Run `gh auth login` in a terminal to sign in to github.com.");
        assert!(hint(&target_of("git@github.example.com:a/b.git"), &Problem::SignedOut).contains("gh auth login --hostname github.example.com"));
        let az = target_of("https://dev.azure.com/org/Proj/_git/repo");
        assert!(hint(&az, &Problem::Missing).contains("az extension add --name azure-devops"));
        assert!(hint(&az, &Problem::Extension).starts_with("Run `az extension add --name azure-devops`"));
        assert!(hint(&az, &Problem::SignedOut).contains("az login"));
        assert!(hint(&target_of("https://gitlab.com/g/r.git"), &Problem::Missing).contains("glab auth login"));
        assert!(hint(&az, &Problem::Other("boom".into())).starts_with("az is installed but could not be used: boom"));

        // Captured from az 2.66 with a sign-in that had gone stale.
        assert!(az_wants_login("ERROR: Before you can run Azure DevOps commands, you need to run the login command(az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.  Please see https://aka.ms/azure-devops-cli-auth for more information."));
        assert!(!az_wants_login("ERROR: TF200016: The following project does not exist: Nope."));
        assert!(az_has_devops(r#"{"azure-cli": "2.66.0", "azure-cli-core": "2.66.0", "extensions": {"azure-devops": "1.0.2"}}"#));
        assert!(!az_has_devops(r#"{"azure-cli": "2.66.0", "extensions": {}}"#));
        assert!(!az_has_devops("not json"));
    }

    #[test]
    fn github_issues() {
        let gh = target_of("git@github.com:cli/cli.git");
        assert_eq!(gh_issue_args(&gh, ""), strings(&["issue", "list", "--repo=cli/cli", "--state=open", "--limit=50", "--json=number,title,body,url,labels,assignees,state,updatedAt"]));
        // A search that starts with a dash stays the search.
        assert_eq!(gh_issue_args(&gh, "-label:bug crash").last().unwrap(), "--search=-label:bug crash");

        // `gh issue list -R cli/cli --json …` (gh 2.86), bodies shortened.
        let json = r#"[
          {"assignees": [], "body": "**Describe the bug**\n\n<script>alert(1)</script>", "labels": [
              {"id": "MDU6TGFiZWwxNTkzNDg0NjIw", "name": "bug", "description": "Something isn't working", "color": "d73a4a"},
              {"id": "LA_kwDODKw3uc8AAAABZ6m4jw", "name": "gh-label", "description": "relating to the gh label command", "color": "E6691F"}],
            "number": 15066, "state": "OPEN", "title": "`gh label list --json` prints nothing instead of `[]`", "updatedAt": "2026-11-16T15:38:19Z", "url": "https://github.com/cli/cli/issues/15066"},
          {"assignees": [{"id": "MDQ6VXNlcjE=", "login": "octocat", "name": "The Octocat"}, {"id": "x", "login": "second", "name": ""}], "body": "", "labels": [],
            "number": 15061, "state": "OPEN", "title": "Triage", "updatedAt": "2026-11-16T18:43:13Z", "url": "https://github.com/cli/cli/issues/15061"}
        ]"#;
        let issues = parse_gh_issues(json).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0],
            Issue {
                id: "15066".into(),
                title: "`gh label list --json` prints nothing instead of `[]`".into(),
                body: "**Describe the bug**\n\n<script>alert(1)</script>".into(),
                url: "https://github.com/cli/cli/issues/15066".into(),
                labels: vec!["bug".into(), "gh-label".into()],
                assignee: None,
                state: "open".into(),
                updated: "2026-11-16T15:38:19Z".into(),
                kind: "issue".into(),
            }
        );
        assert_eq!(issues[1].assignee.as_deref(), Some("octocat"));
        assert!(parse_gh_issues("[]").unwrap().is_empty());
        assert!(parse_gh_issues("no issues match your search").is_err());
    }

    #[test]
    fn gitlab_issues() {
        let gl = target_of("https://gitlab.com/group/sub/repo.git");
        assert_eq!(glab_issue_args(&gl, "login"), strings(&["issue", "list", "--repo=group/sub/repo", "--output=json", "--per-page=50", "--search=login"]));

        // The GitLab issues API shape, which `glab issue list --output json` prints unchanged.
        let json = r#"[{"id": 9001, "iid": 42, "project_id": 7, "title": "Sign-in loops on Safari", "description": "Steps:\n1. Open the app", "state": "opened",
            "created_at": "2026-10-01T08:00:00.000Z", "updated_at": "2026-11-02T09:30:00.000Z", "labels": ["bug", "auth"],
            "assignees": [{"id": 3, "username": "sam", "name": "Sam Doe"}], "assignee": {"id": 3, "username": "sam", "name": "Sam Doe"},
            "issue_type": "incident", "web_url": "https://gitlab.com/group/sub/repo/-/issues/42"},
          {"iid": 43, "title": "No description", "description": null, "state": "opened", "updated_at": "2026-11-03T09:30:00.000Z", "labels": [], "assignees": [], "assignee": null,
            "web_url": "https://gitlab.com/group/sub/repo/-/issues/43"}]"#;
        let issues = parse_glab_issues(json).unwrap();
        assert_eq!(issues.len(), 2);
        assert_eq!(
            issues[0],
            Issue {
                id: "42".into(),
                title: "Sign-in loops on Safari".into(),
                body: "Steps:\n1. Open the app".into(),
                url: "https://gitlab.com/group/sub/repo/-/issues/42".into(),
                labels: vec!["bug".into(), "auth".into()],
                assignee: Some("sam".into()),
                state: "open".into(),
                updated: "2026-11-02T09:30:00.000Z".into(),
                kind: "incident".into(),
            }
        );
        assert_eq!((issues[1].body.as_str(), issues[1].assignee.as_deref(), issues[1].kind.as_str()), ("", None, "issue"));
    }

    #[test]
    fn azure_work_items() {
        let q = wiql("Bob's Project", "", true);
        assert!(q.starts_with("SELECT [System.Id], [System.Title], [System.Description], "));
        assert!(q.contains("[Microsoft.VSTS.TCM.ReproSteps] FROM WorkItems WHERE [System.TeamProject] = 'Bob''s Project' AND"));
        assert!(q.contains("([System.AssignedTo] = @Me OR [System.ChangedDate] >= @Today - 14)"));
        assert!(q.ends_with("ORDER BY [System.ChangedDate] DESC"));
        assert!(!wiql("P", "", false).contains("ReproSteps"));
        // Searches cannot break out of the quoted string.
        assert!(wiql("P", "it's' OR 1=1 --\n", true).contains("AND [System.Title] CONTAINS 'it''s'' OR 1=1 --' ORDER BY"));
        assert!(wiql("P", "#812", true).contains("AND ([System.Id] = 812 OR [System.Title] CONTAINS '#812') ORDER BY"));

        let file = TempText::new("test", "SELECT 1").unwrap();
        let path = file.0.clone();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "SELECT 1");
        let args = az_query_args("https://dev.azure.com/org", &file);
        assert_eq!(args[..3], strings(&["boards", "query", "--org=https://dev.azure.com/org"])[..]);
        assert_eq!(args[3], format!("--wiql=@{}", path.to_string_lossy()));
        assert_eq!(args[4..], strings(&["--detect=false", "--output=json"])[..]);
        drop(file);
        assert!(!path.exists(), "the query file is removed afterwards");

        // What `az boards query --wiql … -o json` prints: the work items with the selected fields.
        let json = r#"[
          {"fields": {"System.AssignedTo": {"_links": {"avatar": {"href": "https://dev.azure.com/org/_apis/GraphProfile/MemberAvatars/aad.x"}}, "descriptor": "aad.x", "displayName": "Jane Doe",
                "id": "5f0d1a3e-0000-0000-0000-000000000000", "imageUrl": "https://dev.azure.com/org/_apis/GraphProfile/MemberAvatars/aad.x", "uniqueName": "jane@example.com", "url": "https://spsprodcus1.vssps.visualstudio.com/x/_apis/Identities/5f0d"},
              "System.ChangedDate": "2026-11-10T14:03:11.377Z", "System.Description": "<div>Export fails when the name has a <b>&amp;</b> in it.</div><div><br></div><ul><li>Open a report</li><li>Click Export&nbsp;</li></ul>",
              "System.Id": 812, "System.State": "Active", "System.Tags": "export; customer", "System.Title": "Export fails on ampersand", "System.WorkItemType": "User Story"},
            "id": 812, "relations": null, "rev": 7, "url": "https://dev.azure.com/org/_apis/wit/workItems/812"},
          {"fields": {"Microsoft.VSTS.TCM.ReproSteps": "<p>1. Sign in</p><p>2. It crashes</p>", "System.AssignedTo": "Sam Roe <sam@example.com>", "System.ChangedDate": "2026-11-09T09:00:00Z",
              "System.Id": 799, "System.State": "New", "System.Title": "Crash on sign-in", "System.WorkItemType": "Bug"},
            "id": 799, "relations": null, "rev": 2, "url": "https://dev.azure.com/org/_apis/wit/workItems/799"}
        ]"#;
        let items = parse_az_items(json, "https://dev.azure.com/org", "My Project").unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(
            items[0],
            Issue {
                id: "812".into(),
                title: "Export fails on ampersand".into(),
                body: "Export fails when the name has a & in it.\n\n- Open a report\n- Click Export".into(),
                url: "https://dev.azure.com/org/My%20Project/_workitems/edit/812".into(),
                labels: vec!["export".into(), "customer".into()],
                assignee: Some("Jane Doe".into()),
                state: "Active".into(),
                updated: "2026-11-10T14:03:11.377Z".into(),
                kind: "User Story".into(),
            }
        );
        assert_eq!((items[1].body.as_str(), items[1].assignee.as_deref(), items[1].kind.as_str()), ("1. Sign in\n2. It crashes", Some("Sam Roe"), "Bug"));
        assert!(items[1].labels.is_empty());
    }

    #[test]
    fn html_becomes_plain_text() {
        assert_eq!(html_to_text("Plain text, nothing to do"), "Plain text, nothing to do");
        assert_eq!(html_to_text("<p>One</p><p>Two<br/>Three</p>"), "One\nTwo\nThree");
        assert_eq!(html_to_text("<script>alert('x')</script><img src=x onerror=alert(1)>after"), "alert('x')after");
        assert_eq!(html_to_text("a &lt;b&gt; &amp;amp; c"), "a <b> &amp; c");
        assert_eq!(html_to_text("if a < b then"), "if a < b then");
        assert_eq!(html_to_text("<h2>Title</h2>\n\n\n<div>Body</div>"), "Title\n\nBody");
    }

    #[test]
    fn pull_request_arguments_and_answers() {
        let gh = target_of("git@github.com:owner/repo.git");
        assert_eq!(
            gh_pr_create_args(&gh, "issue/12-fix", "main", "--fill everything", true),
            strings(&["pr", "create", "--repo=owner/repo", "--head=issue/12-fix", "--base=main", "--title=--fill everything", "--body-file=-", "--draft"])
        );
        assert!(!gh_pr_create_args(&gh, "a", "main", "T", false).contains(&"--draft".to_string()));
        // What gh prints after creating one.
        assert_eq!(created_url("\nCreating pull request for issue/12-fix into main in owner/repo\n\nhttps://github.com/owner/repo/pull/57\n", "/pull/").as_deref(), Some("https://github.com/owner/repo/pull/57"));
        assert_eq!(created_url("Warning: 2 uncommitted changes", "/pull/"), None);

        let title = TempText::new("test-title", "@notes.txt is not a file").unwrap();
        let body = TempText::new("test-body", "- one\n- two").unwrap();
        let az = target_of("https://dev.azure.com/org/My%20Project/_git/repo");
        let args = az_pr_create_args(&az, "@odd", "main", &title, Some(&body), true);
        assert_eq!(
            args,
            vec![
                "repos".to_string(),
                "pr".into(),
                "create".into(),
                "--org=https://dev.azure.com/org".into(),
                "--project=My Project".into(),
                "--repository=repo".into(),
                "--source-branch=refs/heads/@odd".into(),
                "--target-branch=refs/heads/main".into(),
                format!("--title=@{}", title.0.to_string_lossy()),
                "--detect=false".into(),
                "--output=json".into(),
                format!("--description=@{}", body.0.to_string_lossy()),
                "--draft=true".into(),
            ]
        );
        assert_eq!(az_pr_create_args(&az, "a", "b", &title, None, false).len(), 11);
        // The part of `az repos pr create -o json` that is read.
        let created = r#"{"artifactId": null, "codeReviewId": 311, "createdBy": {"displayName": "Jane Doe"}, "isDraft": true, "pullRequestId": 311,
            "repository": {"name": "repo", "webUrl": null}, "sourceRefName": "refs/heads/issue/12-fix", "status": "active", "targetRefName": "refs/heads/main",
            "title": "Fix the export", "url": "https://dev.azure.com/org/00000000-0000/_apis/git/repositories/11111111/pullRequests/311"}"#;
        assert_eq!(
            parse_az_pr(created, "https://dev.azure.com/org/My%20Project/_git/repo"),
            Some(PullRequest { id: "311".into(), title: "Fix the export".into(), url: "https://dev.azure.com/org/My%20Project/_git/repo/pullrequest/311".into() })
        );
        assert_eq!(parse_az_pr("{}", "w"), None);

        let gl = target_of("https://gitlab.com/group/repo.git");
        assert_eq!(
            glab_mr_create_args(&gl, "feature/x", "main", "Title", "- a\n- b", false),
            strings(&["mr", "create", "--repo=group/repo", "--source-branch=feature/x", "--target-branch=main", "--title=Title", "--description=- a\n- b", "--yes"])
        );
        assert_eq!(created_url("!14 Title (feature/x)\n https://gitlab.com/group/repo/-/merge_requests/14\n", "/merge_requests/").as_deref(), Some("https://gitlab.com/group/repo/-/merge_requests/14"));

        // Looking for a pull request that is already open.
        assert_eq!(existing_args(&gh, "feature/x"), strings(&["pr", "list", "--repo=owner/repo", "--head=feature/x", "--state=open", "--limit=1", "--json=number,title,url"]));
        assert_eq!(parse_existing(&gh, "", r#"[{"number":15065,"title":"Fix workflow log truncation","url":"https://github.com/cli/cli/pull/15065"}]"#).unwrap().id, "15065");
        assert_eq!(parse_existing(&gh, "", "[]"), None);
        let az = target_of("https://dev.azure.com/org/Proj/_git/repo");
        assert!(existing_args(&az, "feature/x").contains(&"--source-branch=refs/heads/feature/x".to_string()));
        assert_eq!(parse_existing(&az, "https://dev.azure.com/org/Proj/_git/repo", r#"[{"pullRequestId": 9, "title": "T"}]"#).unwrap().url, "https://dev.azure.com/org/Proj/_git/repo/pullrequest/9");
        assert_eq!(parse_existing(&gl, "", r#"[{"iid": 14, "title": "T", "web_url": "https://gitlab.com/group/repo/-/merge_requests/14"}]"#).unwrap().id, "14");

        assert!(check_branch("feature/x").is_ok());
        for bad in ["", "-x", "@file", "a b", "a..b"] {
            assert!(check_branch(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn web_pages_carry_the_draft_where_they_can() {
        let gh = git::host("git@github.com:owner/repo.git").unwrap();
        let page = web_url(&gh, "issue/12-fix", "main", "Fix the  export\n", "Line one\n\n- a & b").unwrap();
        assert_eq!(page.url, "https://github.com/owner/repo/compare/main...issue%2F12-fix?expand=1&title=Fix%20the%20export&body=Line%20one%0A%0A-%20a%20%26%20b");
        assert!(page.title && page.body);
        // A description too long for a link is left out whole, never cut.
        let long = web_url(&gh, "a", "main", "T", &"word ".repeat(3000)).unwrap();
        assert_eq!(long.url, "https://github.com/owner/repo/compare/main...a?expand=1&title=T");
        assert!(long.title && !long.body);

        let gl = git::host("https://gitlab.com/group/repo.git").unwrap();
        assert_eq!(
            web_url(&gl, "a", "main", "T", "B").unwrap().url,
            "https://gitlab.com/group/repo/-/merge_requests/new?merge_request%5Bsource_branch%5D=a&merge_request%5Btarget_branch%5D=main&merge_request%5Btitle%5D=T&merge_request%5Bdescription%5D=B"
        );
        let az = git::host("https://dev.azure.com/org/Proj/_git/repo").unwrap();
        assert_eq!(web_url(&az, "a", "main", "T", "B").unwrap(), PrWebUrl { url: "https://dev.azure.com/org/Proj/_git/repo/pullrequestcreate?sourceRef=a&targetRef=main".into(), title: false, body: false });
        assert_eq!(web_url(&git::host("git@bitbucket.org:team/repo.git").unwrap(), "a", "main", "T", "B").unwrap().url, "https://bitbucket.org/team/repo/pull-requests/new?source=a&dest=main");
        assert_eq!(web_url(&git::host("git@host.example:o/r.git").unwrap(), "a", "main", "T", "B"), None);

        assert!(same_host(&gh, "https://github.com/owner/repo/issues/3"));
        assert!(same_host(&gh, "https://GitHub.com/other/place"));
        for bad in ["http://github.com/owner/repo", "https://github.com.evil.example/x", "https://evil.example/github.com", "file:///etc/passwd", "https://github.com/a b", "javascript:alert(1)", ""] {
            assert!(!same_host(&gh, bad), "{bad}");
        }
    }

    #[test]
    fn a_hung_tool_is_given_up_on() {
        let dir = std::env::temp_dir();
        let mut slow = if cfg!(windows) { tool("ping", &dir) } else { tool("sleep", &dir) };
        slow.args(if cfg!(windows) { vec!["-n", "30", "127.0.0.1"] } else { vec!["30"] });
        let started = Instant::now();
        let err = run(slow, None, Duration::from_millis(300), "sleep").unwrap_err();
        assert!(err.to_string().contains("did not answer"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(10));

        // Output and exit status come back, and stdin goes in.
        let mut c = tool("git", &dir);
        c.args(["hash-object", "--stdin"]);
        let out = run(c, Some(b"hello\n".to_vec()), Duration::from_secs(20), "git").unwrap();
        assert!(out.ok);
        assert_eq!(out.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
        let mut c = tool("git", &dir);
        c.args(["no-such-command"]);
        let out = run(c, None, Duration::from_secs(20), "git").unwrap();
        assert!(!out.ok);
        assert!(failure("git", &out).to_string().starts_with("git: "));
        let stale = Output { ok: false, stdout: String::new(), stderr: "ERROR: Before you can run Azure DevOps commands, you need to run the login command(az login if using AAD/MSA identity else az devops login if using PAT token) to setup credentials.".into() };
        assert!(failure("az", &stale).to_string().starts_with("Azure DevOps is not signed in. Run `az login`"));
        let other = Output { ok: false, stdout: String::new(), stderr: "WARNING: preview\nERROR: TF401019: The Git repository does not exist.\n".into() };
        assert_eq!(failure("az", &other).to_string(), "az: WARNING: preview TF401019: The Git repository does not exist.");
        assert!(run(tool("no-such-program-anywhere", &dir), None, Duration::from_secs(1), "nothing").is_err());
    }

    #[test]
    fn pull_request_context_from_git() {
        let base = std::env::temp_dir().join(format!("studio-host-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let origin = base.join("origin.git");
        std::fs::create_dir_all(&origin).unwrap();
        Git::at(&origin).run(&["init", "-q", "--bare", "-b", "main"]).unwrap();
        let dir = base.join("work");
        let g = Git::init(&dir).unwrap();
        for (k, v) in [("user.name", "Test"), ("user.email", "t@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            g.run(&["config", k, v]).unwrap();
        }
        assert!(pr_context_of(&g).is_err(), "no remote yet");
        g.run(&["remote", "add", "origin", &origin.to_string_lossy()]).unwrap();
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        g.commit(&["a.txt".into()], "First", "", false).unwrap();
        g.push(false).unwrap();

        g.branch_create("issue/7-fix", None).unwrap();
        std::fs::write(dir.join("b.txt"), "two\n").unwrap();
        g.commit(&["b.txt".into()], "Add b", "Because the list needs it.", false).unwrap();
        std::fs::write(dir.join("a.txt"), "one\nmore\n").unwrap();
        g.commit(&["a.txt".into()], "Extend a", "", false).unwrap();

        // No origin/HEAD in a repository made with `remote add`, and no host to ask: the usual name wins.
        let ctx = pr_context_of(&g).unwrap();
        assert_eq!(ctx, PrContext { branch: "issue/7-fix".into(), base: "main".into(), bases: vec!["main".into()], on_remote: false, unpushed: 2 });
        assert!(pr_create_of(&g, "Title", "", "main", false).is_err(), "a local path is not a host");

        let changes = pr_changes_of(&g, "main").unwrap();
        assert_eq!(changes.count, 2);
        assert_eq!(changes.subjects, vec!["Extend a".to_string(), "Add b".to_string()]);
        assert!(changes.log.contains(" Add b\n    Because the list needs it."), "{}", changes.log);
        assert!(changes.stat.contains("b.txt") && changes.stat.contains("2 files changed"), "{}", changes.stat);
        assert!(pr_changes_of(&g, "nope").is_err());
        assert!(pr_changes_of(&g, "-x").is_err());

        g.push(false).unwrap();
        let ctx = pr_context_of(&g).unwrap();
        assert!(ctx.on_remote);
        assert_eq!(ctx.unpushed, 0);
        std::fs::write(dir.join("b.txt"), "two\nthree\n").unwrap();
        g.commit(&["b.txt".into()], "More b", "", false).unwrap();
        assert_eq!(pr_context_of(&g).unwrap().unpushed, 1);

        // The remote's own idea of its default branch beats the guess.
        g.run(&["branch", "develop", "main"]).unwrap();
        g.run(&["push", "-q", "origin", "develop"]).unwrap();
        g.run(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]).unwrap();
        let ctx = pr_context_of(&g).unwrap();
        assert_eq!(ctx.base, "develop");
        assert!(ctx.bases.contains(&"main".to_string()) && ctx.bases.contains(&"develop".to_string()) && !ctx.bases.contains(&"HEAD".to_string()));

        assert_eq!(clip_stat("a | 1 +\nb | 1 +\n 2 files changed", 9), "a | 1 +\nb\n …\n 2 files changed");
        assert_eq!(clip("héllo", 2), "hé");
        assert_eq!(one_line(" a\n b  c "), "a b c");
        assert_eq!(decode("My%20Project%2"), "My Project%2");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn new_repository_arguments_and_answers() {
        // Nothing but the remote repository is asked for.
        assert_eq!(gh_repo_create_args("harmony", None, true), strings(&["repo", "create", "--private", "--", "harmony"]));
        assert_eq!(gh_repo_create_args("harmony", Some("melodic"), false), strings(&["repo", "create", "--public", "--", "melodic/harmony"]));
        for args in [gh_repo_create_args("a", Some("b"), true), glab_repo_create_args("a", Some("b"), true), az_repo_create_args("https://dev.azure.com/o", "p", "a")] {
            assert!(!args.iter().any(|a| a.starts_with("--source") || a.starts_with("--push") || a.starts_with("--clone") || a == "-c" || a == "-s"), "{args:?}");
        }
        assert_eq!(glab_repo_create_args("harmony", Some("group/sub"), true), strings(&["repo", "create", "--private", "--skipGitInit", "--", "group/sub/harmony"]));
        assert_eq!(az_repo_create_args("https://dev.azure.com/org", "My Project", "harmony"), strings(&["repos", "create", "--name=harmony", "--org=https://dev.azure.com/org", "--project=My Project", "--detect=false", "--output=json"]));

        // gh prints the address alone when it is not on a terminal, with a sentence in front when it is.
        assert_eq!(created_repo_url("https://github.com/melodic/harmony\n", "github.com").as_deref(), Some("https://github.com/melodic/harmony"));
        assert_eq!(created_repo_url("✓ Created repository melodic/harmony on GitHub\n  https://github.com/melodic/harmony\n", "github.com").as_deref(), Some("https://github.com/melodic/harmony"));
        assert_eq!(created_repo_url("✓ Created repository harmony on GitLab: https://gitlab.com/sam/harmony.\n", "gitlab.com").as_deref(), Some("https://gitlab.com/sam/harmony"));
        assert_eq!(created_repo_url("see https://example.com/docs", "github.com"), None);
        assert_eq!(clone_url("https://github.com/melodic/harmony", "https\n").as_deref(), Some("https://github.com/melodic/harmony.git"));
        assert_eq!(clone_url("https://github.com/melodic/harmony", "ssh").as_deref(), Some("git@github.com:melodic/harmony.git"));
        assert_eq!(clone_url("https://gitlab.com/group/sub/harmony/", "ssh").as_deref(), Some("git@gitlab.com:group/sub/harmony.git"));
        assert_eq!(clone_url("https://github.com", "ssh"), None);

        // The part of `az repos create -o json` that is read.
        let created = r#"{"defaultBranch": null, "id": "11111111-2222-3333-4444-555555555555", "isDisabled": false, "name": "harmony",
            "project": {"id": "00000000-0000-0000-0000-000000000000", "name": "My Project", "visibility": "private"},
            "remoteUrl": "https://org@dev.azure.com/org/My%20Project/_git/harmony", "size": 0, "sshUrl": "git@ssh.dev.azure.com:v3/org/My%20Project/harmony",
            "url": "https://dev.azure.com/org/0000/_apis/git/repositories/1111", "webUrl": "https://dev.azure.com/org/My%20Project/_git/harmony"}"#;
        assert_eq!(parse_az_repo(created), Some(HostRepo { web_url: "https://dev.azure.com/org/My%20Project/_git/harmony".into(), remote_url: "https://org@dev.azure.com/org/My%20Project/_git/harmony".into() }));
        assert_eq!(parse_az_repo("[]"), None);

        for good in ["harmony", "my.app_2", "A-b", "_private"] {
            assert!(check_repo_name(good).is_ok(), "{good}");
        }
        for bad in ["", "-rf", ".hidden", "a b", "a/b", "@file", "repo.git", "trailing.", "semi;colon", "ünï", &"x".repeat(101)] {
            assert!(check_repo_name(bad).is_err(), "{bad}");
        }
        let (gh, gl, az) = (provider_target("github").unwrap(), provider_target("gitlab").unwrap(), provider_target("azure").unwrap());
        assert!(check_owner(&gh, "melodic-dev").is_ok() && check_owner(&gl, "group/sub.team").is_ok() && check_owner(&az, "My Project").is_ok());
        for (target, bad) in [(&gh, "-x"), (&gh, "a/b"), (&gh, "a b"), (&gl, "group/-x"), (&gl, "group//x"), (&az, "-p"), (&az, "@p"), (&az, "a/b"), (&az, "_p"), (&az, "")] {
            assert!(check_owner(target, bad).is_err(), "{bad}");
        }
        assert!(provider_target("bitbucket").is_err());

        // The two refusals that get their own words. The first is what gh says for a taken name.
        let taken = create_failure(AppError::msg("gh: GraphQL: Name already exists on this account (createRepository)"), "harmony");
        assert_eq!(taken.to_string(), "A repository named \"harmony\" already exists there. Pick another name.");
        assert!(create_failure(AppError::msg("az: TF400948: A Git repository with the name harmony already exists."), "harmony").to_string().starts_with("A repository named"));
        assert!(create_failure(AppError::msg("gh: GraphQL: octo does not have the correct permissions to execute `CreateRepository` (createRepository)"), "h").to_string().starts_with("You are not allowed to create a repository there. (gh: GraphQL"));
        assert_eq!(create_failure(AppError::msg("gh: something else"), "h").to_string(), "gh: something else");

        let scratch = Scratch::new().unwrap();
        let dir = scratch.0.clone();
        assert!(dir.is_dir());
        drop(scratch);
        assert!(!dir.exists());
    }

    #[test]
    fn owners_and_tools_without_a_repository() {
        assert_eq!(
            github_owners("octocat\n", "melodic\n\ngithub\noctocat\n"),
            vec![HostOwner { id: "octocat".into(), label: "octocat (your account)".into() }, HostOwner { id: "melodic".into(), label: "melodic".into() }, HostOwner { id: "github".into(), label: "github".into() }]
        );
        assert_eq!(github_owners("octocat", "").len(), 1);
        assert!(github_owners("", "").is_empty());

        // The GitLab API shapes `glab api user` and `glab api groups` print.
        let user = r#"{"id": 3, "username": "sam", "name": "Sam Doe", "state": "active", "web_url": "https://gitlab.com/sam"}"#;
        let groups = r#"[{"id": 9, "name": "Sub", "path": "sub", "full_name": "Group / Sub", "full_path": "group/sub", "visibility": "private"}, {"id": 8, "name": "Group", "path": "group", "full_path": "group"}]"#;
        assert_eq!(
            gitlab_owners(user, groups).unwrap(),
            vec![HostOwner { id: "sam".into(), label: "sam (your account)".into() }, HostOwner { id: "group/sub".into(), label: "Group / Sub".into() }, HostOwner { id: "group".into(), label: "group".into() }]
        );
        assert_eq!(gitlab_owners(user, "").unwrap().len(), 1, "no groups is not an error");
        assert!(gitlab_owners("{}", "[]").is_err());

        // `az devops project list -o json` in azure-devops 1.0, and the bare list older versions printed.
        let page = r#"{"continuationToken": null, "value": [{"abbreviation": null, "id": "2", "name": "Zeta", "state": "wellFormed", "visibility": "private"}, {"id": "1", "name": "alpha Project", "state": "wellFormed"}]}"#;
        assert_eq!(parse_az_projects(page).unwrap(), vec![HostOwner { id: "alpha Project".into(), label: "alpha Project".into() }, HostOwner { id: "Zeta".into(), label: "Zeta".into() }]);
        assert_eq!(parse_az_projects(r#"[{"id": "1", "name": "Solo"}]"#).unwrap().len(), 1);
        assert!(parse_az_projects(r#"{"message": "nope"}"#).is_err());

        // What `az devops configure --list` prints.
        let listing = "\n[defaults]\norganization = https://dev.azure.com/melodic\nproject = Studio\n\nUse git alias = No\n";
        assert_eq!(parse_az_default_org(listing).as_deref(), Some("https://dev.azure.com/melodic"));
        assert_eq!(parse_az_default_org("[defaults]\nproject = Studio\n"), None);
        for org in ["melodic", " https://dev.azure.com/melodic/ ", "https://dev.azure.com/melodic/Project/_git/x", "https://melodic.visualstudio.com"] {
            assert_eq!(azure_org_url(org).unwrap(), "https://dev.azure.com/melodic", "{org}");
        }
        for bad in ["", "-x", "@file", "a b", "https://example.com/melodic", "http://dev.azure.com/melodic", "a/b"] {
            assert!(azure_org_url(bad).is_err(), "{bad}");
        }

        assert!(looks_offline("error connecting to api.github.com\ncheck your internet connection"));
        assert!(!looks_offline("To get started with GitHub CLI, please run:  gh auth login"));

        // A tool that is not installed: no call is made, and the hint says what to get.
        let glab = host_cli_of("gitlab", "GitLab");
        if crate::proc::find("glab").is_none() {
            assert_eq!((glab.installed, glab.signed_in, glab.account.clone()), (false, false, None));
            assert!(glab.hint.as_deref().unwrap().contains("glab auth login"));
            assert!(owners_of("gitlab", None).is_err());
        }
        assert_eq!((glab.provider.as_str(), glab.name.as_str(), glab.cli.as_str()), ("gitlab", "GitLab", "glab"));
        assert!(owners_of("bitbucket", None).is_err());
        assert!(create_repo("github", "-rf", None, true, None).is_err(), "refused before any tool runs");
        assert!(create_repo("github", "ok", Some("-owner"), true, None).is_err());
        assert!(create_repo("bitbucket", "ok", None, true, None).is_err());
    }

    /// Read-only calls against the real tools, for a machine where they are signed in:
    /// `cargo test live_read_only -- --ignored --nocapture`. Creates nothing anywhere.
    #[test]
    #[ignore]
    fn live_read_only() {
        let dir = std::env::temp_dir().join(format!("studio-host-live-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let g = Git::init(&dir).unwrap();
        g.run(&["remote", "add", "origin", "https://github.com/cli/cli.git"]).unwrap();

        let st = status(&g).unwrap();
        println!("github status: installed={} signed_in={} hint={:?}", st.installed, st.signed_in, st.hint);
        if st.signed_in {
            let issues = list_issues(&g, "").unwrap();
            println!("{} open issues, first: #{} {:?} labels={:?}", issues.len(), issues[0].id, issues[0].title, issues[0].labels);
            assert!(!issues.is_empty() && issues.iter().all(|i| i.url.starts_with("https://github.com/cli/cli/issues/") && i.state == "open"));
            let found = list_issues(&g, "-label:bug pager").unwrap();
            println!("{} for a search starting with a dash", found.len());
            println!("default branch asked from the host: {:?}", pr_context_of(&g).unwrap().base);
            assert_eq!(pr_context_of(&g).unwrap().base, "trunk");
            println!("owners: {}", owners_of("github", None).unwrap().len());
            // The exact arguments a Create would send, with gh's own dry run: it prints what it would do and creates nothing.
            let (_, gh) = remote(&g).unwrap();
            let mut dry = gh_pr_create_args(&gh, "no-such-user-zz:no-such-branch", "trunk", "-a title that starts with a dash", true);
            dry.push("--dry-run".into());
            let scratch = Scratch::new().unwrap();
            let said = run_ok(&scratch.0, "gh", &dry, Some(b"- first\n- second\n\nFixes #1".to_vec()), CREATE_TIMEOUT).unwrap();
            assert!(said.contains("Would have created a Pull Request"), "{said}");
            assert!(said.contains("title:\t-a title that starts with a dash") && said.contains("draft:\ttrue") && said.contains("base:\ttrunk") && said.contains("- first\n- second\n\nFixes #1"), "{said}");
            println!("gh pr create --dry-run accepted the arguments and the body on stdin");
        }
        for cli in host_clis_now() {
            println!("{}: cli={} installed={} signed_in={} account={} hint={:?}", cli.name, cli.cli, cli.installed, cli.signed_in, cli.account.is_some(), cli.hint);
        }

        g.run(&["remote", "set-url", "origin", "https://dev.azure.com/no-such-org-zz/NoProject/_git/none"]).unwrap();
        let st = status(&g).unwrap();
        println!("azure status: installed={} signed_in={} hint={:?}", st.installed, st.signed_in, st.hint);
        println!("azure list: {:?}", list_issues(&g, "").map(|i| i.len()).map_err(|e| e.to_string()));
        g.run(&["remote", "set-url", "origin", "https://gitlab.com/gitlab-org/cli.git"]).unwrap();
        let st = status(&g).unwrap();
        println!("gitlab status: installed={} signed_in={} hint={:?}", st.installed, st.signed_in, st.hint);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
