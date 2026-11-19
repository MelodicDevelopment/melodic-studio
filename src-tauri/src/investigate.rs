//! Investigations: the tools Claude gets for reproducing a failure, and the recordings it makes.
//!
//! An investigation is an agent session (`agent.rs`) in a worktree of its own. It may read and edit
//! there and build, but running the app, sending it a request and running tests go only through
//! the tools here, so the user is asked first. The tools are a small MCP server over HTTP on
//! 127.0.0.1 with a secret in its address (the pattern of the hook receiver in `conversation.rs`);
//! the session gets it through `--mcp-config`.
//!
//! A tool that runs something emits `investigate-approval` and waits. The window answers with
//! `investigate_start` (run it: the program starts on a pty the window shows as a terminal tab) or
//! `investigate_answer`. Nothing here decides to run anything by itself.
//!
//! Recording: the code Claude adds appends JSON lines to the file named by `STUDIO_REPLAY_FILE`,
//! which is `<worktree>/.studio/replay/run-<n>.jsonl`. When a run starts, every file that holds a
//! `studio-replay` line is copied beside it (`run-<n>.files/`), so Replay can show the code exactly
//! as it ran. `replay_read` hands both to the window.

use crate::commands::main_repo;
use crate::conversation::read_request;
use crate::error::{AppError, Result};
use crate::git::Git;
use crate::run::{self, Runs};
use crate::targets::{self, Kind, Runtime, Target};
use crate::terminal::{self, Terminals};
use crate::{worktree, AppState};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

/// The comment that ends every line of recording code.
pub const MARKER: &str = "studio-replay";
/// The name the MCP server goes by, and so the prefix of its tools (`mcp__studio__run_target`).
pub const SERVER_NAME: &str = "studio";

/// How long a tool waits for the user's answer before giving up.
const APPROVAL_WAIT: Duration = Duration::from_secs(30 * 60);
/// How long `run_tests` lets a test run take.
const TEST_WAIT: Duration = Duration::from_secs(15 * 60);
/// How much of a program's output is kept for Claude, and how much of it one answer carries.
const OUTPUT_KEPT: usize = 512 * 1024;
const OUTPUT_SENT: usize = 12_000;
/// The largest request and response bodies `http_request` deals in.
const BODY_SENT: usize = 16_000;
const RESPONSE_MAX: usize = 4 * 1024 * 1024;
/// Recording files: the largest recording handed to the window, and the largest file copied.
const REPLAY_MAX: u64 = 8 * 1024 * 1024;
const SNAPSHOT_MAX: u64 = 1024 * 1024;
const SNAPSHOT_FILES: usize = 200;

// ---- state --------------------------------------------------------------------

/// What a program started for an investigation has printed, and whether it has ended.
#[derive(Default)]
struct Output {
    bytes: Vec<u8>,
    /// Bytes printed in all, including what is no longer kept.
    total: u64,
    /// Set once the program has ended: its exit code, when the system reported one.
    ended: Option<Option<u32>>,
}

type Shared = Arc<(Mutex<Output>, Condvar)>;

/// The copy of the app (or the test run) an investigation has going.
struct Running {
    term: String,
    port: Option<u16>,
    output: Shared,
}

/// One investigation: the session it belongs to and where it works.
struct Session {
    /// The agent session's key in the window.
    key: String,
    /// The worktree, spelled as the window knows it.
    checkout: PathBuf,
    /// The target the error came from, when it came from a run.
    target: Option<String>,
    tag: String,
    running: Mutex<Option<Running>>,
    /// How many recorded runs it has started.
    replays: Mutex<u32>,
}

enum Answer {
    /// Go ahead (a request).
    Allowed,
    /// Go ahead: the window started the program.
    Started,
    Denied,
    /// The turn ended, or the session is gone.
    Cancelled,
}

/// A tool call waiting for the user.
struct Pending {
    session: Arc<Session>,
    /// What to start when the answer is yes; None for `http_request`.
    launch: Option<(Target, Vec<String>)>,
    answer: mpsc::Sender<Answer>,
}

#[derive(Default)]
pub struct Investigations {
    server: OnceLock<std::result::Result<(u16, String), String>>,
    /// By the tag in each session's MCP address.
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Mutex<HashMap<String, Pending>>,
    last: AtomicU64,
}

/// What the approval card shows.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Approval {
    /// The agent session.
    key: String,
    /// Names this question in `investigate_start` / `investigate_answer`.
    request: String,
    /// `run_target`, `run_tests` or `http_request`.
    tool: String,
    /// The target's name ("https", "All tests") and group ("Shop.Api · launch profiles").
    target: Option<String>,
    group: Option<String>,
    /// The project the target belongs to ("Shop.Api"), when its group names one rather than a file.
    project: Option<String>,
    command: Option<String>,
    port: Option<u16>,
    method: Option<String>,
    path: Option<String>,
    body: Option<String>,
    /// Claude's own sentence on what this touches outside the worktree. Untrusted: shown as text.
    touches: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    key: String,
    step: u8,
    detail: Option<String>,
    thinking: Option<String>,
}

/// What `investigate_start` answers: the terminal to show.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub key: String,
    pub port: Option<u16>,
    pub command: String,
    /// The number of the recording this run writes.
    pub replay: u32,
}

fn secret() -> String {
    (0..2).map(|_| format!("{:016x}", RandomState::new().build_hasher().finish())).collect()
}

fn cut(s: &str, max: usize) -> String {
    match s.char_indices().nth(max) {
        Some((at, _)) => format!("{}…", &s[..at]),
        None => s.to_string(),
    }
}

/// Terminal output as text: escape sequences and carriage returns taken out.
pub fn plain(bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\x1b' => match chars.next() {
                // CSI: parameters, then one final byte.
                Some('[') => {
                    for d in chars.by_ref() {
                        if ('\x40'..='\x7e').contains(&d) {
                            break;
                        }
                    }
                }
                // OSC: up to BEL or ESC \.
                Some(']') => {
                    while let Some(d) = chars.next() {
                        if d == '\x07' {
                            break;
                        }
                        if d == '\x1b' {
                            chars.next();
                            break;
                        }
                    }
                }
                // Charset selection takes one more character; the other two-character sequences are done.
                Some('(' | ')') => drop(chars.next()),
                _ => {}
            },
            '\r' => {}
            c if c.is_control() && c != '\n' && c != '\t' => {}
            c => out.push(c),
        }
    }
    out
}

/// The end of `text`, cut at a line start, with a note when something was left out.
fn tail(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.to_string();
    }
    let mut from = text.len() - max;
    while !text.is_char_boundary(from) {
        from += 1;
    }
    let from = text[from..].find('\n').map(|i| from + i + 1).unwrap_or(from);
    format!("[... earlier output not shown]\n{}", &text[from..])
}

