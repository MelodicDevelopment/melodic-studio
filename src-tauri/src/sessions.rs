//! Claude Code sessions started outside the app (in a terminal, an editor): read from the
//! transcripts Claude Code keeps under `~/.claude/projects/<folder>/<session id>.jsonl`, where
//! the folder is the session's working directory with every character other than a letter or
//! digit turned into `-`. Only the repository's own checkouts are looked at.
//!
//! Nothing here starts or changes a session: the window offers to continue one with
//! `claude --resume <id>` (conversation.rs). Whether one is still open somewhere can only be
//! guessed from when its transcript last changed; Claude Code has no hooks of ours there.

use crate::commands::main_repo;
use crate::error::Result;
use crate::worktree;
use crate::AppState;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;

/// How many sessions per repository the window is sent, newest first.
const MAX_SESSIONS: usize = 40;
/// Claude Code shortens folder names longer than this (and adds a hash).
const MAX_FOLDER: usize = 200;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeSession {
    /// The session id, what `--resume` takes.
    pub id: String,
    /// The checkout it ran in, spelled as `worktree_list` spells it.
    pub cwd: String,
    pub branch: Option<String>,
    /// The short title Claude Code writes itself, when it has one.
    pub title: Option<String>,
    /// The first thing the user asked.
    pub prompt: String,
    /// The last thing the user asked.
    pub last_prompt: Option<String>,
    /// The last thing Claude answered.
    pub last_said: Option<String>,
    /// When the transcript last changed, in ms since the epoch.
    pub modified: u64,
}

/// Transcripts already read, by file: (modified, length, what was found). A transcript only grows.
type Cache = HashMap<PathBuf, (SystemTime, u64, Option<ClaudeSession>)>;
static CACHE: Mutex<Option<Cache>> = Mutex::new(None);

/// Claude Code's own data folder: `CLAUDE_CONFIG_DIR`, else `.claude` in the home folder.
fn claude_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join(".claude"))
}

/// The folder name Claude Code files a working directory's sessions under.
pub fn folder_name(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// The folders in `projects` that hold sessions for `cwd` (one, unless a long name was shortened).
fn folders_for(projects: &Path, cwd: &str) -> Vec<PathBuf> {
    let name = folder_name(cwd);
    if name.len() <= MAX_FOLDER {
        let dir = projects.join(&name);
        return if dir.is_dir() { vec![dir] } else { vec![] };
    }
    let prefix = &name[..MAX_FOLDER];
    std::fs::read_dir(projects)
        .map(|entries| entries.flatten().map(|e| e.path()).filter(|p| p.is_dir() && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(prefix))).collect())
        .unwrap_or_default()
}

/// Whitespace collapsed, cut to `max` characters with an ellipsis.
fn summary(text: &str, max: usize) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.chars().count() <= max {
        flat
    } else {
        let cut: String = flat.chars().take(max.saturating_sub(1)).collect();
        format!("{}…", cut.trim_end())
    }
}

/// The text of a message's content: a plain string, or the `text` parts of a list.
fn text_of(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.clone()),
        Value::Array(parts) => {
            let texts: Vec<&str> = parts.iter().filter(|p| p["type"] == "text").filter_map(|p| p["text"].as_str()).collect();
            (!texts.is_empty()).then(|| texts.join("\n"))
        }
        _ => None,
    }
}

