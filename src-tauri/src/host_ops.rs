//! Working with the host beyond listing issues and opening a pull request: browsing and reviewing pull
//! requests, acting on issues, CI runs, and Jira. Same rules as `host_cli.rs`, whose helpers this uses:
//! only the user's own signed-in tools (`gh`, `az` + azure-devops, `glab`, Atlassian's `acli`), separate argv
//! entries in `--flag=value` form, long text on stdin or through a temp file, a timeout on every call, and
//! everything from the host treated as untrusted text. Anything that writes to the host (a review, a
//! comment, a merge, a new issue) runs only from an explicit click in the window.

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::host_cli::{blocking, check_branch, clip, encode, failure, remote, require, run, run_ok, text, tool, unexpected, usable, Target, TempText, CREATE_TIMEOUT, LIST_TIMEOUT, MAX_BODY_CHARS, STATUS_TIMEOUT};
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

const MAX_NOTES: usize = 100;
const MAX_LIST: usize = 50;

fn s(list: &[&str]) -> Vec<String> {
    list.iter().map(|x| x.to_string()).collect()
}

/// Pull request and issue numbers go on command lines: digits only.
fn check_number(n: &str) -> Result<()> {
    if n.is_empty() || n.len() > 12 || !n.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::msg("Not a valid number"));
    }
    Ok(())
}

fn azure_parts(target: &Target) -> Result<(&str, &str, &str)> {
    match target {
        Target::Azure { org_url, project, repo } => Ok((org_url, project, repo)),
        _ => Err(AppError::msg("Not an Azure DevOps repository")),
    }
}

// ---- pull requests --------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrSummary {
    pub id: String,
    pub title: String,
    pub author: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
    /// open | merged | closed
    pub state: String,
    pub updated: String,
    pub url: String,
    /// approved | changes | required | "" (nothing asked or known)
    pub review: String,
    /// pass | fail | pending | "" (no checks)
    pub checks: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    pub author: String,
    /// Untrusted text from the host, shown as text.
    pub body: String,
    pub created: String,
    /// comment | approved | changes (a review's verdict, when it is one)
    pub kind: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub name: String,
    /// pass | fail | pending | skipped
    pub state: String,
    pub url: String,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrFile {
    pub path: String,
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub summary: PrSummary,
    pub body: String,
    pub notes: Vec<Note>,
    pub checks: Vec<Check>,
    pub files: Vec<PrFile>,
    /// None when the host has not worked it out yet.
    pub mergeable: Option<bool>,
    /// The branch lives in a fork.
    pub cross_repo: bool,
}

/// A check's outcome in our four words. Hosts spell these many ways.
fn check_state(status: &str, conclusion: &str) -> String {
    let (status, conclusion) = (status.to_ascii_lowercase(), conclusion.to_ascii_lowercase());
    match conclusion.as_str() {
        "success" | "succeeded" | "passed" | "approved" | "neutral" => return "pass".into(),
        "failure" | "failed" | "timed_out" | "action_required" | "startup_failure" | "rejected" | "error" | "partiallysucceeded" => return "fail".into(),
        "cancelled" | "canceled" | "skipped" | "stale" | "notapplicable" => return "skipped".into(),
        _ => {}
    }
    match status.as_str() {
        "success" | "succeeded" | "passed" | "approved" => "pass".into(),
        "failed" | "failure" | "error" | "rejected" => "fail".into(),
        "canceled" | "cancelled" | "skipped" | "manual" | "notapplicable" => "skipped".into(),
        _ => "pending".into(),
    }
}

/// Every check's state rolled into one: any failure wins, then anything still running.
fn roll_up(checks: &[Check]) -> String {
    if checks.is_empty() {
        String::new()
    } else if checks.iter().any(|c| c.state == "fail") {
        "fail".into()
    } else if checks.iter().any(|c| c.state == "pending") {
        "pending".into()
    } else {
        "pass".into()
    }
}

// GitHub ------------------------------------------------------------------------

const GH_PR_FIELDS: &str = "number,title,author,headRefName,baseRefName,isDraft,state,updatedAt,url,reviewDecision,statusCheckRollup";

fn gh_checks(rollup: &Value) -> Vec<Check> {
    rollup
        .as_array()
        .map(|list| {
            list.iter()
                .map(|c| {
                    // CheckRun has status/conclusion, StatusContext has state.
                    let state = if c["__typename"] == "StatusContext" { check_state(&text(c, "state"), "") } else { check_state(&text(c, "status"), &text(c, "conclusion")) };
                    let name = c["name"].as_str().or_else(|| c["context"].as_str()).unwrap_or("check").to_string();
                    Check { name, state, url: c["detailsUrl"].as_str().or_else(|| c["targetUrl"].as_str()).unwrap_or("").to_string() }
                })
                .collect()
        })
        .unwrap_or_default()
}

fn gh_summary(p: &Value) -> Option<PrSummary> {
    let checks = gh_checks(&p["statusCheckRollup"]);
    Some(PrSummary {
        id: p["number"].as_u64()?.to_string(),
        title: text(p, "title"),
        author: p["author"]["login"].as_str().unwrap_or("").trim_start_matches("app/").to_string(),
        head: text(p, "headRefName"),
        base: text(p, "baseRefName"),
        draft: p["isDraft"].as_bool().unwrap_or(false),
        state: text(p, "state").to_lowercase(),
        updated: text(p, "updatedAt"),
        url: text(p, "url"),
        review: match p["reviewDecision"].as_str().unwrap_or("") {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "changes",
            "REVIEW_REQUIRED" => "required",
            _ => "",
        }
        .into(),
        checks: roll_up(&checks),
    })
}

fn parse_gh_prs(json: &str) -> Result<Vec<PrSummary>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("gh"))?;
    Ok(items.iter().filter_map(gh_summary).take(MAX_LIST).collect())
}