impl Output {
    fn push(&mut self, bytes: &[u8]) {
        self.total += bytes.len() as u64;
        self.bytes.extend_from_slice(bytes);
        if self.bytes.len() > OUTPUT_KEPT {
            let extra = self.bytes.len() - OUTPUT_KEPT;
            self.bytes.drain(..extra);
        }
    }

    /// What was printed after the first `mark` bytes.
    fn since(&self, mark: u64) -> String {
        let kept_from = self.total - self.bytes.len() as u64;
        let from = mark.saturating_sub(kept_from).min(self.bytes.len() as u64) as usize;
        plain(&self.bytes[from..])
    }
}

// ---- recordings -----------------------------------------------------------------

fn replay_dir(checkout: &Path) -> PathBuf {
    checkout.join(".studio").join("replay")
}

/// Keep `.studio/` out of git in this repository (its worktrees share `info/exclude`), and make the recording folder.
pub fn prepare_checkout(checkout: &Path) -> Result<()> {
    std::fs::create_dir_all(replay_dir(checkout))?;
    let git = Git::at(checkout);
    let listed = git.run(&["rev-parse", "--git-path", "info/exclude"])?;
    let listed = listed.trim();
    let file = if Path::new(listed).is_absolute() { PathBuf::from(listed) } else { checkout.join(listed) };
    let text = std::fs::read_to_string(&file).unwrap_or_default();
    if !text.lines().any(|l| l.trim() == ".studio/") {
        if let Some(parent) = file.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let gap = if text.is_empty() || text.ends_with('\n') { "" } else { "\n" };
        std::fs::write(&file, format!("{text}{gap}.studio/\n"))?;
    }
    Ok(())
}

/// The files of the checkout that hold recording code right now, repository-relative.
fn instrumented(checkout: &Path) -> Vec<String> {
    // Exit code 1 (an error here) is git's "nothing matched".
    Git::at(checkout).run(&["grep", "-l", "-I", "--untracked", "-F", "-e", MARKER]).map(|out| out.lines().map(str::to_string).filter(|l| !l.is_empty()).take(SNAPSHOT_FILES).collect()).unwrap_or_default()
}

/// Copy every instrumented file to `run-<n>.files/`, so Replay shows the code as it was when it ran.
fn snapshot(checkout: &Path, run: u32) -> Result<usize> {
    let dest = replay_dir(checkout).join(format!("run-{run}.files"));
    let mut copied = 0;
    for rel in instrumented(checkout) {
        // Git's own listing of this checkout; still, nothing leaves the folder.
        if rel.split('/').any(|part| part == ".." || part.is_empty()) || Path::new(&rel).is_absolute() {
            continue;
        }
        let from = rel.split('/').fold(checkout.to_path_buf(), |p, part| p.join(part));
        if !std::fs::metadata(&from).is_ok_and(|m| m.is_file() && m.len() <= SNAPSHOT_MAX) {
            continue;
        }
        let to = rel.split('/').fold(dest.clone(), |p, part| p.join(part));
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::copy(&from, &to)?;
        copied += 1;
    }
    Ok(copied)
}

/// Delete a recording helper: a file inside the checkout that git does not track and that holds the marker.
/// Nothing of the user's can go this way: their files are tracked, or do not say `studio-replay`.
pub fn remove_recording_file(checkout: &Path, rel: &str) -> Result<()> {
    let rel = rel.replace('\\', "/");
    let rel = rel.trim_start_matches("./");
    if rel.is_empty() || Path::new(rel).is_absolute() || rel.split('/').any(|part| part.is_empty() || part == ".." || part == ".git") {
        return Err(AppError::msg("The path must be inside the worktree"));
    }
    let file = rel.split('/').fold(checkout.to_path_buf(), |p, part| p.join(part));
    let meta = std::fs::symlink_metadata(&file).map_err(|_| AppError::msg(format!("{rel} does not exist")))?;
    if !meta.is_file() || meta.len() > SNAPSHOT_MAX {
        return Err(AppError::msg(format!("{rel} is not a recording file")));
    }
    if !String::from_utf8_lossy(&std::fs::read(&file)?).contains(MARKER) {
        return Err(AppError::msg(format!("{rel} does not hold the {MARKER} marker, so it is not deleted. Edit it instead.")));
    }
    if Git::at(checkout).run(&["ls-files", "--error-unmatch", "--", rel]).is_ok() {
        return Err(AppError::msg(format!("{rel} is part of the repository, so it is not deleted. Remove the recording lines from it instead.")));
    }
    std::fs::remove_file(&file)?;
    Ok(())
}

/// The next recording number of a checkout: one past the highest `run-<n>.jsonl` or `run-<n>.files` there.
fn next_run(checkout: &Path) -> u32 {
    let highest = std::fs::read_dir(replay_dir(checkout))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().and_then(|n| n.strip_prefix("run-")).and_then(|n| n.split('.').next()).and_then(|n| n.parse::<u32>().ok()))
        .max()
        .unwrap_or(0);
    highest + 1
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ReplayFile {
    pub path: String,
    /// The file as it was when the run started, recording lines included.
    pub text: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Replay {
    pub run: u32,
    /// The recording: one JSON object per line, as the program wrote them.
    pub events: String,
    pub files: Vec<ReplayFile>,
}

fn collect(dir: &Path, rel: &str, out: &mut Vec<ReplayFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let Ok(name) = entry.file_name().into_string() else { continue };
        let path = if rel.is_empty() { name.clone() } else { format!("{rel}/{name}") };
        match entry.file_type() {
            Ok(t) if t.is_dir() => collect(&entry.path(), &path, out),
            Ok(t) if t.is_file() && out.len() < SNAPSHOT_FILES => {
                if let Ok(text) = std::fs::read_to_string(entry.path()) {
                    out.push(ReplayFile { path, text });
                }
            }
            _ => {}
        }
    }
}

/// Recording `run` of the checkout: its events and the files as they ran.
pub fn read_replay(checkout: &Path, run: u32) -> Result<Replay> {
    let dir = replay_dir(checkout);
    let log = dir.join(format!("run-{run}.jsonl"));
    let size = std::fs::metadata(&log).map(|m| m.len()).map_err(|_| AppError::msg(format!("Recording {run} is not there any more")))?;
    if size > REPLAY_MAX {
        return Err(AppError::msg("That recording is too large to show"));
    }
    let events = String::from_utf8_lossy(&std::fs::read(&log)?).to_string();
    let mut files = vec![];
    collect(&dir.join(format!("run-{run}.files")), "", &mut files);
    Ok(Replay { run, events, files })
}

// ---- a small HTTP client ----------------------------------------------------------

