//! The working tree as plain files, for the Files tab: list one folder, read a text
//! file, save it back. Paths are repository-relative with `/` separators and can
//! never leave the repository or reach into `.git`.

use crate::error::{AppError, Result};
use crate::git::Git;
use crate::paths;
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

/// Whether a file name is `.git`, or one of the other names Windows opens `.git` by:
/// trailing dots and spaces are dropped there, `name:stream` reaches the same file, and
/// `GIT~1` is its 8.3 short name. Git refuses all of these as well (`core.protectNTFS`).
fn is_dot_git(name: &str) -> bool {
    let name = name.split(':').next().unwrap_or_default().trim_end_matches(['.', ' ']);
    let short_name = matches!((name.get(..4), name.get(4..)), (Some(head), Some(tail)) if head.eq_ignore_ascii_case("git~") && !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()));
    name.eq_ignore_ascii_case(".git") || short_name
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
                if first && is_dot_git(&name.to_string_lossy()) {
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

// ---- file operations (the Files tab's context menu and drag and drop) --------

/// What to do when something being copied or moved in already has a namesake there.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum OnConflict {
    /// Change nothing; answer the names that clash.
    Ask,
    /// The one already there goes to the trash first.
    Replace,
    /// The new one gets a free name: `name 2.ext`.
    KeepBoth,
    Skip,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Placed {
    /// Repository-relative paths of what was written.
    pub done: Vec<String>,
    /// Where each of `done` came from (a repository-relative path, or the absolute one of an import).
    pub sources: Vec<String>,
    /// Names that already exist at the destination (only with `OnConflict::Ask`, when nothing was written).
    pub conflicts: Vec<String>,
}

/// Whether `name` can be a file name on every OS we run on, refusing the ones that would
/// leave the folder (`/`, `\`, `..`) or name `.git`.
fn check_name(name: &str) -> Result<()> {
    let bad = name.is_empty()
        || name == "."
        || name == ".."
        || name.trim().is_empty()
        || name.chars().any(|c| matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control())
        || name.ends_with(['.', ' ']) && cfg!(windows);
    if bad {
        return Err(AppError::msg(format!("\"{name}\" is not a usable name")));
    }
    if is_dot_git(name) {
        return Err(AppError::msg("That name is reserved for git"));
    }
    Ok(())
}

/// A repository-relative path joined, `/` separated.
fn rel_join(dir: &str, name: &str) -> String {
    if dir.is_empty() { name.to_string() } else { format!("{dir}/{name}") }
}

/// The folder part and the name of a repository-relative path.
fn split_rel(rel: &str) -> (&str, &str) {
    match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    }
}

/// An existing entry itself (not what a symlink points at), refusing the repository root.
/// Its folder must resolve inside the repository; the entry may be a link leading anywhere,
/// since only the link is touched.
fn entry(root: &Path, rel: &str) -> Result<PathBuf> {
    let rel = rel.trim_end_matches('/');
    if rel.is_empty() {
        return Err(AppError::msg("That is the repository itself"));
    }
    let (dir, name) = split_rel(rel);
    check_name(name)?;
    let parent = resolve(root, dir)?;
    let path = parent.join(name);
    std::fs::symlink_metadata(&path).map_err(|_| AppError::msg(format!("{rel} no longer exists")))?;
    Ok(path)
}

/// A folder inside the repository that something new goes into.
fn folder(root: &Path, rel: &str) -> Result<PathBuf> {
    let dir = resolve(root, rel)?;
    if !dir.is_dir() {
        return Err(AppError::msg(format!("{rel} is not a folder")));
    }
    Ok(dir)
}

/// `name 2.ext`, `name 3.ext`, ... (or `name copy.ext` first for a duplicate): the first that is free in `dir`.
fn free_name(dir: &Path, name: &str, copy: bool) -> String {
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let candidates = (if copy { 1 } else { 2 }..).map(|n| match (copy, n) {
        (true, 1) => format!("{stem} copy{ext}"),
        (true, n) => format!("{stem} copy {n}{ext}"),
        (false, n) => format!("{stem} {n}{ext}"),
    });
    candidates.into_iter().find(|n| std::fs::symlink_metadata(dir.join(n)).is_err()).unwrap_or_default()
}

/// A new empty file or folder `name` in folder `dir`. Never replaces anything.
pub fn create(git: &Git, dir: &str, name: &str, is_dir: bool) -> Result<String> {
    check_name(name)?;
    let path = folder(&git.dir, dir)?.join(name);
    if std::fs::symlink_metadata(&path).is_ok() {
        return Err(AppError::msg(format!("{name} already exists")));
    }
    if is_dir {
        std::fs::create_dir(&path)?;
    } else {
        std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
    }
    Ok(rel_join(dir, name))
}

