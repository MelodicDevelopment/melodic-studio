//! Language servers. We start the server the user already has installed for a
//! language (rust-analyzer, typescript-language-server, ...) in the active
//! checkout and relay its JSON-RPC messages to the window; the protocol itself
//! is spoken by the frontend. Nothing is bundled or downloaded.

use crate::commands::repo;
use crate::error::{AppError, Result};
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::Mutex;
use tauri::{Emitter, Manager, State};

struct Server {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Default)]
pub struct Lsp {
    servers: Mutex<HashMap<String, Server>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LspMessage {
    key: String,
    message: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    /// Names this server in `lsp_send` and in `lsp-message` events.
    pub key: String,
    /// The checkout folder the server was started in.
    pub root: String,
    /// False when it was already running (and so is already initialised).
    pub fresh: bool,
}

/// The server for a Monaco language id: (program, arguments).
fn server_for(language: &str) -> Option<(&'static str, &'static [&'static str])> {
    match language {
        "typescript" | "javascript" | "typescriptreact" | "javascriptreact" => Some(("typescript-language-server", &["--stdio"])),
        "rust" => Some(("rust-analyzer", &[])),
        "python" => Some(("pyright-langserver", &["--stdio"])),
        "go" => Some(("gopls", &[])),
        "php" => Some(("intelephense", &["--stdio"])),
        "csharp" => Some(("csharp-ls", &[])),
        _ => None,
    }
}

/// A project's own copy (node_modules/.bin) wins over one on PATH.
fn locate(root: &Path, program: &str) -> Option<PathBuf> {
    crate::proc::find_in(&root.join("node_modules").join(".bin"), program).or_else(|| crate::proc::find(program))
}

/// Read one `Content-Length`-framed message. None at end of stream.
fn read_message(reader: &mut impl BufRead) -> Option<Vec<u8>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let mut body = vec![0; length?];
    reader.read_exact(&mut body).ok()?;
    Some(body)
}

/// Start (or find) the language server for `language` in the active checkout.
/// Ok(None) means no server for that language is installed.
#[tauri::command]
pub async fn lsp_start(app: tauri::AppHandle, state: State<'_, AppState>, lsp: State<'_, Lsp>, id: String, language: String) -> Result<Option<Started>> {
    let root = repo(&state, &id)?.dir;
    let Some((program, args)) = server_for(&language) else {
        return Ok(None);
    };
    let Some(binary) = locate(&root, program) else {
        return Ok(None);
    };
    let root_str = root.to_string_lossy().to_string();
    let key = format!("{program}@{root_str}");
    let mut servers = lsp.servers.lock().unwrap();
    if let Some(server) = servers.get_mut(&key) {
        if matches!(server.child.try_wait(), Ok(None)) {
            return Ok(Some(Started { key, root: root_str, fresh: false }));
        }
        servers.remove(&key);
    }

    let mut child = crate::proc::command(&binary)
        .args(args)
        .current_dir(&root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| AppError::msg(format!("Could not start {program}: {e}")))?;
    let stdin = child.stdin.take().ok_or_else(|| AppError::msg("No input pipe to the language server"))?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("No output pipe from the language server"))?;
    servers.insert(key.clone(), Server { child, stdin });

    let thread_key = key.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while let Some(body) = read_message(&mut reader) {
            if let Ok(message) = serde_json::from_slice::<serde_json::Value>(&body) {
                let _ = app.emit("lsp-message", LspMessage { key: thread_key.clone(), message });
            }
        }
        if let Some(mut server) = app.state::<Lsp>().servers.lock().unwrap().remove(&thread_key) {
            let _ = server.child.wait();
        }
        let _ = app.emit("lsp-closed", thread_key);
    });
    Ok(Some(Started { key, root: root_str, fresh: true }))
}

#[tauri::command]
pub async fn lsp_send(lsp: State<'_, Lsp>, key: String, message: serde_json::Value) -> Result<()> {
    let body = serde_json::to_vec(&message)?;
    let mut servers = lsp.servers.lock().unwrap();
    let server = servers.get_mut(&key).ok_or_else(|| AppError::msg("That language server is not running"))?;
    server.stdin.write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())?;
    server.stdin.write_all(&body)?;
    server.stdin.flush()?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(lsp: State<'_, Lsp>, key: String) -> Result<()> {
    if let Some(mut server) = lsp.servers.lock().unwrap().remove(&key) {
        crate::proc::kill_tree(&mut server.child);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames() {
        let stream = b"Content-Length: 17\r\nContent-Type: x\r\n\r\n{\"jsonrpc\":\"2.0\"}content-length: 2\r\n\r\n{}Content-Length: 99\r\n\r\n{";
        let mut reader = BufReader::new(&stream[..]);
        assert_eq!(read_message(&mut reader).unwrap(), b"{\"jsonrpc\":\"2.0\"}");
        assert_eq!(read_message(&mut reader).unwrap(), b"{}");
        assert!(read_message(&mut reader).is_none(), "a truncated body ends the stream");
    }

    #[test]
    fn servers() {
        assert_eq!(server_for("rust").unwrap().0, "rust-analyzer");
        assert_eq!(server_for("typescript").unwrap().0, "typescript-language-server");
        assert!(server_for("plaintext").is_none());
        let dir = std::env::temp_dir().join(format!("studio-lsp-test-{}", std::process::id()));
        let bin = dir.join("node_modules/.bin");
        std::fs::create_dir_all(&bin).unwrap();
        let file = bin.join(if cfg!(windows) { "typescript-language-server.cmd" } else { "typescript-language-server" });
        std::fs::write(&file, "").unwrap();
        assert_eq!(locate(&dir, "typescript-language-server").unwrap(), file);
        assert!(locate(&dir, "no-such-language-server-anywhere").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
