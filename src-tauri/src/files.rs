//! The working tree as plain files, for the Files tab: list one folder, read a text
//! file, save it back. Paths are repository-relative with `/` separators and can
//! never leave the repository or reach into `.git`.

use crate::error::{AppError, Result};
use crate::git::Git;
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// Files larger than this are not opened in the editor.
const MAX_FILE_BYTES: u64 = 2_000_000;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TreeEntry {
    pub name: String,
    /// Repository-relative, `/` separated.
    pub path: String,
    pub is_dir: bool,
    /// Matched by a .gitignore rule; shown dimmed.
    pub ignored: bool,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub text: String,
    /// Not UTF-8 text; nothing to edit.
    pub binary: bool,
    pub too_large: bool,
    pub size: u64,
}

/// Turn a repository-relative path into a real one, refusing anything that is not
/// plainly inside the repository (absolute paths, `..`, `.git`, symlinks leading out).
pub(crate) fn resolve(root: &Path, rel: &str) -> Result<PathBuf> {
    let outside = || AppError::msg("That path is outside the repository");
    let rel_path = Path::new(rel);
    let mut first = true;
    for part in rel_path.components() {
        match part {
            Component::Normal(name) => {
                if first && name.to_string_lossy().eq_ignore_ascii_case(".git") {
                    return Err(outside());
                }
                first = false;
            }
            _ => return Err(outside()),
        }
    }
    let root = root.canonicalize()?;
    let full = root.join(rel_path).canonicalize().map_err(|_| AppError::msg(format!("{rel} no longer exists")))?;
    if !full.starts_with(&root) || full.starts_with(root.join(".git")) {
        return Err(outside());
    }
    Ok(full)
}

/// Whether two paths name the same folder, however each is spelled.
pub fn same_dir(a: &Path, b: &Path) -> bool {
    matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

/// The entries of one folder (`""` is the repository root): folders first, then by name.
pub fn list_dir(git: &Git, rel: &str) -> Result<Vec<TreeEntry>> {
    let dir = resolve(&git.dir, rel)?;
    if !dir.is_dir() {
        return Err(AppError::msg(format!("{rel} is not a folder")));
    }
    let mut entries = Vec::new();
    for item in std::fs::read_dir(&dir)? {
        let item = item?;
        let name = item.file_name().to_string_lossy().to_string();
        if rel.is_empty() && name.eq_ignore_ascii_case(".git") {
            continue;
        }
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        // `is_dir` follows symlinks, so a linked folder still opens as one.
        entries.push(TreeEntry { name, path, is_dir: item.path().is_dir(), ignored: false });
    }
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.name.cmp(&b.name)));

    let paths: Vec<String> = entries.iter().map(|e| e.path.clone()).collect();
    let hidden = git.ignored(&paths);
    for entry in &mut entries {
        entry.ignored = hidden.contains(&entry.path);
    }
    Ok(entries)
}

pub fn read_file(git: &Git, rel: &str) -> Result<FileContent> {
    let path = resolve(&git.dir, rel)?;
    let meta = std::fs::metadata(&path)?;
    if !meta.is_file() {
        return Err(AppError::msg(format!("{rel} is not a file")));
    }
    let size = meta.len();
    if size > MAX_FILE_BYTES {
        return Ok(FileContent { too_large: true, size, ..Default::default() });
    }
    let bytes = std::fs::read(&path)?;
    if bytes.contains(&0) {
        return Ok(FileContent { binary: true, size, ..Default::default() });
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(FileContent { text, size, ..Default::default() }),
        Err(_) => Ok(FileContent { binary: true, size, ..Default::default() }),
    }
}

