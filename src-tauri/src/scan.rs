//! Finding repositories under a folder the user picked (Add a repository > Scan a folder).
//! Plain directory reads, no git: a folder with a `.git` folder is a repository and is not
//! looked inside. Linked worktrees and submodules (a `.git` file) are not listed.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

/// How far below the chosen folder to look, folders to read at most, and time to spend.
pub const MAX_DEPTH: usize = 6;
pub const MAX_FOLDERS: usize = 30_000;
pub const MAX_TIME: Duration = Duration::from_secs(20);

/// Folders that never hold a repository of the user's own, or are too big to walk.
fn skipped(name: &str) -> bool {
    name.starts_with('.')
        // Our own worktrees sit beside the repository as `<repo>.worktrees`.
        || name.ends_with(".worktrees")
        || matches!(
            name,
            "node_modules" | "bower_components" | "vendor" | "target" | "__pycache__" | "venv" | "Pods" | "DerivedData" | "Library" | "AppData" | "$RECYCLE.BIN" | "System Volume Information"
        )
}

/// Repositories under `root` (or `root` itself), sorted, and whether a limit cut the search short.
pub fn find(root: &Path, max_depth: usize, max_folders: usize, max_time: Duration) -> (Vec<PathBuf>, bool) {
    let started = Instant::now();
    let mut found = Vec::new();
    let mut queue = VecDeque::from([(root.to_path_buf(), 0usize)]);
    let mut read = 0usize;
    let mut truncated = false;
    while let Some((dir, depth)) = queue.pop_front() {
        if dir.join(".git").is_dir() {
            found.push(dir);
            continue;
        }
        if depth >= max_depth {
            continue;
        }
        if read >= max_folders || started.elapsed() > max_time {
            truncated = true;
            break;
        }
        read += 1;
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            // `file_type` does not follow symlinks, so a link cannot lead the walk in circles.
            if !entry.file_type().is_ok_and(|t| t.is_dir()) {
                continue;
            }
            if entry.file_name().to_str().is_some_and(|n| !skipped(n)) {
                queue.push_back((entry.path(), depth + 1));
            }
        }
    }
    found.sort();
    (found, truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_repositories_and_skips_what_it_should() {
        let root = std::env::temp_dir().join(format!("studio-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mk = |p: &str| std::fs::create_dir_all(root.join(p)).unwrap();
        mk("a/.git");
        mk("a/nested/.git"); // inside a repository: not looked at
        mk("group/b/.git");
        mk("group/c/src");
        mk("node_modules/d/.git");
        mk(".hidden/e/.git");
        mk("a.worktrees/feature/.git");
        mk("deep/1/2/3/f/.git");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/.git"), "gitdir: elsewhere").unwrap(); // a worktree or submodule

        let (found, truncated) = find(&root, MAX_DEPTH, MAX_FOLDERS, MAX_TIME);
        assert!(!truncated);
        let rel: Vec<PathBuf> = found.iter().map(|p| p.strip_prefix(&root).unwrap().to_path_buf()).collect();
        assert_eq!(rel, vec![PathBuf::from("a"), Path::new("deep").join("1").join("2").join("3").join("f"), Path::new("group").join("b")]);

        // Depth counts from the chosen folder.
        let (shallow, _) = find(&root, 2, MAX_FOLDERS, MAX_TIME);
        assert_eq!(shallow.len(), 2);
        // The chosen folder may itself be the repository.
        assert_eq!(find(&root.join("a"), MAX_DEPTH, MAX_FOLDERS, MAX_TIME).0, vec![root.join("a")]);
        // Running out of folders to read says so.
        assert!(find(&root, MAX_DEPTH, 1, MAX_TIME).1);
        let _ = std::fs::remove_dir_all(&root);
    }
}