/// What a transcript says about its session. None for sessions the user never typed into, and
/// for headless ones (`claude -p`: this app's agents and one-shot questions, scripts).
pub fn read_transcript(file: &Path, cwd: &str) -> Option<ClaudeSession> {
    let id = file.file_stem()?.to_str()?.to_string();
    let modified = std::fs::metadata(file).ok()?.modified().ok()?;
    let reader = BufReader::new(std::fs::File::open(file).ok()?);
    let (mut title, mut prompt, mut last_prompt, mut last_said, mut branch) = (None, None::<String>, None, None, None);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        // Skip the bulky lines without parsing them: only these kinds are of use.
        if !(line.contains("\"type\":\"user\"") || line.contains("\"type\":\"assistant\"") || line.contains("\"type\":\"ai-title\"") || line.contains("\"type\":\"last-prompt\"")) {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        if v["entrypoint"].as_str().is_some_and(|e| e.starts_with("sdk")) {
            return None;
        }
        if v["isSidechain"] == true || v["isMeta"] == true {
            continue;
        }
        if let Some(b) = v["gitBranch"].as_str().filter(|b| !b.is_empty() && *b != "HEAD") {
            branch = Some(b.to_string());
        }
        match v["type"].as_str() {
            Some("ai-title") => title = v["aiTitle"].as_str().map(|t| summary(t, 80)),
            Some("last-prompt") => last_prompt = v["lastPrompt"].as_str().map(|t| summary(t, 400)),
            Some("user") if prompt.is_none() => {
                // Tool results and Claude Code's own notices (`<command-name>`, `<local-command-stdout>`) are not the user's words.
                if let Some(text) = text_of(&v["message"]["content"]).filter(|t| !t.trim().is_empty() && !t.trim_start().starts_with('<')) {
                    prompt = Some(summary(&text, 600));
                }
            }
            Some("assistant") => {
                if let Some(text) = text_of(&v["message"]["content"]).filter(|t| !t.trim().is_empty()) {
                    last_said = Some(summary(&text, 400));
                }
            }
            _ => {}
        }
    }
    let prompt = prompt?;
    Some(ClaudeSession {
        id,
        cwd: cwd.to_string(),
        branch,
        title,
        last_prompt,
        prompt,
        last_said,
        modified: modified.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
    })
}

/// The sessions of the given checkouts found under `claude`, newest first.
pub fn sessions_in(claude: &Path, checkouts: &[String]) -> Vec<ClaudeSession> {
    let projects = claude.join("projects");
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    let mut found = Vec::new();
    for cwd in checkouts {
        for folder in folders_for(&projects, cwd) {
            let Ok(entries) = std::fs::read_dir(&folder) else { continue };
            for file in entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "jsonl")) {
                let Ok(meta) = std::fs::metadata(&file) else { continue };
                let (Ok(when), len) = (meta.modified(), meta.len()) else { continue };
                let session = match cache.get(&file) {
                    Some((w, l, s)) if *w == when && *l == len => s.clone(),
                    _ => {
                        let s = read_transcript(&file, cwd);
                        cache.insert(file.clone(), (when, len, s.clone()));
                        s
                    }
                };
                found.extend(session);
            }
        }
    }
    found.sort_by_key(|s| std::cmp::Reverse(s.modified));
    found.truncate(MAX_SESSIONS);
    found
}

