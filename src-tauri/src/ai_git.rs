//! Git plumbing for the AI features around changes: the bounded diffs a prompt carries
//! (the checked files, one commit, everything a push would send) and the preview and
//! apply steps of a proposed conflict resolution. Nothing here talks to Claude; the
//! frontend builds the prompt and runs it through the `claude` CLI (see agent.rs).

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::files;
use crate::git::{DiffResult, FileChange, Git};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::State;

/// How much diff one prompt may carry: roughly 15 to 20 thousand tokens.
const MAX_AI_DIFF_BYTES: usize = 60_000;
/// Stop running `git diff` per file once this much has been collected; the rest is only named.
const MAX_COLLECTED_BYTES: usize = MAX_AI_DIFF_BYTES * 4;
/// A diff larger than this is not sent to the UI (same limit as git.rs).
const MAX_DIFF_BYTES: usize = 1_500_000;
/// Commits listed for a review.
const MAX_PUSH_COMMITS: usize = 100;

/// A changed file as the Changes list knows it.
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AiFile {
    pub path: String,
    pub old_path: Option<String>,
    /// modified | added | deleted | renamed | untracked | conflicted
    pub status: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiDiff {
    pub text: String,
    /// Part of the diff was left out to stay under the cap; `text` says where.
    pub truncated: bool,
    /// Subjects of the latest commits, newest first, so a new message can match their style.
    pub recent: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PushCommit {
    pub hash: String,
    pub summary: String,
}

/// Everything a push would send, as one diff.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PushDiff {
    /// The diff with new-file line numbers written in (see `numbered`), capped.
    pub text: String,
    pub truncated: bool,
    /// The commit the diff starts from: where this branch left its upstream or the default branch.
    pub base: String,
    /// The commit it ends at (HEAD when it was read).
    pub head: String,
    /// What `base` was measured against, e.g. `origin/main`.
    pub against: String,
    /// The commits in between, newest first.
    pub commits: Vec<PushCommit>,
    pub files: Vec<FileChange>,
}

/// A conflicted file as it sits in the working tree, conflict markers included.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConflictFile {
    pub text: String,
    pub binary: bool,
    pub too_large: bool,
}

// ---- keeping diffs bounded ---------------------------------------------------

/// Cut `text` to at most `limit` bytes at a line boundary, saying how much is missing.
fn clip(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_string();
    }
    let mut end = limit;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let end = text[..end].rfind('\n').map(|i| i + 1).unwrap_or(0);
    let missing = text[end..].lines().count();
    format!("{}[... {missing} more lines of this file's diff are not shown]\n", &text[..end])
}

/// One section per file of a patch (`diff --git ...` starts a new one). Anything before the
/// first file header is its own section.
fn split_patch(patch: &str) -> Vec<String> {
    let mut sections: Vec<String> = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --") || sections.is_empty() {
            sections.push(String::new());
        }
        sections.last_mut().unwrap().push_str(line);
    }
    sections
}

/// Fit a patch into about `cap` bytes without letting one big file crowd out the others:
/// small files keep their whole diff, the large ones share what is left equally.
fn bounded(sections: &[String], cap: usize) -> (String, bool) {
    let total: usize = sections.iter().map(String::len).sum();
    if total <= cap {
        return (sections.concat(), false);
    }
    let mut sizes: Vec<usize> = sections.iter().map(String::len).collect();
    sizes.sort_unstable();
    let mut left = cap;
    let mut limit = usize::MAX;
    for (i, size) in sizes.iter().enumerate() {
        let share = left / (sizes.len() - i);
        if *size > share {
            limit = share;
            break;
        }
        left -= size;
    }
    // A file always keeps its header lines, however many files there are.
    let limit = limit.max(400);
    (sections.iter().map(|s| clip(s, limit)).collect(), true)
}

