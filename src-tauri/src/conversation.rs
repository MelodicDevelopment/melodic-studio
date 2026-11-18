//! Claude conversations: the user's own `claude` CLI, interactive, on a pty in
//! one checkout of a repository. The window draws it with xterm.js exactly as
//! it draws a shell (same `term-*` commands and events), so nothing of Claude
//! Code is reimplemented.
//!
//! What the window cannot see in a terminal (is it working, waiting for the
//! user, which subagents are running) comes from Claude Code's own hooks. Each
//! conversation is started with `--settings <file>` holding HTTP hooks that
//! post to a small server here, on 127.0.0.1, under a secret path. The hooks
//! are added to the user's own; nothing in their settings changes.

use crate::commands::main_repo;
use crate::error::{AppError, Result};
use crate::terminal::{self, Shell, Terminals};
use crate::{worktree, AppState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

/// The hook events the window uses.
const EVENTS: &[&str] = &["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SessionEnd"];
/// The tools that start a subagent (`Task` before Claude Code 2.1, `Agent` after).
const SUBAGENT_TOOLS: &str = "Task|Agent";
/// A hook body larger than this is not one of ours.
const MAX_BODY: usize = 4 * 1024 * 1024;
/// Text forwarded to the window is cut to this many characters.
const MAX_TEXT: usize = 2000;

/// The hook receiver: where it listens and the secret every hook URL carries.
#[derive(Default)]
pub struct Hooks {
    server: OnceLock<std::result::Result<(u16, String), String>>,
    /// Hook URLs carry a tag of ours (it has to be in the settings file before the terminal exists); tag -> terminal key.
    keys: Mutex<HashMap<String, String>>,
}

/// One hook call, as the window sees it.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct HookEvent {
    /// The terminal key of the conversation.
    key: String,
    /// `hook_event_name`: SessionStart, Stop, ...
    event: String,
    session_id: Option<String>,
    transcript_path: Option<String>,
    /// Notification: what Claude is waiting for. UserPromptSubmit: the prompt. Stop: the last answer.
    text: Option<String>,
    /// Notification: `permission_prompt`, `idle_prompt`, ...
    kind: Option<String>,
    /// PreToolUse / PostToolUse of a subagent.
    tool_use_id: Option<String>,
    description: Option<String>,
    subagent_type: Option<String>,
}

fn secret() -> String {
    // RandomState is seeded from the OS's randomness; two of them give 128 bits.
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

fn cut(s: &str) -> String {
    match s.char_indices().nth(MAX_TEXT) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

fn text(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|s| s.as_str()).map(cut)
}

/// The parts of a hook's JSON the window uses.
fn hook_event(key: &str, body: &Value) -> HookEvent {
    let event = text(body, "hook_event_name").unwrap_or_default();
    let input = body.get("tool_input").cloned().unwrap_or(Value::Null);
    let said = match event.as_str() {
        "Notification" => text(body, "message"),
        "UserPromptSubmit" => text(body, "prompt"),
        "Stop" => text(body, "last_assistant_message"),
        _ => None,
    };
    HookEvent {
        key: key.to_string(),
        session_id: text(body, "session_id"),
        transcript_path: text(body, "transcript_path"),
        text: said,
        kind: text(body, "notification_type").or_else(|| text(body, "source")),
        tool_use_id: text(body, "tool_use_id"),
        description: text(&input, "description"),
        subagent_type: text(&input, "subagent_type"),
        event,
    }
}

/// Read one HTTP request: `(path, body)`. Only what Claude Code's hook client sends is understood.
fn read_request(stream: &TcpStream) -> Option<(String, Vec<u8>)> {
    let mut reader = BufReader::new(stream);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    if parts.next()? != "POST" {
        return None;
    }
    let path = parts.next()?.to_string();
    let mut length = 0usize;
    loop {
        line.clear();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let header = line.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.trim().eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().ok()?;
            }
        }
    }
    if length > MAX_BODY {
        return None;
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some((path, body))
}