#[derive(Debug, PartialEq)]
struct HttpAnswer {
    status: u16,
    reason: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

fn unchunk(mut data: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    while let Some(end) = data.windows(2).position(|w| w == b"\r\n") {
        let size = std::str::from_utf8(&data[..end]).ok().and_then(|l| usize::from_str_radix(l.split(';').next().unwrap_or("").trim(), 16).ok());
        let Some(size) = size else { break };
        data = &data[end + 2..];
        if size == 0 || data.len() < size {
            out.extend_from_slice(&data[..size.min(data.len())]);
            break;
        }
        out.extend_from_slice(&data[..size]);
        data = data.get(size + 2..).unwrap_or(&[]);
    }
    out
}

fn parse_response(raw: &[u8]) -> Option<HttpAnswer> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let mut lines = head.split("\r\n");
    let mut status_line = lines.next()?.splitn(3, ' ');
    if !status_line.next()?.starts_with("HTTP/") {
        return None;
    }
    let status = status_line.next()?.parse().ok()?;
    let reason = status_line.next().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(n, v)| (n.trim().to_string(), v.trim().to_string())).collect();
    let header = |name: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str());
    let rest = &raw[split + 4..];
    let body = if header("transfer-encoding").is_some_and(|v| v.to_ascii_lowercase().contains("chunked")) {
        unchunk(rest)
    } else {
        match header("content-length").and_then(|v| v.parse::<usize>().ok()) {
            Some(n) => rest[..n.min(rest.len())].to_vec(),
            None => rest.to_vec(),
        }
    };
    Some(HttpAnswer { status, reason, headers, body })
}

/// A header name or value, a method or a path that cannot break out of its line.
fn one_line(s: &str) -> bool {
    !s.is_empty() && !s.chars().any(|c| c.is_control())
}

/// The bytes of one HTTP/1.1 request.
fn build_request(port: u16, method: &str, path: &str, headers: &[(String, String)], body: Option<&str>) -> Result<Vec<u8>> {
    if !method.chars().all(|c| c.is_ascii_alphabetic()) || method.is_empty() || method.len() > 12 {
        return Err(AppError::msg("That is not an HTTP method"));
    }
    if !path.starts_with('/') || !one_line(path) || path.contains(' ') {
        return Err(AppError::msg("The path must start with / and hold no spaces (encode them as %20)"));
    }
    let mut out = format!("{} {path} HTTP/1.1\r\nHost: localhost:{port}\r\nConnection: close\r\n", method.to_ascii_uppercase());
    let has = |name: &str| headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name));
    for (name, value) in headers {
        let reserved = ["host", "connection", "content-length", "transfer-encoding"].iter().any(|r| name.eq_ignore_ascii_case(r));
        if reserved || !one_line(name) || name.contains([':', ' ']) || !one_line(value) {
            continue;
        }
        out.push_str(&format!("{name}: {value}\r\n"));
    }
    if !has("accept") {
        out.push_str("Accept: */*\r\n");
    }
    if let Some(body) = body {
        if !has("content-type") {
            out.push_str("Content-Type: application/json\r\n");
        }
        out.push_str(&format!("Content-Length: {}\r\n", body.len()));
    }
    out.push_str("\r\n");
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body.unwrap_or("").as_bytes());
    Ok(bytes)
}

/// Send one request to a port on this computer and read the whole answer.
fn http_call(port: u16, request: &[u8], timeout: Duration) -> Result<HttpAnswer> {
    // `localhost` first: some servers listen only on ::1, others only on 127.0.0.1.
    let addresses: Vec<_> = ("localhost", port).to_socket_addrs().map(|a| a.collect()).unwrap_or_default();
    let fallback = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = addresses.iter().chain(std::iter::once(&fallback)).find_map(|a| TcpStream::connect_timeout(a, Duration::from_secs(3)).ok()).ok_or_else(|| AppError::msg(format!("Nothing is listening on port {port}")))?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(request)?;
    stream.flush()?;
    let mut raw = vec![];
    let mut buf = [0u8; 16 * 1024];
    loop {
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                raw.extend_from_slice(&buf[..n]);
                if raw.len() > RESPONSE_MAX {
                    break;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) if !raw.is_empty() => break,
            Err(e) => return Err(AppError::msg(format!("No answer from port {port}: {e}"))),
        }
    }
    parse_response(&raw).ok_or_else(|| AppError::msg(format!("Port {port} did not answer with HTTP")))
}

// ---- the tools --------------------------------------------------------------------

/// The tools Claude sees, as MCP describes them.
pub fn tool_list() -> Value {
    let touches = json!({ "type": "string", "description": "One plain sentence for the user on what this will touch or change outside the worktree (a database it writes to, an email it sends, an external API it calls), or that it touches nothing. The user reads it before allowing the run." });
    let target = json!({ "type": "string", "description": "A target id from the list in your instructions. Leave out to use the target the error came from." });
    json!([
        {
            "name": "progress",
            "description": "Tell the user where the investigation stands. Call it whenever you start a step of the checklist, and whenever your understanding of the cause changes.",
            "inputSchema": { "type": "object", "properties": {
                "step": { "type": "integer", "minimum": 1, "maximum": 6, "description": "The checklist step you are on now: 1 read the error and the code on its path, 2 find the failing request or input, 3 add recording, 4 run it again recording, 5 narrow down the cause, 6 write the fix and a test." },
                "detail": { "type": "string", "description": "A few words shown under that step: the files read, the request found, how many functions are recorded." },
                "thinking": { "type": "string", "description": "Your thinking so far, in two or three sentences of Markdown. Cite code as `path:line`." }
            }, "required": ["step"] }
        },
        {
            "name": "run_target",
            "description": "Start (or restart) the app in your worktree on its own port, after the user allows it. Waits until the app accepts connections, then answers with the port and what the app printed. Each start begins a new recording file.",
            "inputSchema": { "type": "object", "properties": { "target": target, "touches": touches, "wait_seconds": { "type": "integer", "description": "How long to wait for the app to come up (default 120)." } }, "required": ["touches"] }
        },
        {
            "name": "http_request",
            "description": "Send one HTTP request to the app you started with run_target, after the user allows it. Answers with the status, the response body and what the app printed meanwhile.",
            "inputSchema": { "type": "object", "properties": {
                "method": { "type": "string" },
                "path": { "type": "string", "description": "Path and query, starting with /." },
                "body": { "type": "string", "description": "The request body, sent as application/json unless a Content-Type header says otherwise." },
                "headers": { "type": "object", "additionalProperties": { "type": "string" } },
                "touches": touches
            }, "required": ["method", "path", "touches"] }
        },
        {
            "name": "run_tests",
            "description": "Run a test target in your worktree, after the user allows it. Waits for it to finish and answers with the exit code and the output. Each run begins a new recording file.",
            "inputSchema": { "type": "object", "properties": { "target": target, "filter": { "type": "string", "description": "Only the tests whose name matches this (the runner's own filter syntax: a test name is always fine)." }, "touches": touches }, "required": ["touches"] }
        },
        {
            "name": "target_output",
            "description": "What the app or test run you started has printed so far (the latest part). Asks nobody.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "remove_recording_file",
            "description": "Delete a file you added for recording (the helper). Only a new file in your worktree whose content holds the studio-replay marker can be deleted this way. Asks nobody.",
            "inputSchema": { "type": "object", "properties": { "path": { "type": "string", "description": "Relative to the worktree's root." } }, "required": ["path"] }
        },
        {
            "name": "stop_target",
            "description": "Stop the app you started with run_target. Asks nobody.",
            "inputSchema": { "type": "object", "properties": {} }
        }
    ])
}

