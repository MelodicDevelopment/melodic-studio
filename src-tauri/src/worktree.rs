//! Git worktrees: extra checkouts of one repository, each on its own branch.
//! One of them (or the main checkout) is "active": every other command in the
//! app operates on the active one, so reviewing an agent's branch is just a switch.

use crate::commands::{main_repo, save_worktree};
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::paths;
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    /// As git lists it, in the platform's spelling (`paths::native`). This exact string is
    /// what `worktree_add` returns, so the window can match the two.
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

/// The checkouts git knows, main one first, without counting their changes.
fn entries(git: &Git) -> Result<Vec<Worktree>> {
    let out = git.run(&["worktree", "list", "--porcelain"])?;
    let mut trees = vec![];
    for block in out.split("\n\n") {
        let mut path = None;
        let mut branch = None;
        let mut head = String::new();
        let mut usable = true;
        for line in block.lines() {
            if let Some(p) = line.strip_prefix("worktree ") {
                // Git prints `C:/Users/...` on Windows; everything else here uses `C:\Users\...`.
                path = Some(paths::native(p).to_string_lossy().to_string());
            } else if let Some(h) = line.strip_prefix("HEAD ") {
                head = h.to_string();
            } else if let Some(b) = line.strip_prefix("branch ") {
                branch = Some(b.trim_start_matches("refs/heads/").to_string());
            } else if line == "bare" || line.starts_with("prunable") {
                usable = false;
            }
        }
        if let (Some(path), true) = (path, usable) {
            trees.push(Worktree { path, branch, head, is_main: trees.is_empty(), active: false, changes: 0 });
        }
    }
    Ok(trees)
}

pub fn list(git: &Git) -> Result<Vec<Worktree>> {
    let mut trees = entries(git)?;
    for tree in trees.iter_mut() {
        tree.changes = Git::at(&tree.path).run(&["status", "--porcelain"]).map(|s| s.lines().count()).unwrap_or(0);
    }
    Ok(trees)
}

/// Is `dir` the main checkout or one of its worktrees?
pub fn belongs(git: &Git, dir: &Path) -> bool {
    dir.is_dir() && entries(git).map(|trees| trees.iter().any(|t| paths::same(&t.path, dir))).unwrap_or(false)
}

/// The folder name for a branch's worktree: one path segment that every platform accepts.
fn slug(branch: &str) -> String {
    let s: String = branch.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' { c } else { '-' }).collect();
    // Windows drops trailing dots from names and reserves a handful of device names.
    let s = s.trim_matches(['-', '.']).to_string();
    let stem = s.split('.').next().unwrap_or_default().to_ascii_lowercase();
    let reserved = matches!(stem.as_str(), "con" | "prn" | "aux" | "nul") || (stem.len() == 4 && (stem.starts_with("com") || stem.starts_with("lpt")) && stem.ends_with(|c: char| c.is_ascii_digit()));
    if s.is_empty() || reserved {
        format!("branch-{s}").trim_end_matches('-').to_string()
    } else {
        s
    }
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
    // Hand back git's own name for it, so it matches what `list` reports from now on.
    let listed = entries(git).ok().and_then(|trees| trees.into_iter().find(|t| paths::same(&t.path, &dest)));
    Ok(listed.map(|t| PathBuf::from(t.path)).unwrap_or_else(|| paths::native(&dest)))
}