fn serve(app: tauri::AppHandle, stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let request = read_request(&stream);
    let accepted = request.and_then(|(path, body)| {
        let tag = path.strip_prefix(&format!("/hook/{token}/"))?.to_string();
        let body: Value = serde_json::from_slice(&body).ok()?;
        Some((tag, body))
    });
    let status = if accepted.is_some() { "200 OK" } else { "404 Not Found" };
    let mut stream = stream;
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}");
    let _ = stream.flush();
    let Some((tag, body)) = accepted else { return };
    // A hook can in principle beat `claude_open` registering the tag; give it a moment.
    for _ in 0..50 {
        let key = app.state::<Hooks>().keys.lock().unwrap().get(&tag).cloned();
        if let Some(key) = key {
            let _ = app.emit("claude-hook", hook_event(&key, &body));
            return;
        }
        std::thread::sleep(Duration::from_millis(40));
    }
}

impl Hooks {
    /// The receiver's port and secret, starting it the first time.
    fn server(&self, app: &tauri::AppHandle) -> Result<(u16, String)> {
        let started = self.server.get_or_init(|| {
            let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let token = secret();
            let (app, accept_token) = (app.clone(), token.clone());
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let (app, token) = (app.clone(), accept_token.clone());
                    std::thread::spawn(move || serve(app, stream, &token));
                }
            });
            Ok((port, token))
        });
        started.clone().map_err(|e| AppError::msg(format!("Could not start the conversation status receiver: {e}")))
    }
}

/// The `--settings` file for one conversation: an HTTP hook per event, all to the same address.
pub fn hook_settings(url: &str) -> Value {
    let mut hooks = serde_json::Map::new();
    for event in EVENTS {
        let mut entry = json!({ "hooks": [{ "type": "http", "url": url, "timeout": 5 }] });
        if event.ends_with("ToolUse") {
            entry["matcher"] = json!(SUBAGENT_TOOLS);
        }
        hooks.insert(event.to_string(), json!([entry]));
    }
    json!({ "hooks": hooks })
}

/// Claude Code's session ids are UUIDs; nothing else goes on its command line.
fn check_session(id: &str) -> Result<()> {
    let ok = id.len() == 36 && id.chars().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() });
    if ok {
        Ok(())
    } else {
        Err(AppError::msg("Not a Claude session id"))
    }
}

/// `claude` with our arguments. On Windows an npm install is a `.cmd` shim, which only `cmd.exe` can run.
fn claude_program(args: Vec<String>) -> Result<Shell> {
    let program = crate::proc::find("claude").ok_or_else(|| AppError::msg("Claude Code was not found. Install it (https://claude.com/claude-code) and make sure `claude` runs in a terminal."))?;
    let env_remove = terminal::CLAUDE_MARKERS.to_vec();
    let is_script = program.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    if cfg!(windows) && is_script {
        // Every argument is ours (flags, a UUID, a path we made), so cmd's quoting has nothing to trip on.
        let comspec = std::env::var_os("COMSPEC").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("cmd.exe"));
        let mut all = vec!["/d".to_string(), "/c".to_string(), program.to_string_lossy().to_string()];
        all.extend(args);
        return Ok(Shell { program: comspec, args: all, env_remove });
    }
    Ok(Shell { program, args, env_remove })
}

