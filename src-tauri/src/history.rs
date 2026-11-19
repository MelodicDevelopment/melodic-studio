//! Agent sessions on disk: one JSON file per session in the app's data folder
//! (`agent-sessions/<id>.json`). The window owns what is in a session; this only keeps the
//! text it is given and hands it back at the next start. Browser storage held them before:
//! small, slow to rewrite on every streamed event, and silent when full.

use crate::error::{AppError, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

pub struct History {
    pub dir: PathBuf,
    /// One write at a time: two saves of one session must not share its temporary file.
    lock: Mutex<()>,
}

impl History {
    pub fn at(dir: PathBuf) -> Self {
        History { dir, lock: Mutex::new(()) }
    }
}

#[derive(Serialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stored {
    /// Each session as the text that was saved.
    pub sessions: Vec<String>,
    /// Files that are there but could not be read, by name.
    pub unreadable: Vec<String>,
}

/// A session's id becomes a file name: letters, digits, `-` and `_` only.
fn file(dir: &Path, id: &str) -> Result<PathBuf> {
    if id.is_empty() || id.len() > 100 || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::msg(format!("\"{id}\" is not a session id")));
    }
    Ok(dir.join(format!("{id}.json")))
}

pub fn load(dir: &Path) -> Result<Stored> {
    let mut stored = Stored::default();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        // Nothing was ever saved.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(stored),
        Err(e) => return Err(AppError::msg(format!("{}: {e}", dir.display()))),
    };
    let mut files: Vec<PathBuf> = entries.filter_map(|e| e.ok().map(|e| e.path())).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
    files.sort();
    for path in files {
        match std::fs::read_to_string(&path) {
            Ok(text) => stored.sessions.push(text),
            Err(_) => stored.unreadable.push(path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
        }
    }
    Ok(stored)
}

/// Keep a session (`Some`), or forget it (`None`). The text is written beside the file and moved
/// over it, so a crash or a full disk half way leaves the last good copy.
pub fn save(history: &History, id: &str, session: Option<&str>) -> Result<()> {
    let path = file(&history.dir, id)?;
    let _one = history.lock.lock().unwrap_or_else(|e| e.into_inner());
    let Some(text) = session else {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(AppError::msg(format!("{}: {e}", path.display()))),
            _ => Ok(()),
        };
    };
    let said = |e: std::io::Error| AppError::msg(format!("{}: {e}", history.dir.display()));
    std::fs::create_dir_all(&history.dir).map_err(said)?;
    let temp = path.with_extension("json.tmp");
    let written = std::fs::write(&temp, text).and_then(|()| std::fs::rename(&temp, &path));
    if written.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    written.map_err(said)
}

#[tauri::command]
pub async fn agent_sessions_load(history: State<'_, History>) -> Result<Stored> {
    load(&history.dir)
}

#[tauri::command]
pub async fn agent_session_save(history: State<'_, History>, id: String, session: Option<String>) -> Result<()> {
    save(&history, &id, session.as_deref())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> History {
        let dir = std::env::temp_dir().join(format!("studio-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        History::at(dir.join("agent-sessions"))
    }

    #[test]
    fn sessions_are_kept_replaced_and_forgotten() {
        let h = scratch("keep");
        // Nothing saved yet is not an error.
        assert!(load(&h.dir).unwrap().sessions.is_empty());
        save(&h, "b-2", Some(r#"{"id":"b-2","items":[]}"#)).unwrap();
        save(&h, "a_1", Some(r#"{"id":"a_1"}"#)).unwrap();
        save(&h, "b-2", Some(r#"{"id":"b-2","items":[1]}"#)).unwrap();
        // A write that was cut short leaves its temporary file; it is not a session.
        std::fs::write(h.dir.join("c.json.tmp"), "{").unwrap();
        let stored = load(&h.dir).unwrap();
        assert_eq!(stored.sessions, [r#"{"id":"a_1"}"#, r#"{"id":"b-2","items":[1]}"#]);
        assert!(stored.unreadable.is_empty());

        save(&h, "a_1", None).unwrap();
        save(&h, "a_1", None).unwrap(); // already gone
        assert_eq!(load(&h.dir).unwrap().sessions.len(), 1);
        let _ = std::fs::remove_dir_all(h.dir.parent().unwrap());
    }

    #[test]
    fn an_id_cannot_leave_the_folder() {
        let h = scratch("ids");
        for id in ["", "../x", "a/b", "a\\b", "a.b", "x y", &"z".repeat(101)] {
            assert!(save(&h, id, Some("{}")).is_err(), "{id:?}");
        }
        assert!(!h.dir.exists());
    }

    #[test]
    fn a_file_that_cannot_be_read_is_named() {
        let h = scratch("unreadable");
        save(&h, "good", Some("{}")).unwrap();
        // Not UTF-8: reading it as text fails.
        std::fs::write(h.dir.join("bad.json"), [0xff, 0xfe, 0x00]).unwrap();
        let stored = load(&h.dir).unwrap();
        assert_eq!(stored.sessions, ["{}"]);
        assert_eq!(stored.unreadable, ["bad.json"]);
        let _ = std::fs::remove_dir_all(h.dir.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_folder_that_cannot_be_written_is_an_error_and_keeps_the_last_copy() {
        use std::os::unix::fs::PermissionsExt;
        let h = scratch("readonly");
        save(&h, "s", Some("first")).unwrap();
        std::fs::set_permissions(&h.dir, std::fs::Permissions::from_mode(0o555)).unwrap();
        let failed = save(&h, "s", Some("second"));
        std::fs::set_permissions(&h.dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        // Root writes anywhere; the check means nothing then.
        if failed.is_ok() {
            return;
        }
        let message = failed.unwrap_err().to_string();
        assert!(message.contains("agent-sessions") && message.to_lowercase().contains("denied"), "{message}");
        assert_eq!(load(&h.dir).unwrap().sessions, ["first"]);
        let _ = std::fs::remove_dir_all(h.dir.parent().unwrap());
    }
}