pub fn remove(git: &Git, path: &str, force: bool, delete_branch: bool) -> Result<()> {
    let trees = entries(git)?;
    // Not as strings: /var and /private/var are one folder on macOS, C:/x and C:\x on Windows.
    let tree = trees.iter().find(|t| paths::same(&t.path, path)).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
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

// ---- commands ---------------------------------------------------------------

#[tauri::command]
pub async fn worktree_list(state: State<'_, AppState>, id: String) -> Result<Vec<Worktree>> {
    let (git, active) = main_repo(&state, &id)?;
    let mut trees = list(&git)?;
    for t in trees.iter_mut() {
        t.active = match &active {
            Some(a) => paths::same(&t.path, a),
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
            let tree = entries(&git)?.into_iter().find(|t| paths::same(&t.path, &p)).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
            (!tree.is_main).then(|| PathBuf::from(tree.path))
        }
        None => None,
    };
    save_worktree(&state, &id, target)
}

#[tauri::command]
pub async fn worktree_remove(state: State<'_, AppState>, id: String, path: String, force: bool, delete_branch: bool) -> Result<()> {
    let (git, active) = main_repo(&state, &id)?;
    // Asked before it is gone: afterwards there is no folder left to compare.
    let was_active = active.is_some_and(|a| paths::same(a, &path));
    remove(&git, &path, force, delete_branch)?;
    if was_active {
        save_worktree(&state, &id, None)?;
    }
    Ok(())
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
        for (k, v) in [("user.name", "Test"), ("user.email", "t@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            g.run(&["config", k, v]).unwrap();
        }
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        g.commit(&["a.txt".into()], "One", "", false).unwrap();

        let path = add(&g, "agent/fix thing".replace(' ', "-").as_str(), None).unwrap();
        assert!(path.ends_with(Path::new("proj.worktrees").join("agent-fix-thing")));
        assert!(path.join("a.txt").exists());
        assert!(belongs(&g, &path));
        assert!(belongs(&g, &dir));
        assert!(!belongs(&g, &base));
        // However the folder is spelled when it comes back from the window.
        assert!(belongs(&g, &base.join("proj.worktrees").join("agent-fix-thing")));
        assert!(belongs(&g, Path::new(&format!("{}/", path.display()))));

        // A worktree's `.git` is a file; what git keeps per repository is still found from there.
        assert!(path.join(".git").is_file());
        assert!(Git::at(&path).status().unwrap().last_fetched.is_none());
        std::fs::write(dir.join(".git").join("FETCH_HEAD"), "").unwrap();
        let in_tree = Git::at(&path).status().unwrap();
        assert!(in_tree.last_fetched.is_some(), "the last fetch is the repository's, not the worktree's");
        assert_eq!(in_tree.branch, "agent/fix-thing");

        std::fs::write(path.join("b.txt"), "two\n").unwrap();
        let trees = list(&g).unwrap();
        assert_eq!(trees.len(), 2);
        assert!(trees[0].is_main && !trees[1].is_main);
        assert_eq!(trees[1].branch.as_deref(), Some("agent/fix-thing"));
        assert_eq!(trees[1].changes, 1);
        // What `add` returned is, to the character, what `list` shows: the window matches them as strings.
        assert_eq!(trees[1].path, path.to_string_lossy());
        assert!(paths::same(&trees[0].path, &dir));
        for tree in &trees {
            assert_eq!(tree.path.contains('/'), !cfg!(windows), "{} uses the platform's separators", tree.path);
        }

        let p = path.to_string_lossy().to_string();
        assert!(remove(&g, &p, false, false).is_err(), "dirty worktrees need force");
        assert!(remove(&g, &trees[0].path, true, false).is_err(), "never the main checkout");
        remove(&g, &p, true, true).unwrap();
        assert_eq!(list(&g).unwrap().len(), 1);
        assert_eq!(g.branches().unwrap().len(), 1);
        assert!(add(&g, "-bad", None).is_err());

        // A second one, removed by a differently spelled path, as the main checkout sees it.
        let other = add(&g, "topic", None).unwrap();
        remove(&g, &format!("{}/", base.join("proj.worktrees").join("topic").display()), false, true).unwrap();
        assert!(!other.exists());
        assert_eq!(list(&g).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn folder_names() {
        assert_eq!(slug("agent/fix-the-seek-bug"), "agent-fix-the-seek-bug");
        assert_eq!(slug("release/1.4"), "release-1.4");
        assert_eq!(slug("feature/ünï"), "feature--n", "only ASCII, so the name is the same on every file system");
        // Names Windows cannot create, or would silently rename.
        assert_eq!(slug("con"), "branch-con");
        assert_eq!(slug("NUL.txt"), "branch-NUL.txt");
        assert_eq!(slug("com1"), "branch-com1");
        assert_eq!(slug("common"), "common");
        assert_eq!(slug("wip..."), "wip");
        assert_eq!(slug("///"), "branch");
    }
}