fn parse_gh_pr(json: &str) -> Result<PrDetail> {
    let p: Value = serde_json::from_str(json).map_err(|_| unexpected("gh"))?;
    let summary = gh_summary(&p).ok_or_else(|| unexpected("gh"))?;
    let mut notes: Vec<Note> = p["comments"].as_array().into_iter().flatten().map(|c| Note { author: text(&c["author"], "login"), body: clip(&text(c, "body"), MAX_BODY_CHARS), created: text(c, "createdAt"), kind: "comment".into() }).collect();
    notes.extend(p["reviews"].as_array().into_iter().flatten().filter_map(|r| {
        let kind = match r["state"].as_str()? {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "changes",
            "COMMENTED" => "comment",
            _ => return None,
        };
        let body = clip(&text(r, "body"), MAX_BODY_CHARS);
        (kind != "comment" || !body.trim().is_empty()).then(|| Note { author: text(&r["author"], "login"), body, created: text(r, "submittedAt"), kind: kind.into() })
    }));
    notes.sort_by(|a, b| a.created.cmp(&b.created));
    notes.truncate(MAX_NOTES);
    Ok(PrDetail {
        body: clip(&text(&p, "body"), MAX_BODY_CHARS),
        notes,
        checks: gh_checks(&p["statusCheckRollup"]),
        files: p["files"].as_array().into_iter().flatten().take(300).map(|f| PrFile { path: text(f, "path"), additions: f["additions"].as_u64().unwrap_or(0), deletions: f["deletions"].as_u64().unwrap_or(0) }).collect(),
        mergeable: match p["mergeable"].as_str() {
            Some("MERGEABLE") => Some(true),
            Some("CONFLICTING") => Some(false),
            _ => None,
        },
        cross_repo: p["isCrossRepository"].as_bool().unwrap_or(false),
        summary,
    })
}

// Azure DevOps --------------------------------------------------------------------

fn short_ref(r: &str) -> String {
    r.trim_start_matches("refs/heads/").to_string()
}

fn az_pr_url(web: &str, id: u64) -> String {
    format!("{web}/pullrequest/{id}")
}

fn az_summary(p: &Value, web: &str) -> Option<PrSummary> {
    let id = p["pullRequestId"].as_u64()?;
    // Votes: 10 approved, 5 approved with suggestions, -5 waiting for author, -10 rejected.
    let votes: Vec<i64> = p["reviewers"].as_array().into_iter().flatten().filter_map(|r| r["vote"].as_i64()).collect();
    let review = if votes.iter().any(|v| *v < 0) {
        "changes"
    } else if votes.iter().any(|v| *v > 0) {
        "approved"
    } else if !votes.is_empty() {
        "required"
    } else {
        ""
    };
    let state = match p["status"].as_str().unwrap_or("") {
        "completed" => "merged",
        "abandoned" => "closed",
        _ => "open",
    };
    Some(PrSummary {
        id: id.to_string(),
        title: text(p, "title"),
        author: text(&p["createdBy"], "displayName"),
        head: short_ref(&text(p, "sourceRefName")),
        base: short_ref(&text(p, "targetRefName")),
        draft: p["isDraft"].as_bool().unwrap_or(false),
        state: state.into(),
        updated: p["closedDate"].as_str().or_else(|| p["creationDate"].as_str()).unwrap_or("").to_string(),
        url: az_pr_url(web, id),
        review: review.into(),
        checks: String::new(),
    })
}

fn parse_az_prs(json: &str, web: &str) -> Result<Vec<PrSummary>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("az"))?;
    Ok(items.iter().filter_map(|p| az_summary(p, web)).take(MAX_LIST).collect())
}

/// `az devops invoke ... pullRequestThreads`: people's comments, not the system's (votes, pushes).
fn parse_az_threads(json: &str) -> Vec<Note> {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let mut notes: Vec<Note> = v["value"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|t| t["comments"].as_array().cloned().unwrap_or_default())
        .filter(|c| c["commentType"].as_str().is_none_or(|k| k == "text") && !c["isDeleted"].as_bool().unwrap_or(false))
        .map(|c| Note { author: text(&c["author"], "displayName"), body: clip(&text(&c, "content"), MAX_BODY_CHARS), created: text(&c, "publishedDate"), kind: "comment".into() })
        .filter(|n| !n.body.trim().is_empty())
        .collect();
    notes.sort_by(|a, b| a.created.cmp(&b.created));
    notes.truncate(MAX_NOTES);
    notes
}

/// `az repos pr policy list`: build validation, required reviewers and so on.
fn parse_az_policies(json: &str) -> Vec<Check> {
    let items: Vec<Value> = serde_json::from_str(json).unwrap_or_default();
    items
        .iter()
        .map(|p| Check {
            name: p["configuration"]["type"]["displayName"].as_str().or_else(|| p["configuration"]["settings"]["displayName"].as_str()).unwrap_or("Policy").to_string(),
            state: check_state(&text(p, "status"), ""),
            url: String::new(),
        })
        .collect()
}

// GitLab ----------------------------------------------------------------------------

fn glab_summary(m: &Value) -> Option<PrSummary> {
    let pipeline = m["head_pipeline"]["status"].as_str().or_else(|| m["pipeline"]["status"].as_str()).unwrap_or("");
    let state = match m["state"].as_str().unwrap_or("") {
        "opened" => "open",
        "merged" => "merged",
        _ => "closed",
    };
    Some(PrSummary {
        id: m["iid"].as_u64()?.to_string(),
        title: text(m, "title"),
        author: text(&m["author"], "username"),
        head: text(m, "source_branch"),
        base: text(m, "target_branch"),
        draft: m["draft"].as_bool().or_else(|| m["work_in_progress"].as_bool()).unwrap_or(false),
        state: state.into(),
        updated: text(m, "updated_at"),
        url: text(m, "web_url"),
        review: if m["detailed_merge_status"] == "not_approved" { "required".into() } else { String::new() },
        checks: if pipeline.is_empty() { String::new() } else { check_state(pipeline, "") },
    })
}

fn parse_glab_mrs(json: &str) -> Result<Vec<PrSummary>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("glab"))?;
    Ok(items.iter().filter_map(glab_summary).take(MAX_LIST).collect())
}

fn parse_glab_mr(json: &str) -> Result<PrDetail> {
    let m: Value = serde_json::from_str(json).map_err(|_| unexpected("glab"))?;
    let summary = glab_summary(&m).ok_or_else(|| unexpected("glab"))?;
    let notes = m["notes"]
        .as_array()
        .or_else(|| m["Notes"].as_array())
        .into_iter()
        .flatten()
        .filter(|n| !n["system"].as_bool().unwrap_or(false))
        .map(|n| Note { author: text(&n["author"], "username"), body: clip(&text(n, "body"), MAX_BODY_CHARS), created: text(n, "created_at"), kind: "comment".into() })
        .take(MAX_NOTES)
        .collect();
    let checks = match m["head_pipeline"]["status"].as_str() {
        Some(status) => vec![Check { name: "Pipeline".into(), state: check_state(status, ""), url: text(&m["head_pipeline"], "web_url") }],
        None => vec![],
    };
    Ok(PrDetail {
        body: clip(&text(&m, "description"), MAX_BODY_CHARS),
        notes,
        checks,
        files: vec![],
        mergeable: match m["detailed_merge_status"].as_str() {
            Some("mergeable") => Some(true),
            Some("broken_status") | Some("conflict") => Some(false),
            _ => None,
        },
        cross_repo: m["source_project_id"] != m["target_project_id"],
        summary,
    })
}