/// Claude Code sessions in the repository's checkouts (main and worktrees), newest first.
#[tauri::command]
pub async fn claude_sessions(state: State<'_, AppState>, id: String) -> Result<Vec<ClaudeSession>> {
    let (git, _) = main_repo(&state, &id)?;
    let checkouts: Vec<String> = worktree::entries(&git)?.into_iter().map(|t| t.path).collect();
    let Some(claude) = claude_dir() else { return Ok(vec![]) };
    Ok(tauri::async_runtime::spawn_blocking(move || sessions_in(&claude, &checkouts)).await.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-sessions-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn line(v: Value) -> String {
        format!("{v}\n")
    }

    #[test]
    fn folder_names_follow_claude_code() {
        assert_eq!(folder_name("/Users/me/Source/melodic-studio"), "-Users-me-Source-melodic-studio");
        assert_eq!(folder_name("/Users/rick.hopkins/repo.worktrees/agent-x"), "-Users-rick-hopkins-repo-worktrees-agent-x");
        assert_eq!(folder_name(r"C:\Users\me\repo"), "C--Users-me-repo");
    }

    #[test]
    fn reads_a_terminal_session_and_skips_headless_ones() {
        let claude = scratch("read");
        let cwd = "/work/repo";
        let folder = claude.join("projects").join(folder_name(cwd));
        std::fs::create_dir_all(&folder).unwrap();
        let cli = [
            line(serde_json::json!({"type": "user", "isMeta": true, "entrypoint": "cli", "message": {"role": "user", "content": "<local-command-caveat>ignore</local-command-caveat>"}})),
            line(serde_json::json!({"type": "user", "entrypoint": "cli", "gitBranch": "main", "message": {"role": "user", "content": [{"type": "text", "text": "Fix the  login\nbug"}, {"type": "image"}]}})),
            line(serde_json::json!({"type": "assistant", "entrypoint": "cli", "message": {"content": [{"type": "thinking", "thinking": "hm"}, {"type": "text", "text": "Done: it was the cookie."}]}})),
            line(serde_json::json!({"type": "user", "entrypoint": "cli", "isSidechain": true, "message": {"content": "subagent work"}})),
            line(serde_json::json!({"type": "user", "entrypoint": "cli", "message": {"content": [{"type": "tool_result", "content": "ok"}]}})),
            line(serde_json::json!({"type": "ai-title", "aiTitle": "Login bug"})),
            line(serde_json::json!({"type": "last-prompt", "lastPrompt": "thanks"})),
            line(serde_json::json!({"type": "assistant", "entrypoint": "cli", "message": {"content": [{"type": "tool_use", "name": "Read"}]}})),
        ]
        .concat();
        std::fs::write(folder.join("aaaa-1111.jsonl"), cli).unwrap();
        let headless = line(serde_json::json!({"type": "user", "entrypoint": "sdk-cli", "message": {"content": "an agent task"}}));
        std::fs::write(folder.join("bbbb-2222.jsonl"), headless).unwrap();
        let empty = line(serde_json::json!({"type": "user", "entrypoint": "cli", "message": {"content": "<command-name>/model</command-name>"}}));
        std::fs::write(folder.join("cccc-3333.jsonl"), empty).unwrap();
        std::fs::write(folder.join("notes.txt"), "not a transcript").unwrap();

        let found = sessions_in(&claude, &[cwd.to_string(), "/elsewhere".to_string()]);
        assert_eq!(found.len(), 1, "{found:?}");
        let s = &found[0];
        assert_eq!(s.id, "aaaa-1111");
        assert_eq!(s.cwd, cwd);
        assert_eq!(s.branch.as_deref(), Some("main"));
        assert_eq!(s.title.as_deref(), Some("Login bug"));
        assert_eq!(s.prompt, "Fix the login bug");
        assert_eq!(s.last_prompt.as_deref(), Some("thanks"));
        assert_eq!(s.last_said.as_deref(), Some("Done: it was the cookie."));
        assert!(s.modified > 0);

        // Read again from the cache, then again after the transcript grows.
        assert_eq!(sessions_in(&claude, &[cwd.to_string()]), found);
        let mut more = std::fs::read_to_string(folder.join("aaaa-1111.jsonl")).unwrap();
        more.push_str(&line(serde_json::json!({"type": "assistant", "entrypoint": "cli", "message": {"content": [{"type": "text", "text": "Also fixed the test."}]}})));
        std::fs::write(folder.join("aaaa-1111.jsonl"), more).unwrap();
        assert_eq!(sessions_in(&claude, &[cwd.to_string()])[0].last_said.as_deref(), Some("Also fixed the test."));
        let _ = std::fs::remove_dir_all(&claude);
    }

    #[test]
    fn long_folder_names_match_by_prefix() {
        let claude = scratch("long");
        let cwd = format!("/work/{}", "x".repeat(250));
        let short = &folder_name(&cwd)[..MAX_FOLDER];
        let folder = claude.join("projects").join(format!("{short}-1a2b3c"));
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("dddd-4444.jsonl"), line(serde_json::json!({"type": "user", "entrypoint": "cli", "message": {"content": "hello"}}))).unwrap();
        assert_eq!(sessions_in(&claude, &[cwd]).len(), 1);
        let _ = std::fs::remove_dir_all(&claude);
    }

    /// `cargo test live_sessions -- --ignored --nocapture`: this project's own sessions, read from the real ~/.claude.
    #[test]
    #[ignore]
    fn live_sessions_of_this_project() {
        let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_string_lossy().to_string();
        for s in sessions_in(&claude_dir().unwrap(), &[project]) {
            println!("{} {:?} | {} | {:?}", s.id, s.title, s.prompt.chars().take(60).collect::<String>(), s.branch);
        }
    }

    #[test]
    fn summaries_are_cut_on_characters() {
        assert_eq!(summary("  a\n\tb  ", 10), "a b");
        assert_eq!(summary("ééééé", 3), "éé…");
    }
}