/// Rewrite a unified diff so every line says where it is in the new file:
/// `   42 + added`, `   43   unchanged`, `      - removed`. A model asked for line
/// numbers then reads them instead of counting from the hunk header.
fn numbered(patch: &str) -> String {
    let mut out = String::with_capacity(patch.len() + patch.len() / 4);
    let mut in_hunk = false;
    let mut line_no = 0usize;
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --") {
            in_hunk = false;
        } else if line.starts_with("@@ ") {
            // `@@ -12,9 +14,11 @@`: the new file's range is the token that starts with `+`.
            let start = line.split_whitespace().find_map(|t| t.strip_prefix('+')).and_then(|t| t.split(',').next()).and_then(|n| n.parse::<usize>().ok());
            in_hunk = start.is_some();
            line_no = start.unwrap_or(0);
        } else if in_hunk {
            match line.as_bytes().first() {
                Some(b'+') => {
                    out.push_str(&format!("{line_no:>6} + {}", &line[1..]));
                    line_no += 1;
                    continue;
                }
                Some(b'-') => {
                    out.push_str(&format!("{:>6} - {}", "", &line[1..]));
                    continue;
                }
                Some(b'\\') => {}
                _ => {
                    // Context. Some tools strip the leading space of an empty context line.
                    out.push_str(&format!("{line_no:>6}   {}", line.strip_prefix(' ').unwrap_or(line)));
                    line_no += 1;
                    continue;
                }
            }
        }
        out.push_str(line);
    }
    out
}