// The commands' work ------------------------------------------------------------------

fn pr_list_args(target: &Target, scope: &str) -> Result<Vec<String>> {
    Ok(match target {
        Target::GitHub { .. } => {
            let mut a = vec!["pr".into(), "list".into(), target.repo_arg(), "--state=open".into(), format!("--limit={MAX_LIST}"), format!("--json={GH_PR_FIELDS}")];
            match scope {
                "mine" => a.push("--author=@me".into()),
                "review" => a.push("--search=review-requested:@me".into()),
                _ => {}
            }
            a
        }
        Target::Azure { org_url, project, repo } => vec![
            "repos".into(),
            "pr".into(),
            "list".into(),
            format!("--org={org_url}"),
            format!("--project={project}"),
            format!("--repository={repo}"),
            "--status=active".into(),
            format!("--top={MAX_LIST}"),
            "--detect=false".into(),
            "--output=json".into(),
        ],
        Target::GitLab { .. } => {
            let mut a = vec!["mr".into(), "list".into(), target.repo_arg(), "--output=json".into(), format!("--per-page={MAX_LIST}")];
            match scope {
                "mine" => a.push("--author=@me".into()),
                "review" => a.push("--reviewer=@me".into()),
                _ => {}
            }
            a
        }
        Target::None => return Err(AppError::msg("This host has no command-line tool, so its pull requests open in the browser")),
    })
}

fn pr_list_of(g: &Git, scope: &str) -> Result<Vec<PrSummary>> {
    let (host, target) = remote(g)?;
    let program = require(&target)?;
    let out = run_ok(&g.dir, program, &pr_list_args(&target, scope)?, None, LIST_TIMEOUT)?;
    match &target {
        Target::GitHub { .. } => parse_gh_prs(&out),
        Target::Azure { .. } => parse_az_prs(&out, &host.web),
        Target::GitLab { .. } => parse_glab_mrs(&out),
        Target::None => Ok(vec![]),
    }
}

fn pr_view_of(g: &Git, number: &str) -> Result<PrDetail> {
    check_number(number)?;
    let (host, target) = remote(g)?;
    let program = require(&target)?;
    match &target {
        Target::GitHub { .. } => {
            let fields = format!("--json={GH_PR_FIELDS},body,comments,reviews,files,mergeable,isCrossRepository");
            parse_gh_pr(&run_ok(&g.dir, program, &["pr".into(), "view".into(), number.into(), target.repo_arg(), fields], None, LIST_TIMEOUT)?)
        }
        Target::Azure { .. } => {
            let (org, project, repo) = azure_parts(&target)?;
            let show = run_ok(&g.dir, program, &[s(&["repos", "pr", "show"]), vec![format!("--id={number}"), format!("--org={org}"), "--detect=false".into(), "--output=json".into()]].concat(), None, LIST_TIMEOUT)?;
            let p: Value = serde_json::from_str(&show).map_err(|_| unexpected("az"))?;
            let summary = az_summary(&p, &host.web).ok_or_else(|| unexpected("az"))?;
            let threads = run_ok(
                &g.dir,
                program,
                &[s(&["devops", "invoke", "--area=git", "--resource=pullRequestThreads", "--route-parameters"]), vec![format!("project={project}"), format!("repositoryId={repo}"), format!("pullRequestId={number}"), format!("--org={org}"), "--api-version=7.1".into(), "--output=json".into()]].concat(),
                None,
                LIST_TIMEOUT,
            )
            .map(|o| parse_az_threads(&o))
            .unwrap_or_default();
            let checks = run_ok(&g.dir, program, &[s(&["repos", "pr", "policy", "list"]), vec![format!("--id={number}"), format!("--org={org}"), "--detect=false".into(), "--output=json".into()]].concat(), None, LIST_TIMEOUT).map(|o| parse_az_policies(&o)).unwrap_or_default();
            let mut summary = summary;
            summary.checks = roll_up(&checks);
            Ok(PrDetail {
                body: clip(&text(&p, "description"), MAX_BODY_CHARS),
                notes: threads,
                checks,
                files: vec![],
                mergeable: match p["mergeStatus"].as_str() {
                    Some("succeeded") => Some(true),
                    Some("conflicts") | Some("failure") | Some("rejectedByPolicy") => Some(false),
                    _ => None,
                },
                cross_repo: p["forkSource"].is_object(),
                summary,
            })
        }
        Target::GitLab { .. } => parse_glab_mr(&run_ok(&g.dir, program, &["mr".into(), "view".into(), number.into(), target.repo_arg(), "--output=json".into(), "--comments".into()], None, LIST_TIMEOUT)?),
        Target::None => Err(AppError::msg("This host has no command-line tool")),
    }
}

/// approve | request-changes | comment. `body` may be empty for an approval.
fn pr_review_of(g: &Git, number: &str, verdict: &str, body: &str) -> Result<()> {
    check_number(number)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    let body = body.trim();
    if verdict != "approve" && body.is_empty() {
        return Err(AppError::msg("Write what should change"));
    }
    match &target {
        Target::GitHub { .. } => {
            let flag = match verdict {
                "approve" => "--approve",
                "request-changes" => "--request-changes",
                "comment" => "--comment",
                _ => return Err(AppError::msg("Unknown review")),
            };
            run_ok(&g.dir, program, &["pr".into(), "review".into(), number.into(), target.repo_arg(), flag.into(), "--body-file=-".into()], Some(body.as_bytes().to_vec()), CREATE_TIMEOUT)?;
        }
        Target::Azure { .. } => {
            let (org, ..) = azure_parts(&target)?;
            if !body.is_empty() {
                pr_comment_of(g, number, body)?;
            }
            let vote = match verdict {
                "approve" => "approve",
                "request-changes" => "wait-for-author",
                _ => return Ok(()),
            };
            run_ok(&g.dir, program, &[s(&["repos", "pr", "set-vote"]), vec![format!("--id={number}"), format!("--vote={vote}"), format!("--org={org}"), "--detect=false".into(), "--output=none".into()]].concat(), None, CREATE_TIMEOUT)?;
        }
        Target::GitLab { .. } => {
            if !body.is_empty() {
                pr_comment_of(g, number, body)?;
            }
            if verdict == "approve" {
                run_ok(&g.dir, program, &["mr".into(), "approve".into(), number.into(), target.repo_arg()], None, CREATE_TIMEOUT)?;
            }
        }
        Target::None => return Err(AppError::msg("This host has no command-line tool")),
    }
    Ok(())
}