/// Rename or move entries into folder `to_dir`, keeping each one's name, or giving the
/// only one `rename` as its new name. A folder cannot go inside itself.
pub fn relocate(git: &Git, paths: &[String], to_dir: &str, rename: Option<&str>, on_conflict: OnConflict) -> Result<Placed> {
    if rename.is_some() && paths.len() != 1 {
        return Err(AppError::msg("Rename one entry at a time"));
    }
    let to_dir = to_dir.trim_end_matches('/');
    let target = folder(&git.dir, to_dir)?;
    let mut plan = Vec::new();
    for rel in paths {
        let rel = rel.trim_end_matches('/');
        let from = entry(&git.dir, rel)?;
        let name = rename.unwrap_or_else(|| split_rel(rel).1);
        check_name(name)?;
        if to_dir == rel || to_dir.starts_with(&format!("{rel}/")) {
            return Err(AppError::msg(format!("{rel} cannot be moved inside itself")));
        }
        if split_rel(rel).0 == to_dir && split_rel(rel).1 == name {
            continue; // already there
        }
        plan.push((rel.to_string(), from, name.to_string()));
    }
    place(&target, to_dir, plan, on_conflict, |from, to| std::fs::rename(from, to).map_err(AppError::from))
}

/// Copy files and folders from anywhere (a drop from Finder or Explorer) into folder `to_dir`.
pub fn import(git: &Git, sources: &[PathBuf], to_dir: &str, on_conflict: OnConflict) -> Result<Placed> {
    let to_dir = to_dir.trim_end_matches('/');
    let target = folder(&git.dir, to_dir)?;
    let mut plan = Vec::new();
    for source in sources {
        let meta = std::fs::symlink_metadata(source).map_err(|_| AppError::msg(format!("{} no longer exists", source.display())))?;
        if meta.is_dir() && target.canonicalize()?.starts_with(source.canonicalize()?) {
            return Err(AppError::msg(format!("{} cannot be copied inside itself", source.display())));
        }
        let name = source.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        check_name(&name)?;
        plan.push((source.display().to_string(), source.clone(), name));
    }
    place(&target, to_dir, plan, on_conflict, copy_all)
}

/// A copy of one entry beside it, as `name copy.ext`.
pub fn duplicate(git: &Git, rel: &str) -> Result<String> {
    let from = entry(&git.dir, rel)?;
    let (dir, name) = split_rel(rel.trim_end_matches('/'));
    let parent = from.parent().ok_or_else(|| AppError::msg("Nothing to duplicate"))?.to_path_buf();
    let new_name = free_name(&parent, name, true);
    copy_all(&from, &parent.join(&new_name))?;
    Ok(rel_join(dir, &new_name))
}

/// Move entries to the OS trash. Where there is no trash (some Linux desktops) a file is deleted,
/// a folder is refused: nothing large disappears for good from a menu click.
pub fn trash(git: &Git, paths: &[String]) -> Result<()> {
    let mut found = Vec::new();
    for rel in paths {
        found.push((rel, entry(&git.dir, rel)?));
    }
    for (rel, path) in found {
        if trash::delete(&path).is_err() {
            if path.is_dir() && !path.is_symlink() {
                return Err(AppError::msg(format!("{rel} could not be moved to the trash")));
            }
            std::fs::remove_file(&path).map_err(|e| AppError::msg(format!("Could not remove {rel}: {e}")))?;
        }
    }
    Ok(())
}

/// An entry's real path, for revealing it in the file manager.
pub fn locate(git: &Git, rel: &str) -> Result<PathBuf> {
    if rel.trim_end_matches('/').is_empty() {
        return Ok(git.dir.clone());
    }
    entry(&git.dir, rel)
}