fn is_hash(s: &str) -> bool {
    (4..=64).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

fn check_hash(s: &str) -> Result<()> {
    if is_hash(s) {
        Ok(())
    } else {
        Err(AppError::msg("That is not a commit"))
    }
}

// ---- the diffs ---------------------------------------------------------------

/// The working-tree diff of the given files against HEAD, as one capped patch.
pub fn selected_diff(git: &Git, files: &[AiFile]) -> Result<AiDiff> {
    let mut sections = Vec::new();
    let mut collected = 0usize;
    let mut skipped = false;
    for file in files {
        let name = match file.old_path.as_deref() {
            Some(old) => format!("{old} -> {}", file.path),
            None => file.path.clone(),
        };
        if collected > MAX_COLLECTED_BYTES {
            sections.push(format!("[{} {name}: diff not shown]\n", file.status));
            skipped = true;
            continue;
        }
        let section = match git.diff_worktree(&file.path, file.old_path.as_deref(), &file.status) {
            Ok(d) if d.too_large => {
                skipped = true;
                format!("[{} {name}: diff too large to show]\n", file.status)
            }
            Ok(d) if d.text.trim().is_empty() => format!("[{} {name}: no text changes]\n", file.status),
            Ok(d) => d.text,
            Err(_) => format!("[{} {name}: the diff could not be read]\n", file.status),
        };
        collected += section.len();
        sections.push(section);
    }
    let (text, truncated) = bounded(&sections, MAX_AI_DIFF_BYTES);
    let recent = if git.has_commits() { git.run(&["log", "-8", "--format=%s"]).map(|out| out.lines().map(str::to_string).collect()).unwrap_or_default() } else { vec![] };
    Ok(AiDiff { text, truncated: truncated || skipped, recent })
}

/// One whole commit: its message, the files it touched and the patch against its first parent.
pub fn commit_patch(git: &Git, hash: &str) -> Result<AiDiff> {
    check_hash(hash)?;
    let message = git.run(&["show", "-s", "--no-color", "--date=short", "--format=commit %h%nAuthor: %an%nDate: %ad%n%n%B", hash])?;
    let parent = format!("{hash}^");
    let (stat, patch) = if git.run(&["rev-parse", "--verify", "-q", &parent]).is_ok() {
        (git.run(&["diff", "--no-color", "--stat", "-M", &parent, hash])?, git.run(&["diff", "--no-color", "--no-ext-diff", "-M", &parent, hash])?)
    } else {
        (git.run(&["show", "--no-color", "--stat", "--format=", hash])?, git.run(&["show", "--no-color", "--no-ext-diff", "--format=", hash])?)
    };
    let (patch, truncated) = bounded(&split_patch(&patch), MAX_AI_DIFF_BYTES);
    let text = format!("{}\n\n{}\n{patch}", message.trim_end(), clip(&stat, 6_000));
    Ok(AiDiff { text, truncated, recent: vec![] })
}

/// The branch a new branch is measured against: the remote's default, else the usual trunk names.
fn default_branch(git: &Git) -> Option<String> {
    let current = git.run(&["symbolic-ref", "--short", "-q", "HEAD"]).map(|s| s.trim().to_string()).unwrap_or_default();
    let mut candidates: Vec<String> = Vec::new();
    if let Some(remote) = git.default_remote() {
        if let Ok(head) = git.run(&["symbolic-ref", "--short", "-q", &format!("refs/remotes/{remote}/HEAD")]) {
            candidates.push(head.trim().to_string());
        }
        candidates.extend(["main", "master", "develop"].iter().map(|n| format!("{remote}/{n}")));
    }
    candidates.extend(["main", "master", "develop"].iter().filter(|n| **n != current).map(|n| n.to_string()));
    candidates.into_iter().find(|c| !c.is_empty() && !c.starts_with('-') && git.run(&["rev-parse", "--verify", "-q", &format!("{c}^{{commit}}")]).is_ok())
}

/// Files changed between two commits.
fn changed_files(git: &Git, base: &str, head: &str) -> Result<Vec<FileChange>> {
    let out = git.run(&["diff", "--name-status", "-M", "-z", base, head])?;
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

/// What a push would send: the upstream branch to HEAD, or, for a branch that was never
/// pushed, the point where it left the default branch to HEAD. No commits means nothing to send.
pub fn push_diff(git: &Git) -> Result<PushDiff> {
    if !git.has_commits() {
        return Err(AppError::msg("There are no commits to review yet"));
    }
    let against = match git.run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) {
        Ok(upstream) => upstream.trim().to_string(),
        Err(_) => default_branch(git).ok_or_else(|| AppError::msg("This branch has no upstream and there is no default branch to compare it with, so there is nothing to review against"))?,
    };
    let base = git.run(&["merge-base", &against, "HEAD"]).map_err(|_| AppError::msg(format!("This branch shares no history with {against}")))?.trim().to_string();
    let head = git.run(&["rev-parse", "HEAD"])?.trim().to_string();
    let range = format!("{base}..{head}");
    let limit = format!("-{MAX_PUSH_COMMITS}");
    let commits: Vec<PushCommit> = git
        .run(&["log", &limit, "--format=%H%x1f%s", &range])?
        .lines()
        .filter_map(|l| l.split_once('\x1f'))
        .map(|(hash, summary)| PushCommit { hash: hash.to_string(), summary: summary.to_string() })
        .collect();
    if commits.is_empty() {
        return Ok(PushDiff { base, head, against, ..Default::default() });
    }
    let files = changed_files(git, &base, &head)?;
    let patch = git.run(&["diff", "--no-color", "--no-ext-diff", "-M", &base, &head])?;
    let (text, truncated) = bounded(&split_patch(&numbered(&patch)), MAX_AI_DIFF_BYTES);
    Ok(PushDiff { text, truncated, base, head, against, commits, files })
}

/// One file of a reviewed range, for showing a finding in place.
pub fn range_file_diff(git: &Git, base: &str, head: &str, path: &str) -> Result<DiffResult> {
    check_hash(base)?;
    check_hash(head)?;
    let text = git.run(&["diff", "--no-color", "--no-ext-diff", base, head, "--", path])?;
    if text.len() > MAX_DIFF_BYTES {
        Ok(DiffResult { text: String::new(), too_large: true })
    } else {
        Ok(DiffResult { text, too_large: false })
    }
}

// ---- conflict resolution -----------------------------------------------------

/// Whether any line opens or closes a conflict block. A lone `=======` is not counted:
/// it is also a heading underline in Markdown and reStructuredText.
pub fn has_conflict_markers(text: &str) -> bool {
    text.lines().any(|l| {
        let l = l.trim_end_matches('\r');
        ["<<<<<<<", ">>>>>>>"].iter().any(|m| l.strip_prefix(m).is_some_and(|rest| rest.is_empty() || rest.starts_with(' ')))
    })
}

fn is_conflicted(git: &Git, rel: &str) -> bool {
    git.conflicted_paths().iter().any(|p| p == rel)
}

/// The conflict-marked file a resolution is proposed for.
pub fn conflict_file(git: &Git, rel: &str) -> Result<ConflictFile> {
    if !is_conflicted(git, rel) {
        return Err(AppError::msg(format!("{rel} has no conflict to resolve")));
    }
    let file = files::read_file(git, rel)?;
    Ok(ConflictFile { text: file.text, binary: file.binary, too_large: file.too_large })
}

static TEMP_SEQ: AtomicU32 = AtomicU32::new(0);

/// A file name of our own in the system temp folder, keeping the extension so diff drivers
/// keyed on it behave the same.
fn temp_path(rel: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut name = format!("melodic-studio-proposal-{}-{stamp}-{}", std::process::id(), TEMP_SEQ.fetch_add(1, Ordering::Relaxed));
    if let Some(ext) = Path::new(rel).extension().and_then(|e| e.to_str()).filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric())) {
        name.push('.');
        name.push_str(ext);
    }
    std::env::temp_dir().join(name)
}