/// The permission rules that let a session call the tools without Claude Code asking (we ask instead).
pub fn tool_rules() -> Vec<String> {
    tool_list().as_array().into_iter().flatten().filter_map(|t| t["name"].as_str()).map(|name| format!("mcp__{SERVER_NAME}__{name}")).collect()
}

/// The arguments that make a test target run only the tests matching `filter`.
pub fn filter_args(target: &Target, filter: &str) -> Result<Vec<String>> {
    let filter = filter.trim();
    if filter.is_empty() {
        return Ok(vec![]);
    }
    if filter.starts_with('-') || filter.chars().any(|c| c.is_control()) {
        return Err(AppError::msg("That test filter cannot be used"));
    }
    let f = filter.to_string();
    Ok(match target.runtime {
        Runtime::Dotnet => vec!["--filter".into(), f],
        Runtime::Rust => vec![f],
        Runtime::Go => vec!["-run".into(), f],
        Runtime::Python => vec!["-k".into(), f],
        // npm and pnpm pass what follows `--` to the script; yarn and bun pass everything.
        Runtime::Node if matches!(target.argv.first().map(String::as_str), Some("npm" | "pnpm")) => vec!["--".into(), f],
        Runtime::Node => vec![f],
    })
}

/// "Shop.Api" from the group "Shop.Api · launch profiles"; None when the group is only the file the target was read from.
fn project(target: &Target) -> Option<String> {
    let first = target.group.split(" · ").next().unwrap_or_default();
    (!first.is_empty() && first != target.source).then(|| first.to_string())
}

struct Tool<'a> {
    app: &'a tauri::AppHandle,
    session: Arc<Session>,
}

type ToolResult = std::result::Result<String, String>;

fn text_arg<'v>(args: &'v Value, name: &str) -> Option<&'v str> {
    args.get(name).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty())
}