fn place(target: &Path, to_dir: &str, plan: Vec<(String, PathBuf, String)>, on_conflict: OnConflict, put: impl Fn(&Path, &Path) -> Result<()>) -> Result<Placed> {
    // A name that only changes case finds the entry itself on a case-insensitive disk: not a clash.
    let taken = |from: &Path, name: &str| {
        let dest = target.join(name);
        std::fs::symlink_metadata(&dest).is_ok() && !paths::same(&dest, from)
    };
    let clashes: Vec<String> = plan.iter().filter(|(_, from, name)| taken(from, name)).map(|(_, _, n)| n.clone()).collect();
    if on_conflict == OnConflict::Ask && !clashes.is_empty() {
        return Ok(Placed { done: vec![], sources: vec![], conflicts: clashes });
    }
    let (mut done, mut sources) = (Vec::new(), Vec::new());
    for (label, from, name) in plan {
        let mut name = name;
        let dest = target.join(&name);
        if taken(&from, &name) {
            match on_conflict {
                OnConflict::Skip | OnConflict::Ask => continue,
                OnConflict::KeepBoth => name = free_name(target, &name, false),
                OnConflict::Replace => {
                    trash::delete(&dest).or_else(|_| if dest.is_dir() { Err(()) } else { std::fs::remove_file(&dest).map_err(|_| ()) }).map_err(|_| AppError::msg(format!("{name} could not be replaced")))?;
                }
            }
        }
        put(&from, &target.join(&name))?;
        done.push(rel_join(to_dir, &name));
        sources.push(label);
    }
    Ok(Placed { done, sources, conflicts: vec![] })
}