fn az_thread_json(body: &str) -> String {
    serde_json::json!({ "comments": [{ "parentCommentId": 0, "content": body, "commentType": 1 }], "status": 1 }).to_string()
}

fn pr_comment_of(g: &Git, number: &str, body: &str) -> Result<()> {
    check_number(number)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::msg("The comment is empty"));
    }
    match &target {
        Target::GitHub { .. } => {
            run_ok(&g.dir, program, &["pr".into(), "comment".into(), number.into(), target.repo_arg(), "--body-file=-".into()], Some(body.as_bytes().to_vec()), CREATE_TIMEOUT)?;
        }
        Target::Azure { .. } => {
            let (org, project, repo) = azure_parts(&target)?;
            let file = TempText::new("pr-thread", &az_thread_json(body))?;
            run_ok(
                &g.dir,
                program,
                &[
                    s(&["devops", "invoke", "--area=git", "--resource=pullRequestThreads", "--http-method=POST", "--route-parameters"]),
                    vec![format!("project={project}"), format!("repositoryId={repo}"), format!("pullRequestId={number}"), format!("--in-file={}", file.path()), format!("--org={org}"), "--api-version=7.1".into(), "--output=none".into()],
                ]
                .concat(),
                None,
                CREATE_TIMEOUT,
            )?;
        }
        Target::GitLab { .. } => {
            run_ok(&g.dir, program, &["mr".into(), "note".into(), number.into(), target.repo_arg(), format!("--message={body}")], None, CREATE_TIMEOUT)?;
        }
        Target::None => return Err(AppError::msg("This host has no command-line tool")),
    }
    Ok(())
}

/// merge | squash | rebase.
fn pr_merge_of(g: &Git, number: &str, method: &str, delete_branch: bool) -> Result<()> {
    check_number(number)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    if !["merge", "squash", "rebase"].contains(&method) {
        return Err(AppError::msg("Unknown merge method"));
    }
    match &target {
        Target::GitHub { .. } => {
            let mut a = vec!["pr".into(), "merge".into(), number.into(), target.repo_arg(), format!("--{method}")];
            if delete_branch {
                a.push("--delete-branch".into());
            }
            run_ok(&g.dir, program, &a, None, CREATE_TIMEOUT)?;
        }
        Target::Azure { .. } => {
            let (org, ..) = azure_parts(&target)?;
            if method == "rebase" {
                return Err(AppError::msg("Azure DevOps completes a pull request with a merge or a squash. Pick one of those, or rebase from its web page."));
            }
            run_ok(
                &g.dir,
                program,
                &[s(&["repos", "pr", "update"]), vec![format!("--id={number}"), "--status=completed".into(), format!("--squash={}", method == "squash"), format!("--delete-source-branch={delete_branch}"), format!("--org={org}"), "--detect=false".into(), "--output=none".into()]].concat(),
                None,
                CREATE_TIMEOUT,
            )?;
        }
        Target::GitLab { .. } => {
            let mut a = vec!["mr".into(), "merge".into(), number.into(), target.repo_arg(), "--yes".into()];
            match method {
                "squash" => a.push("--squash".into()),
                "rebase" => a.push("--rebase".into()),
                _ => {}
            }
            if delete_branch {
                a.push("--remove-source-branch".into());
            }
            run_ok(&g.dir, program, &a, None, CREATE_TIMEOUT)?;
        }
        Target::None => return Err(AppError::msg("This host has no command-line tool")),
    }
    Ok(())
}

/// Fetch a pull request's commits into a local branch (its own name, or `pr-N` when that is taken
/// by something else or it comes from a fork) and answer the branch, for a worktree to be made on it.
fn pr_fetch_of(g: &Git, number: &str) -> Result<String> {
    check_number(number)?;
    let detail = pr_view_of(g, number)?;
    let (host, target) = remote(g)?;
    let remote_name = g.default_remote().ok_or_else(|| AppError::msg("This repository has no remote"))?;
    let source = match target {
        Target::GitHub { .. } => format!("refs/pull/{number}/head"),
        Target::GitLab { .. } => format!("refs/merge-requests/{number}/head"),
        _ if detail.cross_repo => return Err(AppError::msg(format!("This pull request comes from a fork. Open it on {} instead.", host.name))),
        _ => {
            check_branch(&detail.summary.head)?;
            format!("refs/heads/{}", detail.summary.head)
        }
    };
    let own = detail.summary.head.clone();
    let exists = |b: &str| g.run(&["rev-parse", "--verify", "-q", &format!("refs/heads/{b}")]).is_ok();
    let branch = if !detail.cross_repo && check_branch(&own).is_ok() && !own.is_empty() && !exists(&own) { own } else { format!("pr-{number}") };
    if exists(&branch) {
        // Already fetched once: bring it up to date when that is a fast-forward, else leave it as it is.
        let _ = g.run(&["fetch", "-q", &remote_name, &format!("{source}:refs/heads/{branch}")]);
        return Ok(branch);
    }
    g.run(&["fetch", "-q", &remote_name, &format!("{source}:refs/heads/{branch}")])?;
    Ok(branch)
}

// ---- issues and work items: acting on them ------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub id: String,
    pub url: String,
}

/// The last https address a tool printed (gh and glab end with the new page's).
fn last_url(out: &str) -> Option<String> {
    out.split_whitespace().rev().find(|t| t.starts_with("https://")).map(String::from)
}