fn settings_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(|e| AppError::msg(e.to_string()))?.join("conversations");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Start `claude` in `cwd` (the repository or one of its worktrees). `session` is the
/// conversation's id: a new one (`--session-id`) or one to continue (`--resume`).
/// Returns the terminal key; `term_write`, `term_resize` and `term_close` work on it.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn claude_open(app: tauri::AppHandle, state: State<'_, AppState>, terminals: State<'_, Terminals>, hooks: State<'_, Hooks>, id: String, cwd: String, session: String, resume: bool, cols: u16, rows: u16) -> Result<String> {
    check_session(&session)?;
    let (git, _) = main_repo(&state, &id)?;
    let dir = PathBuf::from(&cwd);
    if !worktree::belongs(&git, &dir) {
        return Err(AppError::msg("Conversations can only run inside this repository or one of its worktrees"));
    }
    let (port, token) = hooks.server(&app)?;
    // The key the hooks report under has to be in their address before the terminal exists, so it is ours, not the pty's.
    let tag = secret();
    let url = format!("http://127.0.0.1:{port}/hook/{token}/{tag}");
    let file = settings_dir(&app)?.join(format!("{tag}.json"));
    std::fs::write(&file, serde_json::to_vec_pretty(&hook_settings(&url))?)?;

    let mut args = vec!["--settings".to_string(), file.to_string_lossy().to_string()];
    args.push(if resume { "--resume" } else { "--session-id" }.to_string());
    args.push(session);
    let program = claude_program(args)?;
    let (gone, end_app, end_tag) = (file.clone(), app.clone(), tag.clone());
    let key = terminal::start(app.clone(), &terminals, &program, Path::new(&dir), cols, rows, move || {
        let _ = std::fs::remove_file(gone);
        end_app.state::<Hooks>().keys.lock().unwrap().remove(&end_tag);
    });
    let key = match key {
        Ok(key) => key,
        Err(e) => {
            let _ = std::fs::remove_file(&file);
            return Err(e);
        }
    };
    hooks.keys.lock().unwrap().insert(tag, key.clone());
    Ok(key)
}

/// Files left behind by a run that did not end cleanly.
pub fn clean(app: &tauri::AppHandle) {
    if let Ok(dir) = settings_dir(app) {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_have_one_http_hook_per_event() {
        let s = hook_settings("http://127.0.0.1:1/hook/t/k");
        for event in EVENTS {
            let hook = &s["hooks"][event][0]["hooks"][0];
            assert_eq!(hook["type"], "http");
            assert_eq!(hook["url"], "http://127.0.0.1:1/hook/t/k");
        }
        assert_eq!(s["hooks"]["PreToolUse"][0]["matcher"], SUBAGENT_TOOLS);
        assert!(s["hooks"]["Stop"][0].get("matcher").is_none());
    }

    #[test]
    fn reads_what_the_window_needs() {
        let body = json!({
            "session_id": "s", "transcript_path": "/t.jsonl", "hook_event_name": "PreToolUse",
            "tool_name": "Agent", "tool_use_id": "toolu_1", "tool_input": { "description": "Find it", "subagent_type": "Explore", "prompt": "long" }
        });
        let e = hook_event("k", &body);
        assert_eq!((e.event.as_str(), e.tool_use_id.as_deref(), e.description.as_deref(), e.subagent_type.as_deref()), ("PreToolUse", Some("toolu_1"), Some("Find it"), Some("Explore")));
        let stop = hook_event("k", &json!({ "hook_event_name": "Stop", "last_assistant_message": "x".repeat(5000) }));
        assert_eq!(stop.text.unwrap().chars().count(), MAX_TEXT + 1);
    }

    #[test]
    fn session_ids_are_uuids() {
        assert!(check_session("11111111-2222-3333-4444-555555555555").is_ok());
        assert!(check_session("--dangerously-skip-permissions").is_err());
        assert!(check_session("11111111-2222-3333-4444-55555555555g").is_err());
    }

    #[test]
    fn serves_one_hook_over_http() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let client = std::thread::spawn(move || {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            let body = r#"{"hook_event_name":"Stop"}"#;
            write!(s, "POST /hook/tok/k1 HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
            s.flush().unwrap();
        });
        let (stream, _) = listener.accept().unwrap();
        let (path, body) = read_request(&stream).unwrap();
        client.join().unwrap();
        assert_eq!(path, "/hook/tok/k1");
        assert_eq!(serde_json::from_slice::<Value>(&body).unwrap()["hook_event_name"], "Stop");
    }
}