/// Copy a file, or a folder with everything in it. Symlinks inside are recreated, not followed.
fn copy_all(from: &Path, to: &Path) -> Result<()> {
    let meta = std::fs::symlink_metadata(from)?;
    if meta.is_symlink() {
        let target = std::fs::read_link(from)?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, to)?;
        #[cfg(windows)]
        {
            if from.is_dir() {
                std::os::windows::fs::symlink_dir(&target, to)?;
            } else {
                std::os::windows::fs::symlink_file(&target, to)?;
            }
        }
        return Ok(());
    }
    if meta.is_dir() {
        std::fs::create_dir(to)?;
        for item in std::fs::read_dir(from)? {
            let item = item?;
            copy_all(&item.path(), &to.join(item.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to)?;
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

        // The last few are other names for `.git` on Windows; they are refused everywhere, as git does.
        for bad in ["../x", "/etc/passwd", ".git/config", ".GIT/config", "a/../../x", "./ok.txt", ".git./config", ".git /config", ".git::$INDEX_ALLOCATION/config", "GIT~1/config", "git~1/config"] {
            assert!(read_file(&g, bad).is_err(), "{bad}");
            assert!(write_file(&g, bad, "x").is_err(), "{bad}");
        }
        // Windows-only ways out of the folder, harmless names elsewhere.
        #[cfg(windows)]
        for bad in [r"..\x", r"C:\Windows\win.ini", "C:ok.txt", r"\\?\C:\Windows\win.ini", r"sub\..\..\x"] {
            assert!(read_file(&g, bad).is_err(), "{bad}");
            assert!(write_file(&g, bad, "x").is_err(), "{bad}");
        }
        assert!(!is_dot_git(".gitignore") && !is_dot_git(".github") && !is_dot_git("git~x") && !is_dot_git("git") && !is_dot_git("gitélan"));
        assert_eq!(read_file(&g, "ok.txt").unwrap().text, "ok");
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

    #[test]
    fn creates_renames_moves_and_duplicates() {
        let g = scratch("ops");
        std::fs::create_dir_all(g.dir.join("src/deep")).unwrap();
        std::fs::write(g.dir.join("src/a.txt"), "a").unwrap();

        assert_eq!(create(&g, "src", "b.txt", false).unwrap(), "src/b.txt");
        assert_eq!(create(&g, "", "docs", true).unwrap(), "docs");
        assert!(g.dir.join("docs").is_dir() && g.dir.join("src/b.txt").is_file());
        // Never replaces, never leaves the folder, never makes `.git`.
        for bad in ["a.txt", "../x", "x/y", r"x\y", ".git", "GIT~1", "", " ", "..", "a:b", "a*b"] {
            assert!(create(&g, "src", bad, false).is_err(), "{bad}");
        }
        assert!(create(&g, ".git", "x", false).is_err() && create(&g, "nowhere", "x", false).is_err());

        // Rename in place, including a change of case only.
        assert_eq!(relocate(&g, &["src/b.txt".into()], "src", Some("c.txt"), OnConflict::Ask).unwrap().done, ["src/c.txt"]);
        assert_eq!(relocate(&g, &["src/c.txt".into()], "src", Some("C.txt"), OnConflict::Ask).unwrap().done, ["src/C.txt"]);
        assert!(list_dir(&g, "src").unwrap().iter().any(|e| e.name == "C.txt"));
        // A clash is reported first and nothing moves.
        std::fs::write(g.dir.join("docs/a.txt"), "other").unwrap();
        let asked = relocate(&g, &["src/a.txt".into(), "src/C.txt".into()], "docs", None, OnConflict::Ask).unwrap();
        assert_eq!((asked.done.len(), asked.conflicts), (0, vec!["a.txt".to_string()]));
        assert!(g.dir.join("src/a.txt").exists());
        let kept = relocate(&g, &["src/a.txt".into(), "src/C.txt".into()], "docs", None, OnConflict::KeepBoth).unwrap();
        assert_eq!(kept.done, ["docs/a 2.txt", "docs/C.txt"]);
        assert_eq!(std::fs::read_to_string(g.dir.join("docs/a.txt")).unwrap(), "other");
        // A folder cannot go inside itself; out of the repository is refused.
        assert!(relocate(&g, &["src".into()], "src/deep", None, OnConflict::Ask).is_err());
        assert!(relocate(&g, &["src".into()], "src", Some("../x"), OnConflict::Ask).is_err());
        assert!(relocate(&g, &["".into()], "docs", None, OnConflict::Ask).is_err());
        assert_eq!(relocate(&g, &["src/deep".into()], "docs", None, OnConflict::Ask).unwrap().done, ["docs/deep"]);

        assert_eq!(duplicate(&g, "docs/a.txt").unwrap(), "docs/a copy.txt");
        assert_eq!(duplicate(&g, "docs/a.txt").unwrap(), "docs/a copy 2.txt");
        assert_eq!(duplicate(&g, "docs/deep").unwrap(), "docs/deep copy");
        assert_eq!(std::fs::read_to_string(g.dir.join("docs/a copy.txt")).unwrap(), "other");

        let _ = std::fs::remove_dir_all(&g.dir);
    }

    #[test]
    fn imports_from_outside() {
        let g = scratch("import");
        let outside = std::env::temp_dir().join(format!("studio-files-test-import-src-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&outside);
        std::fs::create_dir_all(outside.join("pics/nested")).unwrap();
        std::fs::write(outside.join("shot.png"), [1u8, 2, 3]).unwrap();
        std::fs::write(outside.join("pics/nested/a.txt"), "a").unwrap();
        std::fs::create_dir_all(g.dir.join("img")).unwrap();
        std::fs::write(g.dir.join("img/shot.png"), "old").unwrap();

        let sources = [outside.join("shot.png"), outside.join("pics")];
        let asked = import(&g, &sources, "img", OnConflict::Ask).unwrap();
        assert_eq!(asked.conflicts, ["shot.png"]);
        assert!(!g.dir.join("img/pics").exists());
        assert_eq!(import(&g, &sources, "img", OnConflict::Skip).unwrap().done, ["img/pics"]);
        assert_eq!(std::fs::read_to_string(g.dir.join("img/pics/nested/a.txt")).unwrap(), "a");
        assert_eq!(std::fs::read(g.dir.join("img/shot.png")).unwrap(), b"old");
        assert_eq!(import(&g, &sources[..1], "img", OnConflict::KeepBoth).unwrap().done, ["img/shot 2.png"]);
        assert!(import(&g, &sources[..1], ".git", OnConflict::KeepBoth).is_err());
        // The originals are copied, not moved.
        assert!(outside.join("shot.png").exists() && outside.join("pics/nested/a.txt").exists());
        // A repository folder dropped onto its own subfolder.
        assert!(import(&g, &[g.dir.join("img")], "img/pics", OnConflict::KeepBoth).is_err());

        let _ = std::fs::remove_dir_all(&g.dir);
        let _ = std::fs::remove_dir_all(&outside);
    }

    #[test]
    fn trash_and_locate_stay_inside() {
        let g = scratch("trash");
        std::fs::write(g.dir.join("gone.txt"), "x").unwrap();
        assert!(trash(&g, &["".into()]).is_err() && trash(&g, &[".git".into()]).is_err() && trash(&g, &["../x".into()]).is_err());
        assert!(trash(&g, &["missing.txt".into()]).is_err());
        assert!(paths::same(locate(&g, "").unwrap(), &g.dir));
        assert!(locate(&g, "gone.txt").unwrap().ends_with("gone.txt"));
        assert!(locate(&g, ".git/config").is_err());
        #[cfg(unix)]
        {
            // A link is the entry itself: removing it leaves what it points at.
            let outside = g.dir.with_extension("target");
            std::fs::write(&outside, "keep").unwrap();
            std::os::unix::fs::symlink(&outside, g.dir.join("link")).unwrap();
            assert!(entry(&g.dir, "link").unwrap().ends_with("link"));
            let _ = std::fs::remove_file(g.dir.join("link"));
            assert_eq!(std::fs::read_to_string(&outside).unwrap(), "keep");
            let _ = std::fs::remove_file(&outside);
        }
        let _ = std::fs::remove_dir_all(&g.dir);
    }
}
