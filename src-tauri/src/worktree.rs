//! Git worktrees: extra checkouts of one repository, each on its own branch.
//! One of them (or the main checkout) is "active": every other command in the
//! app operates on the active one, so reviewing an agent's branch is just a switch.

use crate::commands::{main_repo, save_worktree};
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: Option<String>,
    pub head: String,
    /// The repository's original checkout.
    pub is_main: bool,
    /// The one the rest of the app is looking at.
    pub active: bool,
    /// Uncommitted files in it.
    pub changes: usize,
}

pub fn list(git: &Git) -> Result<Vec<Worktree>> {
    let out = git.run(&["worktree", "list", "--porcelain"])?;
    let mut trees = vec![];
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut head = String::new();
        let mut usable = true;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                path = Some(p.to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" || line.starts_with("prunable") {
                usable = false;
            }
        }
        if let (Some(path), true) = (path, usable) {
            let changes = Git::at(&path).run(&["status", "--porcelain"]).map(|s| s.lines().count()).unwrap_or(0);
            trees.push(Worktree { path, branch, head, is_main: trees.is_empty(), active: false, changes });
        }
    }
    Ok(trees)
}

/// Is `dir` the main checkout or one of its worktrees?
pub fn belongs(git: &Git, dir: &Path) -> bool {
    let want = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    list(git).map(|trees| trees.iter().any(|t| Path::new(&t.path).canonicalize().map(|p| p == want).unwrap_or(false))).unwrap_or(false)
}

fn slug(branch: &str) -> String {
    let s: String = branch.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' }).collect();
    s.trim_matches('-').to_string()
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') || name.contains(char::is_whitespace) || name.contains("..") {
        return Err(AppError::msg(format!("\"{name}\" is not a valid name")));
    }
    Ok(())
}

/// Check out `branch` in a new folder beside the repository (`<repo>.worktrees/<branch>`),
/// creating the branch from `base` (or the current commit) when it does not exist yet.
pub fn add(git: &Git, branch: &str, base: Option<&str>) -> Result<PathBuf> {
    check_name(branch)?;
    let name = git.dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "repo".into());
    let root = git.dir.parent().unwrap_or(&git.dir).join(format!("{name}.worktrees"));
    let dest = root.join(slug(branch));
    if dest.exists() {
        return Err(AppError::msg(format!("{} already exists", dest.display())));
    }
    std::fs::create_dir_all(&root)?;
    let dest_str = dest.to_string_lossy().to_string();
    if git.run(&["rev-parse", "--verify", "-q", &format!("refs/heads/{branch}")]).is_ok() {
        git.run(&["worktree", "add", "-q", &dest_str, branch])?;
    } else {
        let mut args = vec!["worktree", "add", "-q", "-b", branch, &dest_str];
        if let Some(base) = base {
            check_name(base)?;
            args.push(base);
        }
        git.run(&args)?;
    }
    Ok(dest)
}

pub fn remove(git: &Git, path: &str, force: bool, delete_branch: bool) -> Result<()> {
    let trees = list(git)?;
    // Compare real paths: /var and /private/var are the same folder on macOS.
    let real = |p: &str| Path::new(p).canonicalize().unwrap_or_else(|_| PathBuf::from(p));
    let want = real(path);
    let tree = trees.iter().find(|t| real(&t.path) == want).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
    let path = tree.path.as_str();
    if tree.is_main {
        return Err(AppError::msg("The main checkout cannot be removed"));
    }
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    git.run(&args)?;
    if let (true, Some(branch)) = (delete_branch, tree.branch.as_deref()) {
        git.run(&["branch", if force { "-D" } else { "-d" }, branch])?;
    }
    Ok(())
}

// ---- what a checkout has done since a commit --------------------------------

/// Past this much diff text the rest of the files are listed without their diffs.
const MAX_COMPARE_BYTES: usize = 1_500_000;
/// Untracked files each cost a git call; a checkout full of build output is not worth thousands.
const MAX_UNTRACKED_DIFFS: usize = 300;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    /// modified | added | deleted | renamed | untracked
    pub status: String,
    /// This file's unified diff. Empty when the whole comparison grew too large to send.
    pub diff: String,
}

