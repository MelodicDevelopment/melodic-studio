//! Thin wrapper over the system `git`. Shelling out means the user's SSH agent,
//! credential helpers, hooks and signing config all work without us knowing.

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

/// Diffs larger than this are not sent to the UI.
const MAX_DIFF_BYTES: usize = 1_500_000;

#[derive(Clone)]
pub struct Git {
    pub dir: PathBuf,
}

/// Who commits: `user.name` and `user.email` at one level of git's config.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
pub struct Identity {
    pub name: String,
    pub email: String,
}

impl Identity {
    fn is_empty(&self) -> bool {
        self.name.is_empty() && self.email.is_empty()
    }

    /// Both parts, trimmed; refused when either is missing, spans lines or could be read as an option.
    fn checked(&self) -> Result<Identity> {
        let who = Identity { name: self.name.trim().to_string(), email: self.email.trim().to_string() };
        if who.name.is_empty() || who.email.is_empty() {
            return Err(AppError::msg("Give both a name and an email"));
        }
        if [&who.name, &who.email].iter().any(|v| v.starts_with('-') || v.contains(['\n', '\r'])) {
            return Err(AppError::msg("That name or email cannot be used"));
        }
        Ok(who)
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// modified | added | deleted | renamed | untracked | conflicted
    pub status: String,
}

/// One line of an interactive rebase, as the UI sends it. `action` is pick, reword, squash, fixup
/// or drop. `message` replaces the message of the commit this line starts (a pick or reword
/// together with the squash and fixup lines after it).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RebaseStep {
    pub hash: String,
    pub action: String,
    pub message: Option<String>,
}

