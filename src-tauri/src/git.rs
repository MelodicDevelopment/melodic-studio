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

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,
    /// modified | added | deleted | renamed | untracked | conflicted
    pub status: String,
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
    /// Where the remote is hosted, when the URL is one we recognise.
    pub host: Option<Host>,
    pub files: Vec<FileChange>,
    pub merge_in_progress: bool,
    pub rebase_in_progress: bool,
    /// merge | rebase | cherry-pick | revert, when one is stopped half way.
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
        // Nothing here can answer an editor; accept the message git proposes.
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true");
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    c
}

/// Run git; `ok_codes` lists exit codes besides 0 that still mean success.
fn exec(mut c: Command, stdin: Option<&[u8]>, ok_codes: &[i32]) -> Result<String> {
    if stdin.is_some() {
        c.stdin(Stdio::piped());
    }
    let mut child = c.spawn().map_err(|e| AppError::Git(format!("could not run git: {e}")))?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input)?;
        }
    }
    let out = child.wait_with_output()?;
    if out.status.success() || out.status.code().is_some_and(|code| ok_codes.contains(&code)) {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let msg = if err.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { err };
        Err(AppError::Git(msg))
    }
}

/// Branch and ref names go on the command line; refuse anything that could be read as an option.
fn check_ref(name: &str) -> Result<()> {
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
        let mut out = Vec::new();
        // Small batches: `exec` writes all of stdin before reading any output.
        for chunk in paths.chunks(200) {
            let mut c = base_command();
            c.env_remove("GIT_LITERAL_PATHSPECS").current_dir(&self.dir).args(["check-ignore", "-z", "--stdin"]);
            // Exit code 1 only means none of them is ignored.
            if let Ok(text) = exec(c, Some(chunk.join("\0").as_bytes()), &[1]) {
                out.extend(text.split('\0').filter(|p| !p.is_empty()).map(str::to_string));
            }
        }
        out
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

    /// The top-level directory of the repository containing `dir`.
    pub fn toplevel(dir: &Path) -> Result<PathBuf> {
        if !dir.is_dir() {
            return Err(AppError::msg("That folder does not exist"));
        }
        let out = Git::at(dir).run(&["rev-parse", "--show-toplevel"]).map_err(|_| AppError::msg("That folder is not a git repository"))?;
        Ok(PathBuf::from(out.trim()))
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

        let git_dir = self.git_dir();
        st.merge_in_progress = git_dir.join("MERGE_HEAD").exists();
        st.rebase_in_progress = git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists();
        st.operation = if st.merge_in_progress {
            Some("merge")
        } else if st.rebase_in_progress {
            Some("rebase")
        } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick")
        } else if git_dir.join("REVERT_HEAD").exists() {
            Some("revert")
        } else {
            None
        }
        .map(String::from);
        st.stashes = self.stashes();
        st.last_fetched = std::fs::metadata(git_dir.join("FETCH_HEAD"))
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
            // `--no-index` exits 1 when the files differ, which is always.
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
                        trash::delete(&full).or_else(|_| std::fs::remove_file(&full)).map_err(|e| AppError::msg(format!("Could not remove {path}: {e}")))?;
                    }
                }
            }
        }
        Ok(())
    }

    // ---- history ------------------------------------------------------------

    pub fn log(&self, skip: usize, limit: usize) -> Result<Vec<Commit>> {
        if !self.has_commits() {
            return Ok(vec![]);
        }
        let unpushed: std::collections::HashSet<String> = self
            .run(&["rev-list", "--max-count=2000", "HEAD", "--not", "--remotes"])
            .map(|s| s.lines().map(|l| l.trim().to_string()).collect())
            .unwrap_or_default();
        let n = format!("--max-count={limit}");
        let s = format!("--skip={skip}");
        let out = self.run(&["log", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%D%x1f%s%x1f%b%x1e", &n, &s])?;
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
            "--format=%(refname)%1f%(refname:short)%1f%(upstream:short)%1f%(committerdate:iso-strict)%1f%(HEAD)",
            "refs/heads",
            "refs/remotes",
        ])?;
        Ok(out
            .lines()
            .filter_map(|line| {
                let f: Vec<&str> = line.split('\x1f').collect();
                if f.len() < 5 {
                    return None;
                }
                let is_remote = f[0].starts_with("refs/remotes/");
                if is_remote && (f[0].ends_with("/HEAD") || !f[1].contains('/')) {
                    return None;
                }
                Some(Branch {
                    name: f[1].to_string(),
                    is_remote,
                    is_current: f[4] == "*",
                    upstream: Some(f[2].to_string()).filter(|s| !s.is_empty()),
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

    pub fn branch_delete(&self, name: &str, force: bool) -> Result<()> {
        check_ref(name)?;
        self.run(&["branch", if force { "-D" } else { "-d" }, name]).map(|_| ())
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

    /// Copy `hash` onto the current branch.
    pub fn cherry_pick(&self, hash: &str) -> Result<()> {
        check_ref(hash)?;
        self.or_conflict(self.run(&["cherry-pick", hash])).map(|_| ())
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
        let d = self.git_dir();
        if d.join("MERGE_HEAD").exists() {
            Some("merge")
        } else if d.join("rebase-merge").exists() || d.join("rebase-apply").exists() {
            Some("rebase")
        } else if d.join("CHERRY_PICK_HEAD").exists() {
            Some("cherry-pick")
        } else if d.join("REVERT_HEAD").exists() {
            Some("revert")
        } else {
            None
        }
    }

    /// Give up on the merge, rebase, cherry-pick or revert that is stopped half way.
    pub fn op_abort(&self) -> Result<()> {
        let op = self.operation().ok_or_else(|| AppError::msg("Nothing is in progress"))?;
        self.run(&[op, "--abort"]).map(|_| ())
    }

    /// Stage everything as resolved and carry on with the stopped operation.
    pub fn op_continue(&self) -> Result<()> {
        let op = self.operation().ok_or_else(|| AppError::msg("Nothing is in progress"))?;
        self.run(&["add", "-A"])?;
        let result = if op == "merge" { self.run(&["commit", "-q", "--no-edit"]) } else { self.run(&[op, "--continue"]) };
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
        if left.contains('/') {
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

/// The folder name a clone of `url` gets.
pub fn repo_name(url: &str) -> String {
    let u = url.trim().trim_end_matches('/');
    let u = u.strip_suffix(".git").unwrap_or(u);
    u.rsplit(['/', ':']).next().unwrap_or("repository").to_string()
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
        dir
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
        assert_eq!(repo_name("git@github.com:owner/repo.git"), "repo");
        assert_eq!(repo_name("https://github.com/owner/thing/"), "thing");
    }

    #[test]
    fn commit_only_selected_then_undo_and_discard() {
        let dir = scratch("flow");
        let g = Git::at(&dir);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("b *.txt"), "two\n").unwrap();

        let st = g.status().unwrap();
        assert!(!st.has_commits);
        assert_eq!(st.files.len(), 2);
        assert!(st.files.iter().all(|f| f.status == "untracked"));
        assert!(g.diff_worktree("a.txt", None, "untracked").unwrap().text.contains("+one"));

        g.commit(&["a.txt".into()], "Add a", "", false).unwrap();
        let st = g.status().unwrap();
        assert!(st.has_commits);
        assert_eq!(st.files.len(), 1, "only the unselected file is left");
        assert_eq!(st.files[0].path, "b *.txt");
        assert_eq!(st.undo.as_ref().map(|u| u.summary.as_str()), Some("Add a"));

        g.commit(&["b *.txt".into()], "Add b", "Body text", false).unwrap();
        let log = g.log(0, 10).unwrap();
        assert_eq!(log.len(), 2);
        assert_eq!(log[0].summary, "Add b");
        assert_eq!(log[0].body, "Body text");
        assert!(log[0].unpushed);
        let files = g.commit_files(&log[0].hash).unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].status, "added");
        assert!(g.diff_commit(&log[0].hash, "b *.txt", None).unwrap().text.contains("+two"));
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
        g.discard(&[FileRef { path: "a.txt".into(), old_path: None }, FileRef { path: "b *.txt".into(), old_path: None }]).unwrap();
        assert!(g.status().unwrap().files.is_empty());
        assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
        assert!(!dir.join("b *.txt").exists());

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
        g.branch_delete("feature-2", false).unwrap();
        assert_eq!(g.branches().unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