fn issue_create_of(g: &Git, title: &str, body: &str, kind: &str) -> Result<Created> {
    let (host, target) = remote(g)?;
    let program = require(&target)?;
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err(AppError::msg("Give it a title"));
    }
    let body = body.trim();
    match &target {
        Target::GitHub { .. } => {
            let out = run_ok(&g.dir, program, &["issue".into(), "create".into(), target.repo_arg(), format!("--title={title}"), "--body-file=-".into()], Some(body.as_bytes().to_vec()), CREATE_TIMEOUT)?;
            let url = last_url(&out).ok_or_else(|| unexpected("gh"))?;
            Ok(Created { id: url.rsplit('/').next().unwrap_or("").to_string(), url })
        }
        Target::Azure { org_url, project, .. } => {
            let kind = if kind.is_empty() { "Task" } else { kind };
            if !usable(kind) || kind.len() > 60 {
                return Err(AppError::msg("Not a work item type"));
            }
            let title_file = TempText::new("wi-title", &title)?;
            let mut a = vec!["boards".into(), "work-item".into(), "create".into(), format!("--type={kind}"), title_file.arg("--title"), format!("--org={org_url}"), format!("--project={project}"), "--detect=false".into(), "--output=json".into()];
            let description = if body.is_empty() { None } else { Some(TempText::new("wi-description", body)?) };
            if let Some(d) = &description {
                a.push(d.arg("--description"));
            }
            let out = run_ok(&g.dir, program, &a, None, CREATE_TIMEOUT)?;
            let v: Value = serde_json::from_str(&out).map_err(|_| unexpected("az"))?;
            let id = v["id"].as_u64().ok_or_else(|| unexpected("az"))?;
            Ok(Created { id: id.to_string(), url: format!("{org_url}/{}/_workitems/edit/{id}", encode(project)) })
        }
        Target::GitLab { .. } => {
            let out = run_ok(&g.dir, program, &["issue".into(), "create".into(), target.repo_arg(), format!("--title={title}"), format!("--description={body}"), "--yes".into()], None, CREATE_TIMEOUT)?;
            let url = last_url(&out).ok_or_else(|| unexpected("glab"))?;
            Ok(Created { id: url.rsplit('/').next().unwrap_or("").to_string(), url })
        }
        Target::None => Err(AppError::msg(format!("{} has no command-line tool; create it on the web page", host.name))),
    }
}

fn issue_comment_of(g: &Git, number: &str, body: &str) -> Result<()> {
    check_number(number)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    let body = body.trim();
    if body.is_empty() {
        return Err(AppError::msg("The comment is empty"));
    }
    match &target {
        Target::GitHub { .. } => run_ok(&g.dir, program, &["issue".into(), "comment".into(), number.into(), target.repo_arg(), "--body-file=-".into()], Some(body.as_bytes().to_vec()), CREATE_TIMEOUT).map(|_| ()),
        Target::Azure { org_url, .. } => {
            let file = TempText::new("wi-comment", body)?;
            run_ok(&g.dir, program, &["boards".into(), "work-item".into(), "update".into(), format!("--id={number}"), file.arg("--discussion"), format!("--org={org_url}"), "--detect=false".into(), "--output=none".into()], None, CREATE_TIMEOUT).map(|_| ())
        }
        Target::GitLab { .. } => run_ok(&g.dir, program, &["issue".into(), "note".into(), number.into(), target.repo_arg(), format!("--message={body}")], None, CREATE_TIMEOUT).map(|_| ()),
        Target::None => Err(AppError::msg("This host has no command-line tool")),
    }
}

/// Close (`open == false`) or reopen. Azure DevOps states depend on the process template, so the usual names are tried in turn.
fn issue_state_of(g: &Git, number: &str, open: bool) -> Result<()> {
    check_number(number)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    let verb = if open { "reopen" } else { "close" };
    match &target {
        Target::GitHub { .. } => run_ok(&g.dir, program, &["issue".into(), verb.into(), number.into(), target.repo_arg()], None, CREATE_TIMEOUT).map(|_| ()),
        Target::GitLab { .. } => run_ok(&g.dir, program, &["issue".into(), verb.into(), number.into(), target.repo_arg()], None, CREATE_TIMEOUT).map(|_| ()),
        Target::Azure { org_url, .. } => {
            let names: &[&str] = if open { &["Active", "New", "To Do"] } else { &["Closed", "Done", "Resolved", "Completed"] };
            let mut last = None;
            for name in names {
                match run_ok(&g.dir, program, &["boards".into(), "work-item".into(), "update".into(), format!("--id={number}"), format!("--state={name}"), format!("--org={org_url}"), "--detect=false".into(), "--output=none".into()], None, CREATE_TIMEOUT) {
                    Ok(_) => return Ok(()),
                    Err(e) => last = Some(e),
                }
            }
            Err(last.unwrap_or_else(|| AppError::msg("Could not change the state")))
        }
        Target::None => Err(AppError::msg("This host has no command-line tool")),
    }
}

// ---- CI ------------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub name: String,
    pub title: String,
    /// pass | fail | pending | skipped
    pub state: String,
    pub url: String,
    pub created: String,
    pub branch: String,
    /// Azure Pipelines: the pipeline to queue again.
    pub definition: Option<String>,
}

fn parse_gh_runs(json: &str) -> Result<Vec<Run>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("gh"))?;
    Ok(items
        .iter()
        .filter_map(|r| {
            Some(Run {
                id: r["databaseId"].as_u64()?.to_string(),
                name: r["workflowName"].as_str().or_else(|| r["name"].as_str()).unwrap_or("").to_string(),
                title: text(r, "displayTitle"),
                state: check_state(&text(r, "status"), &text(r, "conclusion")),
                url: text(r, "url"),
                created: text(r, "createdAt"),
                branch: text(r, "headBranch"),
                definition: None,
            })
        })
        .collect())
}

fn parse_az_runs(json: &str) -> Result<Vec<Run>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("az"))?;
    Ok(items
        .iter()
        .filter_map(|r| {
            Some(Run {
                id: r["id"].as_u64()?.to_string(),
                name: text(&r["definition"], "name"),
                title: text(r, "buildNumber"),
                state: check_state(&text(r, "status"), &text(r, "result")),
                url: r["_links"]["web"]["href"].as_str().unwrap_or("").to_string(),
                created: r["queueTime"].as_str().or_else(|| r["startTime"].as_str()).unwrap_or("").to_string(),
                branch: short_ref(&text(r, "sourceBranch")),
                definition: r["definition"]["id"].as_u64().map(|d| d.to_string()),
            })
        })
        .collect())
}

fn parse_glab_runs(json: &str) -> Result<Vec<Run>> {
    let items: Vec<Value> = serde_json::from_str(json).map_err(|_| unexpected("glab"))?;
    Ok(items
        .iter()
        .filter_map(|r| {
            Some(Run {
                id: r["id"].as_u64()?.to_string(),
                name: "Pipeline".into(),
                title: r["sha"].as_str().map(|h| h.chars().take(8).collect()).unwrap_or_default(),
                state: check_state(&text(r, "status"), ""),
                url: text(r, "web_url"),
                created: text(r, "created_at"),
                branch: text(r, "ref"),
                definition: None,
            })
        })
        .collect())
}