impl Tool<'_> {
    fn hub(&self) -> State<'_, Investigations> {
        self.app.state::<Investigations>()
    }

    /// The target a tool call means: the one it names, else the investigation's own, else the only candidate.
    fn target(&self, args: &Value, kind: Kind) -> std::result::Result<Target, String> {
        let all = targets::discover(&self.session.checkout);
        let listing = || all.iter().filter(|t| t.kind == kind).map(|t| format!("{} ({})", t.id, t.argv.join(" "))).collect::<Vec<_>>().join("\n");
        if let Some(id) = text_arg(args, "target") {
            return all.iter().find(|t| t.id == id).cloned().ok_or_else(|| format!("There is no target with the id {id:?}. The {} targets are:\n{}", if kind == Kind::Test { "test" } else { "run" }, listing()));
        }
        let own = self.session.target.as_ref().and_then(|id| all.iter().find(|t| &t.id == id));
        let pick = match (own, kind) {
            (Some(own), _) if own.kind == kind => Some(own),
            // Tests for an app target: the test targets of the same runtime, when there is exactly one.
            (Some(own), Kind::Test) => {
                let same: Vec<&Target> = all.iter().filter(|t| t.kind == Kind::Test && t.runtime == own.runtime).collect();
                (same.len() == 1).then(|| same[0])
            }
            _ => {
                let of_kind: Vec<&Target> = all.iter().filter(|t| t.kind == kind).collect();
                (of_kind.len() == 1).then(|| of_kind[0])
            }
        };
        pick.cloned().ok_or_else(|| format!("Say which target: pass \"target\" with one of these ids.\n{}", listing()))
    }

    /// Ask the user and wait for the answer.
    fn ask(&self, mut approval: Approval, launch: Option<(Target, Vec<String>)>) -> std::result::Result<Answer, String> {
        let hub = self.hub();
        let request = format!("ask-{}", hub.last.fetch_add(1, Ordering::SeqCst) + 1);
        let (answer, wait) = mpsc::channel();
        hub.pending.lock().unwrap().insert(request.clone(), Pending { session: self.session.clone(), launch, answer });
        approval.key = self.session.key.clone();
        approval.request = request.clone();
        let _ = self.app.emit("investigate-approval", approval);
        let answer = wait.recv_timeout(APPROVAL_WAIT);
        hub.pending.lock().unwrap().remove(&request);
        match answer {
            Ok(Answer::Denied) => Err("The user chose not to run this. Do not try another way to run it: carry on with what you can learn by reading the code, or say what you would need.".to_string()),
            Ok(Answer::Cancelled) => Err("The investigation was stopped.".to_string()),
            Ok(answer) => Ok(answer),
            Err(_) => Err("The user has not answered. Nothing was run.".to_string()),
        }
    }

    fn running(&self) -> Option<(String, Option<u16>, Shared)> {
        self.session.running.lock().unwrap().as_ref().map(|r| (r.term.clone(), r.port, r.output.clone()))
    }

    fn progress(&self, args: &Value) -> ToolResult {
        let step = args.get("step").and_then(|s| s.as_u64()).filter(|s| (1..=6).contains(s)).ok_or("\"step\" is a number from 1 to 6")? as u8;
        let said = |name: &str, max: usize| text_arg(args, name).map(|s| cut(s, max));
        let _ = self.app.emit("investigate-progress", Progress { key: self.session.key.clone(), step, detail: said("detail", 300), thinking: said("thinking", 2000) });
        Ok("Shown to the user.".to_string())
    }

    fn run_target(&self, args: &Value) -> ToolResult {
        let target = self.target(args, Kind::Run)?;
        let port = self.app.state::<Runs>().port(self.app, &self.session.checkout, &target);
        let approval = Approval { tool: "run_target".into(), target: Some(target.name.clone()), group: Some(target.group.clone()), project: project(&target), command: Some(run::command_line(&target, &[])), port, touches: text_arg(args, "touches").map(|t| cut(t, 600)), ..Default::default() };
        self.ask(approval, Some((target.clone(), vec![])))?;
        let (_, port, output) = self.running().ok_or("The app could not be started.")?;
        let wait = Duration::from_secs(args.get("wait_seconds").and_then(|w| w.as_u64()).unwrap_or(120).clamp(5, 600));
        let started = Instant::now();
        let up = loop {
            if output.0.lock().unwrap().ended.is_some() {
                break false;
            }
            if port.is_some_and(|p| TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], p)), Duration::from_millis(300)).is_ok()) {
                break true;
            }
            if started.elapsed() > wait {
                break false;
            }
            std::thread::sleep(Duration::from_millis(400));
        };
        // A moment for the lines the app prints once it is up.
        std::thread::sleep(Duration::from_millis(if up { 500 } else { 100 }));
        let out = output.0.lock().unwrap();
        let printed = tail(&out.since(0), OUTPUT_SENT);
        let status = match (up, out.ended) {
            (true, _) => format!("{} is running and accepts connections on port {}. Send requests with http_request.", target.name, port.unwrap_or(0)),
            (false, Some(code)) => format!("{} ended{} before it accepted connections.", target.name, code.map(|c| format!(" with exit code {c}")).unwrap_or_default()),
            (false, None) => format!("{} is running but nothing answers on port {} yet. It may still be starting (look again with target_output), or it does not read its port from {}.", target.name, port.unwrap_or(0), if target.runtime == Runtime::Dotnet { "ASPNETCORE_URLS" } else { "PORT" }),
        };
        let reply = format!("{status}\n\nOutput:\n{printed}");
        if up {
            Ok(reply)
        } else {
            Err(reply)
        }
    }

    fn run_tests(&self, args: &Value) -> ToolResult {
        let target = self.target(args, Kind::Test)?;
        let extra = filter_args(&target, text_arg(args, "filter").unwrap_or("")).map_err(|e| e.to_string())?;
        let approval = Approval { tool: "run_tests".into(), target: Some(target.name.clone()), group: Some(target.group.clone()), project: project(&target), command: Some(run::command_line(&target, &extra)), touches: text_arg(args, "touches").map(|t| cut(t, 600)), ..Default::default() };
        self.ask(approval, Some((target.clone(), extra)))?;
        let (term, _, output) = self.running().ok_or("The tests could not be started.")?;
        let (lock, ended) = &*output;
        let (out, timed_out) = ended.wait_timeout_while(lock.lock().unwrap(), TEST_WAIT, |o| o.ended.is_none()).map(|(guard, t)| (guard, t.timed_out())).map_err(|_| "The test run was lost.")?;
        let printed = tail(&out.since(0), OUTPUT_SENT);
        let ended = out.ended;
        drop(out);
        if timed_out {
            terminal::close(&self.app.state::<Terminals>(), &term);
            return Err(format!("The tests were still running after {} minutes and were stopped.\n\nOutput:\n{printed}", TEST_WAIT.as_secs() / 60));
        }
        let code = ended.flatten();
        let reply = format!("The tests ended{}.\n\nOutput:\n{printed}", code.map(|c| format!(" with exit code {c}")).unwrap_or_default());
        Ok(reply)
    }

    fn http_request(&self, args: &Value) -> ToolResult {
        let (_, port, output) = self.running().filter(|(_, _, o)| o.0.lock().unwrap().ended.is_none()).ok_or("The app is not running. Start it with run_target first.")?;
        let port = port.ok_or("The app was started without a port of its own.")?;
        let method = text_arg(args, "method").unwrap_or("GET").to_ascii_uppercase();
        let path = text_arg(args, "path").ok_or("\"path\" is required")?;
        let body = args.get("body").and_then(|b| b.as_str()).filter(|b| !b.is_empty());
        let headers: Vec<(String, String)> = args.get("headers").and_then(|h| h.as_object()).into_iter().flatten().filter_map(|(n, v)| Some((n.clone(), v.as_str()?.to_string()))).collect();
        let request = build_request(port, &method, path, &headers, body).map_err(|e| e.to_string())?;
        let approval = Approval { tool: "http_request".into(), port: Some(port), method: Some(method.clone()), path: Some(cut(path, 400)), body: body.map(|b| cut(b, 2000)), touches: text_arg(args, "touches").map(|t| cut(t, 600)), ..Default::default() };
        self.ask(approval, None)?;
        let mark = output.0.lock().unwrap().total;
        let answer = http_call(port, &request, Duration::from_secs(60));
        // What the app logs about the request arrives a moment after its answer.
        std::thread::sleep(Duration::from_millis(600));
        let printed = tail(&output.0.lock().unwrap().since(mark), OUTPUT_SENT);
        let printed = if printed.trim().is_empty() { "(nothing)".to_string() } else { printed };
        match answer {
            Ok(a) => {
                let kind = a.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("content-type")).map(|(_, v)| v.as_str()).unwrap_or("");
                let body = String::from_utf8_lossy(&a.body);
                Ok(format!("{method} {path} answered {} {}\nContent-Type: {kind}\n\n{}\n\nWhat the app printed meanwhile:\n{printed}", a.status, a.reason, if body.is_empty() { "(no body)".to_string() } else { cut(&body, BODY_SENT) }))
            }
            Err(e) => Err(format!("{e}\n\nWhat the app printed meanwhile:\n{printed}")),
        }
    }

    fn target_output(&self) -> ToolResult {
        let (_, _, output) = self.running().ok_or("Nothing has been started yet.")?;
        let out = output.0.lock().unwrap();
        let state = match out.ended {
            Some(code) => format!("It has ended{}.", code.map(|c| format!(" with exit code {c}")).unwrap_or_default()),
            None => "It is still running.".to_string(),
        };
        Ok(format!("{state}\n\nOutput:\n{}", tail(&out.since(0), OUTPUT_SENT)))
    }

    fn remove_recording_file(&self, args: &Value) -> ToolResult {
        let rel = text_arg(args, "path").ok_or("\"path\" is required")?;
        remove_recording_file(&self.session.checkout, rel).map(|_| format!("Deleted {rel}.")).map_err(|e| e.to_string())
    }

    fn stop_target(&self) -> ToolResult {
        match self.session.running.lock().unwrap().as_ref() {
            Some(running) => {
                terminal::close(&self.app.state::<Terminals>(), &running.term);
                Ok("Stopped.".to_string())
            }
            None => Ok("Nothing was running.".to_string()),
        }
    }

    fn call(&self, name: &str, args: &Value) -> ToolResult {
        match name {
            "progress" => self.progress(args),
            "run_target" => self.run_target(args),
            "run_tests" => self.run_tests(args),
            "http_request" => self.http_request(args),
            "target_output" => self.target_output(),
            "remove_recording_file" => self.remove_recording_file(args),
            "stop_target" => self.stop_target(),
            _ => Err(format!("There is no tool named {name}")),
        }
    }
}

// ---- the MCP server ---------------------------------------------------------------

/// The answer to one JSON-RPC message, or None for a notification. `call` runs a tool.
fn respond(message: &Value, call: impl FnOnce(&str, &Value) -> ToolResult) -> Option<Value> {
    let id = message.get("id").filter(|id| !id.is_null())?.clone();
    let result = |result: Value| Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
    match message.get("method").and_then(|m| m.as_str()).unwrap_or("") {
        "initialize" => {
            let version = message.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or("2025-06-18");
            result(json!({ "protocolVersion": version, "capabilities": { "tools": {} }, "serverInfo": { "name": "melodic-studio", "version": env!("CARGO_PKG_VERSION") } }))
        }
        "ping" => result(json!({})),
        "tools/list" => result(json!({ "tools": tool_list() })),
        "tools/call" => {
            let name = message.pointer("/params/name").and_then(|n| n.as_str()).unwrap_or("");
            let args = message.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let (text, failed) = match call(name, &args) {
                Ok(text) => (text, false),
                Err(text) => (text, true),
            };
            result(json!({ "content": [{ "type": "text", "text": text }], "isError": failed }))
        }
        _ => Some(json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } })),
    }
}

