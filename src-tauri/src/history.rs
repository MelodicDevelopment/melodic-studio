//! Agent sessions on disk: one JSON file per session in the app's data folder
//! (`agent-sessions/<id>.json`). The window owns what is in a session; this only keeps the
//! text it is given and hands it back at the next start. Browser storage held them before:
//! small, slow to rewrite on every streamed event, and silent when full.
//!
//! Images the user attached to a message are files too, in `agent-sessions/<id>.images/`:
//! a transcript names them, and the turn that sends them reads them here (`agent.rs`).

use crate::error::{AppError, Result};
use base64::Engine;
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

/// The folder of a session's attached images, beside its file.
fn images(dir: &Path, id: &str) -> Result<PathBuf> {
    Ok(file(dir, id)?.with_extension("images"))
}

/// One image may be this large. The API takes 5 MB of base64, which is 3.75 MB of image.
pub const MAX_IMAGE: usize = 3_700_000;
/// A dropped file larger than this is not read at all; the window makes smaller ones fit.
const MAX_DROPPED: u64 = 30_000_000;

/// The media type an image's name stands for. The name is ours (the window makes it up):
/// letters, digits and `-`, then one of the four extensions Claude reads.
pub fn media_type(name: &str) -> Result<&'static str> {
    let (stem, ext) = name.rsplit_once('.').unwrap_or(("", ""));
    let plain = !stem.is_empty() && stem.len() <= 64 && stem.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    match (plain, ext) {
        (true, "png") => Ok("image/png"),
        (true, "jpg") => Ok("image/jpeg"),
        (true, "gif") => Ok("image/gif"),
        (true, "webp") => Ok("image/webp"),
        _ => Err(AppError::msg(format!("\"{name}\" is not an image name"))),
    }
}

/// What the bytes are, whatever the name says.
fn sniff(bytes: &[u8]) -> Option<&'static str> {
    match bytes {
        [0x89, b'P', b'N', b'G', ..] => Some("image/png"),
        [0xff, 0xd8, 0xff, ..] => Some("image/jpeg"),
        [b'G', b'I', b'F', b'8', ..] => Some("image/gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => Some("image/webp"),
        _ => None,
    }
}

/// Keep an image the user attached to a message of this session.
pub fn image_save(history: &History, id: &str, name: &str, bytes: &[u8]) -> Result<()> {
    let folder = images(&history.dir, id)?;
    if sniff(bytes) != Some(media_type(name)?) {
        return Err(AppError::msg("That is not a PNG, JPEG, GIF or WebP image"));
    }
    if bytes.len() > MAX_IMAGE {
        return Err(AppError::msg("That image is too large to send"));
    }
    let said = |e: std::io::Error| AppError::msg(format!("{}: {e}", folder.display()));
    std::fs::create_dir_all(&folder).map_err(said)?;
    std::fs::write(folder.join(name), bytes).map_err(said)
}

pub fn image_read(dir: &Path, id: &str, name: &str) -> Result<Vec<u8>> {
    media_type(name)?;
    let path = images(dir, id)?.join(name);
    std::fs::read(&path).map_err(|e| AppError::msg(format!("{}: {e}", path.display())))
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
        // Its images go with it.
        let _ = std::fs::remove_dir_all(path.with_extension("images"));
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

/// `data` is the image in base64.
#[tauri::command]
pub async fn agent_image_save(history: State<'_, History>, id: String, name: String, data: String) -> Result<()> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).map_err(|_| AppError::msg("That image did not arrive whole"))?;
    image_save(&history, &id, &name, &bytes)
}

/// An attached image in base64, for the transcript to show.
#[tauri::command]
pub async fn agent_image_read(history: State<'_, History>, id: String, name: String) -> Result<String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(image_read(&history.dir, &id, &name)?))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dropped {
    /// What the file's extension says it is; the window decodes it and decides.
    pub media_type: String,
    pub data: String,
}

/// An image file the user dropped on a session, in base64. Only files named as images are read.
#[tauri::command]
pub async fn agent_image_file(path: String) -> Result<Dropped> {
    let file = Path::new(&path);
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let media_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" | "heif" => "image/heic",
        "tif" | "tiff" => "image/tiff",
        "bmp" => "image/bmp",
        _ => return Err(AppError::msg("Only images can be attached")),
    };
    let said = |e: std::io::Error| AppError::msg(format!("{}: {e}", file.display()));
    if std::fs::metadata(file).map_err(said)?.len() > MAX_DROPPED {
        return Err(AppError::msg("That image is too large to attach"));
    }
    Ok(Dropped { media_type: media_type.into(), data: base64::engine::general_purpose::STANDARD.encode(std::fs::read(file).map_err(said)?) })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    #[test]
    fn images_are_kept_beside_the_session_and_go_with_it() {
        let h = scratch("images");
        save(&h, "s-1", Some("{}")).unwrap();
        image_save(&h, "s-1", "a1.png", PNG).unwrap();
        assert_eq!(image_read(&h.dir, "s-1", "a1.png").unwrap(), PNG);
        // The folder is not taken for a session.
        assert_eq!(load(&h.dir).unwrap().sessions, ["{}"]);
        assert!(load(&h.dir).unwrap().unreadable.is_empty());

        // The name is ours and stays in the folder; the bytes are what the name says.
        for name in ["../a.png", "a/b.png", "a.txt", "a", ".png", "a b.png", "a.PNG"] {
            assert!(image_save(&h, "s-1", name, PNG).is_err(), "{name:?}");
            assert!(image_read(&h.dir, "s-1", name).is_err(), "{name:?}");
        }
        assert!(image_save(&h, "../s", "a.png", PNG).is_err());
        assert!(image_save(&h, "s-1", "a.jpg", PNG).is_err(), "a PNG named as a JPEG");
        assert!(image_save(&h, "s-1", "a.png", b"<svg onload=x>").is_err());
        assert!(image_save(&h, "s-1", "big.png", &[PNG, &vec![0; MAX_IMAGE]].concat()).is_err());

        save(&h, "s-1", None).unwrap();
        assert!(image_read(&h.dir, "s-1", "a1.png").is_err());
        assert!(!h.dir.join("s-1.images").exists());
        let _ = std::fs::remove_dir_all(h.dir.parent().unwrap());
    }

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