/// The latest CI runs for `branch` (newest first).
fn ci_runs_of(g: &Git, branch: &str) -> Result<Vec<Run>> {
    check_branch(branch)?;
    let (_, target) = remote(g)?;
    let Some(program) = target.program().filter(|p| crate::proc::find(p).is_some()) else { return Ok(vec![]) };
    match &target {
        Target::GitHub { .. } => parse_gh_runs(&run_ok(&g.dir, program, &["run".into(), "list".into(), target.repo_arg(), format!("--branch={branch}"), "--limit=10".into(), "--json=databaseId,name,workflowName,displayTitle,status,conclusion,url,createdAt,headBranch".into()], None, STATUS_TIMEOUT)?),
        Target::Azure { org_url, project, .. } => parse_az_runs(&run_ok(&g.dir, program, &["pipelines".into(), "runs".into(), "list".into(), format!("--branch=refs/heads/{branch}"), "--top=10".into(), format!("--org={org_url}"), format!("--project={project}"), "--detect=false".into(), "--output=json".into()], None, STATUS_TIMEOUT)?),
        Target::GitLab { .. } => parse_glab_runs(&run_ok(&g.dir, program, &["ci".into(), "list".into(), target.repo_arg(), format!("--ref={branch}"), "--per-page=10".into(), "--output=json".into()], None, STATUS_TIMEOUT)?),
        Target::None => Ok(vec![]),
    }
}

/// Run a CI run's failed jobs again (GitHub, GitLab), or queue its pipeline again on the branch (Azure).
fn ci_rerun_of(g: &Git, run_id: &str, definition: Option<&str>, branch: &str) -> Result<()> {
    check_number(run_id)?;
    let (_, target) = remote(g)?;
    let program = require(&target)?;
    match &target {
        Target::GitHub { .. } => run_ok(&g.dir, program, &["run".into(), "rerun".into(), run_id.into(), target.repo_arg(), "--failed".into()], None, CREATE_TIMEOUT).map(|_| ()),
        Target::GitLab { .. } => run_ok(&g.dir, program, &["ci".into(), "retry".into(), run_id.into(), target.repo_arg()], None, CREATE_TIMEOUT).map(|_| ()),
        Target::Azure { org_url, project, .. } => {
            let definition = definition.ok_or_else(|| AppError::msg("Which pipeline to run is not known"))?;
            check_number(definition)?;
            check_branch(branch)?;
            run_ok(&g.dir, program, &["pipelines".into(), "run".into(), format!("--id={definition}"), format!("--branch=refs/heads/{branch}"), format!("--org={org_url}"), format!("--project={project}"), "--detect=false".into(), "--output=none".into()], None, CREATE_TIMEOUT).map(|_| ())
        }
        Target::None => Err(AppError::msg("This host has no command-line tool")),
    }
}

// ---- Jira, through acli --------------------------------------------------------------

#[derive(Serialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct JiraIssue {
    pub key: String,
    pub title: String,
    pub body: String,
    pub status: String,
    pub kind: String,
    pub assignee: Option<String>,
    pub updated: String,
    pub labels: Vec<String>,
    pub url: String,
}

/// A Jira project key (`ABC`) or issue key (`ABC-123`).
fn check_jira_key(key: &str, issue: bool) -> Result<()> {
    let (project, number) = match key.split_once('-') {
        Some((p, n)) if issue => (p, Some(n)),
        _ if issue => return Err(AppError::msg("Not a Jira issue key")),
        _ => (key, None),
    };
    let ok_project = !project.is_empty() && project.len() <= 30 && project.starts_with(|c: char| c.is_ascii_uppercase()) && project.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    let ok_number = number.is_none_or(|n| !n.is_empty() && n.len() <= 10 && n.chars().all(|c| c.is_ascii_digit()));
    if ok_project && ok_number {
        Ok(())
    } else {
        Err(AppError::msg(if issue { "Not a Jira issue key" } else { "Not a Jira project key (like ABC)" }))
    }
}

/// `team.atlassian.net`, or a server's host name; nothing that could be a path or a flag.
fn check_site(site: &str) -> Result<String> {
    let host = site.trim().trim_start_matches("https://").trim_end_matches('/');
    if host.is_empty() || host.len() > 200 || !usable(host) || !host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-') || !host.contains('.') {
        return Err(AppError::msg("Enter the Jira site as its address, like team.atlassian.net"));
    }
    Ok(host.to_string())
}

/// Atlassian Document Format (Jira Cloud's rich text) as plain text: the text nodes, with paragraph breaks.
fn adf_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Object(o) => {
            if let Some(t) = o.get("text").and_then(Value::as_str) {
                return t.to_string();
            }
            let inner: String = o.get("content").and_then(Value::as_array).map(|c| c.iter().map(adf_text).collect()).unwrap_or_default();
            match o.get("type").and_then(Value::as_str) {
                Some("paragraph") | Some("heading") | Some("codeBlock") | Some("blockquote") => format!("{}\n", inner.trim_end()),
                Some("listItem") => format!("- {}\n", inner.trim()),
                Some("hardBreak") => "\n".into(),
                _ => inner,
            }
        }
        Value::Array(a) => a.iter().map(adf_text).collect(),
        _ => String::new(),
    }
}

fn jql(project: &str, query: &str) -> String {
    let quote = |s: &str| s.chars().filter(|c| !c.is_control()).collect::<String>().replace('\\', "\\\\").replace('"', "\\\"");
    let q = query.trim();
    let narrow = if q.is_empty() {
        "(assignee = currentUser() OR updated >= -14d)".to_string()
    } else if check_jira_key(&q.to_ascii_uppercase(), true).is_ok() {
        format!("key = \"{}\"", quote(&q.to_ascii_uppercase()))
    } else {
        format!("text ~ \"{}\"", quote(q))
    };
    format!("project = \"{}\" AND statusCategory != Done AND {narrow} ORDER BY updated DESC", quote(project))
}