/// `git diff --no-index` between two files on disk. Paths go in as OS strings, so a temp
/// folder with any name works; exit code 1 only means the files differ.
fn diff_files(git: &Git, old: &Path, new: &Path) -> Result<String> {
    let mut c = crate::proc::command("git");
    c.current_dir(&git.dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(["diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--"])
        .arg(old)
        .arg(new)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = c.output().map_err(|e| AppError::Git(format!("could not run git: {e}")))?;
    if out.status.success() || out.status.code() == Some(1) {
        Ok(String::from_utf8_lossy(&out.stdout).to_string())
    } else {
        Err(AppError::Git(String::from_utf8_lossy(&out.stderr).trim().to_string()))
    }
}

/// How the file would change if `text` replaced it: a diff of the working-tree file
/// against the proposal, made through a temp file. Nothing in the repository is touched.
pub fn resolution_preview(git: &Git, rel: &str, text: &str) -> Result<DiffResult> {
    let full = files::resolve(&git.dir, rel)?;
    if !full.is_file() {
        return Err(AppError::msg(format!("{rel} is not a file")));
    }
    let temp = temp_path(rel);
    std::fs::write(&temp, text)?;
    // The repository-relative path, not the canonical one: Windows canonical paths (`\\?\C:\...`) confuse git.
    let diff = diff_files(git, Path::new(rel), &temp);
    let _ = std::fs::remove_file(&temp);
    let text = diff?;
    if text.len() > MAX_DIFF_BYTES {
        Ok(DiffResult { text: String::new(), too_large: true })
    } else {
        Ok(DiffResult { text, too_large: false })
    }
}

/// Accept a proposal: write it over the conflicted file and stage it, which is how git
/// is told a conflict is settled. `original` is the text the proposal was made from; if
/// the file has changed since, nothing is written.
pub fn resolution_apply(git: &Git, rel: &str, text: &str, original: &str) -> Result<()> {
    if has_conflict_markers(text) {
        return Err(AppError::msg("The proposal still contains conflict markers, so it was not applied"));
    }
    let full = files::resolve(&git.dir, rel)?;
    if !full.is_file() {
        return Err(AppError::msg(format!("{rel} is not a file")));
    }
    if !is_conflicted(git, rel) {
        return Err(AppError::msg(format!("{rel} is no longer conflicted, so the proposal was not applied")));
    }
    let current = std::fs::read(&full)?;
    if current != original.as_bytes() {
        return Err(AppError::msg(format!("{rel} changed since this resolution was proposed. Propose a new one.")));
    }
    std::fs::write(&full, text)?;
    git.run(&["add", "--", rel]).map(|_| ())
}

// ---- commands ----------------------------------------------------------------

#[tauri::command]
pub async fn ai_selected_diff(state: State<'_, AppState>, id: String, files: Vec<AiFile>) -> Result<AiDiff> {
    selected_diff(&repo(&state, &id)?, &files)
}

#[tauri::command]
pub async fn ai_commit_patch(state: State<'_, AppState>, id: String, hash: String) -> Result<AiDiff> {
    commit_patch(&repo(&state, &id)?, &hash)
}

#[tauri::command]
pub async fn ai_push_diff(state: State<'_, AppState>, id: String) -> Result<PushDiff> {
    push_diff(&repo(&state, &id)?)
}

#[tauri::command]
pub async fn ai_range_file_diff(state: State<'_, AppState>, id: String, base: String, head: String, path: String) -> Result<DiffResult> {
    range_file_diff(&repo(&state, &id)?, &base, &head, &path)
}

#[tauri::command]
pub async fn ai_conflict_file(state: State<'_, AppState>, id: String, path: String) -> Result<ConflictFile> {
    conflict_file(&repo(&state, &id)?, &path)
}

#[tauri::command]
pub async fn ai_resolution_preview(state: State<'_, AppState>, id: String, path: String, text: String) -> Result<DiffResult> {
    resolution_preview(&repo(&state, &id)?, &path, &text)
}

/// `root` is the checkout the conflict was read from; nothing is written if another one is active by now.
#[tauri::command]
pub async fn ai_resolution_apply(state: State<'_, AppState>, id: String, path: String, text: String, original: String, root: String) -> Result<()> {
    let g = repo(&state, &id)?;
    if !files::same_dir(&g.dir, Path::new(&root)) {
        return Err(AppError::msg("The active checkout changed, so the proposal was not applied."));
    }
    resolution_apply(&g, &path, &text, &original)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Git {
        let dir = std::env::temp_dir().join(format!("studio-ai-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let g = Git::init(&dir).unwrap();
        // autocrlf off: on Windows git would otherwise check files out with CRLF and the content assertions would not hold.
        for (key, value) in [("user.name", "Test"), ("user.email", "test@example.com"), ("commit.gpgsign", "false"), ("core.autocrlf", "false")] {
            g.run(&["config", key, value]).unwrap();
        }
        g
    }

    fn write(g: &Git, rel: &str, text: &str) {
        let path = g.dir.join(rel);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }

    fn file(path: &str, status: &str) -> AiFile {
        AiFile { path: path.into(), old_path: None, status: status.into() }
    }

    #[test]
    fn bounds_and_numbers_patches() {
        let small = "diff --git a/s b/s\n+one\n".to_string();
        let big = format!("diff --git a/b b/b\n{}", "+line of text\n".repeat(1000));
        let (all, cut) = bounded(&[small.clone(), big.clone()], 100_000);
        assert!(!cut && all.len() == small.len() + big.len());

        let (text, cut) = bounded(&[small.clone(), big.clone(), big.clone()], 4_000);
        assert!(cut && text.len() < 4_400, "{}", text.len());
        assert!(text.starts_with(&small), "a small file keeps its whole diff");
        assert_eq!(text.matches("diff --git a/b b/b").count(), 2, "every file is still named");
        assert_eq!(text.matches("more lines of this file's diff are not shown]").count(), 2);
        // Never cut inside a multi-byte character.
        assert!(clip(&"é".repeat(50), 31).starts_with('['));
        assert!(clip(&format!("ab\n{}", "é".repeat(50)), 31).starts_with("ab\n[... 1 more lines"));

        assert_eq!(split_patch("commit 1\n\ndiff --git a/x b/x\n+x\ndiff --git a/y b/y\n+y\n").len(), 3);

        let patch = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -3,4 +10,5 @@ fn x() {\n same\n-gone\n+new one\n+new two\n\n last\n\\ No newline at end of file\n@@ -40 +50 @@\n-a\n+b\n";
        let want = "diff --git a/a.ts b/a.ts\nindex 1..2 100644\n--- a/a.ts\n+++ b/a.ts\n@@ -3,4 +10,5 @@ fn x() {\n    10   same\n       - gone\n    11 + new one\n    12 + new two\n    13   \n    14   last\n\\ No newline at end of file\n@@ -40 +50 @@\n       - a\n    50 + b\n";
        assert_eq!(numbered(patch), want);
        assert!(is_hash("0a1b2c3") && !is_hash("HEAD") && !is_hash("--all") && !is_hash("abc"));
    }

    #[test]
    fn selected_diff_is_combined_and_capped() {
        let g = scratch("selected");
        write(&g, "a.txt", "one\n");
        write(&g, "skip.txt", "untouched\n");
        g.commit(&["a.txt".into(), "skip.txt".into()], "Add a", "", false).unwrap();
        write(&g, "a.txt", "one\ntwo\n");
        write(&g, "skip.txt", "left out\n");
        write(&g, "src/new file.rs", "fn main() {}\n");

        let d = selected_diff(&g, &[file("a.txt", "modified"), file("src/new file.rs", "untracked")]).unwrap();
        assert!(!d.truncated);
        assert!(d.text.contains("+two") && d.text.contains("+fn main() {}"), "{}", d.text);
        assert!(!d.text.contains("left out"), "only the selected files");
        assert_eq!(d.recent, ["Add a"]);

        // A huge file is cut down to its share; the small one survives whole.
        write(&g, "big.txt", &"a fairly long line of text for the big file\n".repeat(5000));
        let d = selected_diff(&g, &[file("big.txt", "untracked"), file("a.txt", "modified")]).unwrap();
        assert!(d.truncated);
        assert!(d.text.len() < MAX_AI_DIFF_BYTES + 500, "{}", d.text.len());
        assert!(d.text.contains("+two") && d.text.contains("more lines of this file's diff are not shown]"));

        // Nothing committed yet: everything reads as new.
        let fresh = scratch("selected-fresh");
        write(&fresh, "first.txt", "hello\n");
        let d = selected_diff(&fresh, &[file("first.txt", "untracked")]).unwrap();
        assert!(d.text.contains("+hello") && d.recent.is_empty());

        let _ = std::fs::remove_dir_all(&g.dir);
        let _ = std::fs::remove_dir_all(&fresh.dir);
    }

    #[test]
    fn commit_patch_has_message_and_diff() {
        let g = scratch("commit");
        write(&g, "a.txt", "one\n");
        g.commit(&["a.txt".into()], "Add a", "", false).unwrap();
        write(&g, "a.txt", "one\ntwo\n");
        g.commit(&["a.txt".into()], "Second line", "Because one was lonely.", false).unwrap();
        let log = g.log(0, 10).unwrap();

        let p = commit_patch(&g, &log[0].hash).unwrap();
        assert!(p.text.contains("Second line") && p.text.contains("Because one was lonely.") && p.text.contains("+two"), "{}", p.text);
        assert!(p.text.contains("a.txt | 1 +"), "the stat lists the files: {}", p.text);
        let root = commit_patch(&g, &log[1].hash).unwrap();
        assert!(root.text.contains("Add a") && root.text.contains("+one"), "{}", root.text);
        assert!(commit_patch(&g, "--all").is_err());
        assert!(commit_patch(&g, "HEAD").is_err(), "only hashes");

        let _ = std::fs::remove_dir_all(&g.dir);
    }

    #[test]
    fn push_diff_covers_what_would_be_pushed() {
        let g = scratch("push");
        let remote = g.dir.with_extension("remote.git");
        let _ = std::fs::remove_dir_all(&remote);
        Git::run_global(&["init", "-q", "--bare", "-b", "main", &remote.to_string_lossy()]).unwrap();

        // No remote, on the only branch: nothing to measure against.
        write(&g, "a.txt", "one\n");
        g.commit(&["a.txt".into()], "Add a", "", false).unwrap();
        assert!(push_diff(&g).is_err());

        g.set_remote(&remote.to_string_lossy()).unwrap();
        g.push(false).unwrap();
        let empty = push_diff(&g).unwrap();
        assert!(empty.commits.is_empty() && empty.text.is_empty() && empty.against == "origin/main");

        // Two commits ahead of the upstream.
        write(&g, "a.txt", "one\ntwo\n");
        g.commit(&["a.txt".into()], "Second line", "", false).unwrap();
        write(&g, "b.txt", "bee\n");
        g.commit(&["b.txt".into()], "Add b", "", false).unwrap();
        let d = push_diff(&g).unwrap();
        assert_eq!(d.commits.iter().map(|c| c.summary.as_str()).collect::<Vec<_>>(), ["Add b", "Second line"]);
        assert_eq!(d.against, "origin/main");
        assert_eq!(d.files.iter().map(|f| (f.path.as_str(), f.status.as_str())).collect::<Vec<_>>(), [("a.txt", "modified"), ("b.txt", "added")]);
        assert!(d.text.contains("     2 + two") && d.text.contains("     1 + bee"), "numbered by new-file line: {}", d.text);
        assert!(!d.truncated && d.head == g.log(0, 1).unwrap()[0].hash);

        let one = range_file_diff(&g, &d.base, &d.head, "a.txt").unwrap();
        assert!(one.text.contains("+two") && !one.text.contains("bee"));
        assert!(range_file_diff(&g, "main", &d.head, "a.txt").is_err(), "only hashes");

        // A branch that was never pushed is measured from where it left the default branch.
        g.push(false).unwrap();
        g.branch_create("topic", None).unwrap();
        write(&g, "c.txt", "sea\n");
        g.commit(&["c.txt".into()], "Add c", "", false).unwrap();
        let d = push_diff(&g).unwrap();
        assert_eq!(d.against, "origin/main");
        assert_eq!(d.commits.len(), 1);
        assert_eq!(d.files.len(), 1);
        assert!(d.text.contains("     1 + sea") && !d.text.contains("bee"));

        let _ = std::fs::remove_dir_all(&g.dir);
        let _ = std::fs::remove_dir_all(&remote);
    }

    #[test]
    fn resolution_preview_and_apply() {
        let g = scratch("resolve");
        write(&g, "src/f.txt", "top\nbase\nbottom\n");
        write(&g, "other.txt", "x\n");
        g.commit(&["src/f.txt".into(), "other.txt".into()], "Base", "", false).unwrap();
        g.branch_create("feature", None).unwrap();
        write(&g, "src/f.txt", "top\nfeature\nbottom\n");
        g.commit(&["src/f.txt".into()], "Feature", "", false).unwrap();
        g.branch_checkout("main", false).unwrap();
        write(&g, "src/f.txt", "top\nmain\nbottom\n");
        g.commit(&["src/f.txt".into()], "Main", "", false).unwrap();
        assert!(matches!(g.merge("feature"), Err(AppError::Conflict(_))));

        let conflict = conflict_file(&g, "src/f.txt").unwrap();
        assert!(has_conflict_markers(&conflict.text) && conflict.text.contains("main\n=======\nfeature"), "{}", conflict.text);
        assert!(conflict_file(&g, "other.txt").is_err(), "not a conflicted file");
        assert!(conflict_file(&g, "../x").is_err());

        let resolved = "top\nmain and feature\nbottom\n";
        let preview = resolution_preview(&g, "src/f.txt", resolved).unwrap();
        assert!(preview.text.contains("-<<<<<<< HEAD") && preview.text.contains("+main and feature") && preview.text.contains(" bottom"), "{}", preview.text);
        assert_eq!(std::fs::read_to_string(g.dir.join("src/f.txt")).unwrap(), conflict.text, "a preview changes nothing");
        assert!(resolution_preview(&g, "../outside.txt", "x").is_err());
        assert!(resolution_preview(&g, ".git/config", "x").is_err());

        // Refused: markers left in, a path outside the repository, a file that is not conflicted, a stale proposal.
        assert!(resolution_apply(&g, "src/f.txt", &conflict.text, &conflict.text).is_err());
        assert!(resolution_apply(&g, "src/f.txt", "top\n>>>>>>> feature\n", &conflict.text).is_err());
        assert!(resolution_apply(&g, "../outside.txt", resolved, &conflict.text).is_err());
        assert!(resolution_apply(&g, ".git/config", resolved, &conflict.text).is_err());
        assert!(resolution_apply(&g, "other.txt", resolved, "x\n").is_err());
        assert!(resolution_apply(&g, "src/f.txt", resolved, "something else").is_err());
        assert_eq!(std::fs::read_to_string(g.dir.join("src/f.txt")).unwrap(), conflict.text, "nothing was written");
        assert_eq!(g.status().unwrap().files[0].status, "conflicted");

        resolution_apply(&g, "src/f.txt", resolved, &conflict.text).unwrap();
        assert_eq!(std::fs::read_to_string(g.dir.join("src/f.txt")).unwrap(), resolved);
        let st = g.status().unwrap();
        assert!(st.merge_in_progress && st.files.iter().all(|f| f.status != "conflicted"), "staged as resolved: {:?}", st.files);
        g.op_continue().unwrap();
        assert_eq!(g.log(0, 1).unwrap()[0].parents.len(), 2);

        // A heading underline is not a conflict marker.
        assert!(!has_conflict_markers("Title\n=======\ntext\n"));
        assert!(has_conflict_markers("a\r\n<<<<<<< HEAD\r\nb\r\n") && has_conflict_markers("x\n>>>>>>>\n"));
        assert!(!has_conflict_markers("<<<<<<<<< not a marker\n"));

        let _ = std::fs::remove_dir_all(&g.dir);
    }
}