/// Everything a checkout holds that `base` does not: commits made since, staged and
/// unstaged edits, and untracked files.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDiff {
    pub base: String,
    pub head: String,
    pub files: Vec<ChangedFile>,
    /// Some diffs were left out; the file list is still complete.
    pub too_large: bool,
}

/// One section per file of a multi-file `git diff`. A line starting `diff --git ` is always a
/// header: inside a hunk every line starts with a space, `+`, `-` or a backslash.
fn sections(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for line in text.split_inclusive('\n') {
        if line.starts_with("diff --git ") || out.is_empty() {
            out.push(String::new());
        }
        if let Some(last) = out.last_mut() {
            last.push_str(line);
        }
    }
    out
}

/// The working tree of `tree` against the commit `base`. Reads only: the index and the
/// files are left exactly as they are, so it is safe while an agent is still working there.
pub fn diff_since(tree: &Git, base: &str) -> Result<WorktreeDiff> {
    check_name(base)?;
    let base = tree.run(&["rev-parse", "--verify", "-q", &format!("{base}^{{commit}}")])?.trim().to_string();
    let head = tree.run(&["rev-parse", "--verify", "-q", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();

    // Tracked files: committed, staged and unstaged changes in one comparison.
    let names = tree.run(&["diff", "--name-status", "-M", "-z", &base])?;
    let mut files = vec![];
    let mut tokens = names.split('\0').filter(|t| !t.is_empty());
    while let Some(code) = tokens.next() {
        let kind = code.as_bytes()[0];
        let old_path = if kind == b'R' || kind == b'C' { tokens.next().map(String::from) } else { None };
        let Some(path) = tokens.next() else { break };
        let status = match kind {
            b'R' => "renamed",
            b'A' | b'C' => "added",
            b'D' => "deleted",
            _ => "modified",
        };
        files.push(ChangedFile { path: path.to_string(), old_path: old_path.filter(|_| kind == b'R'), status: status.into(), diff: String::new() });
    }
    let text = tree.run(&["diff", "--no-color", "--no-ext-diff", "-M", &base])?;
    let mut too_large = text.len() > MAX_COMPARE_BYTES;
    let mut size = text.len();
    if !too_large {
        let parts = sections(&text);
        if parts.len() == files.len() {
            for (file, part) in files.iter_mut().zip(parts) {
                file.diff = part;
            }
        } else {
            // Something git prints differently (an unmerged path, say): ask file by file.
            for file in files.iter_mut() {
                let mut args = vec!["diff", "--no-color", "--no-ext-diff", "-M", &base, "--"];
                if let Some(old) = file.old_path.as_deref() {
                    args.push(old);
                }
                args.push(&file.path);
                file.diff = tree.run(&args).unwrap_or_default();
            }
        }
    }

    // Untracked files (ignored ones excluded) are new work too.
    let others = tree.run(&["ls-files", "--others", "--exclude-standard", "-z"])?;
    for (n, path) in others.split('\0').filter(|p| !p.is_empty()).enumerate() {
        let mut diff = String::new();
        if !too_large && n < MAX_UNTRACKED_DIFFS {
            match tree.diff_worktree(path, None, "untracked") {
                Ok(d) if !d.too_large && size + d.text.len() <= MAX_COMPARE_BYTES => {
                    size += d.text.len();
                    diff = d.text;
                }
                Ok(_) => too_large = true,
                Err(_) => {} // gone again between the listing and the read
            }
        } else {
            too_large = true;
        }
        files.push(ChangedFile { path: path.to_string(), old_path: None, status: "untracked".into(), diff });
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(WorktreeDiff { base, head, files, too_large })
}

/// Where a checkout parted from the main one, for sessions that did not record their starting commit.
fn fork_point(main: &Git, tree: &Git) -> Result<String> {
    let trunk = main.run(&["rev-parse", "--verify", "-q", "HEAD"])?;
    Ok(tree.run(&["merge-base", "HEAD", trunk.trim()])?.trim().to_string())
}

// ---- commands ---------------------------------------------------------------

#[tauri::command]
pub async fn worktree_list(state: State<'_, AppState>, id: String) -> Result<Vec<Worktree>> {
    let (git, active) = main_repo(&state, &id)?;
    let mut trees = list(&git)?;
    let active = active.map(|p| p.to_string_lossy().to_string());
    for t in trees.iter_mut() {
        t.active = match &active {
            Some(a) => &t.path == a,
            None => t.is_main,
        };
    }
    if !trees.iter().any(|t| t.active) {
        if let Some(main) = trees.first_mut() {
            main.active = true;
        }
    }
    Ok(trees)
}

#[tauri::command]
pub async fn worktree_add(state: State<'_, AppState>, id: String, branch: String, base: Option<String>) -> Result<String> {
    let (git, _) = main_repo(&state, &id)?;
    Ok(add(&git, branch.trim(), base.as_deref())?.to_string_lossy().to_string())
}

/// Point the app at a worktree (`path`) or back at the main checkout (`None`).
#[tauri::command]
pub async fn worktree_select(state: State<'_, AppState>, id: String, path: Option<String>) -> Result<()> {
    let (git, _) = main_repo(&state, &id)?;
    let target = match path {
        Some(p) => {
            let tree = list(&git)?.into_iter().find(|t| t.path == p).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
            (!tree.is_main).then(|| PathBuf::from(tree.path))
        }
        None => None,
    };
    save_worktree(&state, &id, target)
}

#[tauri::command]
pub async fn worktree_remove(state: State<'_, AppState>, id: String, path: String, force: bool, delete_branch: bool) -> Result<()> {
    let (git, active) = main_repo(&state, &id)?;
    remove(&git, &path, force, delete_branch)?;
    if active.is_some_and(|a| a.to_string_lossy() == path) {
        save_worktree(&state, &id, None)?;
    }
    Ok(())
}

/// What the checkout at `path` has changed since `base` (a commit; when missing, the point
/// where it left the main checkout's branch), uncommitted and untracked work included.
#[tauri::command]
pub async fn worktree_diff(state: State<'_, AppState>, id: String, path: String, base: Option<String>) -> Result<WorktreeDiff> {
    let (git, _) = main_repo(&state, &id)?;
    let real = |p: &str| Path::new(p).canonicalize().unwrap_or_else(|_| PathBuf::from(p));
    let want = real(&path);
    let found = list(&git)?.into_iter().find(|t| real(&t.path) == want).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
    let tree = Git::at(&found.path);
    let base = match base.map(|b| b.trim().to_string()).filter(|b| !b.is_empty()) {
        Some(b) => b,
        None => fork_point(&git, &tree)?,
    };
    diff_since(&tree, &base)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_list_remove() {
        let base = std::env::temp_dir().join(format!("studio-worktree-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("proj");
        let g = Git::init(&dir).unwrap();
        for (k, v) in [("user.name", "Test"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
            g.run(&["config", k, v]).unwrap();
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        g.commit(&["a.txt".into()], "One", "", false).unwrap();

        let path = add(&g, "agent/fix thing".replace(' ', "-").as_str(), None).unwrap();
        assert!(path.ends_with("proj.worktrees/agent-fix-thing"));
        assert!(path.join("a.txt").exists());
        assert!(belongs(&g, &path));
        assert!(!belongs(&g, &base));

        std::fs::write(path.join("b.txt"), "two\n").unwrap();
        let trees = list(&g).unwrap();
        assert_eq!(trees.len(), 2);
        assert!(trees[0].is_main && !trees[1].is_main);
        assert_eq!(trees[1].branch.as_deref(), Some("agent/fix-thing"));
        assert_eq!(trees[1].changes, 1);

        let p = path.to_string_lossy().to_string();
        assert!(remove(&g, &p, false, false).is_err(), "dirty worktrees need force");
        assert!(remove(&g, &trees[0].path, true, false).is_err(), "never the main checkout");
        remove(&g, &p, true, true).unwrap();
        assert_eq!(list(&g).unwrap().len(), 1);
        assert_eq!(g.branches().unwrap().len(), 1);
        assert!(add(&g, "-bad", None).is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn diff_since_start_includes_uncommitted_and_untracked() {
        let base = std::env::temp_dir().join(format!("studio-attempt-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let dir = base.join("proj");
        let g = Git::init(&dir).unwrap();
        for (k, v) in [("user.name", "Test"), ("user.email", "t@example.com"), ("commit.gpgsign", "false")] {
            g.run(&["config", k, v]).unwrap();
        }
        std::fs::write(dir.join("a.txt"), "one\ntwo\nthree\n").unwrap();
        std::fs::write(dir.join("old name.txt"), "a file that will be renamed\nand keeps its text\n").unwrap();
        std::fs::write(dir.join("gone.txt"), "bye\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        g.commit(&["a.txt".into(), "old name.txt".into(), "gone.txt".into(), ".gitignore".into()], "Start", "", false).unwrap();
        let start = g.run(&["rev-parse", "HEAD"]).unwrap().trim().to_string();

        let path = add(&g, "agent/try", None).unwrap();
        let tree = Git::at(&path);
        assert!(diff_since(&tree, &start).unwrap().files.is_empty(), "a fresh worktree has done nothing");

        // The agent commits one edit...
        std::fs::write(path.join("a.txt"), "one\nTWO\nthree\n").unwrap();
        tree.commit(&["a.txt".into()], "Shout", "", false).unwrap();
        // ...then leaves more behind: an unstaged edit, a staged rename, a deletion, a new file, an ignored one.
        std::fs::write(path.join("a.txt"), "one\nTWO\nthree\nfour\n").unwrap();
        tree.run(&["mv", "old name.txt", "new name.txt"]).unwrap();
        std::fs::remove_file(path.join("gone.txt")).unwrap();
        std::fs::create_dir_all(path.join("src")).unwrap();
        std::fs::write(path.join("src").join("new *.txt"), "brand new\n").unwrap();
        std::fs::write(path.join("debug.log"), "noise\n").unwrap();
        let status = tree.run(&["status", "--porcelain"]).unwrap();

        let d = diff_since(&tree, &start).unwrap();
        assert_eq!(d.base, start);
        assert_ne!(d.head, start);
        assert!(!d.too_large);
        let seen: Vec<(&str, &str)> = d.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect();
        assert_eq!(seen, [("a.txt", "modified"), ("gone.txt", "deleted"), ("new name.txt", "renamed"), ("src/new *.txt", "untracked")]);
        let file = |p: &str| d.files.iter().find(|f| f.path == p).unwrap();
        // Committed and uncommitted work on the same file arrive as one diff against the start.
        assert!(file("a.txt").diff.starts_with("diff --git "));
        assert!(file("a.txt").diff.contains("-two\n+TWO\n") && file("a.txt").diff.contains("+four\n"));
        assert!(!file("a.txt").diff.contains("gone.txt"), "each file carries only its own section");
        assert!(file("gone.txt").diff.contains("-bye"));
        assert_eq!(file("new name.txt").old_path.as_deref(), Some("old name.txt"));
        assert!(file("src/new *.txt").diff.contains("+brand new"));
        assert_eq!(tree.run(&["status", "--porcelain"]).unwrap(), status, "comparing changes nothing in the checkout");

        // Without a recorded start, the point where the branch left the main checkout is used.
        assert_eq!(fork_point(&g, &tree).unwrap(), start);
        std::fs::write(dir.join("main.txt"), "meanwhile\n").unwrap();
        g.commit(&["main.txt".into()], "Meanwhile on main", "", false).unwrap();
        assert_eq!(fork_point(&g, &tree).unwrap(), start);
        assert!(diff_since(&tree, "-bad").is_err());
        assert!(diff_since(&tree, "no-such-commit").is_err());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn diff_sections() {
        assert!(sections("").is_empty());
        let two = "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-diff --git a/y b/y\n+z\ndiff --git a/y b/y\nBinary files differ\n";
        let parts = sections(two);
        assert_eq!(parts.len(), 2);
        assert!(parts[0].ends_with("+z\n") && parts[1].starts_with("diff --git a/y"));
    }
}