/// Save over an existing file. The editor only ever saves files it opened, so a
/// path that does not exist any more is an error rather than a new file.
pub fn write_file(git: &Git, rel: &str, text: &str) -> Result<()> {
    let path = resolve(&git.dir, rel)?;
    if !path.is_file() {
        return Err(AppError::msg(format!("{rel} is not a file")));
    }
    std::fs::write(&path, text)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Git {
        let dir = std::env::temp_dir().join(format!("studio-files-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        Git::init(&dir).unwrap();
        Git::at(dir)
    }

    fn names(entries: &[TreeEntry]) -> Vec<&str> {
        entries.iter().map(|e| e.path.as_str()).collect()
    }

    #[test]
    fn lists_folders_first_and_marks_ignored() {
        let g = scratch("list");
        std::fs::create_dir_all(g.dir.join("src/deep")).unwrap();
        std::fs::create_dir_all(g.dir.join("node_modules/pkg")).unwrap();
        std::fs::write(g.dir.join("src/b.ts"), "b").unwrap();
        std::fs::write(g.dir.join("src/A.ts"), "a").unwrap();
        std::fs::write(g.dir.join("README.md"), "# hi\n").unwrap();
        std::fs::write(g.dir.join("debug.log"), "x").unwrap();
        std::fs::write(g.dir.join(".gitignore"), "node_modules/\n*.log\n").unwrap();

        let root = list_dir(&g, "").unwrap();
        assert_eq!(names(&root), ["node_modules", "src", ".gitignore", "debug.log", "README.md"]);
        let ignored: Vec<&str> = root.iter().filter(|e| e.ignored).map(|e| e.path.as_str()).collect();
        assert_eq!(ignored, ["node_modules", "debug.log"]);
        assert!(root[0].is_dir && !root[2].is_dir);

        let src = list_dir(&g, "src").unwrap();
        assert_eq!(names(&src), ["src/deep", "src/A.ts", "src/b.ts"]);
        assert!(src.iter().all(|e| !e.ignored));

        let _ = std::fs::remove_dir_all(&g.dir);
    }

    #[test]
    fn reads_and_saves_text() {
        let g = scratch("rw");
        std::fs::create_dir_all(g.dir.join("src")).unwrap();
        std::fs::write(g.dir.join("src/a.txt"), "one\r\ntwo\r\n").unwrap();
        std::fs::write(g.dir.join("blob.bin"), [0u8, 159, 146, 150]).unwrap();
        std::fs::write(g.dir.join("latin1.txt"), [b'c', b'a', b'f', 0xe9]).unwrap();

        let a = read_file(&g, "src/a.txt").unwrap();
        assert_eq!((a.text.as_str(), a.binary, a.too_large, a.size), ("one\r\ntwo\r\n", false, false, 10));
        assert!(read_file(&g, "blob.bin").unwrap().binary);
        assert!(read_file(&g, "latin1.txt").unwrap().binary);

        write_file(&g, "src/a.txt", "three\n").unwrap();
        assert_eq!(std::fs::read_to_string(g.dir.join("src/a.txt")).unwrap(), "three\n");
        // Saving never creates a file.
        assert!(write_file(&g, "src/new.txt", "x").is_err());
        assert!(!g.dir.join("src/new.txt").exists());

        let big = g.dir.join("big.txt");
        std::fs::write(&big, vec![b'a'; MAX_FILE_BYTES as usize + 1]).unwrap();
        let b = read_file(&g, "big.txt").unwrap();
        assert!(b.too_large && b.text.is_empty());

        let _ = std::fs::remove_dir_all(&g.dir);
    }

    #[test]
    fn stays_inside_the_repository() {
        let g = scratch("jail");
        let outside = g.dir.with_extension("outside");
        std::fs::write(&outside, "secret").unwrap();
        std::fs::write(g.dir.join("ok.txt"), "ok").unwrap();

        for bad in ["../x", "/etc/passwd", ".git/config", ".GIT/config", "a/../../x", "./ok.txt"] {
            assert!(read_file(&g, bad).is_err(), "{bad}");
            assert!(write_file(&g, bad, "x").is_err(), "{bad}");
        }
        assert!(list_dir(&g, ".git").is_err());
        assert!(list_dir(&g, "..").is_err());

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&outside, g.dir.join("link.txt")).unwrap();
            assert!(read_file(&g, "link.txt").is_err());
            assert!(write_file(&g, "link.txt", "x").is_err());
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "secret");
        }
        assert!(list_dir(&g, "").unwrap().iter().all(|e| e.name != ".git"));
        assert!(same_dir(&g.dir, &g.dir) && !same_dir(&g.dir, g.dir.parent().unwrap()) && !same_dir(&g.dir, Path::new("/no/such/dir")));

        let _ = std::fs::remove_dir_all(&g.dir);
        let _ = std::fs::remove_file(&outside);
    }
}