fn parse_jira(json: &str, site: &str) -> Result<Vec<JiraIssue>> {
    let v: Value = serde_json::from_str(json).map_err(|_| unexpected("acli"))?;
    // A bare list, or the REST API's page object.
    let list = v.as_array().or_else(|| v["issues"].as_array()).ok_or_else(|| unexpected("acli"))?;
    Ok(list
        .iter()
        .filter_map(|i| {
            let key = i["key"].as_str()?.to_string();
            let f = &i["fields"];
            Some(JiraIssue {
                title: text(f, "summary"),
                body: clip(adf_text(&f["description"]).trim(), MAX_BODY_CHARS),
                status: text(&f["status"], "name"),
                kind: text(&f["issuetype"], "name"),
                assignee: f["assignee"]["displayName"].as_str().map(String::from),
                updated: text(f, "updated"),
                labels: f["labels"].as_array().map(|l| l.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
                url: format!("https://{site}/browse/{key}"),
                key,
            })
        })
        .take(100)
        .collect())
}

fn acli(dir: &std::path::Path, args: Vec<String>) -> Result<String> {
    if crate::proc::find("acli").is_none() {
        return Err(AppError::msg("Install the Atlassian CLI (acli) from https://developer.atlassian.com/cloud/acli/guides/install-acli/, then run `acli jira auth login --web` in a terminal."));
    }
    let mut c = tool("acli", dir);
    c.args(args);
    let out = run(c, None, LIST_TIMEOUT, "acli")?;
    if out.ok {
        Ok(out.stdout)
    } else {
        Err(failure("acli", &out))
    }
}

// ---- commands --------------------------------------------------------------------------

#[tauri::command]
pub async fn pr_list(state: State<'_, AppState>, id: String, scope: String) -> Result<Vec<PrSummary>> {
    let g = repo(&state, &id)?;
    blocking(move || pr_list_of(&g, &scope)).await
}

#[tauri::command]
pub async fn pr_view(state: State<'_, AppState>, id: String, number: String) -> Result<PrDetail> {
    let g = repo(&state, &id)?;
    blocking(move || pr_view_of(&g, &number)).await
}

/// Publishes a review. Only the review box's buttons call this.
#[tauri::command]
pub async fn pr_review(state: State<'_, AppState>, id: String, number: String, verdict: String, body: String) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || pr_review_of(&g, &number, &verdict, &body)).await
}

#[tauri::command]
pub async fn pr_comment(state: State<'_, AppState>, id: String, number: String, body: String) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || pr_comment_of(&g, &number, &body)).await
}

/// Merges on the host. Only the Merge dialog's button calls this.
#[tauri::command]
pub async fn pr_merge(state: State<'_, AppState>, id: String, number: String, method: String, delete_branch: bool) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || pr_merge_of(&g, &number, &method, delete_branch)).await
}

/// The pull request's commits as a local branch (fetched, nothing checked out); answers its name.
#[tauri::command]
pub async fn pr_fetch(state: State<'_, AppState>, id: String, number: String) -> Result<String> {
    let (g, _) = crate::commands::main_repo(&state, &id)?;
    blocking(move || pr_fetch_of(&g, &number)).await
}

#[tauri::command]
pub async fn issue_create(state: State<'_, AppState>, id: String, title: String, body: String, kind: String) -> Result<Created> {
    let g = repo(&state, &id)?;
    blocking(move || issue_create_of(&g, &title, &body, &kind)).await
}

#[tauri::command]
pub async fn issue_comment(state: State<'_, AppState>, id: String, number: String, body: String) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || issue_comment_of(&g, &number, &body)).await
}

#[tauri::command]
pub async fn issue_set_state(state: State<'_, AppState>, id: String, number: String, open: bool) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || issue_state_of(&g, &number, open)).await
}

#[tauri::command]
pub async fn ci_runs(state: State<'_, AppState>, id: String, branch: String) -> Result<Vec<Run>> {
    let g = repo(&state, &id)?;
    blocking(move || ci_runs_of(&g, &branch)).await
}

#[tauri::command]
pub async fn ci_rerun(state: State<'_, AppState>, id: String, run: String, definition: Option<String>, branch: String) -> Result<()> {
    let g = repo(&state, &id)?;
    blocking(move || ci_rerun_of(&g, &run, definition.as_deref(), &branch)).await
}

#[tauri::command]
pub async fn jira_issues(site: String, project: String, query: String) -> Result<Vec<JiraIssue>> {
    let site = check_site(&site)?;
    check_jira_key(&project, false)?;
    blocking(move || {
        let out = acli(&std::env::temp_dir(), vec!["jira".into(), "workitem".into(), "search".into(), format!("--jql={}", jql(&project, &query)), "--limit=50".into(), "--json".into()])?;
        parse_jira(&out, &site)
    })
    .await
}

/// Move an issue to another status (by its name, as the board shows it).
#[tauri::command]
pub async fn jira_transition(key: String, status: String) -> Result<()> {
    check_jira_key(&key, true)?;
    let status = status.trim().to_string();
    if status.is_empty() || status.len() > 60 || !usable(&status) {
        return Err(AppError::msg("Not a status name"));
    }
    blocking(move || acli(&std::env::temp_dir(), vec!["jira".into(), "workitem".into(), "transition".into(), format!("--key={key}"), format!("--status={status}"), "--yes".into()]).map(|_| ())).await
}

#[tauri::command]
pub async fn jira_comment(key: String, body: String) -> Result<()> {
    check_jira_key(&key, true)?;
    let body = body.trim().to_string();
    if body.is_empty() {
        return Err(AppError::msg("The comment is empty"));
    }
    blocking(move || acli(&std::env::temp_dir(), vec!["jira".into(), "workitem".into(), "comment".into(), "create".into(), format!("--key={key}"), format!("--body={body}")]).map(|_| ())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(name: &str) -> String {
        std::fs::read_to_string(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/host").join(name)).unwrap()
    }

    #[test]
    fn github_pull_requests_and_runs() {
        let list = parse_gh_prs(&sample("gh-pr-list.json")).unwrap();
        assert_eq!(list[0].id, "8");
        assert_eq!(list[0].author, "dependabot");
        assert_eq!(list[0].checks, "fail");
        assert_eq!((list[0].state.as_str(), list[0].draft, list[0].base.as_str()), ("open", false, "main"));

        let pr = parse_gh_pr(&sample("gh-pr-view.json")).unwrap();
        assert_eq!(pr.files.len(), 2);
        assert_eq!(pr.files[1], PrFile { path: "package.json".into(), additions: 1, deletions: 1 });
        assert_eq!(pr.mergeable, Some(true));
        assert!(!pr.cross_repo);
        assert!(pr.checks.iter().any(|c| c.state == "fail") && pr.checks.iter().any(|c| c.state == "pass"));
        assert!(pr.body.starts_with("Removes"));

        let runs = parse_gh_runs(&sample("gh-runs.json")).unwrap();
        assert_eq!(runs[0].state, "fail");
        assert_eq!(runs[0].name, "CI");
        assert!(runs[0].url.starts_with("https://github.com/"));
    }

    #[test]
    fn reviews_and_comments_are_notes() {
        let json = r#"{"number":3,"title":"t","author":{"login":"a"},"state":"OPEN","reviewDecision":"CHANGES_REQUESTED",
            "comments":[{"author":{"login":"b"},"body":"hi","createdAt":"2026-01-02T00:00:00Z"}],
            "reviews":[{"author":{"login":"c"},"state":"CHANGES_REQUESTED","body":"fix","submittedAt":"2026-01-01T00:00:00Z"},{"author":{"login":"d"},"state":"COMMENTED","body":"","submittedAt":"2026-01-03T00:00:00Z"}]}"#;
        let pr = parse_gh_pr(json).unwrap();
        assert_eq!(pr.summary.review, "changes");
        assert_eq!(pr.notes.iter().map(|n| (n.author.as_str(), n.kind.as_str())).collect::<Vec<_>>(), [("c", "changes"), ("b", "comment")]);
    }

    #[test]
    fn azure_pull_requests() {
        let json = r#"[{"pullRequestId":12,"title":"Add login","createdBy":{"displayName":"Ann"},"sourceRefName":"refs/heads/feature/login","targetRefName":"refs/heads/main","isDraft":true,"status":"active","creationDate":"2026-01-01T00:00:00Z","reviewers":[{"vote":10},{"vote":0}]},
            {"pullRequestId":13,"title":"x","createdBy":{"displayName":"Bo"},"sourceRefName":"refs/heads/b","targetRefName":"refs/heads/main","status":"active","reviewers":[{"vote":-10}]}]"#;
        let list = parse_az_prs(json, "https://dev.azure.com/org/P/_git/r").unwrap();
        assert_eq!((list[0].head.as_str(), list[0].base.as_str(), list[0].draft, list[0].review.as_str()), ("feature/login", "main", true, "approved"));
        assert_eq!(list[0].url, "https://dev.azure.com/org/P/_git/r/pullrequest/12");
        assert_eq!(list[1].review, "changes");

        let threads = r#"{"value":[{"comments":[{"author":{"displayName":"Ann"},"content":"Looks good","publishedDate":"2026-01-02","commentType":"text"},{"author":{"displayName":"System"},"content":"Ann voted 10","commentType":"system"}]}]}"#;
        assert_eq!(parse_az_threads(threads).len(), 1);
        let policies = r#"[{"status":"approved","configuration":{"type":{"displayName":"Build"}}},{"status":"queued","configuration":{"type":{"displayName":"Minimum reviewers"}}}]"#;
        let checks = parse_az_policies(policies);
        assert_eq!((checks[0].state.as_str(), checks[1].state.as_str()), ("pass", "pending"));
        assert_eq!(roll_up(&checks), "pending");
        let thread: Value = serde_json::from_str(&az_thread_json("a \"quoted\"\nline")).unwrap();
        assert_eq!(thread["comments"][0]["content"], "a \"quoted\"\nline");
    }

    #[test]
    fn gitlab_merge_requests_and_pipelines() {
        let json = r#"[{"iid":4,"title":"MR","author":{"username":"ann"},"source_branch":"f","target_branch":"main","draft":false,"state":"opened","updated_at":"2026","web_url":"https://gitlab.com/g/p/-/merge_requests/4","head_pipeline":{"status":"running"}}]"#;
        let list = parse_glab_mrs(json).unwrap();
        assert_eq!((list[0].id.as_str(), list[0].state.as_str(), list[0].checks.as_str()), ("4", "open", "pending"));
        let view = r#"{"iid":4,"title":"MR","state":"merged","description":"d","notes":[{"author":{"username":"bo"},"body":"ok","system":false},{"body":"merged","system":true}],"detailed_merge_status":"mergeable","source_project_id":1,"target_project_id":1}"#;
        let mr = parse_glab_mr(view).unwrap();
        assert_eq!((mr.notes.len(), mr.mergeable, mr.cross_repo, mr.summary.state.as_str()), (1, Some(true), false, "merged"));
        let runs = parse_glab_runs(r#"[{"id":77,"status":"failed","ref":"main","sha":"abcdef123456","web_url":"https://gitlab.com/x","created_at":"2026"}]"#).unwrap();
        assert_eq!((runs[0].state.as_str(), runs[0].title.as_str()), ("fail", "abcdef12"));
        let az = parse_az_runs(r#"[{"id":5,"definition":{"id":9,"name":"CI"},"status":"completed","result":"succeeded","sourceBranch":"refs/heads/main","_links":{"web":{"href":"https://dev.azure.com/o/p/_build/results?buildId=5"}}}]"#).unwrap();
        assert_eq!((az[0].state.as_str(), az[0].definition.as_deref(), az[0].branch.as_str()), ("pass", Some("9"), "main"));
    }

    #[test]
    fn args_never_become_options() {
        for bad in ["", "-1", "1a", "--help", "12345678901234"] {
            assert!(check_number(bad).is_err(), "{bad}");
        }
        assert!(check_number("42").is_ok());
        let gh = Target::GitHub { domain: "github.com".into(), repo: "o/r".into() };
        assert_eq!(pr_list_args(&gh, "review").unwrap().last().unwrap(), "--search=review-requested:@me");
        assert!(pr_list_args(&Target::None, "open").is_err());
        assert!(check_jira_key("ABC-12", true).is_ok() && check_jira_key("ABC", false).is_ok());
        for bad in ["abc-1", "-ABC-1", "ABC-", "ABC-x", "A B-1"] {
            assert!(check_jira_key(bad, true).is_err(), "{bad}");
        }
        assert_eq!(check_site("https://team.atlassian.net/").unwrap(), "team.atlassian.net");
        for bad in ["", "-x.com", "a/b.com", "localhost", "x .com"] {
            assert!(check_site(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn jira_text_and_queries() {
        assert_eq!(jql("ABC", ""), "project = \"ABC\" AND statusCategory != Done AND (assignee = currentUser() OR updated >= -14d) ORDER BY updated DESC");
        assert!(jql("ABC", "abc-12").contains("key = \"ABC-12\""));
        assert!(jql("ABC", "say \"hi\"").contains("text ~ \"say \\\"hi\\\"\""));
        let adf = serde_json::json!({"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"First"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"one"}]}]}]}]});
        assert_eq!(adf_text(&adf).trim(), "First\n- one");
        let issues = parse_jira(r#"{"issues":[{"key":"ABC-1","fields":{"summary":"S","status":{"name":"To Do"},"issuetype":{"name":"Bug"},"labels":["x"],"description":"plain"}}]}"#, "team.atlassian.net").unwrap();
        assert_eq!((issues[0].url.as_str(), issues[0].status.as_str(), issues[0].body.as_str()), ("https://team.atlassian.net/browse/ABC-1", "To Do", "plain"));
    }
}
