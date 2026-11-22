//! What Studio does itself between a task's Claude turns (`src/services/pipeline.store.ts`): commit and
//! push the agent's work on its own branch, run the project's tests in the agent's worktree, and read
//! the diff its review covers. Every command takes the checkout it works in and refuses one that is not
//! a worktree of the repository; the tests are targets read again from the project files
//! (`targets.rs`), so a command line never comes from the window.

use crate::ai_git::{review_diff, ReviewDiff};
use crate::commands::main_repo;
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::targets::{self, Kind, Target};
use crate::{proc, run, terminal, worktree, AppState};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

/// A test run that takes longer than this is stopped and counts as failed.
const TEST_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// How much of a test run's output is kept: the end, where runners print what failed and the totals.
const KEEP_OUTPUT: usize = 48 * 1024;

/// Test runs in progress, by the key the window gave them, so Stop can end one.
#[derive(Default)]
pub struct Tests(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestRun {
    pub ok: bool,
    /// None when it was stopped, timed out or killed by a signal.
    pub code: Option<i32>,
    /// The end of what it printed, stdout then stderr.
    pub output: String,
    pub command: String,
    pub millis: u64,
    pub timed_out: bool,
    pub stopped: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Committed {
    /// False when there was nothing to commit.
    pub committed: bool,
    pub head: String,
    pub pushed: bool,
    /// Why the push did not happen (no remote, rejected, signed out), in git's words.
    pub push_error: Option<String>,
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Cleaned {
    pub removed_tree: bool,
    pub deleted_branch: bool,
    /// The remote copies deleted, as `origin/agent/x`.
    pub deleted_remote: Vec<String>,
    /// What could not be done (a push that was refused), in git's words.
    pub problems: Vec<String>,
}

/// Clean up after a task: its worktree (with anything uncommitted in it), its branch, and the copies of the
/// branch it pushed. Refuses the main checkout, a branch the main checkout has, and the remote's default branch.
fn clean_up(git: &Git, cwd: &str, branch: &str) -> Result<Cleaned> {
    crate::git::check_ref(branch)?;
    let mut done = Cleaned::default();
    let trees = worktree::entries(git)?;
    if trees.iter().any(|t| t.is_main && t.branch.as_deref() == Some(branch)) {
        return Err(AppError::msg(format!("{branch} is the main checkout's branch, so it is left alone")));
    }
    let defaults: Vec<String> = git.run(&["for-each-ref", "--format=%(symref:short)", "refs/remotes/*/HEAD"]).unwrap_or_default().lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    if let Some(tree) = trees.iter().find(|t| !t.is_main && crate::paths::same(&t.path, cwd)) {
        let path = tree.path.clone();
        worktree::remove(git, &path, true, false)?;
        done.removed_tree = true;
    }
    // The remote copies first: once the local branch is gone, nothing says which of them were ours.
    let remotes = git.run(&["for-each-ref", "--format=%(refname:short)", "refs/remotes"]).unwrap_or_default();
    for name in remotes.lines().map(str::trim).filter(|r| r.split_once('/').is_some_and(|(_, b)| b == branch)) {
        if defaults.iter().any(|d| d == name) {
            continue;
        }
        match git.branch_delete_remote(name) {
            Ok(()) => done.deleted_remote.push(name.to_string()),
            Err(e) => done.problems.push(format!("{name} was not deleted: {e}")),
        }
    }
    if git.run(&["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_ok() {
        match git.run(&["branch", "-D", branch]) {
            Ok(_) => done.deleted_branch = true,
            Err(e) => done.problems.push(format!("{branch} was not deleted: {e}")),
        }
    }
    Ok(done)
}

/// A worktree of repository `id` that is not the main checkout: the only place a task's pipeline works.
fn agent_tree(state: &State<'_, AppState>, id: &str, cwd: &str) -> Result<Git> {
    let (git, _) = main_repo(state, id)?;
    let tree = worktree::entries(&git)?.into_iter().find(|t| crate::paths::same(&t.path, cwd)).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
    if tree.is_main {
        return Err(AppError::msg("A task's steps run in its own worktree, not the main checkout"));
    }
    Ok(Git::at(&tree.path))
}

/// The last `max` bytes of `text`, starting at a line where it can.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut start = text.len() - max;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let cut = &text[start..];
    let cut = cut.find('\n').map(|i| &cut[i + 1..]).unwrap_or(cut);
    format!("[… the start of the output was cut]\n{cut}")
}

/// Everything from a pipe, keeping only the end.
fn drain(pipe: Option<impl Read + Send + 'static>) -> std::sync::mpsc::Receiver<String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut kept: Vec<u8> = Vec::new();
        if let Some(mut pipe) = pipe {
            let mut buf = [0u8; 8192];
            while let Ok(n) = pipe.read(&mut buf) {
                if n == 0 {
                    break;
                }
                kept.extend_from_slice(&buf[..n]);
                if kept.len() > KEEP_OUTPUT * 2 {
                    kept.drain(..kept.len() - KEEP_OUTPUT);
                }
            }
        }
        let _ = tx.send(String::from_utf8_lossy(&kept).to_string());
    });
    rx
}

/// Run `target` in `checkout` to the end (or the timeout, or Stop), with output captured.
fn run_target(tests: &Tests, key: &str, checkout: &Path, target: &Target) -> Result<TestRun> {
    let dir: PathBuf = run::folder(checkout, target)?;
    let shell = run::program(&dir, target, &[], vec![])?;
    let mut c = proc::command(&shell.program);
    c.current_dir(&dir).args(&shell.args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    for name in terminal::CLAUDE_MARKERS {
        c.env_remove(name);
    }
    // Test runners that would otherwise watch for changes (vitest, jest --watch defaults) run once, without colour codes.
    c.env("CI", "true").env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    let started = Instant::now();
    let mut child = c.spawn().map_err(|e| AppError::msg(format!("Could not start {}: {e}", run::command_line(target, &[]))))?;
    let out = drain(child.stdout.take());
    let err = drain(child.stderr.take());
    let child = Arc::new(Mutex::new(child));
    tests.0.lock().unwrap().insert(key.to_string(), child.clone());
    let mut timed_out = false;
    let status = loop {
        {
            let mut c = child.lock().unwrap();
            if let Some(status) = c.try_wait()? {
                break Some(status);
            }
            if started.elapsed() >= TEST_TIMEOUT {
                proc::kill_tree(&mut c);
                let _ = c.wait();
                timed_out = true;
                break None;
            }
        }
        if !tests.0.lock().unwrap().contains_key(key) {
            // Stopped: `test_stop` killed it and took it off the list.
            let _ = child.lock().unwrap().wait();
            break None;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let stopped = tests.0.lock().unwrap().remove(key).is_none() && !timed_out;
    let grace = Duration::from_secs(3);
    let stdout = out.recv_timeout(grace).unwrap_or_default();
    let stderr = err.recv_timeout(grace).unwrap_or_default();
    let both = match (stdout.trim().is_empty(), stderr.trim().is_empty()) {
        (false, false) => format!("{}\n{}", stdout.trim_end(), stderr.trim_end()),
        (false, true) => stdout,
        _ => stderr,
    };
    let code = status.and_then(|s| s.code());
    Ok(TestRun {
        ok: status.is_some_and(|s| s.success()),
        code,
        output: tail(both.trim(), KEEP_OUTPUT),
        command: run::command_line(target, &[]),
        millis: started.elapsed().as_millis() as u64,
        timed_out,
        stopped,
    })
}

/// Commit everything in the checkout as the user, then push the branch when there is a remote.
fn commit_and_push(git: &Git, message: &str) -> Result<Committed> {
    let paths: Vec<String> = git.status()?.files.into_iter().map(|f| f.path).collect();
    let mut lines = message.trim().splitn(2, '\n');
    let summary = lines.next().unwrap_or("").trim();
    let description = lines.next().unwrap_or("").trim();
    let committed = !paths.is_empty();
    if committed {
        git.commit(&paths, if summary.is_empty() { "Agent work" } else { summary }, description, false)?;
    }
    let head = git.run(&["rev-parse", "HEAD"]).map(|h| h.trim().to_string()).unwrap_or_default();
    if git.default_remote().is_none() {
        return Ok(Committed { committed, head, pushed: false, push_error: Some("This repository has no remote".into()) });
    }
    match git.push(false) {
        Ok(()) => Ok(Committed { committed, head, pushed: true, push_error: None }),
        Err(e) => Ok(Committed { committed, head, pushed: false, push_error: Some(e.to_string()) }),
    }
}

/// The test targets of the project in an agent's worktree.
#[tauri::command]
pub async fn pipeline_tests(state: State<'_, AppState>, id: String, cwd: String) -> Result<Vec<Target>> {
    let git = agent_tree(&state, &id, &cwd)?;
    Ok(targets::discover(&git.dir).into_iter().filter(|t| t.kind == Kind::Test).collect())
}

/// Run test target `target` in an agent's worktree and answer how it went. `key` is what `pipeline_test_stop` takes.
#[tauri::command]
pub async fn pipeline_test_run(state: State<'_, AppState>, tests: State<'_, Arc<Tests>>, id: String, cwd: String, key: String, target: String) -> Result<TestRun> {
    let git = agent_tree(&state, &id, &cwd)?;
    let checkout = git.dir.clone();
    let target = run::find(&checkout, &target)?;
    if target.kind != Kind::Test {
        return Err(AppError::msg("That target does not run tests"));
    }
    let tests = tests.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_target(&tests, &key, &checkout, &target)).await.map_err(|e| AppError::msg(e.to_string()))?
}

#[tauri::command]
pub async fn pipeline_test_stop(tests: State<'_, Arc<Tests>>, key: String) -> Result<()> {
    if let Some(child) = tests.0.lock().unwrap().remove(&key) {
        proc::kill_tree(&mut child.lock().unwrap());
    }
    Ok(())
}

/// Commit what the agent changed in its worktree, as the user, and push its branch.
#[tauri::command]
pub async fn pipeline_commit(state: State<'_, AppState>, id: String, cwd: String, message: String) -> Result<Committed> {
    let git = agent_tree(&state, &id, &cwd)?;
    tauri::async_runtime::spawn_blocking(move || commit_and_push(&git, &message)).await.map_err(|e| AppError::msg(e.to_string()))?
}

/// After a task was merged, or given up: remove its worktree and delete its branch, here and on the remote.
#[tauri::command]
pub async fn pipeline_clean(state: State<'_, AppState>, id: String, cwd: String, branch: String) -> Result<Cleaned> {
    let (git, _) = main_repo(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || clean_up(&git, &cwd, &branch)).await.map_err(|e| AppError::msg(e.to_string()))?
}

/// What a task's review covers: everything in its worktree since the commit it started from.
#[tauri::command]
pub async fn pipeline_review_diff(state: State<'_, AppState>, id: String, cwd: String, base: Option<String>) -> Result<ReviewDiff> {
    let git = agent_tree(&state, &id, &cwd)?;
    review_diff(&git, "work", base.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets::Runtime;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-pipeline-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn git(dir: &Path, args: &[&str]) {
        let ok = std::process::Command::new("git").current_dir(dir).args(args).status().unwrap().success();
        assert!(ok, "git {args:?}");
    }

    #[test]
    fn cleans_up_the_worktree_the_branch_and_its_pushed_copy() {
        let root = scratch("clean");
        let (origin, main) = (root.join("origin.git"), root.join("main"));
        git(&root, &["init", "-q", "--bare", "-b", "main", origin.to_str().unwrap()]);
        git(&root, &["clone", "-q", origin.to_str().unwrap(), main.to_str().unwrap()]);
        for (k, v) in [("user.name", "Test"), ("user.email", "test@example.com"), ("core.autocrlf", "false")] {
            git(&main, &["config", k, v]);
        }
        std::fs::write(main.join("a.txt"), "a\n").unwrap();
        git(&main, &["add", "a.txt"]);
        git(&main, &["commit", "-q", "-m", "first"]);
        git(&main, &["push", "-q", "-u", "origin", "main"]);
        let g = Git::at(&main);
        let tree = root.join("tree");
        git(&main, &["worktree", "add", "-q", "-b", "agent/x", tree.to_str().unwrap()]);
        std::fs::write(tree.join("b.txt"), "b\n").unwrap();
        let pushed = commit_and_push(&Git::at(&tree), "Add b").unwrap();
        assert!(pushed.pushed, "{:?}", pushed.push_error);
        std::fs::write(tree.join("left.txt"), "uncommitted\n").unwrap();
        assert!(clean_up(&g, tree.to_str().unwrap(), "main").is_err(), "the main checkout's branch is refused");
        let done = clean_up(&g, tree.to_str().unwrap(), "agent/x").unwrap();
        assert!(done.removed_tree && done.deleted_branch, "{:?}", done.problems);
        assert_eq!(done.deleted_remote, vec!["origin/agent/x".to_string()]);
        assert!(!tree.exists());
        assert!(g.run(&["ls-remote", "--heads", "origin", "agent/x"]).unwrap().trim().is_empty());
        assert!(g.run(&["rev-parse", "--verify", "-q", "refs/heads/agent/x"]).is_err());
        let again = clean_up(&g, tree.to_str().unwrap(), "agent/x").unwrap();
        assert!(!again.removed_tree && !again.deleted_branch && again.deleted_remote.is_empty(), "nothing left to do");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn keeps_the_end_of_long_output() {
        let text: String = (0..20_000).map(|i| format!("line {i}\n")).collect();
        let kept = tail(&text, 1000);
        assert!(kept.len() < 1100);
        assert!(kept.starts_with("[… the start of the output was cut]\n"));
        assert!(kept.trim_end().ends_with("line 19999"));
        assert_eq!(tail("short", 1000), "short");
    }

    #[test]
    fn commits_everything_and_says_when_there_is_no_remote() {
        let dir = scratch("commit");
        git(&dir, &["init", "-q", "-b", "main"]);
        git(&dir, &["config", "user.name", "Test"]);
        git(&dir, &["config", "user.email", "test@example.com"]);
        git(&dir, &["config", "core.autocrlf", "false"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        git(&dir, &["add", "a.txt"]);
        git(&dir, &["commit", "-q", "-m", "first"]);
        std::fs::write(dir.join("a.txt"), "changed\n").unwrap();
        std::fs::write(dir.join("new.txt"), "new\n").unwrap();
        let g = Git::at(&dir);
        let done = commit_and_push(&g, "Add the new file\n\nAnd change a.").unwrap();
        assert!(done.committed);
        assert!(!done.pushed);
        assert_eq!(done.push_error.as_deref(), Some("This repository has no remote"));
        assert!(g.status().unwrap().files.is_empty(), "everything is committed");
        let log = g.run(&["log", "-1", "--format=%s%n%b"]).unwrap();
        assert!(log.starts_with("Add the new file"));
        assert!(log.contains("And change a."));
        let again = commit_and_push(&g, "Nothing").unwrap();
        assert!(!again.committed, "nothing left to commit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn runs_a_target_and_captures_how_it_ended() {
        let dir = scratch("run");
        let target = Target { id: "t".into(), name: "t".into(), group: "g".into(), cwd: String::new(), argv: vec!["git".into(), "--version".into()], kind: Kind::Test, runtime: Runtime::Node, source: String::new() };
        let tests = Tests::default();
        let run = run_target(&tests, "k", &dir, &target).unwrap();
        assert!(run.ok);
        assert_eq!(run.code, Some(0));
        assert!(run.output.contains("git version"));
        assert!(!run.stopped && !run.timed_out);
        let bad = Target { argv: vec!["git".into(), "no-such-command".into()], ..target };
        let run = run_target(&tests, "k2", &dir, &bad).unwrap();
        assert!(!run.ok);
        assert!(run.code.is_some_and(|c| c != 0));
        assert!(tests.0.lock().unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