fn write_response(stream: &mut TcpStream, status: &str, body: &str) {
    let _ = write!(stream, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    let _ = stream.flush();
}

fn serve(app: tauri::AppHandle, stream: TcpStream, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let request = read_request(&stream);
    let mut stream = stream;
    let found = request.and_then(|(path, body)| {
        let tag = path.strip_prefix(&format!("/mcp/{token}/"))?.to_string();
        let session = app.state::<Investigations>().sessions.lock().unwrap().get(&tag).cloned()?;
        Some((session, serde_json::from_slice::<Value>(&body).ok()?))
    });
    // Anything that is not a POST to a session of ours: also the GET Claude Code tries for a server-sent stream.
    let Some((session, message)) = found else {
        return write_response(&mut stream, "404 Not Found", "{}");
    };
    let tool = Tool { app: &app, session };
    match respond(&message, |name, args| tool.call(name, args)) {
        Some(reply) => write_response(&mut stream, "200 OK", &reply.to_string()),
        None => write_response(&mut stream, "202 Accepted", ""),
    }
}

impl Investigations {
    /// The server's port and secret, starting it the first time.
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
        started.clone().map_err(|e| AppError::msg(format!("Could not start the investigation tools: {e}")))
    }

    fn by_key(&self, key: &str) -> Option<Arc<Session>> {
        self.sessions.lock().unwrap().values().find(|s| s.key == key).cloned()
    }

    /// Answer everything `key` is waiting on with "stopped", and stop what it has running.
    fn settle(&self, app: &tauri::AppHandle, key: &str) {
        let waiting: Vec<Pending> = {
            let mut pending = self.pending.lock().unwrap();
            let requests: Vec<String> = pending.iter().filter(|(_, p)| p.session.key == key).map(|(r, _)| r.clone()).collect();
            requests.into_iter().filter_map(|r| pending.remove(&r)).collect()
        };
        for p in waiting {
            let _ = p.answer.send(Answer::Cancelled);
        }
        if let Some(session) = self.by_key(key) {
            if let Some(running) = session.running.lock().unwrap().as_ref() {
                terminal::close(&app.state::<Terminals>(), &running.term);
            }
        }
    }
}

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf> {
    let dir = app.path().app_cache_dir().map_err(|e| AppError::msg(e.to_string()))?.join("investigations");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// The `--mcp-config` file's content for a server at `url`.
pub fn mcp_config(url: &str) -> Value {
    json!({ "mcpServers": { SERVER_NAME: { "type": "http", "url": url } } })
}

/// Called by `agent_start` for a turn of an investigation: makes sure the session is known to the
/// server and its worktree is ready for recordings. Returns the `--mcp-config` file for the turn.
pub fn prepare(app: &tauri::AppHandle, key: &str, checkout: &Path, target: Option<String>) -> Result<PathBuf> {
    let hub = app.state::<Investigations>();
    let (port, token) = hub.server(app)?;
    prepare_checkout(checkout)?;
    let session = match hub.by_key(key) {
        Some(session) => session,
        None => {
            let session = Arc::new(Session { key: key.to_string(), checkout: checkout.to_path_buf(), target, tag: secret(), running: Mutex::new(None), replays: Mutex::new(0) });
            hub.sessions.lock().unwrap().insert(session.tag.clone(), session.clone());
            session
        }
    };
    let file = config_dir(app)?.join(format!("{}.json", session.tag));
    std::fs::write(&file, serde_json::to_vec_pretty(&mcp_config(&format!("http://127.0.0.1:{port}/mcp/{token}/{}", session.tag)))?)?;
    Ok(file)
}

/// A turn of session `key` has ended: nothing of it keeps waiting or running.
pub fn turn_ended(app: &tauri::AppHandle, key: &str) {
    app.state::<Investigations>().settle(app, key);
}

/// Files left behind by a run that did not end cleanly.
pub fn clean(app: &tauri::AppHandle) {
    if let Ok(dir) = config_dir(app) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

// ---- commands ---------------------------------------------------------------------

/// The user allowed a run: start it on a pty and answer the terminal to show. The tool that asked carries on.
#[tauri::command]
pub async fn investigate_start(app: tauri::AppHandle, hub: State<'_, Investigations>, terminals: State<'_, Terminals>, runs: State<'_, Runs>, request: String, cols: u16, rows: u16) -> Result<Started> {
    let pending = hub.pending.lock().unwrap().remove(&request).ok_or_else(|| AppError::msg("Claude is no longer waiting for that"))?;
    let session = pending.session.clone();
    let started = (|| {
        let (target, extra) = pending.launch.as_ref().ok_or_else(|| AppError::msg("There is nothing to start for that"))?;
        // One program at a time: a restart replaces the copy that was running.
        if let Some(old) = session.running.lock().unwrap().take() {
            terminal::close(&terminals, &old.term);
        }
        let dir = run::folder(&session.checkout, target)?;
        let port = (target.kind == Kind::Run).then(|| runs.port(&app, &session.checkout, target)).flatten();
        let replay = {
            let mut replays = session.replays.lock().unwrap();
            *replays = next_run(&session.checkout).max(*replays + 1);
            *replays
        };
        snapshot(&session.checkout, replay)?;
        let mut env = port.map(|p| run::port_env(target.runtime, p)).unwrap_or_default();
        env.push(("STUDIO_REPLAY_FILE".to_string(), replay_dir(&session.checkout).join(format!("run-{replay}.jsonl")).to_string_lossy().to_string()));
        let shell = run::program(&dir, target, extra, env)?;
        let output: Shared = Arc::new((Mutex::new(Output::default()), Condvar::new()));
        let (tap, done) = (output.clone(), output.clone());
        let key = terminal::start_tapped(
            app.clone(),
            &terminals,
            &shell,
            &dir,
            cols,
            rows,
            move |bytes| tap.0.lock().unwrap().push(bytes),
            move |code| {
                done.0.lock().unwrap().ended = Some(code);
                done.1.notify_all();
            },
        )?;
        *session.running.lock().unwrap() = Some(Running { term: key.clone(), port, output });
        Ok(Started { key, port, command: run::command_line(target, extra), replay })
    })();
    let _ = pending.answer.send(if started.is_ok() { Answer::Started } else { Answer::Denied });
    started
}

/// The user's answer to a question that starts nothing (a request), or "no" to any.
#[tauri::command]
pub async fn investigate_answer(hub: State<'_, Investigations>, request: String, allow: bool) -> Result<()> {
    if let Some(pending) = hub.pending.lock().unwrap().remove(&request) {
        let _ = pending.answer.send(if allow { Answer::Allowed } else { Answer::Denied });
    }
    Ok(())
}

/// The investigation is over (removed, or its app is closing): stop what it runs and forget it.
#[tauri::command]
pub async fn investigate_close(app: tauri::AppHandle, hub: State<'_, Investigations>, key: String) -> Result<()> {
    hub.settle(&app, &key);
    let gone: Vec<String> = hub.sessions.lock().unwrap().iter().filter(|(_, s)| s.key == key).map(|(tag, _)| tag.clone()).collect();
    for tag in gone {
        hub.sessions.lock().unwrap().remove(&tag);
        if let Ok(dir) = config_dir(&app) {
            let _ = std::fs::remove_file(dir.join(format!("{tag}.json")));
        }
    }
    Ok(())
}

/// Accept the fix: commit everything the investigation changed in its worktree, as the user, with the
/// user's message. Refused while recording code is still in it. Only the Accept fix button calls this.
#[tauri::command]
pub async fn investigate_commit(state: State<'_, AppState>, id: String, cwd: String, summary: String, description: String) -> Result<()> {
    let (git, _) = main_repo(&state, &id)?;
    let tree = worktree::entries(&git)?.into_iter().find(|t| crate::paths::same(&t.path, &cwd)).ok_or_else(|| AppError::msg("That worktree is not part of this repository"))?;
    if tree.is_main {
        return Err(AppError::msg("An investigation's fix is committed in its own worktree"));
    }
    let checkout = Path::new(&tree.path);
    let left = instrumented(checkout);
    if !left.is_empty() {
        return Err(AppError::msg(format!("Recording code is still in {}. It has to go before the fix is committed.", left.join(", "))));
    }
    let tree = Git::at(checkout);
    let paths: Vec<String> = tree.status()?.files.into_iter().map(|f| f.path).collect();
    if paths.is_empty() {
        return Ok(()); // already committed
    }
    tree.commit(&paths, &summary, &description, false)
}

/// Recording `run` of the worktree at `cwd`, for Replay.
#[tauri::command]
pub async fn replay_read(state: State<'_, AppState>, id: String, cwd: String, run: u32) -> Result<Replay> {
    let (git, _) = main_repo(&state, &id)?;
    if !worktree::belongs(&git, Path::new(&cwd)) {
        return Err(AppError::msg("That worktree is not part of this repository"));
    }
    read_replay(Path::new(&cwd), run)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(runtime: Runtime, argv: &[&str]) -> Target {
        Target { id: "t".into(), name: "t".into(), group: "g".into(), cwd: String::new(), argv: argv.iter().map(|a| a.to_string()).collect(), kind: Kind::Test, runtime, source: String::new() }
    }

    #[test]
    fn speaks_enough_mcp_for_claude_code() {
        let never = |_: &str, _: &Value| -> ToolResult { panic!("no tool is called here") };
        let init = respond(&json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize", "params": { "protocolVersion": "2025-11-25", "capabilities": {} } }), never).unwrap();
        assert_eq!(init["result"]["protocolVersion"], "2025-11-25");
        assert!(init["result"]["capabilities"]["tools"].is_object());
        assert!(respond(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), never).is_none(), "a notification gets no answer");
        // Claude Code probes for a method we do not have before it initialises.
        let probe = respond(&json!({ "jsonrpc": "2.0", "id": "server-discover-probe-1", "method": "server/discover" }), never).unwrap();
        assert_eq!(probe["error"]["code"], -32601);
        assert_eq!(probe["id"], "server-discover-probe-1");

        let list = respond(&json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }), never).unwrap();
        let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["progress", "run_target", "http_request", "run_tests", "target_output", "remove_recording_file", "stop_target"]);
        for tool in list["result"]["tools"].as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], "object", "{}", tool["name"]);
        }
        assert_eq!(tool_rules()[1], "mcp__studio__run_target");
    }

    #[test]
    fn tool_calls_reach_the_session_and_report_failure() {
        // A fake session: it records what was asked and answers like the real tools do.
        let asked = std::cell::RefCell::new(vec![]);
        let fake = |name: &str, args: &Value| -> ToolResult {
            asked.borrow_mut().push(format!("{name} {args}"));
            match name {
                "run_target" => Ok("https is running and accepts connections on port 7251.".into()),
                _ => Err("The user chose not to run this.".into()),
            }
        };
        let call = |name: &str, args: Value| json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/call", "params": { "name": name, "arguments": args, "_meta": { "progressToken": 2 } } });
        let ok = respond(&call("run_target", json!({ "touches": "Nothing." })), fake).unwrap();
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["result"]["isError"], false);
        assert_eq!(ok["result"]["content"][0]["text"], "https is running and accepts connections on port 7251.");
        let denied = respond(&call("http_request", json!({ "method": "POST", "path": "/api/orders" })), fake).unwrap();
        assert_eq!(denied["result"]["isError"], true);
        assert_eq!(denied["result"]["content"][0]["type"], "text");
        // No arguments at all is an empty object, not a failure.
        let bare = respond(&json!({ "jsonrpc": "2.0", "id": 8, "method": "tools/call", "params": { "name": "stop_target" } }), fake).unwrap();
        assert_eq!(bare["result"]["isError"], true);
        assert_eq!(*asked.borrow(), [r#"run_target {"touches":"Nothing."}"#, r#"http_request {"method":"POST","path":"/api/orders"}"#, "stop_target {}"]);
    }

    #[test]
    fn serves_a_session_over_http_and_nothing_else() {
        // The transport, without the app: one request in, one JSON answer out.
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            for _ in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                match read_request(&stream).and_then(|(path, body)| path.starts_with("/mcp/tok/").then_some(body)) {
                    Some(body) => {
                        let reply = respond(&serde_json::from_slice(&body).unwrap(), |_, _| Ok("fine".into())).unwrap();
                        write_response(&mut stream, "200 OK", &reply.to_string());
                    }
                    None => write_response(&mut stream, "404 Not Found", "{}"),
                }
            }
        });
        let body = r#"{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"target_output","arguments":{}}}"#;
        let good = http_call(port, &build_request(port, "POST", "/mcp/tok/tag", &[], Some(body)).unwrap(), Duration::from_secs(10)).unwrap();
        assert_eq!(good.status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&good.body).unwrap()["result"]["content"][0]["text"], "fine");
        let wrong = http_call(port, &build_request(port, "POST", "/mcp/other/tag", &[], Some(body)).unwrap(), Duration::from_secs(10)).unwrap();
        assert_eq!(wrong.status, 404, "a wrong secret gets nothing");
        server.join().unwrap();
        assert_eq!(mcp_config("http://127.0.0.1:1/mcp/t/k")["mcpServers"]["studio"], json!({ "type": "http", "url": "http://127.0.0.1:1/mcp/t/k" }));
    }

    #[test]
    fn builds_requests_and_refuses_what_could_break_out() {
        let text = |bytes: Vec<u8>| String::from_utf8(bytes).unwrap();
        let post = text(build_request(7251, "post", "/api/orders?x=1", &[("X-Test".into(), "1".into()), ("Host".into(), "evil".into()), ("Bad\r\nName".into(), "x".into())], Some("{\"a\":1}")).unwrap());
        assert_eq!(post, "POST /api/orders?x=1 HTTP/1.1\r\nHost: localhost:7251\r\nConnection: close\r\nX-Test: 1\r\nAccept: */*\r\nContent-Type: application/json\r\nContent-Length: 7\r\n\r\n{\"a\":1}");
        let get = text(build_request(80, "GET", "/", &[("Accept".into(), "text/html".into())], None).unwrap());
        assert_eq!(get, "GET / HTTP/1.1\r\nHost: localhost:80\r\nConnection: close\r\nAccept: text/html\r\n\r\n");
        assert!(build_request(80, "GET", "api", &[], None).is_err());
        assert!(build_request(80, "GET", "/a b", &[], None).is_err());
        assert!(build_request(80, "GET", "/a\r\nHost: x", &[], None).is_err());
        assert!(build_request(80, "GE T", "/", &[], None).is_err());
    }

    #[test]
    fn reads_plain_and_chunked_responses() {
        let plain = parse_response(b"HTTP/1.1 500 Internal Server Error\r\nContent-Type: application/json\r\nContent-Length: 5\r\n\r\nhelloEXTRA").unwrap();
        assert_eq!((plain.status, plain.reason.as_str(), plain.body.as_slice()), (500, "Internal Server Error", &b"hello"[..]));
        let chunked = parse_response(b"HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6;x=1\r\n world\r\n0\r\n\r\n").unwrap();
        assert_eq!((chunked.status, String::from_utf8(chunked.body).unwrap().as_str()), (201, "hello world"));
        let open_ended = parse_response(b"HTTP/1.0 200 OK\r\n\r\nall of it").unwrap();
        assert_eq!(open_ended.body, b"all of it");
        assert!(parse_response(b"not http").is_none());
        assert_eq!(unchunk(b"5\r\nhel"), b"hel", "a cut-off chunk gives what arrived");
    }

    #[test]
    fn output_is_plain_text_and_bounded() {
        assert_eq!(plain(b"\x1b[32minfo\x1b[0m: Now listening\r\n\x1b]0;title\x07fail: x\x1b(B\x08"), "info: Now listening\nfail: x");
        let mut out = Output::default();
        out.push(b"one\n");
        let mark = out.total;
        out.push(b"two\n");
        assert_eq!(out.since(mark), "two\n");
        assert_eq!(out.since(0), "one\ntwo\n");
        out.push(&vec![b'x'; OUTPUT_KEPT]);
        assert_eq!(out.bytes.len(), OUTPUT_KEPT);
        assert_eq!(out.since(mark).len(), OUTPUT_KEPT, "a mark that fell out of the buffer gives what is kept");
        assert_eq!(tail("first line\nsecond line\nthird", 14), "[... earlier output not shown]\nthird");
        assert_eq!(tail("short", 100), "short");
    }

    #[test]
    fn test_filters_per_runner() {
        let args = |runtime, argv: &[&str]| filter_args(&target(runtime, argv), "Archived_tier").unwrap().join(" ");
        assert_eq!(args(Runtime::Dotnet, &["dotnet", "test"]), "--filter Archived_tier");
        assert_eq!(args(Runtime::Rust, &["cargo", "test"]), "Archived_tier");
        assert_eq!(args(Runtime::Go, &["go", "test", "./..."]), "-run Archived_tier");
        assert_eq!(args(Runtime::Python, &["python3", "-m", "pytest"]), "-k Archived_tier");
        assert_eq!(args(Runtime::Node, &["npm", "test"]), "-- Archived_tier");
        assert_eq!(args(Runtime::Node, &["yarn", "test"]), "Archived_tier");
        assert!(filter_args(&target(Runtime::Rust, &["cargo", "test"]), "").unwrap().is_empty());
        assert!(filter_args(&target(Runtime::Rust, &["cargo", "test"]), "--no-run").is_err(), "a filter cannot be an option");

        let named = |group: &str, source: &str| project(&Target { group: group.into(), source: source.into(), ..target(Runtime::Node, &["x"]) });
        assert_eq!(named("Shop.Api · launch profiles", "launchSettings.json").as_deref(), Some("Shop.Api"));
        assert_eq!(named("Shop.Tests", "Shop.Tests.csproj").as_deref(), Some("Shop.Tests"));
        assert_eq!(named("web · package.json", "package.json").as_deref(), Some("web"));
        assert_eq!(named("package.json", "package.json"), None);
    }

    #[test]
    fn keeps_the_files_as_they_ran_and_reads_the_recording_back() {
        let root = std::env::temp_dir().join(format!("studio-replay-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        let git = Git::at(&root);
        git.run(&["init", "-q"]).unwrap();
        std::fs::write(root.join("src").join("pricing.py"), "def apply(order):\n    replay.line(order=order)  # studio-replay\n    return order.total\n").unwrap();
        std::fs::write(root.join("src").join("other.py"), "x = 1\n").unwrap();
        std::fs::write(root.join("studio_replay.py"), "# studio-replay helper\n").unwrap();

        prepare_checkout(&root).unwrap();
        prepare_checkout(&root).unwrap();
        let exclude = std::fs::read_to_string(root.join(".git").join("info").join("exclude")).unwrap();
        assert_eq!(exclude.lines().filter(|l| *l == ".studio/").count(), 1, "added once: {exclude}");

        assert_eq!(next_run(&root), 1);
        assert_eq!(snapshot(&root, 1).unwrap(), 2);
        std::fs::write(replay_dir(&root).join("run-1.jsonl"), "{\"seq\":1}\n{\"seq\":2}\n").unwrap();
        assert_eq!(next_run(&root), 2);
        // The recording folder itself is ignored, so the copies are never copied again.
        assert_eq!(snapshot(&root, 2).unwrap(), 2);

        let replay = read_replay(&root, 1).unwrap();
        assert_eq!(replay.events.lines().count(), 2);
        let paths: Vec<&str> = replay.files.iter().map(|f| f.path.as_str()).collect();
        assert_eq!(paths, ["src/pricing.py", "studio_replay.py"]);
        assert!(replay.files[0].text.contains("# studio-replay"), "the copy still has its recording lines");
        assert!(read_replay(&root, 9).is_err());

        // The helper can be deleted through the tool; nothing else can.
        git.run(&["add", "src/other.py"]).unwrap();
        assert!(remove_recording_file(&root, "src/other.py").is_err(), "no marker");
        git.run(&["add", "src/pricing.py"]).unwrap();
        assert!(remove_recording_file(&root, "src/pricing.py").unwrap_err().to_string().contains("part of the repository"));
        assert!(remove_recording_file(&root, "../outside.py").is_err());
        assert!(remove_recording_file(&root, ".git/config").is_err());
        assert!(remove_recording_file(&root, "missing.py").is_err());
        remove_recording_file(&root, "./studio_replay.py").unwrap();
        assert!(!root.join("studio_replay.py").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