/// A file the UI wants acted on (discard).
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub path: String,
    pub old_path: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UndoInfo {
    pub hash: String,
    pub summary: String,
    pub description: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stash {
    /// `stash@{0}` style name.
    pub name: String,
    pub message: String,
    pub date: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatus {
    pub branch: String,
    pub detached: bool,
    pub has_commits: bool,
    /// Tip commit id; the UI reloads history when it moves.
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub remote: Option<String>,
    pub remote_url: Option<String>,
    /// The remote's default branch (its `HEAD`, else `main` / `master` when the remote has one), without the remote prefix.
    pub default_branch: Option<String>,
    /// Where the remote is hosted, when the URL is one we recognise.
    pub host: Option<Host>,
    pub files: Vec<FileChange>,
    pub merge_in_progress: bool,
    pub rebase_in_progress: bool,
    /// merge | rebase | cherry-pick | revert | squash, when one is stopped half way.
    pub operation: Option<String>,
    pub stashes: Vec<Stash>,
    /// Milliseconds since the epoch of the last fetch, if any.
    pub last_fetched: Option<u64>,
    /// The tip commit, when it is safe to undo (not on any remote, not a merge).
    pub undo: Option<UndoInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub short_hash: String,
    pub author_name: String,
    pub author_email: String,
    pub date: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub summary: String,
    pub body: String,
    pub unpushed: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub is_remote: bool,
    pub is_current: bool,
    pub upstream: Option<String>,
    /// A local branch's own copy on a remote (`origin/feature`), as of the last fetch: the
    /// remote branch of the same name, on the upstream's remote when the branch has one, else
    /// on the only remote that has it. Deleting "on the remote too" deletes exactly this.
    pub published: Option<String>,
    pub date: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiffResult {
    pub text: String,
    pub too_large: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UndoneCommit {
    pub summary: String,
    pub description: String,
}

fn base_command() -> Command {
    let mut c = crate::proc::command("git");
    c.env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        // Paths come from git's own output; never let one be read as a glob or magic pathspec.
        .env("GIT_LITERAL_PATHSPECS", "1")
        // Status polls must not fight a git command the user runs in a terminal.
        .env("GIT_OPTIONAL_LOCKS", "0")
        // Nothing here can answer an editor; accept the message git proposes. `:` is git's own
        // "no editor" (it never starts a program), where `true` only exists on Unix.
        .env("GIT_EDITOR", ":")
        .env("GIT_SEQUENCE_EDITOR", ":");
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

/// Run git; `ok_codes` lists exit codes besides 0 that still mean success.
fn exec(mut c: Command, stdin: Option<&[u8]>, ok_codes: &[i32]) -> Result<String> {
    if stdin.is_some() {
        c.stdin(Stdio::piped());
    }
    let mut child = c.spawn().map_err(|e| AppError::Git(format!("could not run git: {e}")))?;
    let pipe = child.stdin.take();
    // Feed stdin while the output is being read. Written first, a long input stalls for good
    // once git has filled its output pipe and stopped reading (a pipe holds 64 KB on Linux,
    // as little as 4 KB on Windows).
    let out = std::thread::scope(|scope| {
        if let (Some(input), Some(mut pipe)) = (stdin, pipe) {
            scope.spawn(move || {
                // If git exits early its own error is the one worth reporting.
                let _ = pipe.write_all(input);
            });
        }
        child.wait_with_output()
    })?;
    if out.status.success() || out.status.code().is_some_and(|code| ok_codes.contains(&code)) {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(AppError::Git(msg))
    }
}

/// How long the fetch nobody asked for may take.
const QUIET_FETCH_LIMIT: std::time::Duration = std::time::Duration::from_secs(60);

/// More commits than this is not a list anyone edits by hand.
const REBASE_LIMIT: usize = 500;

/// What is stopped half way in the repository whose git dir is `d`. A squash merge leaves only
/// SQUASH_MSG behind, which also outlives one finished in a terminal, so it counts only while
/// files are still conflicted.
fn operation_at(d: &Path, conflicted: bool) -> Option<&'static str> {
    if d.join("MERGE_HEAD").exists() {
        Some("merge")
    } else if d.join("rebase-merge").exists() || d.join("rebase-apply").exists() {
        Some("rebase")
    } else if d.join("CHERRY_PICK_HEAD").exists() {
        Some("cherry-pick")
    } else if d.join("REVERT_HEAD").exists() {
        Some("revert")
    } else if conflicted && d.join("SQUASH_MSG").exists() {
        Some("squash")
    } else {
        None
    }
}

/// A path for git's shell, single-quoted. Forward slashes, which Git for Windows' shell and
/// programs read as well as backslashes. A path holding a quote is refused rather than escaped.
fn sh_quote(path: &Path) -> Result<String> {
    let s = path.to_string_lossy();
    let s = if cfg!(windows) { s.replace('\\', "/") } else { s.into_owned() };
    if s.contains('\'') || s.contains('\n') {
        return Err(AppError::msg("The repository's path contains a quote or line break, which an interactive rebase cannot use"));
    }
    Ok(format!("'{s}'"))
}

/// The todo list for `rebase -i`. Messages are written to files in `dir` and applied by an
/// `exec` line after the last squash or fixup of the commit they belong to.
fn rebase_todo(steps: &[RebaseStep], dir: &Path) -> Result<String> {
    let mut lines: Vec<String> = Vec::new();
    // The message waiting for the end of the current commit's group.
    let mut pending: Option<String> = None;
    let mut started = false;
    for (i, step) in steps.iter().enumerate() {
        check_ref(&step.hash)?;
        if !step.hash.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::msg(format!("\"{}\" is not a commit hash", step.hash)));
        }
        let action = match step.action.as_str() {
            "pick" | "reword" => "pick",
            "squash" => "squash",
            "fixup" => "fixup",
            "drop" => "drop",
            other => return Err(AppError::msg(format!("Unknown rebase action \"{other}\""))),
        };
        if action == "drop" {
            lines.push(format!("drop {}", step.hash));
            continue;
        }
        if action == "pick" {
            if let Some(exec) = pending.take() {
                lines.push(exec);
            }
            started = true;
            if let Some(message) = step.message.as_deref().map(str::trim).filter(|m| !m.is_empty()) {
                let file = dir.join(format!("message-{i}.txt"));
                std::fs::write(&file, message)?;
                pending = Some(format!("exec git commit --amend --no-verify --allow-empty -q --cleanup=whitespace -F {}", sh_quote(&file)?));
            }
        } else if !started {
            return Err(AppError::msg("The first commit kept cannot be squashed or fixed up: there is nothing before it to fold into"));
        }
        lines.push(format!("{action} {}", step.hash));
    }
    if let Some(exec) = pending {
        lines.push(exec);
    }
    lines.push(String::new());
    Ok(lines.join("\n"))
}

/// Branch and ref names go on the command line; refuse anything that could be read as an option.
pub(crate) fn check_ref(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) || name.contains("..") {
        return Err(AppError::msg(format!("\"{name}\" is not a valid name")));
    }
    Ok(())
}

impl Git {
    pub fn at(dir: impl Into<PathBuf>) -> Self {
        Git { dir: dir.into() }
    }

    pub fn run(&self, args: &[&str]) -> Result<String> {
        let mut c = base_command();
        c.current_dir(&self.dir).args(args);
        exec(c, None, &[])
    }

    /// `git stash` uses pathspec magic internally, which literal pathspecs break. These
    /// commands take no paths from us, so the guard is not needed.
    fn run_magic(&self, args: &[&str]) -> Result<String> {
        let mut c = base_command();
        c.env_remove("GIT_LITERAL_PATHSPECS").current_dir(&self.dir).args(args);
        exec(c, None, &[])
    }

    fn run_stdin(&self, args: &[&str], input: &[u8]) -> Result<String> {
        let mut c = base_command();
        c.current_dir(&self.dir).args(args);
        exec(c, Some(input), &[])
    }

    /// Which of `paths` a .gitignore rule matches (for the Files tab). `check-ignore`
    /// refuses literal pathspecs, so the guard comes off; the names go in on stdin, never
    /// the command line. Best effort: nothing is marked if git fails.
    pub fn ignored(&self, paths: &[String]) -> Vec<String> {
        if paths.is_empty() {
            return Vec::new();
        }
        let mut c = base_command();
        c.env_remove("GIT_LITERAL_PATHSPECS").current_dir(&self.dir).args(["check-ignore", "-z", "--stdin"]);
        // Exit code 1 only means none of them is ignored.
        exec(c, Some(paths.join("\0").as_bytes()), &[1]).map(|text| text.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect()).unwrap_or_default()
    }

    fn run_ok(&self, args: &[&str], ok_codes: &[i32]) -> Result<String> {
        let mut c = base_command();
        c.current_dir(&self.dir).args(args);
        exec(c, None, ok_codes)
    }

    /// Run without a repository (version, clone, global config).
    pub fn run_global(args: &[&str]) -> Result<String> {
        let mut c = base_command();
        c.current_dir(std::env::temp_dir()).args(args);
        exec(c, None, &[])
    }

    pub fn version() -> Option<String> {
        Git::run_global(&["--version"]).ok().map(|s| s.trim().trim_start_matches("git version ").to_string())
    }

    pub fn global_config(key: &str) -> String {
        Git::run_global(&["config", "--global", "--get", key]).map(|s| s.trim().to_string()).unwrap_or_default()
    }

    /// The identity every repository commits with unless it has its own.
    pub fn global_identity() -> Identity {
        Identity { name: Git::global_config("user.name"), email: Git::global_config("user.email") }
    }

    pub fn set_global_identity(who: &Identity) -> Result<()> {
        let who = who.checked()?;
        Git::run_global(&["config", "--global", "user.name", &who.name])?;
        Git::run_global(&["config", "--global", "user.email", &who.email])?;
        Ok(())
    }

    /// This repository's own identity (`.git/config`, shared by its worktrees); `None` when it
    /// uses the global one.
    pub fn local_identity(&self) -> Option<Identity> {
        let get = |key: &str| self.run(&["config", "--local", "--get", key]).map(|s| s.trim().to_string()).unwrap_or_default();
        Some(Identity { name: get("user.name"), email: get("user.email") }).filter(|w| !w.is_empty())
    }

    /// Give this repository its own identity, or with `None` go back to the global one.
    pub fn set_local_identity(&self, who: Option<&Identity>) -> Result<()> {
        match who {
            Some(who) => {
                let who = who.checked()?;
                self.run(&["config", "--local", "user.name", &who.name])?;
                self.run(&["config", "--local", "user.email", &who.email])?;
            }
            None => {
                for key in ["user.name", "user.email"] {
                    // `--unset` fails when the key is not there, so only unset what is set.
                    if self.run(&["config", "--local", "--get", key]).is_ok() {
                        self.run(&["config", "--local", "--unset-all", key])?;
                    }
                }
            }
        }
        Ok(())
    }

    /// The top-level directory of the repository containing `dir`, in the platform's own
    /// spelling (git prints `C:/Users/...` on Windows).
    pub fn toplevel(dir: &Path) -> Result<PathBuf> {
        if !dir.is_dir() {
            return Err(AppError::msg("That folder does not exist"));
        }
        let out = Git::at(dir).run(&["rev-parse", "--show-toplevel"]).map_err(|_| AppError::msg("That folder is not a git repository"))?;
        Ok(crate::paths::native(out.trim_end_matches(['\r', '\n'])))
    }

    pub fn init(dir: &Path) -> Result<Git> {
        std::fs::create_dir_all(dir)?;
        let g = Git::at(dir);
        g.run(&["init", "-q", "-b", "main"])?;
        Ok(g)
    }

    pub fn clone(url: &str, dest: &Path) -> Result<Git> {
        if url.starts_with('-') {
            return Err(AppError::msg("That is not a repository URL"));
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent)?;
        }
        Git::run_global(&["clone", "-q", "--", url, &dest.to_string_lossy()])?;
        Ok(Git::at(dest))
    }

    pub fn has_commits(&self) -> bool {
        self.run(&["rev-parse", "--verify", "-q", "HEAD"]).is_ok()
    }

    fn git_dir(&self) -> PathBuf {
        self.run(&["rev-parse", "--absolute-git-dir"]).map(|s| PathBuf::from(s.trim())).unwrap_or_else(|_| self.dir.join(".git"))
    }

    /// `origin` when it exists, else the first remote.
    pub fn default_remote(&self) -> Option<String> {
        let out = self.run(&["remote"]).ok()?;
        let names: Vec<&str> = out.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        names.iter().find(|n| **n == "origin").or(names.first()).map(|s| s.to_string())
    }

    /// The remote's default branch name: `refs/remotes/<remote>/HEAD`, else `main` or `master` when the remote has it.
    pub fn remote_default_branch(&self, remote: &str) -> Option<String> {
        let prefix = format!("{remote}/");
        if let Some(name) = self.run(&["symbolic-ref", "--short", "-q", &format!("refs/remotes/{remote}/HEAD")]).ok().and_then(|s| s.trim().strip_prefix(&prefix).map(String::from)) {
            return Some(name);
        }
        ["main", "master"].iter().find(|n| self.run(&["rev-parse", "--verify", "-q", &format!("refs/remotes/{remote}/{n}")]).is_ok()).map(|n| n.to_string())
    }

    /// The URL of `origin`, else of the first remote, in one git call.
    pub fn origin_url(&self) -> Option<String> {
        let out = self.run(&["config", "--get-regexp", r"^remote\..*\.url$"]).ok()?;
        let urls: Vec<(&str, &str)> = out
            .lines()
            .filter_map(|l| l.split_once(' '))
            .filter_map(|(k, v)| Some((k.strip_prefix("remote.")?.strip_suffix(".url")?, v.trim())))
            .collect();
        urls.iter().find(|(n, _)| *n == "origin").or(urls.first()).map(|(_, u)| u.to_string()).filter(|u| !u.is_empty())
    }

    pub fn remote_url(&self, remote: &str) -> Option<String> {
        self.run(&["remote", "get-url", remote]).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
    }

    pub fn set_remote(&self, url: &str) -> Result<()> {
        if url.starts_with('-') || url.trim().is_empty() {
            return Err(AppError::msg("That is not a repository URL"));
        }
        if self.remote_url("origin").is_some() {
            self.run(&["remote", "set-url", "origin", url])?;
        } else {
            self.run(&["remote", "add", "origin", url])?;
        }
        Ok(())
    }

    pub fn conflicted_paths(&self) -> Vec<String> {
        self.run(&["diff", "--name-only", "--diff-filter=U", "-z"]).map(|s| s.split('\0').filter(|l| !l.is_empty()).map(String::from).collect()).unwrap_or_default()
    }

    // ---- status -------------------------------------------------------------

    pub fn status(&self) -> Result<RepoStatus> {
        let out = self.run(&["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"])?;
        let mut st = RepoStatus::default();
        let mut records = out.split('\0');
        while let Some(rec) = records.next() {
            if rec.is_empty() {
                continue;
            }
            if let Some(header) = rec.strip_prefix("# ") {
                let (key, value) = header.split_once(' ').unwrap_or((header, ""));
                match key {
                    "branch.oid" => {
                        st.has_commits = value != "(initial)";
                        st.head = st.has_commits.then(|| value.to_string());
                    }
                    "branch.head" => {
                        st.detached = value == "(detached)";
                        st.branch = value.to_string();
                    }
                    "branch.upstream" => st.upstream = Some(value.to_string()),
                    "branch.ab" => {
                        let mut it = value.split_whitespace();
                        st.ahead = it.next().and_then(|s| s.trim_start_matches('+').parse().ok()).unwrap_or(0);
                        st.behind = it.next().and_then(|s| s.trim_start_matches('-').parse().ok()).unwrap_or(0);
                    }
                    _ => {}
                }
                continue;
            }
            match rec.as_bytes()[0] {
                b'1' => {
                    let f: Vec<&str> = rec.splitn(9, ' ').collect();
                    if f.len() == 9 {
                        let xy = f[1].as_bytes();
                        let status = if xy[0] == b'A' {
                            "added"
                        } else if xy[0] == b'D' || xy[1] == b'D' {
                            "deleted"
                        } else {
                            "modified"
                        };
                        st.files.push(FileChange { path: f[8].to_string(), old_path: None, status: status.into() });
                    }
                }
                b'2' => {
                    let f: Vec<&str> = rec.splitn(10, ' ').collect();
                    let orig = records.next().map(String::from);
                    if f.len() == 10 {
                        st.files.push(FileChange { path: f[9].to_string(), old_path: orig, status: "renamed".into() });
                    }
                }
                b'u' => {
                    let f: Vec<&str> = rec.splitn(11, ' ').collect();
                    if f.len() == 11 {
                        st.files.push(FileChange { path: f[10].to_string(), old_path: None, status: "conflicted".into() });
                    }
                }
                b'?' => st.files.push(FileChange { path: rec[2..].to_string(), old_path: None, status: "untracked".into() }),
                _ => {}
            }
        }
        st.files.sort_by_key(|f| f.path.to_lowercase());

        if st.detached {
            st.branch = self.run(&["rev-parse", "--short", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_else(|_| "detached".into());
        }
        st.remote = self.default_remote();
        st.remote_url = st.remote.as_deref().and_then(|r| self.remote_url(r));
        st.host = st.remote_url.as_deref().and_then(host);
        st.default_branch = st.remote.as_deref().and_then(|r| self.remote_default_branch(r));

        let git_dir = self.git_dir();
        st.merge_in_progress = git_dir.join("MERGE_HEAD").exists();
        st.rebase_in_progress = git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists();
        st.operation = operation_at(&git_dir, st.files.iter().any(|f| f.status == "conflicted")).map(String::from);
        st.stashes = self.stashes();
        // In a linked worktree `.git` is a file and the git dir is `<main>/.git/worktrees/<name>`;
        // FETCH_HEAD stays in the shared one, which `commondir` points at.
        let common_dir = std::fs::read_to_string(git_dir.join("commondir")).map(|rel| git_dir.join(rel.trim())).unwrap_or_else(|_| git_dir.clone());
        st.last_fetched = std::fs::metadata(common_dir.join("FETCH_HEAD"))
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64);

        if st.has_commits && st.operation.is_none() {
            st.undo = self.undo_candidate();
        }
        Ok(st)
    }

    /// The tip commit when undoing it cannot rewrite anything already shared.
    fn undo_candidate(&self) -> Option<UndoInfo> {
        let out = self.run(&["log", "-1", "--format=%H%x1f%P%x1f%s%x1f%b"]).ok()?;
        let mut f = out.trim_end_matches('\n').split('\x1f');
        let hash = f.next()?.to_string();
        let parents = f.next()?;
        let summary = f.next().unwrap_or("").to_string();
        let description = f.next().unwrap_or("").trim().to_string();
        if parents.split_whitespace().count() > 1 {
            return None;
        }
        let local_only = self.run(&["rev-list", "-1", "HEAD", "--not", "--remotes"]).ok()?;
        if local_only.trim().is_empty() {
            return None;
        }
        Some(UndoInfo { hash, summary, description })
    }

    // ---- diffs --------------------------------------------------------------

    fn diff_result(text: String) -> DiffResult {
        if text.len() > MAX_DIFF_BYTES {
            DiffResult { text: String::new(), too_large: true }
        } else {
            DiffResult { text, too_large: false }
        }
    }

    /// Working tree (and index) against HEAD for one file.
    pub fn diff_worktree(&self, path: &str, old_path: Option<&str>, status: &str) -> Result<DiffResult> {
        let text = if status == "untracked" || !self.has_commits() {
            // `--no-index` exits 1 when the files differ, which is always. Git reads the
            // literal name `/dev/null` as "no file" on every platform, Windows included.
            self.run_ok(&["diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", path], &[1])?
        } else {
            let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", "HEAD", "--"];
            if let Some(old) = old_path {
                args.push(old);
            }
            args.push(path);
            self.run(&args)?
        };
        Ok(Git::diff_result(text))
    }

    /// One file as changed by a commit (against its first parent).
    pub fn diff_commit(&self, hash: &str, path: &str, old_path: Option<&str>) -> Result<DiffResult> {
        check_ref(hash)?;
        let parent = format!("{hash}^");
        let text = if self.run(&["rev-parse", "--verify", "-q", &parent]).is_ok() {
            let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", &parent, hash, "--"];
            if let Some(old) = old_path {
                args.push(old);
            }
            args.push(path);
            self.run(&args)?
        } else {
            self.run(&["show", "--no-color", "--no-ext-diff", "--format=", hash, "--", path])?
        };
        Ok(Git::diff_result(text))
    }

    /// A file as it was at a commit (`rev`), in the shape the Files tab reads one from disk. Too large
    /// and binary files come back flagged and empty. An error when the commit has no such file.
    pub fn file_at(&self, rev: &str, path: &str) -> Result<crate::files::FileContent> {
        check_ref(rev)?;
        // One argument, `<rev>:<path>`: not a pathspec, so a name is never read as a pattern or an option.
        let spec = format!("{rev}:{path}");
        let size: u64 = self.run(&["cat-file", "-s", &spec])?.trim().parse().unwrap_or(0);
        if size > crate::files::MAX_FILE_BYTES {
            return Ok(crate::files::FileContent { too_large: true, size, ..Default::default() });
        }
        let text = self.run(&["show", "--no-textconv", &spec])?;
        // `run` reads the output as text; what was not text shows as NUL or the replacement character.
        if text.contains('\0') || text.contains('\u{FFFD}') {
            return Ok(crate::files::FileContent { binary: true, size, ..Default::default() });
        }
        Ok(crate::files::FileContent { text, size, ..Default::default() })
    }

    // ---- committing ---------------------------------------------------------

    /// Commit exactly the given paths (GitHub Desktop style: the checked files
    /// are the commit; the index is not something the user manages).
    pub fn commit(&self, paths: &[String], summary: &str, description: &str, amend: bool) -> Result<()> {
        if summary.trim().is_empty() {
            return Err(AppError::msg("A commit needs a summary"));
        }
        if paths.is_empty() && !amend {
            return Err(AppError::msg("Select at least one file to commit"));
        }
        if amend && self.undo_candidate().is_none() {
            return Err(AppError::msg("The last commit has already been pushed, so it cannot be amended here"));
        }
        // A plain reset would drop MERGE_HEAD, so a merge keeps whatever it staged.
        if !self.git_dir().join("MERGE_HEAD").exists() {
            let _ = self.run(&["reset", "-q"]);
        }
        if !paths.is_empty() {
            let input = paths.join("\0");
            self.run_stdin(&["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], input.as_bytes())?;
        }
        let mut args = vec!["commit", "-q", "-m", summary.trim()];
        if amend {
            args.push("--amend");
        }
        if !description.trim().is_empty() {
            args.push("-m");
            args.push(description.trim());
        }
        self.run(&args)?;
        Ok(())
    }

    /// Take back the tip commit, leaving its changes in the working tree.
    pub fn undo_commit(&self) -> Result<UndoneCommit> {
        if self.undo_candidate().is_none() {
            return Err(AppError::msg("The last commit has already been pushed, so it cannot be undone here"));
        }
        let message = self.run(&["log", "-1", "--format=%s%x1f%b"])?;
        let (summary, body) = message.split_once('\x1f').unwrap_or((message.as_str(), ""));
        if self.run(&["rev-parse", "--verify", "-q", "HEAD^"]).is_ok() {
            self.run(&["reset", "-q", "--soft", "HEAD^"])?;
        } else {
            self.run(&["update-ref", "-d", "HEAD"])?;
        }
        Ok(UndoneCommit { summary: summary.trim().to_string(), description: body.trim().to_string() })
    }

    /// Throw away working-tree changes. Files git does not know go to the OS trash.
    pub fn discard(&self, files: &[FileRef]) -> Result<()> {
        let has_head = self.has_commits();
        for file in files {
            let mut paths = vec![file.path.as_str()];
            if let Some(old) = file.old_path.as_deref() {
                paths.push(old);
            }
            for path in paths {
                if has_head {
                    let _ = self.run(&["reset", "-q", "--", path]);
                } else {
                    let _ = self.run(&["rm", "-q", "--cached", "--", path]);
                }
                let in_head = has_head && self.run(&["cat-file", "-e", &format!("HEAD:{path}")]).is_ok();
                if in_head {
                    self.run(&["checkout", "HEAD", "--", path])?;
                } else {
                    let full = self.dir.join(path);
                    if full.exists() {
                        crate::files::to_trash(&full).or_else(|_| std::fs::remove_file(&full)).map_err(|e| AppError::msg(format!("Could not remove {path}: {e}")))?;
                    }
                }
            }
        }
        Ok(())
    }

    // ---- history ------------------------------------------------------------

    pub fn log(&self, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        self.log_range(None, None, skip, limit)
    }

    /// The commits that touched one file, following it across renames.
    pub fn file_log(&self, path: &str, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        if path.is_empty() || path.starts_with('-') {
            return Err(AppError::msg("Not a file in this repository"));
        }
        // git applies `--skip` before `--follow` filters, so page here instead.
        Ok(self.log_range(None, Some(path), 0, skip + limit)?.into_iter().skip(skip).collect())
    }

    /// Comparing with another branch: the commits `branch` has that HEAD lacks (`ahead == false`, what a merge
    /// would bring in), or the ones HEAD has that `branch` lacks (`ahead == true`).
    pub fn compare_log(&self, branch: &str, ahead: bool, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        check_ref(branch)?;
        let range = if ahead { format!("{branch}..HEAD") } else { format!("HEAD..{branch}") };
        self.log_range(Some(&range), None, skip, limit)
    }

    /// How far HEAD is `(ahead, behind)` of `branch`.
    pub fn ahead_behind(&self, branch: &str) -> Result<(u32, u32)> {
        check_ref(branch)?;
        let out = self.run(&["rev-list", "--left-right", "--count", &format!("HEAD...{branch}"), "--"])?;
        let mut n = out.split_whitespace().map(|v| v.parse::<u32>().unwrap_or(0));
        Ok((n.next().unwrap_or(0), n.next().unwrap_or(0)))
    }

    /// `path`: only the commits that touched that one file, following renames.
    fn log_range(&self, range: Option<&str>, path: Option<&str>, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        if !self.has_commits() {
            return Ok(vec![]);
        }
        let unpushed: std::collections::HashSet<String> = self
            .run(&["rev-list", "--max-count=2000", "HEAD", "--not", "--remotes"])
            .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
            .unwrap_or_default();
        let n = format!("--max-count={limit}");
        let s = format!("--skip={skip}");
        let mut args = vec!["log", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%b%x1e", &n, &s];
        if let Some(range) = range {
            args.push(range);
        }
        if path.is_some() {
            args.push("--follow");
        }
        // `--` so a file that happens to share the branch's name cannot make the range ambiguous.
        if range.is_some() || path.is_some() {
            args.push("--");
        }
        if let Some(path) = path {
            args.push(path);
        }
        let out = self.run(&args)?;
        Ok(out
            .split('\x1e')
            .filter_map(|rec| {
                let rec = rec.trim_start_matches('\n');
                if rec.is_empty() {
                    return None;
                }
                let mut f = rec.split('\x1f');
                let hash = f.next()?.to_string();
                Some(Commit {
                    unpushed: unpushed.contains(&hash),
                    hash,
                    short_hash: f.next()?.to_string(),
                    author_name: f.next()?.to_string(),
                    author_email: f.next()?.to_string(),
                    date: f.next()?.to_string(),
                    parents: f.next()?.split_whitespace().map(String::from).collect(),
                    refs: f.next()?.split(", ").filter(|r| !r.is_empty()).map(String::from).collect(),
                    summary: f.next().unwrap_or("").to_string(),
                    body: f.next().unwrap_or("").trim().to_string(),
                })
            })
            .collect())
    }

    /// Files a commit changed, against its first parent.
    pub fn commit_files(&self, hash: &str) -> Result<Vec<FileChange>> {
        check_ref(hash)?;
        let parent = format!("{hash}^");
        let out = if self.run(&["rev-parse", "--verify", "-q", &parent]).is_ok() {
            self.run(&["diff", "--name-status", "-M", "-z", &parent, hash])?
        } else {
            self.run(&["diff-tree", "--no-commit-id", "--name-status", "-r", "-z", "--root", hash])?
        };
        let mut files = vec![];
        let mut tokens = out.split('\0').filter(|t| !t.is_empty());
        while let Some(code) = tokens.next() {
            let kind = code.as_bytes()[0];
            if kind == b'R' || kind == b'C' {
                let old = tokens.next().map(String::from);
                if let Some(path) = tokens.next() {
                    files.push(FileChange { path: path.to_string(), old_path: old, status: if kind == b'R' { "renamed" } else { "added" }.into() });
                }
            } else if let Some(path) = tokens.next() {
                let status = match kind {
                    b'A' => "added",
                    b'D' => "deleted",
                    _ => "modified",
                };
                files.push(FileChange { path: path.to_string(), old_path: None, status: status.into() });
            }
        }
        Ok(files)
    }

    // ---- branches -----------------------------------------------------------

    pub fn branches(&self) -> Result<Vec<Branch>> {
        let out = self.run(&[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(HEAD)%1f%(upstream:remotename)",
            "refs/heads",
            "refs/remotes",
        ])?;
        let rows: Vec<Vec<&str>> = out.lines().map(|line| line.split('\x1f').collect()).filter(|f: &Vec<&str>| f.len() >= 6).collect();
        // (remote, branch) of every remote branch, for `published`.
        let remotes: Vec<(&str, &str)> = rows.iter().filter(|f| f[0].starts_with("refs/remotes/") && !f[0].ends_with("/HEAD")).filter_map(|f| f[1].split_once('/')).collect();
        Ok(rows
            .iter()
            .filter_map(|f| {
                let is_remote = f[0].starts_with("refs/remotes/");
                if is_remote && (f[0].ends_with("/HEAD") || !f[1].contains('/')) {
                    return None;
                }
                let published = if is_remote {
                    None
                } else {
                    let same: Vec<&(&str, &str)> = remotes.iter().filter(|(_, branch)| *branch == f[1]).collect();
                    // An upstream of "." is another local branch, which says nothing about remotes.
                    let found = match f[5] {
                        "" | "." => Some(same.as_slice()).filter(|s| s.len() == 1).map(|s| s[0]),
                        remote => same.iter().copied().find(|(r, _)| *r == remote),
                    };
                    found.map(|(remote, branch)| format!("{remote}/{branch}"))
                };
                Some(Branch {
                    name: f[1].to_string(),
                    is_remote,
                    is_current: f[4] == "*",
                    upstream: Some(f[2].to_string()).filter(|s| !s.is_empty()),
                    published,
                    date: f[3].to_string(),
                })
            })
            .collect())
    }

    pub fn branch_create(&self, name: &str, start: Option<&str>) -> Result<()> {
        check_ref(name)?;
        let mut args = vec!["checkout", "-q", "-b", name];
        if let Some(start) = start {
            check_ref(start)?;
            args.push(start);
        }
        self.run(&args).map(|_| ())
    }

    /// Delete a branch on its remote. `name` is `remote/branch`.
    pub fn branch_delete_remote(&self, name: &str) -> Result<()> {
        check_ref(name)?;
        let (remote, branch) = name.split_once('/').ok_or_else(|| AppError::msg("That is not a remote branch"))?;
        self.run(&["push", "-q", remote, "--delete", branch]).map(|_| ())
    }

    pub fn branch_checkout(&self, name: &str, is_remote: bool) -> Result<()> {
        check_ref(name)?;
        if !is_remote {
            return self.run(&["checkout", "-q", name]).map(|_| ());
        }
        let local = name.split_once('/').map(|(_, b)| b).unwrap_or(name);
        if self.run(&["rev-parse", "--verify", "-q", &format!("refs/heads/{local}")]).is_ok() {
            self.run(&["checkout", "-q", local]).map(|_| ())
        } else {
            self.run(&["checkout", "-q", "-b", local, "--track", name]).map(|_| ())
        }
    }

    /// Delete a local branch, and with `remote` its copy on the remote (`Branch::published`)
    /// as well. The remote goes first, so a push that fails leaves everything as it was.
    pub fn branch_delete(&self, name: &str, force: bool, remote: bool) -> Result<()> {
        check_ref(name)?;
        if !remote {
            return self.run(&["branch", if force { "-D" } else { "-d" }, name]).map(|_| ());
        }
        let published = self.branches()?.into_iter().find(|b| !b.is_remote && b.name == name).and_then(|b| b.published);
        let Some(published) = published else {
            return Err(AppError::msg(format!("{name} is not on a remote")));
        };
        let (on, _) = published.split_once('/').ok_or_else(|| AppError::msg("That is not a remote branch"))?;
        check_ref(on)?;
        let local = format!("refs/heads/{name}");
        // `git branch -d` is content with a branch that is merged into its upstream, which is
        // about to go as well: ask instead whether any other branch has these commits.
        if !force {
            let (not_local, not_remote) = (format!("--exclude={name}"), format!("--exclude={published}"));
            let only_here = self.run(&["rev-list", "--max-count=1", &local, "--not", &not_local, "--branches", &not_remote, "--remotes"])?;
            if !only_here.trim().is_empty() {
                return Err(AppError::Git(format!("The branch '{name}' is not fully merged.")));
            }
        }
        // Git refuses to delete a branch a checkout has. Find that out before the remote is touched.
        if !self.run(&["for-each-ref", "--format=%(worktreepath)", &local])?.trim().is_empty() {
            return Err(AppError::msg(format!("{name} is checked out. Switch to another branch first.")));
        }
        match self.run(&["push", "-q", on, "--delete", &local]) {
            // Someone deleted it there since the last fetch: only our record of it is left.
            Err(AppError::Git(m)) if m.contains("remote ref does not exist") => {
                self.run(&["branch", "-q", "-d", "-r", &published])?;
            }
            other => {
                other?;
            }
        }
        self.run(&["branch", "-q", "-D", name]).map(|_| ())
    }

    pub fn branch_rename(&self, from: &str, to: &str) -> Result<()> {
        check_ref(from)?;
        check_ref(to)?;
        self.run(&["branch", "-m", from, to]).map(|_| ())
    }

    /// Merge `from` into the current branch. Conflicts leave the merge in progress.
    pub fn merge(&self, from: &str) -> Result<String> {
        check_ref(from)?;
        self.or_conflict(self.run(&["merge", "--no-edit", from]))
    }

    /// Replay the current branch on top of `onto`. Conflicts leave the rebase stopped.
    pub fn rebase(&self, onto: &str) -> Result<()> {
        check_ref(onto)?;
        self.or_conflict(self.run(&["rebase", onto])).map(|_| ())
    }

    /// Add a commit that undoes `hash`.
    pub fn revert(&self, hash: &str) -> Result<()> {
        check_ref(hash)?;
        self.or_conflict(self.run(&["revert", "--no-edit", hash])).map(|_| ())
    }

    /// Copy `hashes` onto the current branch, in the order given (oldest first). A conflict
    /// stops the cherry-pick at that commit; the rest follow on continue.
    pub fn cherry_pick(&self, hashes: &[String]) -> Result<()> {
        if hashes.is_empty() {
            return Err(AppError::msg("Choose at least one commit to cherry-pick"));
        }
        let mut args = vec!["cherry-pick"];
        for h in hashes {
            check_ref(h)?;
            args.push(h);
        }
        self.or_conflict(self.run(&args)).map(|_| ())
    }

    /// Bring every change of `from` into the current branch as one new commit. On conflicts the
    /// message is left in SQUASH_MSG for `op_continue`, and nothing is committed.
    pub fn merge_squash(&self, from: &str, message: &str) -> Result<()> {
        check_ref(from)?;
        if message.trim().is_empty() {
            return Err(AppError::msg("A squash merge needs a commit message"));
        }
        if self.operation().is_some() {
            return Err(AppError::msg("Finish or abort the operation in progress first"));
        }
        let merged = self.run(&["merge", "--squash", from]);
        if merged.is_err() {
            let _ = std::fs::write(self.git_dir().join("SQUASH_MSG"), message.trim());
            return self.or_conflict(merged).map(|_| ());
        }
        if self.run_ok(&["diff", "--cached", "--quiet"], &[]).is_ok() {
            return Err(AppError::msg(format!("{from} brings no changes that this branch does not already have")));
        }
        self.run_stdin(&["commit", "-q", "-F", "-"], message.trim().as_bytes()).map(|_| ())
    }

    /// The commits an interactive rebase on `upstream` would replay, oldest first: `upstream..HEAD`,
    /// or the whole branch from its first commit when `upstream` is None.
    pub fn rebase_plan(&self, upstream: Option<&str>) -> Result<Vec<Commit>> {
        if let Some(u) = upstream {
            check_ref(u)?;
        }
        let range = upstream.map(|u| format!("{u}..HEAD")).unwrap_or_else(|| "HEAD".into());
        let mut list = self.log_range(Some(&range), None, 0, REBASE_LIMIT + 1)?;
        if list.len() > REBASE_LIMIT {
            return Err(AppError::msg(format!("That is more than {REBASE_LIMIT} commits to rewrite. Start from a later commit.")));
        }
        list.reverse();
        Ok(list)
    }

    /// Rewrite `upstream..HEAD` (or the whole branch) as `steps` say: git's own `rebase -i`, with
    /// the todo list written by us instead of an editor. New messages are applied by an
    /// `exec git commit --amend` after the commit they belong to, so a stop for conflicts in
    /// between does not lose them. Conflicts leave the rebase stopped, as any rebase.
    pub fn rebase_interactive(&self, upstream: Option<&str>, steps: &[RebaseStep]) -> Result<()> {
        if self.operation().is_some() {
            return Err(AppError::msg("Finish or abort the operation in progress first"));
        }
        let plan = self.rebase_plan(upstream)?;
        let mut expected: Vec<&str> = plan.iter().map(|c| c.hash.as_str()).collect();
        let mut given: Vec<&str> = steps.iter().map(|s| s.hash.as_str()).collect();
        expected.sort_unstable();
        given.sort_unstable();
        if expected != given {
            return Err(AppError::msg("The branch changed since the list was made. Open it again."));
        }
        if plan.iter().any(|c| c.parents.len() > 1) {
            return Err(AppError::msg("These commits include a merge, which an interactive rebase would flatten. Start after the merge."));
        }

        let dir = self.git_dir().join("studio-rebase");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir)?;
        let todo = rebase_todo(steps, &dir)?;
        let todo_file = dir.join("todo");
        std::fs::write(&todo_file, todo)?;

        // Git starts the sequence editor through its shell (Git for Windows brings its own), with
        // the path of its todo file appended: copy ours over it.
        let editor = format!("cp {}", sh_quote(&todo_file)?);
        let mut c = base_command();
        c.current_dir(&self.dir).env("GIT_SEQUENCE_EDITOR", editor).args(["rebase", "-i", "--autostash"]);
        match upstream {
            Some(u) => c.arg(u),
            None => c.arg("--root"),
        };
        let result = self.or_conflict(exec(c, None, &[]));
        if result.is_ok() {
            let _ = std::fs::remove_dir_all(&dir);
        }
        result.map(|_| ())
    }

    /// Move the current branch to `hash`. `mode` is soft, mixed or hard.
    pub fn reset(&self, hash: &str, mode: &str) -> Result<()> {
        check_ref(hash)?;
        let flag = match mode {
            "soft" => "--soft",
            "mixed" => "--mixed",
            "hard" => "--hard",
            _ => return Err(AppError::msg("Unknown reset mode")),
        };
        self.run(&["reset", "-q", flag, hash]).map(|_| ())
    }

    pub fn checkout_commit(&self, hash: &str) -> Result<()> {
        check_ref(hash)?;
        self.run(&["checkout", "-q", "--detach", hash]).map(|_| ())
    }

    pub fn tag_create(&self, name: &str, hash: &str, push: bool) -> Result<()> {
        check_ref(name)?;
        check_ref(hash)?;
        self.run(&["tag", name, hash])?;
        if push {
            let remote = self.default_remote().ok_or_else(|| AppError::msg("The tag was created, but there is no remote to push it to"))?;
            self.run(&["push", "-q", &remote, &format!("refs/tags/{name}")])?;
        }
        Ok(())
    }

    pub fn tag_delete(&self, name: &str) -> Result<()> {
        check_ref(name)?;
        self.run(&["tag", "-d", name]).map(|_| ())
    }

    fn operation(&self) -> Option<&'static str> {
        operation_at(&self.git_dir(), !self.conflicted_paths().is_empty())
    }

    /// Give up on the merge, rebase, cherry-pick, revert or squash merge that is stopped half way.
    pub fn op_abort(&self) -> Result<()> {
        let op = self.operation().ok_or_else(|| AppError::msg("Nothing is in progress"))?;
        if op == "squash" {
            // A squash merge leaves no MERGE_HEAD; put the index and the files it touched back.
            self.run(&["reset", "-q", "--merge"])?;
            let _ = std::fs::remove_file(self.git_dir().join("SQUASH_MSG"));
            return Ok(());
        }
        self.run(&[op, "--abort"]).map(|_| ())
    }

    /// Stage everything as resolved and carry on with the stopped operation.
    pub fn op_continue(&self) -> Result<()> {
        let op = self.operation().ok_or_else(|| AppError::msg("Nothing is in progress"))?;
        self.run(&["add", "-A"])?;
        let result = match op {
            "merge" => self.run(&["commit", "-q", "--no-edit"]),
            "squash" => {
                let msg = self.git_dir().join("SQUASH_MSG");
                let text = std::fs::read_to_string(&msg).unwrap_or_default();
                self.run_stdin(&["commit", "-q", "--cleanup=strip", "-F", "-"], text.as_bytes())
            }
            _ => self.run(&[op, "--continue"]),
        };
        self.or_conflict(result).map(|_| ())
    }

    /// Settle a conflicted file by taking one side whole. `side` is mine or theirs.
    pub fn resolve(&self, path: &str, side: &str) -> Result<()> {
        // During a rebase git's "ours" is the branch being rebased onto, so the sides swap.
        let rebasing = self.operation() == Some("rebase");
        let flag = match (side, rebasing) {
            ("mine", false) | ("theirs", true) => "--ours",
            ("theirs", false) | ("mine", true) => "--theirs",
            _ => return Err(AppError::msg("Unknown side")),
        };
        self.run(&["checkout", flag, "--", path])?;
        self.run(&["add", "--", path]).map(|_| ())
    }

    // ---- stashes ------------------------------------------------------------

    pub fn stashes(&self) -> Vec<Stash> {
        self.run(&["stash", "list", "--format=%gd%x1f%gs%x1f%cI"])
            .map(|out| {
                out.lines()
                    .filter_map(|l| {
                        let mut f = l.split('\x1f');
                        Some(Stash { name: f.next()?.to_string(), message: f.next()?.to_string(), date: f.next().unwrap_or("").to_string() })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Shelve every change, untracked files included.
    pub fn stash_save(&self, message: &str) -> Result<()> {
        let mut args = vec!["stash", "push", "-q", "--include-untracked"];
        if !message.trim().is_empty() {
            args.push("-m");
            args.push(message.trim());
        }
        self.run_magic(&args).map(|_| ())
    }

    pub fn stash_pop(&self, name: &str) -> Result<()> {
        check_ref(name)?;
        self.or_conflict(self.run_magic(&["stash", "pop", "-q", name])).map(|_| ())
    }

    pub fn stash_drop(&self, name: &str) -> Result<()> {
        check_ref(name)?;
        self.run(&["stash", "drop", "-q", name]).map(|_| ())
    }

    /// Add a path to the repository's top-level .gitignore.
    pub fn ignore(&self, path: &str) -> Result<()> {
        let file = self.dir.join(".gitignore");
        let mut text = std::fs::read_to_string(&file).unwrap_or_default();
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&format!("/{path}\n"));
        std::fs::write(file, text)?;
        Ok(())
    }

    fn or_conflict(&self, result: Result<String>) -> Result<String> {
        match result {
            Err(AppError::Git(msg)) => {
                let conflicts = self.conflicted_paths();
                if conflicts.is_empty() {
                    Err(AppError::Git(msg))
                } else {
                    Err(AppError::Conflict(conflicts))
                }
            }
            other => other,
        }
    }

    // ---- remotes ------------------------------------------------------------

    pub fn fetch(&self) -> Result<()> {
        if self.default_remote().is_none() {
            return Ok(());
        }
        self.run(&["fetch", "--all", "--prune", "-q"]).map(|_| ())
    }

    /// The fetch the window runs by itself every few minutes. Nobody asked for it, so it may
    /// not ask for anything either: no password or passphrase window (git's askpass, ssh's,
    /// Git Credential Manager's sign-in), and it is stopped after `QUIET_FETCH_LIMIT` so a
    /// connection that hangs cannot hold up the fetch, pull or push the user starts next.
    /// Whatever needs an answer fails here and is asked by the fetch the user clicks.
    pub fn fetch_quiet(&self) -> Result<()> {
        if self.default_remote().is_none() {
            return Ok(());
        }
        let mut c = base_command();
        // An empty GIT_ASKPASS is git's "no askpass at all" (it also skips core.askPass and SSH_ASKPASS).
        c.env("GIT_ASKPASS", "").env("SSH_ASKPASS", "").env("SSH_ASKPASS_REQUIRE", "never").env("GCM_INTERACTIVE", "never");
        c.current_dir(&self.dir).args(["fetch", "--all", "--prune", "-q"]);
        let out = crate::host_cli::run(c, None, QUIET_FETCH_LIMIT, "git fetch")?;
        if out.ok {
            Ok(())
        } else {
            Err(AppError::Git(out.stderr.trim().to_string()))
        }
    }

    pub fn pull(&self) -> Result<()> {
        // Git refuses to pull diverged branches until told how; default to a merge like GitHub Desktop.
        let configured = self.run(&["config", "--get", "pull.rebase"]).is_ok() || self.run(&["config", "--get", "pull.ff"]).is_ok();
        let mut args = vec!["pull", "-q", "--no-edit"];
        if !configured {
            args.push("--no-rebase");
        }
        self.or_conflict(self.run(&args)).map(|_| ())
    }

    /// Push the current branch, publishing it (and setting upstream) when it has none.
    pub fn push(&self, force: bool) -> Result<()> {
        let remote = self.default_remote().ok_or_else(|| AppError::msg("This repository has no remote yet"))?;
        if self.run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).is_ok() {
            // With-lease refuses if the remote moved since our last fetch, so nobody else's work is lost.
            self.run(if force { &["push", "-q", "--force-with-lease"] } else { &["push", "-q"] }).map(|_| ())
        } else {
            let branch = self.run(&["symbolic-ref", "--short", "HEAD"]).map_err(|_| AppError::msg("Check out a branch before pushing"))?;
            self.run(&["push", "-q", "-u", &remote, branch.trim()]).map(|_| ())
        }
    }
}

/// The hosting service behind a remote, and the pages on it worth opening.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    /// github | azure | gitlab | bitbucket | other
    pub provider: String,
    pub name: String,
    /// The repository's page.
    pub web: String,
    /// Issues, or work items on Azure DevOps.
    pub issues: Option<String>,
    /// What this host calls its tasks: "Issues" or "Work items".
    pub issues_label: String,
    pub pulls: Option<String>,
    /// "Pull requests" or "Merge requests".
    pub pulls_label: String,
}

impl Host {
    /// The page that starts a pull request from `branch`.
    pub fn new_pull(&self, branch: &str) -> Option<String> {
        let b = encode(branch);
        match self.provider.as_str() {
            "github" => Some(format!("{}/compare/{b}?expand=1", self.web)),
            "azure" => Some(format!("{}/pullrequestcreate?sourceRef={b}", self.web)),
            "gitlab" => Some(format!("{}/-/merge_requests/new?merge_request%5Bsource_branch%5D={b}", self.web)),
            "bitbucket" => Some(format!("{}/pull-requests/new?source={b}", self.web)),
            _ => None,
        }
    }

    pub fn commit(&self, hash: &str) -> Option<String> {
        match self.provider.as_str() {
            "github" | "azure" => Some(format!("{}/commit/{hash}", self.web)),
            "gitlab" => Some(format!("{}/-/commit/{hash}", self.web)),
            "bitbucket" => Some(format!("{}/commits/{hash}", self.web)),
            _ => None,
        }
    }

    /// The page that shows `branch` (its name on the remote, without the remote prefix).
    pub fn branch(&self, branch: &str) -> Option<String> {
        let path = branch.split('/').map(encode).collect::<Vec<_>>().join("/");
        match self.provider.as_str() {
            "github" => Some(format!("{}/tree/{path}", self.web)),
            "azure" => Some(format!("{}?version=GB{}", self.web, encode(branch))),
            "gitlab" => Some(format!("{}/-/tree/{path}", self.web)),
            "bitbucket" => Some(format!("{}/branch/{path}", self.web)),
            _ => None,
        }
    }
}

fn encode(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

/// Split a remote URL into (host, path), dropping scheme, credentials, port and `.git`.
fn split_remote(remote: &str) -> Option<(String, String)> {
    let r = remote.trim().trim_end_matches('/');
    let r = r.strip_suffix(".git").unwrap_or(r);
    let (host, path) = if let Some((_, rest)) = r.split_once("://") {
        let rest = rest.rsplit_once('@').map(|(_, h)| h).unwrap_or(rest);
        let (host, path) = rest.split_once('/')?;
        (host.split(':').next()?, path)
    } else {
        // scp style: user@host:path
        let (left, path) = r.split_once(':')?;
        // `C:\repos\thing` and `C:/repos/thing` are folders on Windows, not a host called "c".
        if left.contains('/') || (left.len() == 1 && left.chars().all(|c| c.is_ascii_alphabetic())) {
            return None;
        }
        (left.rsplit_once('@').map(|(_, h)| h).unwrap_or(left), path)
    };
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some((host.to_ascii_lowercase(), path.trim_matches('/').to_string()))
}

/// Recognise where a remote lives from its URL alone. No network, no sign-in.
pub fn host(remote: &str) -> Option<Host> {
    let (host, path) = split_remote(remote)?;
    let make = |provider: &str, name: &str, web: String, issues: Option<String>, issues_label: &str, pulls: Option<String>, pulls_label: &str| Host {
        provider: provider.into(),
        name: name.into(),
        web,
        issues,
        issues_label: issues_label.into(),
        pulls,
        pulls_label: pulls_label.into(),
    };

    // Azure DevOps: dev.azure.com/org/project/_git/repo, ssh.dev.azure.com:v3/org/project/repo, org.visualstudio.com/project/_git/repo
    let azure = if host == "dev.azure.com" {
        let p: Vec<&str> = path.split('/').collect();
        match p.as_slice() {
            [org, project, "_git", repo] => Some((org.to_string(), project.to_string(), repo.to_string())),
            [org, "_git", repo] => Some((org.to_string(), repo.to_string(), repo.to_string())),
            _ => None,
        }
    } else if host == "ssh.dev.azure.com" || host == "vs-ssh.visualstudio.com" {
        let p: Vec<&str> = path.split('/').collect();
        match p.as_slice() {
            ["v3", org, project, repo] => Some((org.to_string(), project.to_string(), repo.to_string())),
            _ => None,
        }
    } else if let Some(org) = host.strip_suffix(".visualstudio.com") {
        let p: Vec<&str> = path.split('/').filter(|s| *s != "DefaultCollection").collect();
        match p.as_slice() {
            [project, "_git", repo] => Some((org.to_string(), project.to_string(), repo.to_string())),
            ["_git", repo] => Some((org.to_string(), repo.to_string(), repo.to_string())),
            _ => None,
        }
    } else {
        None
    };
    if let Some((org, project, repo)) = azure {
        let project_url = format!("https://dev.azure.com/{org}/{project}");
        let web = format!("{project_url}/_git/{repo}");
        return Some(make("azure", "Azure DevOps", web.clone(), Some(format!("{project_url}/_workitems/recentlyupdated")), "Work items", Some(format!("{web}/pullrequests")), "Pull requests"));
    }

    let web = format!("https://{host}/{path}");
    Some(if host == "github.com" || host.starts_with("github.") {
        make("github", "GitHub", web.clone(), Some(format!("{web}/issues")), "Issues", Some(format!("{web}/pulls")), "Pull requests")
    } else if host == "gitlab.com" || host.starts_with("gitlab.") {
        make("gitlab", "GitLab", web.clone(), Some(format!("{web}/-/issues")), "Issues", Some(format!("{web}/-/merge_requests")), "Merge requests")
    } else if host == "bitbucket.org" {
        make("bitbucket", "Bitbucket", web.clone(), Some(format!("{web}/issues")), "Issues", Some(format!("{web}/pull-requests")), "Pull requests")
    } else {
        make("other", &host, web, None, "Issues", None, "Pull requests")
    })
}

/// Where a repository lives and who it belongs to, for grouping the repository list.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Origin {
    /// github | azure | gitlab | bitbucket | other
    pub provider: String,
    /// "GitHub", "Azure DevOps", ... or the host name for anything else.
    pub label: String,
    /// The GitHub owner, Azure DevOps `org/project`, GitLab group (with subgroups), Bitbucket workspace.
    pub owner: String,
}

/// The `Origin` of a remote URL; `None` for a remote that is a folder.
pub fn origin(remote: &str) -> Option<Origin> {
    let h = host(remote)?;
    let rest = h.web.strip_prefix("https://")?;
    let segs: Vec<&str> = rest.split('/').skip(1).collect();
    let owner = if h.provider == "azure" {
        segs.iter().take(2).copied().collect::<Vec<_>>().join("/")
    } else {
        segs[..segs.len().saturating_sub(1)].join("/")
    };
    Some(Origin { provider: h.provider, label: h.name, owner })
}

/// The folder name a clone of `url` gets.
pub fn repo_name(url: &str) -> String {
    let u = url.trim().trim_end_matches(['/', '\\']);
    let u = u.strip_suffix(".git").unwrap_or(u);
    u.rsplit(['/', ':', '\\']).next().unwrap_or("repository").to_string()
}

/// The files of a checkout, for opening one by name.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileList {
    /// Repository-relative, sorted.
    pub paths: Vec<String>,
    /// The checkout has more files than were asked for.
    pub truncated: bool,
}

impl Git {
    /// Every file git knows or would add: tracked ones and new ones, nothing `.gitignore` leaves
    /// out. A tracked file that was deleted is still listed (the window knows those from the
    /// status); a submodule is a folder, not a file, and is left out.
    pub fn files(&self, limit: usize) -> Result<FileList> {
        // No `--deduplicate` (git 2.31): a conflicted file is listed once per stage, so that is done here.
        let out = self.run(&["ls-files", "--cached", "--others", "--exclude-standard", "-z"])?;
        let mut paths: Vec<String> = out.split('\0').filter(|p| !p.is_empty()).map(str::to_string).collect();
        paths.sort_unstable();
        paths.dedup();
        if self.dir.join(".gitmodules").is_file() {
            // `160000 <hash> <stage>\t<path>` is a submodule's entry.
            let staged = self.run(&["ls-files", "--stage", "-z"])?;
            let links: std::collections::HashSet<&str> = staged.split('\0').filter(|e| e.starts_with("160000 ")).filter_map(|e| e.split_once('\t').map(|(_, path)| path)).collect();
            paths.retain(|p| !links.contains(p.as_str()));
        }
        let truncated = paths.len() > limit;
        paths.truncate(limit);
        Ok(FileList { paths, truncated })
    }
}

/// How a search in files reads its text.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub match_case: bool,
    pub whole_word: bool,
    /// The text is an extended regular expression rather than itself.
    pub regex: bool,
}

/// One matching line. Columns count UTF-16 units from 1, as the editor does.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub path: String,
    pub line: u32,
    /// Where the line's first match starts.
    pub column: u32,
    /// The line to show: leading white space gone, and cut around the match when it is long.
    pub text: String,
    /// Where the first match starts in `text` (UTF-16 units from 0).
    pub start: u32,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub matches: Vec<SearchMatch>,
    /// There were more matching lines than were asked for.
    pub truncated: bool,
}

/// A matching line is shown in one row: this much of it at most, and this much before the match.
const SEARCH_TEXT: usize = 300;
const SEARCH_LEAD: usize = 60;

/// One record of `git grep -n --column -z`: `path NUL line NUL column NUL text`.
fn search_match(record: &[u8]) -> Option<SearchMatch> {
    let mut parts = record.splitn(4, |b| *b == 0);
    let path = String::from_utf8_lossy(parts.next()?).to_string();
    let line: u32 = std::str::from_utf8(parts.next()?).ok()?.parse().ok()?;
    let column: usize = std::str::from_utf8(parts.next()?).ok()?.parse().ok()?;
    let text = parts.next()?;
    // git counts bytes. Split there before decoding, so text that is not UTF-8 cannot move the match.
    let at = column.saturating_sub(1).min(text.len());
    let before = String::from_utf8_lossy(&text[..at]);
    let after = String::from_utf8_lossy(&text[at..]);
    let lead = before.trim_start();
    let lead: String = if lead.chars().count() > SEARCH_LEAD + 20 {
        let skip = lead.chars().count() - SEARCH_LEAD;
        std::iter::once('…').chain(lead.chars().skip(skip)).collect()
    } else {
        lead.to_string()
    };
    let rest: String = after.chars().take(SEARCH_TEXT.saturating_sub(lead.chars().count())).collect();
    Some(SearchMatch {
        path,
        line,
        column: before.encode_utf16().count() as u32 + 1,
        start: lead.encode_utf16().count() as u32,
        text: format!("{lead}{}", rest.trim_end()),
    })
}

impl Git {
    /// Find in files: `git grep` over the checkout's tracked files and its new ones, so `.gitignore`
    /// is respected and binary files are skipped. The text is one argument after `-e`, never part
    /// of a command line. Stops (and stops git) once `limit` matching lines are read.
    pub fn grep(&self, pattern: &str, options: &SearchOptions, limit: usize) -> Result<SearchResult> {
        if pattern.is_empty() {
            return Ok(SearchResult::default());
        }
        if pattern.contains(['\n', '\r', '\0']) {
            return Err(AppError::msg("A search is one line of text"));
        }
        let mut c = base_command();
        c.current_dir(&self.dir).args(["grep", "--untracked", "--no-color", "-n", "--column", "-I", "-z"]);
        if !options.match_case {
            c.arg("-i");
        }
        if options.whole_word {
            c.arg("-w");
        }
        c.arg(if options.regex { "-E" } else { "-F" }).arg("-e").arg(pattern);
        let mut child = c.spawn().map_err(|e| AppError::Git(format!("could not run git: {e}")))?;
        let stdout = child.stdout.take().ok_or_else(|| AppError::msg("git gave no output"))?;
        let stderr = child.stderr.take();
        let mut result = SearchResult::default();
        // What git says goes wrong is read beside the matches: a pipe nobody reads fills up and stalls git.
        let complaint = std::thread::scope(|scope| {
            let errors = scope.spawn(move || {
                let mut text = String::new();
                if let Some(mut pipe) = stderr {
                    let _ = std::io::Read::read_to_string(&mut pipe, &mut text);
                }
                text
            });
            let mut reader = std::io::BufReader::new(stdout);
            let mut record = Vec::new();
            loop {
                record.clear();
                match std::io::BufRead::read_until(&mut reader, b'\n', &mut record) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
                while matches!(record.last(), Some(b'\n' | b'\r')) {
                    record.pop();
                }
                let Some(found) = search_match(&record) else { continue };
                if result.matches.len() == limit {
                    result.truncated = true;
                    crate::proc::kill_tree(&mut child);
                    break;
                }
                result.matches.push(found);
            }
            drop(reader);
            errors.join().unwrap_or_default()
        });
        let status = child.wait()?;
        // 1 is git's "nothing matched". After we stopped it ourselves the code means nothing.
        if result.truncated || status.success() || status.code() == Some(1) {
            return Ok(result);
        }
        let complaint = complaint.trim();
        let complaint = complaint.strip_prefix("fatal: ").unwrap_or(complaint);
        // "-e option, '(': parentheses not balanced": the part after the pattern is the reason.
        Err(AppError::Git(match complaint.rsplit_once("': ") {
            Some((_, reason)) if options.regex => format!("Not a regular expression: {reason}"),
            _ if complaint.is_empty() => "The search failed".into(),
            _ => complaint.to_string(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git(dir: &Path, args: &[&str]) {
        Git::at(dir).run(args).unwrap();
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Git::init(&dir).unwrap();
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "commit.gpgsign", "false"]);
        // Git for Windows turns LF into CRLF on checkout by default; the tests compare file contents.
        git(&dir, &["config", "core.autocrlf", "false"]);
        dir
    }

    #[test]
    fn a_file_as_it_was_at_a_commit() {
        let dir = scratch("file-at");
        let g = Git::at(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src").join(ODD), "one\n").unwrap();
        std::fs::write(dir.join("data.bin"), [0u8, 159, 146, 150]).unwrap();
        g.commit(&[format!("src/{ODD}"), "data.bin".into()], "One", "", false).unwrap();
        let first = g.run(&["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(dir.join("src").join(ODD), "two\n").unwrap();
        g.commit(&[format!("src/{ODD}")], "Two", "", false).unwrap();
        // What is on disk since does not matter.
        std::fs::write(dir.join("src").join(ODD), "three\n").unwrap();

        assert_eq!(g.file_at(&first, &format!("src/{ODD}")).unwrap().text, "one\n");
        assert_eq!(g.file_at("HEAD", &format!("src/{ODD}")).unwrap().text, "two\n");
        let binary = g.file_at("HEAD", "data.bin").unwrap();
        assert!(binary.binary && binary.text.is_empty() && binary.size == 4);
        assert!(g.file_at("HEAD", "src/missing.txt").is_err());
        assert!(g.file_at("--output=x", "data.bin").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_identity_overrides_and_reverts() {
        let dir = scratch("identity");
        let g = Git::at(&dir);
        // `scratch` gives every test repository its own identity.
        assert_eq!(g.local_identity(), Some(Identity { name: "Test".into(), email: "test@example.com".into() }));
        g.set_local_identity(Some(&Identity { name: "  Other Person ".into(), email: "other@example.com".into() })).unwrap();
        assert_eq!(g.local_identity().unwrap().name, "Other Person");
        assert!(g.set_local_identity(Some(&Identity { name: "Name".into(), email: String::new() })).is_err());
        assert!(g.set_local_identity(Some(&Identity { name: "--global".into(), email: "a@b.c".into() })).is_err());
        assert!(g.set_local_identity(Some(&Identity { name: "a\nb".into(), email: "a@b.c".into() })).is_err());
        g.set_local_identity(None).unwrap();
        assert_eq!(g.local_identity(), None);
        // Removing it again is not an error.
        g.set_local_identity(None).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A file name full of pathspec magic. `*` cannot be in a file name on Windows; brackets can.
    const ODD: &str = if cfg!(windows) { "b [1].txt" } else { "b *.txt" };

    #[test]
    fn file_history_follows_renames() {
        let dir = scratch("file-log");
        let g = Git::at(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("other.txt"), "x\n").unwrap();
        g.commit(&["a.txt".into(), "other.txt".into()], "add", "", false).unwrap();
        std::fs::write(dir.join("other.txt"), "y\n").unwrap();
        g.commit(&["other.txt".into()], "other only", "", false).unwrap();
        git(&dir, &["mv", "a.txt", ODD]);
        g.commit(&["a.txt".into(), ODD.into()], "rename", "", false).unwrap();
        let subjects: Vec<String> = g.file_log(ODD, 0, 50).unwrap().into_iter().map(|c| c.summary).collect();
        assert_eq!(subjects, ["rename", "add"]);
        assert_eq!(g.file_log(ODD, 1, 50).unwrap().len(), 1);
        assert!(g.file_log("--all", 0, 50).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn compare_with_branch() {
        let dir = scratch("compare");
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-m", "base"]);
        git(&dir, &["branch", "other"]);
        std::fs::write(dir.join("b.txt"), "b").unwrap();
        git(&dir, &["add", "b.txt"]);
        git(&dir, &["commit", "-m", "mine"]);
        git(&dir, &["checkout", "-q", "other"]);
        for n in ["one", "two"] {
            std::fs::write(dir.join(format!("{n}.txt")), n).unwrap();
            git(&dir, &["add", "."]);
            git(&dir, &["commit", "-m", n]);
        }
        git(&dir, &["checkout", "-q", "-"]);
        // A file named like the branch must not turn the range into a path.
        std::fs::write(dir.join("other"), "x").unwrap();
        let g = Git::at(&dir);
        assert_eq!(g.ahead_behind("other").unwrap(), (1, 2));
        let behind: Vec<String> = g.compare_log("other", false, 0, 50).unwrap().into_iter().map(|c| c.summary).collect();
        assert_eq!(behind, ["two", "one"]);
        let ahead: Vec<String> = g.compare_log("other", true, 0, 50).unwrap().into_iter().map(|c| c.summary).collect();
        assert_eq!(ahead, ["mine"]);
        assert!(g.compare_log("--all", false, 0, 50).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn remote_default_branch() {
        let dir = scratch("default-branch");
        std::fs::write(dir.join("a.txt"), "a").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-m", "first"]);
        let g = Git::at(&dir);
        assert_eq!(g.remote_default_branch("origin"), None);
        git(&dir, &["update-ref", "refs/remotes/origin/master", "HEAD"]);
        assert_eq!(g.remote_default_branch("origin").as_deref(), Some("master"));
        git(&dir, &["update-ref", "refs/remotes/origin/develop", "HEAD"]);
        git(&dir, &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
        assert_eq!(g.remote_default_branch("origin").as_deref(), Some("develop"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn web_urls() {
        let gh = host("git@github.com:owner/repo.git").unwrap();
        assert_eq!((gh.provider.as_str(), gh.web.as_str()), ("github", "https://github.com/owner/repo"));
        assert_eq!(gh.issues.as_deref(), Some("https://github.com/owner/repo/issues"));
        assert_eq!(gh.new_pull("feature/a b").as_deref(), Some("https://github.com/owner/repo/compare/feature%2Fa%20b?expand=1"));
        assert_eq!(gh.branch("feature/a b").as_deref(), Some("https://github.com/owner/repo/tree/feature/a%20b"));
        assert_eq!(host("https://user:tok@github.com/owner/repo.git").unwrap().web, "https://github.com/owner/repo");

        let az = "https://dev.azure.com/org/Proj/_git/repo";
        for url in ["https://org@dev.azure.com/org/Proj/_git/repo", "git@ssh.dev.azure.com:v3/org/Proj/repo", "https://org.visualstudio.com/DefaultCollection/Proj/_git/repo"] {
            let h = host(url).unwrap();
            assert_eq!((h.provider.as_str(), h.web.as_str()), ("azure", az), "{url}");
            assert_eq!(h.issues.as_deref(), Some("https://dev.azure.com/org/Proj/_workitems/recentlyupdated"));
            assert_eq!(h.issues_label, "Work items");
        }

        let gl = host("https://gitlab.com/group/sub/repo.git").unwrap();
        assert_eq!(gl.pulls.as_deref(), Some("https://gitlab.com/group/sub/repo/-/merge_requests"));
        assert_eq!(host("git@bitbucket.org:team/repo.git").unwrap().provider, "bitbucket");

        let other = host("ssh://git@host.example:2222/owner/repo.git").unwrap();
        assert_eq!((other.provider.as_str(), other.web.as_str(), other.issues.is_none()), ("other", "https://host.example/owner/repo", true));
        assert_eq!(host("/local/path"), None);
        assert_eq!(host(r"C:\repos\thing.git"), None, "a drive letter is not a host");
        assert_eq!(host("C:/repos/thing.git"), None);
        assert_eq!(host("file:///srv/git/thing.git"), None);
        assert_eq!(repo_name("git@github.com:owner/repo.git"), "repo");
        assert_eq!(repo_name("https://github.com/owner/thing/"), "thing");
        assert_eq!(repo_name(r"C:\repos\thing.git"), "thing");
        assert_eq!(repo_name(r"C:\repos\thing\"), "thing");
    }

    #[test]
    fn origins_group_by_owner() {
        let o = |url: &str| origin(url).map(|o| (o.provider, o.label, o.owner));
        let t = |p: &str, l: &str, w: &str| Some((p.to_string(), l.to_string(), w.to_string()));
        assert_eq!(o("git@github.com:MelodicDevelopment/studio.git"), t("github", "GitHub", "MelodicDevelopment"));
        assert_eq!(o("git@ssh.dev.azure.com:v3/org/Proj/repo"), t("azure", "Azure DevOps", "org/Proj"));
        assert_eq!(o("https://org.visualstudio.com/DefaultCollection/Proj/_git/repo"), t("azure", "Azure DevOps", "org/Proj"));
        assert_eq!(o("https://gitlab.com/group/sub/repo.git"), t("gitlab", "GitLab", "group/sub"));
        assert_eq!(o("git@bitbucket.org:team/repo.git"), t("bitbucket", "Bitbucket", "team"));
        assert_eq!(o("ssh://git@host.example:2222/repo.git"), t("other", "host.example", ""));
        assert_eq!(o("/srv/git/thing.git"), None);
    }

    #[test]
    fn origin_url_prefers_origin() {
        let dir = scratch("origin-url");
        let g = Git::at(&dir);
        assert_eq!(g.origin_url(), None);
        git(&dir, &["remote", "add", "fork", "git@github.com:me/x.git"]);
        assert_eq!(g.origin_url().as_deref(), Some("git@github.com:me/x.git"));
        git(&dir, &["remote", "add", "origin", "git@github.com:team/x.git"]);
        assert_eq!(g.origin_url().as_deref(), Some("git@github.com:team/x.git"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn commit_only_selected_then_undo_and_discard() {
        let dir = scratch("flow");
        let g = Git::at(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join(ODD), "two\n").unwrap();

        let st = g.status().unwrap();
        assert!(!st.has_commits);
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().all(|f| f.status == "untracked"));
        assert!(g.diff_worktree("a.txt", None, "untracked").unwrap().text.contains("+one"));

        g.commit(&["a.txt".into()], "Add a", "", false).unwrap();
        let st = g.status().unwrap();
        assert!(st.has_commits);
        assert_eq!(st.files.len(), 1, "only the unselected file is left");
        assert_eq!(st.files[0].path, ODD);
        assert_eq!(st.undo.as_ref().map(|u| u.summary.as_str()), Some("Add a"));

        g.commit(&[ODD.into()], "Add b", "Body text", false).unwrap();
        let log = g.log(0, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "Add b");
        assert_eq!(log[0].body, "Body text");
        assert!(log[0].unpushed);
        let files = g.commit_files(&log[0].hash).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "added");
        assert!(g.diff_commit(&log[0].hash, ODD, None).unwrap().text.contains("+two"));
        assert_eq!(g.commit_files(&log[1].hash).unwrap()[0].path, "a.txt", "root commit lists its files");

        let undone = g.undo_commit().unwrap();
        assert_eq!(undone.summary, "Add b");
        assert_eq!(undone.description, "Body text");
        assert_eq!(g.log(0, 10).unwrap().len(), 1);

        // Modify a tracked file and discard both it and the (now staged-new) file.
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        let st = g.status().unwrap();
        assert_eq!(st.files.len(), 2);
        assert!(g.diff_worktree("a.txt", None, "modified").unwrap().text.contains("+changed"));
        g.discard(&[FileRef { path: "a.txt".into(), old_path: None }, FileRef { path: ODD.into(), old_path: None }]).unwrap();
        assert!(g.status().unwrap().files.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join(ODD).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn toplevel_is_spelled_natively() {
        let dir = scratch("toplevel");
        std::fs::create_dir_all(dir.join("deep").join("er")).unwrap();
        let top = Git::toplevel(&dir.join("deep").join("er")).unwrap();
        // Git prints its own idea of the path (forward slashes on Windows, the real path
        // behind a symlinked temp dir on macOS); it must name the same folder all the same.
        assert!(crate::paths::same(&top, &dir), "{} is {}", top.display(), dir.display());
        let text = top.to_string_lossy();
        assert_eq!(text.contains('/'), !cfg!(windows), "{text}");
        assert_eq!(crate::paths::native(&top), top);
        assert!(Git::toplevel(&std::env::temp_dir().join("studio-test-no-such-folder")).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn long_stdin_does_not_stall() {
        let dir = scratch("stdin");
        let g = Git::at(&dir);
        std::fs::write(dir.join(".gitignore"), "*.tmp\n").unwrap();
        // About a megabyte in and as much out: far more than any pipe holds, so this only
        // finishes if input is written while output is read.
        let paths: Vec<String> = (0..20_000).map(|i| format!("some/folder/with/a/long/name/file-number-{i}.tmp")).collect();
        let ignored = g.ignored(&paths);
        assert_eq!(ignored.len(), paths.len());
        assert_eq!(ignored[19_999], paths[19_999]);
        assert!(g.ignored(&["kept.txt".to_string()]).is_empty());
        assert!(g.ignored(&[]).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stash_amend_revert_reset_tag() {
        let dir = scratch("ops");
        let g = Git::at(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        g.commit(&["a.txt".into()], "One", "", false).unwrap();

        std::fs::write(dir.join("a.txt"), "two\n").unwrap();
        std::fs::write(dir.join("new.txt"), "n\n").unwrap();
        g.stash_save("wip").unwrap();
        let st = g.status().unwrap();
        assert!(st.files.is_empty());
        assert_eq!(st.stashes.len(), 1);
        assert!(st.stashes[0].message.contains("wip"));
        g.stash_pop(&st.stashes[0].name).unwrap();
        assert_eq!(g.status().unwrap().files.len(), 2);

        g.commit(&["a.txt".into(), "new.txt".into()], "Two", "", false).unwrap();
        g.commit(&[], "Two, reworded", "", true).unwrap();
        let log = g.log(0, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "Two, reworded");

        g.tag_create("v1", &log[0].hash, false).unwrap();
        assert!(g.log(0, 1).unwrap()[0].refs.iter().any(|r| r == "tag: v1"));
        g.tag_delete("v1").unwrap();

        g.revert(&log[0].hash).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert_eq!(g.log(0, 10).unwrap().len(), 3);

        g.reset(&log[1].hash, "hard").unwrap();
        assert_eq!(g.log(0, 10).unwrap().len(), 1);
        assert!(g.reset(&log[1].hash, "bogus").is_err());

        g.ignore("scratch.log").unwrap();
        std::fs::write(dir.join("scratch.log"), "x").unwrap();
        let files = g.status().unwrap().files;
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, ".gitignore");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rebase_conflict_resolve_and_continue() {
        let dir = scratch("rebase");
        let g = Git::at(&dir);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        g.commit(&["f.txt".into()], "Base", "", false).unwrap();
        g.branch_create("topic", None).unwrap();
        std::fs::write(dir.join("f.txt"), "topic\n").unwrap();
        g.commit(&["f.txt".into()], "Topic", "", false).unwrap();
        g.branch_checkout("main", false).unwrap();
        std::fs::write(dir.join("f.txt"), "main\n").unwrap();
        g.commit(&["f.txt".into()], "Main", "", false).unwrap();
        g.branch_checkout("topic", false).unwrap();

        assert!(matches!(g.rebase("main"), Err(AppError::Conflict(_))));
        assert_eq!(g.status().unwrap().operation.as_deref(), Some("rebase"));
        g.resolve("f.txt", "mine").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "topic\n", "mine is the branch being rebased");
        g.op_continue().unwrap();
        let st = g.status().unwrap();
        assert_eq!(st.operation, None);
        assert_eq!(g.log(0, 10).unwrap().len(), 3);

        // And abort puts everything back.
        g.branch_checkout("main", false).unwrap();
        g.branch_create("other", Some("HEAD~1")).unwrap();
        std::fs::write(dir.join("f.txt"), "other\n").unwrap();
        g.commit(&["f.txt".into()], "Other", "", false).unwrap();
        assert!(matches!(g.merge("main"), Err(AppError::Conflict(_))));
        g.op_abort().unwrap();
        assert_eq!(g.status().unwrap().operation, None);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn branches_merge_and_conflict() {
        let dir = scratch("branches");
        let g = Git::at(&dir);
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        g.commit(&["f.txt".into()], "Base", "", false).unwrap();

        g.branch_create("feature", None).unwrap();
        std::fs::write(dir.join("f.txt"), "feature\n").unwrap();
        g.commit(&["f.txt".into()], "Feature change", "", false).unwrap();

        g.branch_checkout("main", false).unwrap();
        let branches = g.branches().unwrap();
        assert_eq!(branches.len(), 2);
        assert!(branches.iter().any(|b| b.name == "main" && b.is_current));

        std::fs::write(dir.join("f.txt"), "main\n").unwrap();
        g.commit(&["f.txt".into()], "Main change", "", false).unwrap();

        match g.merge("feature") {
            Err(AppError::Conflict(paths)) => assert_eq!(paths, vec!["f.txt".to_string()]),
            other => panic!("expected a conflict, got {other:?}"),
        }
        let st = g.status().unwrap();
        assert!(st.merge_in_progress);
        assert_eq!(st.files[0].status, "conflicted");

        // Resolve by editing the file, then commit: the merge must survive the commit path.
        std::fs::write(dir.join("f.txt"), "resolved\n").unwrap();
        g.commit(&["f.txt".into()], "Merge feature", "", false).unwrap();
        let st = g.status().unwrap();
        assert!(!st.merge_in_progress);
        assert!(st.files.is_empty());
        assert_eq!(g.log(0, 10).unwrap()[0].parents.len(), 2);

        assert!(g.branch_create("-bad", None).is_err());
        g.branch_rename("feature", "feature-2").unwrap();
        g.branch_delete("feature-2", false, false).unwrap();
        assert_eq!(g.branches().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_quiet_fetch_brings_what_the_remote_has() {
        let dir = scratch("fetch-quiet");
        let g = Git::at(&dir);
        // No remote: nothing to do, and nothing wrong.
        g.fetch_quiet().unwrap();
        assert!(g.status().unwrap().last_fetched.is_none());

        let bare = remote_for(&dir, "origin");
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        g.commit(&["f.txt".into()], "Base", "", false).unwrap();
        let main = g.run(&["symbolic-ref", "--short", "HEAD"]).unwrap().trim().to_string();
        git(&dir, &["push", "-q", "-u", "origin", &main]);

        // Someone else pushes a commit.
        let other = dir.with_file_name(format!("{}-other", dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&other);
        git(&dir, &["clone", "-q", &bare.to_string_lossy(), &other.to_string_lossy()]);
        git(&other, &["config", "user.name", "Other"]);
        git(&other, &["config", "user.email", "other@example.com"]);
        git(&other, &["config", "commit.gpgsign", "false"]);
        git(&other, &["checkout", "-q", &main]);
        std::fs::write(other.join("f.txt"), "theirs\n").unwrap();
        Git::at(&other).commit(&["f.txt".into()], "Theirs", "", false).unwrap();
        git(&other, &["push", "-q", "origin", &main]);

        assert_eq!(g.status().unwrap().behind, 0);
        g.fetch_quiet().unwrap();
        let st = g.status().unwrap();
        assert_eq!(st.behind, 1);
        assert!(st.last_fetched.is_some());

        // A remote that cannot be reached is an error, said in git's words, not a wait.
        git(&dir, &["remote", "set-url", "origin", &dir.join("no-such-remote").to_string_lossy()]);
        assert!(matches!(g.fetch_quiet(), Err(AppError::Git(m)) if !m.is_empty()));

        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::remove_dir_all(&bare);
        let _ = std::fs::remove_dir_all(&other);
    }

    /// A second repository to push to, added as `name`.
    fn remote_for(dir: &Path, name: &str) -> PathBuf {
        let bare = dir.with_file_name(format!("{}-{name}.git", dir.file_name().unwrap().to_string_lossy()));
        let _ = std::fs::remove_dir_all(&bare);
        std::fs::create_dir_all(&bare).unwrap();
        git(&bare, &["init", "-q", "--bare"]);
        git(dir, &["remote", "add", name, &bare.to_string_lossy()]);
        bare
    }

    #[test]
    fn deleting_a_branch_on_the_remote_too() {
        let dir = scratch("delete-published");
        let g = Git::at(&dir);
        let bare = remote_for(&dir, "origin");
        std::fs::write(dir.join("f.txt"), "base\n").unwrap();
        g.commit(&["f.txt".into()], "Base", "", false).unwrap();
        let main = g.run(&["symbolic-ref", "--short", "HEAD"]).unwrap().trim().to_string();
        git(&dir, &["push", "-q", "-u", "origin", &main]);
        let published = |name: &str| g.branches().unwrap().into_iter().find(|b| !b.is_remote && b.name == name).unwrap().published;
        let on_remote = |name: &str| Git::at(&bare).run(&["rev-parse", "--verify", "-q", &format!("refs/heads/{name}")]).is_ok();

        // Pushed with an upstream, and with commits nothing else has.
        g.branch_create("feature/one", None).unwrap();
        file_commit(&g, &dir, "one.txt", "one\n", "One");
        git(&dir, &["push", "-q", "-u", "origin", "feature/one"]);
        // Never pushed, but following the trunk: that is not its own branch on the remote.
        git(&dir, &["checkout", "-q", "-b", "local-only", "--track", &format!("origin/{main}")]);
        // Pushed without an upstream.
        git(&dir, &["checkout", "-q", "-b", "plain", &main]);
        git(&dir, &["push", "-q", "origin", "plain"]);
        g.branch_checkout(&main, false).unwrap();

        assert_eq!(published(&main), Some(format!("origin/{main}")));
        assert_eq!(published("feature/one").as_deref(), Some("origin/feature/one"));
        assert_eq!(published("local-only"), None);
        assert_eq!(published("plain").as_deref(), Some("origin/plain"));
        assert!(g.branches().unwrap().iter().filter(|b| b.is_remote).all(|b| b.published.is_none()));

        // Nothing to delete on a remote, and the trunk is not touched.
        assert!(g.branch_delete("local-only", false, true).is_err());
        assert!(on_remote(&main) && published("local-only").is_none());

        // `git branch -d` would allow this (merged into its upstream); with the remote going too it is the only copy.
        let err = g.branch_delete("feature/one", false, true).unwrap_err();
        assert!(err.to_string().contains("not fully merged"), "{err}");
        assert!(on_remote("feature/one") && published("feature/one").is_some());

        // The checked-out branch is refused before the remote is touched.
        g.branch_checkout("plain", false).unwrap();
        assert!(g.branch_delete("plain", false, true).is_err());
        assert!(on_remote("plain"));
        g.branch_checkout(&main, false).unwrap();

        g.branch_delete("plain", false, true).unwrap();
        assert!(!on_remote("plain"));
        g.branch_delete("feature/one", true, true).unwrap();
        assert!(!on_remote("feature/one"));
        let left: Vec<String> = g.branches().unwrap().into_iter().map(|b| b.name).collect();
        assert!(!left.iter().any(|n| n.contains("feature/one") || n.contains("plain")), "{left:?}");

        // Deleted on the remote by someone else since the last fetch: our stale record goes, then the branch.
        g.branch_create("stale", None).unwrap();
        git(&dir, &["push", "-q", "-u", "origin", "stale"]);
        g.branch_checkout(&main, false).unwrap();
        git(&bare, &["update-ref", "-d", "refs/heads/stale"]);
        g.branch_delete("stale", false, true).unwrap();
        assert!(!g.branches().unwrap().iter().any(|b| b.name.contains("stale")));

        // The same name on two remotes and no upstream: which one is meant is unknown.
        let second = remote_for(&dir, "backup");
        g.branch_create("both", None).unwrap();
        git(&dir, &["push", "-q", "origin", "both"]);
        git(&dir, &["push", "-q", "backup", "both"]);
        assert_eq!(published("both"), None);
        git(&dir, &["branch", "-q", "--set-upstream-to=backup/both", "both"]);
        assert_eq!(published("both").as_deref(), Some("backup/both"));

        for d in [&dir, &bare, &second] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    fn step(hash: &str, action: &str, message: Option<&str>) -> RebaseStep {
        RebaseStep { hash: hash.into(), action: action.into(), message: message.map(String::from) }
    }

    fn file_commit(g: &Git, dir: &Path, name: &str, text: &str, summary: &str) {
        std::fs::write(dir.join(name), text).unwrap();
        g.commit(&[name.into()], summary, "", false).unwrap();
    }

    fn summaries(g: &Git) -> Vec<String> {
        g.log(0, 50).unwrap().into_iter().map(|c| c.summary).collect()
    }

    #[test]
    fn cherry_pick_several_and_squash_merge() {
        let dir = scratch("pick-squash");
        let g = Git::at(&dir);
        file_commit(&g, &dir, "base.txt", "base\n", "Base");
        g.branch_create("topic", None).unwrap();
        file_commit(&g, &dir, "a.txt", "a\n", "Add a");
        file_commit(&g, &dir, "b.txt", "b\n", "Add b");
        file_commit(&g, &dir, "c.txt", "c\n", "Add c");
        let topic: Vec<String> = g.log(0, 3).unwrap().into_iter().map(|c| c.hash).collect();

        g.branch_checkout("main", false).unwrap();
        g.branch_create("picked", None).unwrap();
        // Oldest first, as the UI sends them: a then c.
        g.cherry_pick(&[topic[2].clone(), topic[0].clone()]).unwrap();
        assert_eq!(summaries(&g), ["Add c", "Add a", "Base"]);
        assert!(g.cherry_pick(&[]).is_err());

        g.branch_checkout("main", false).unwrap();
        g.merge_squash("topic", "Topic in one\n\nEverything from topic.").unwrap();
        let log = g.log(0, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "Topic in one");
        assert_eq!(log[0].body, "Everything from topic.");
        assert_eq!(log[0].parents.len(), 1, "a squash merge is an ordinary commit");
        assert!(g.status().unwrap().files.is_empty());
        assert!(g.merge_squash("topic", "Again").is_err(), "nothing left to bring in");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn squash_merge_conflict_continue_and_abort() {
        let dir = scratch("squash-conflict");
        let g = Git::at(&dir);
        file_commit(&g, &dir, "f.txt", "base\n", "Base");
        g.branch_create("topic", None).unwrap();
        file_commit(&g, &dir, "f.txt", "topic\n", "Topic");
        g.branch_checkout("main", false).unwrap();
        file_commit(&g, &dir, "f.txt", "main\n", "Main");

        assert!(matches!(g.merge_squash("topic", "Squashed topic"), Err(AppError::Conflict(_))));
        assert_eq!(g.status().unwrap().operation.as_deref(), Some("squash"));
        g.op_abort().unwrap();
        let st = g.status().unwrap();
        assert_eq!(st.operation, None);
        assert!(st.files.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("f.txt")).unwrap(), "main\n");

        assert!(matches!(g.merge_squash("topic", "Squashed topic"), Err(AppError::Conflict(_))));
        std::fs::write(dir.join("f.txt"), "both\n").unwrap();
        g.op_continue().unwrap();
        assert_eq!(g.status().unwrap().operation, None);
        assert_eq!(summaries(&g)[0], "Squashed topic");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn interactive_rebase_reorder_drop_squash_reword() {
        let dir = scratch("rebase-i");
        let g = Git::at(&dir);
        file_commit(&g, &dir, "base.txt", "base\n", "Base");
        file_commit(&g, &dir, "a.txt", "a\n", "Add a");
        file_commit(&g, &dir, "b.txt", "b\n", "Add b");
        file_commit(&g, &dir, "c.txt", "c\n", "Add c");
        file_commit(&g, &dir, "d.txt", "d\n", "Add d");
        file_commit(&g, &dir, "e.txt", "e\n", "Add e");

        let base = g.log(0, 10).unwrap().last().unwrap().hash.clone();
        let plan = g.rebase_plan(Some(&base)).unwrap();
        let names: Vec<&str> = plan.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(names, ["Add a", "Add b", "Add c", "Add d", "Add e"], "oldest first");
        let h = |i: usize| plan[i].hash.clone();

        // e first and reworded, a + c squashed with a new message, d fixed up into it, b dropped.
        let steps = vec![
            step(&h(4), "reword", Some("Add e first")),
            step(&h(0), "pick", Some("A and c\n\nTogether.")),
            step(&h(2), "squash", None),
            step(&h(3), "fixup", None),
            step(&h(1), "drop", None),
        ];
        g.rebase_interactive(Some(&base), &steps).unwrap();
        assert_eq!(g.status().unwrap().operation, None);
        let log = g.log(0, 10).unwrap();
        let names: Vec<&str> = log.iter().map(|c| c.summary.as_str()).collect();
        assert_eq!(names, ["A and c", "Add e first", "Base"]);
        assert_eq!(log[0].body, "Together.");
        assert!(!dir.join("b.txt").exists(), "b was dropped");
        assert!(dir.join("d.txt").exists() && dir.join("c.txt").exists());
        assert_eq!(g.commit_files(&log[0].hash).unwrap().len(), 3);
        assert!(!g.git_dir().join("studio-rebase").exists(), "the scratch files are cleaned up");

        // The list has to match the branch exactly, and cannot start with a squash.
        let plan = g.rebase_plan(Some(&base)).unwrap();
        assert!(g.rebase_interactive(Some(&base), &[step(&plan[0].hash, "pick", None)]).is_err());
        let bad = vec![step(&plan[0].hash, "squash", None), step(&plan[1].hash, "pick", None)];
        assert!(g.rebase_interactive(Some(&base), &bad).is_err());
        assert_eq!(g.status().unwrap().operation, None);

        // From the very first commit (--root): squash everything into one.
        let all = g.rebase_plan(None).unwrap();
        assert_eq!(all.len(), 3);
        let steps: Vec<RebaseStep> = all.iter().enumerate().map(|(i, c)| step(&c.hash, if i == 0 { "pick" } else { "fixup" }, (i == 0).then_some("Everything"))).collect();
        g.rebase_interactive(None, &steps).unwrap();
        assert_eq!(summaries(&g), ["Everything"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn interactive_rebase_conflict_keeps_new_message() {
        let dir = scratch("rebase-i-conflict");
        let g = Git::at(&dir);
        file_commit(&g, &dir, "f.txt", "base\n", "Base");
        file_commit(&g, &dir, "f.txt", "one\n", "One");
        file_commit(&g, &dir, "f.txt", "two\n", "Two");
        let base = g.log(0, 10).unwrap().last().unwrap().hash.clone();
        let plan = g.rebase_plan(Some(&base)).unwrap();

        // Swapping two edits of the same line conflicts at the first one.
        let steps = vec![step(&plan[1].hash, "reword", Some("Two, now first")), step(&plan[0].hash, "pick", None)];
        assert!(matches!(g.rebase_interactive(Some(&base), &steps), Err(AppError::Conflict(_))));
        assert_eq!(g.status().unwrap().operation.as_deref(), Some("rebase"));
        std::fs::write(dir.join("f.txt"), "two\n").unwrap();
        // The next pick conflicts as well.
        assert!(matches!(g.op_continue(), Err(AppError::Conflict(_))));
        std::fs::write(dir.join("f.txt"), "one\n").unwrap();
        g.op_continue().unwrap();
        assert_eq!(g.status().unwrap().operation, None);
        assert_eq!(summaries(&g), ["One", "Two, now first", "Base"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn find_in_files() {
        let dir = scratch("grep");
        let g = Git::at(&dir);
        let any = SearchOptions::default();
        let exact = SearchOptions { match_case: true, ..Default::default() };
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join(".gitignore"), "out/\n").unwrap();
        std::fs::write(dir.join("src").join("a b.txt"), "first line\n\t  let needle = 1; // Needle again\nlast needles\n").unwrap();
        std::fs::write(dir.join("src").join("flags.txt"), "run with -x --all\r\ncaf\u{e9} \u{1F600} needle\r\n").unwrap();
        std::fs::write(dir.join("data.bin"), b"needle\0\x9f\x92needle").unwrap();
        std::fs::write(dir.join("out").join("built.txt"), "needle\n").unwrap();
        g.commit(&[".gitignore".into(), "src/a b.txt".into(), "data.bin".into()], "One", "", false).unwrap();
        // `src/flags.txt` is new and not committed: found all the same. `out/` is ignored, `data.bin` binary.

        let found = g.grep("needle", &any, 100).unwrap();
        assert!(!found.truncated);
        let lines: Vec<(&str, u32, u32)> = found.matches.iter().map(|m| (m.path.as_str(), m.line, m.column)).collect();
        assert_eq!(lines, [("src/a b.txt", 2, 8), ("src/a b.txt", 3, 6), ("src/flags.txt", 2, 9)]);
        // Leading white space is not shown, and `start` points at the match in what is.
        assert_eq!(found.matches[0].text, "let needle = 1; // Needle again");
        assert_eq!(found.matches[0].start, 4);
        // Columns count UTF-16 units (the emoji is two), and a CRLF line ends before its CR.
        assert_eq!(found.matches[2].text, "caf\u{e9} \u{1F600} needle");
        assert_eq!(found.matches[2].start, 8);

        assert_eq!(g.grep("Needle", &exact, 100).unwrap().matches.len(), 1);
        assert_eq!(g.grep("needle", &SearchOptions { whole_word: true, ..Default::default() }, 100).unwrap().matches.len(), 2);
        // A pattern that looks like an option is still only a pattern.
        let dash = g.grep("-x", &any, 100).unwrap();
        assert_eq!(dash.matches.iter().map(|m| (m.path.as_str(), m.line)).collect::<Vec<_>>(), [("src/flags.txt", 1)]);
        assert_eq!(dash.matches[0].text, "run with -x --all");
        // Plain text is not a pattern; a regular expression is one when asked for.
        assert!(g.grep("ne+dles?", &any, 100).unwrap().matches.is_empty());
        let regex = SearchOptions { regex: true, ..Default::default() };
        assert_eq!(g.grep("ne+dles$", &regex, 100).unwrap().matches.len(), 1);
        let bad = g.grep("(", &regex, 100).unwrap_err();
        assert!(matches!(&bad, AppError::Git(m) if m.starts_with("Not a regular expression: ") && m.len() > 30), "{bad:?}");

        let capped = g.grep("needle", &any, 2).unwrap();
        assert!(capped.truncated && capped.matches.len() == 2);
        assert!(g.grep("", &any, 100).unwrap().matches.is_empty());
        assert!(g.grep("nothing like this", &any, 100).unwrap().matches.is_empty());
        assert!(g.grep("a\nb", &any, 100).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_long_line_is_cut_around_its_match() {
        let record = format!("min.js\x001\x00{}\x00{}needle{}", 501, "x".repeat(500), "y".repeat(1000));
        let m = search_match(record.as_bytes()).unwrap();
        assert_eq!(m.column, 501);
        assert!(m.text.starts_with('…') && m.text.chars().count() <= SEARCH_TEXT);
        assert_eq!(&m.text[m.text.char_indices().nth(m.start as usize).unwrap().0..][..6], "needle");
    }

    #[test]
    fn the_files_of_a_checkout() {
        let dir = scratch("files");
        let g = Git::at(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join(".gitignore"), "out/\n*.log\n").unwrap();
        std::fs::write(dir.join("src").join(ODD), "one\n").unwrap();
        std::fs::write(dir.join("src").join("a b.txt"), "one\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "one\n").unwrap();
        std::fs::write(dir.join("out").join("built.js"), "x\n").unwrap();
        std::fs::write(dir.join("debug.log"), "x\n").unwrap();
        g.commit(&[".gitignore".into(), format!("src/{ODD}"), "gone.txt".into()], "One", "", false).unwrap();
        std::fs::remove_file(dir.join("gone.txt")).unwrap();
        // `src/a b.txt` is new; `out/` and `debug.log` are ignored; `gone.txt` is tracked, so still listed.
        let mut expected = vec![".gitignore".to_string(), "gone.txt".into(), "src/a b.txt".into(), format!("src/{ODD}")];
        expected.sort_unstable();
        let all = g.files(100).unwrap();
        assert_eq!(all.paths, expected);
        assert!(!all.truncated);

        let some = g.files(2).unwrap();
        assert!(some.truncated && some.paths == expected[..2]);

        // A submodule is not a file to open.
        let head = g.run(&["rev-parse", "HEAD"]).unwrap().trim().to_string();
        std::fs::write(dir.join(".gitmodules"), "[submodule \"vendor/lib\"]\n\tpath = vendor/lib\n\turl = ../lib\n").unwrap();
        git(&dir, &["update-index", "--add", "--cacheinfo", &format!("160000,{head},vendor/lib")]);
        let listed = g.files(100).unwrap().paths;
        assert!(listed.contains(&".gitmodules".to_string()) && !listed.iter().any(|p| p.starts_with("vendor")), "{listed:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
