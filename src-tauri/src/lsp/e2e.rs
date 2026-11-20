//! End to end against the real servers. Ignored by default: they install the
//! servers into a scratch folder with the app's own install code (network, npm
//! and dotnet needed), start each one in a copy of a fixture project from
//! `tests/fixtures`, and speak the protocol to it.
//!
//!   cargo test -- --ignored e2e
//!
//! Two clients are exercised. The `*_hover_and_definition` tests talk through
//! this file's small client, which sends what the frontend sends (the same
//! capabilities file, the same `initialize` fields). The `app_client_*` tests
//! run the frontend's own client code in Node (`scripts/lsp-smoke.mjs`).

use super::servers::{self, Source, Spec};
use super::{read_message, write_message, Tail};
use crate::proc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

/// What the frontend declares; `LspService` sends this very file.
const CAPABILITIES: &str = include_str!("../../../src/services/lsp/capabilities.json");

fn scratch() -> PathBuf {
    std::env::temp_dir().join("melodic-studio-lsp-e2e")
}

/// Symlinks resolved (macOS keeps its temp folder behind one), so paths compare with what servers answer.
fn real(path: PathBuf) -> PathBuf {
    if cfg!(windows) {
        path // canonicalize would make it a \\?\ path, which neither cmd.exe nor a file URI takes
    } else {
        std::fs::canonicalize(&path).unwrap_or(path)
    }
}

/// The stand-in for the app data folder. Kept between runs, so only the first one downloads.
fn managed() -> PathBuf {
    let dir = scratch().join("managed");
    std::fs::create_dir_all(&dir).unwrap();
    real(dir)
}

/// Install through the app's own code. One at a time, as the app does: two of them share an npm folder.
fn installed(name: &str) -> &'static Spec {
    static INSTALLING: Mutex<()> = Mutex::new(());
    let spec = servers::named(name).unwrap();
    let _one_at_a_time = INSTALLING.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    servers::install(spec, &managed()).unwrap_or_else(|e| panic!("installing {name}: {e}"));
    spec
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(entry.file_name());
        if entry.path().is_dir() {
            copy_dir(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), target).unwrap();
        }
    }
}

/// A private copy of `tests/fixtures/<name>`: servers write into the project (C# builds into obj/).
fn fixture(name: &str) -> PathBuf {
    static COPIES: AtomicU32 = AtomicU32::new(0);
    let from = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures").join(name);
    // The space is deliberate: checkouts live under names like "C:\Users\Jo Bloggs", and the URIs must survive it.
    let to = scratch().join(format!("work {}-{}", std::process::id(), COPIES.fetch_add(1, Ordering::Relaxed))).join(name);
    let _ = std::fs::remove_dir_all(&to);
    copy_dir(&from, &to);
    if name == "csharp" {
        // Target whatever SDK this machine has, so the test does not need one particular .NET.
        let version = proc::command("dotnet").arg("--version").output().expect("dotnet runs").stdout;
        let major = String::from_utf8_lossy(&version).trim().split('.').next().unwrap().to_string();
        let project = to.join("Fixture.csproj");
        std::fs::write(&project, std::fs::read_to_string(&project).unwrap().replace("net10.0", &format!("net{major}.0"))).unwrap();
    }
    real(to)
}

fn file_uri(path: &Path) -> String {
    let mut text = path.to_string_lossy().replace('\\', "/");
    if !text.starts_with('/') {
        text.insert(0, '/');
    }
    let mut uri = String::from("file://");
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'/' | b'-' | b'.' | b'_' | b'~' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

/// A file URI as something to compare: unescaped and lower case, however the server chose to write it.
fn uri_path(uri: &str) -> String {
    let bytes = uri.trim_start_matches("file://").as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let escaped = (bytes[i] == b'%' && i + 2 < bytes.len()).then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|hex| u8::from_str_radix(hex, 16).ok())).flatten();
        match escaped {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(bytes[i]);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).to_lowercase()
}

/// Where the first `needle` in `text` starts, as a protocol position.
fn position(text: &str, needle: &str) -> Value {
    let at = text.find(needle).unwrap_or_else(|| panic!("{needle:?} is not in the fixture"));
    let before = &text[..at];
    let line = before.matches('\n').count();
    let character = before.rsplit('\n').next().unwrap().encode_utf16().count();
    json!({ "line": line, "character": character })
}

/// The `initialize` request, field for field what `initializeParams` in src/services/lsp/protocol.ts builds.
fn initialize_params(root: &Path, options: &Value) -> Value {
    let uri = file_uri(root);
    let mut params = json!({
        "processId": null,
        "clientInfo": { "name": "Melodic Studio" },
        "rootPath": root.to_string_lossy(),
        "rootUri": uri,
        "workspaceFolders": [{ "uri": uri, "name": root.file_name().unwrap().to_string_lossy() }],
        "capabilities": serde_json::from_str::<Value>(CAPABILITIES).unwrap(),
    });
    if !options.is_null() {
        params["initializationOptions"] = options.clone();
    }
    params
}

/// One real server, started the way `lsp_start` starts it, with a client that does what the frontend's does.
struct Session {
    server: &'static str,
    root: PathBuf,
    child: Child,
    stdin: ChildStdin,
    incoming: mpsc::Receiver<Value>,
    stderr: Tail,
    next: i64,
    /// Published diagnostics by `uri_path`.
    diagnostics: HashMap<String, Vec<Value>>,
}

impl Session {
    fn start(server: &str) -> Session {
        let spec = installed(server);
        let root = fixture(server);
        let launch = servers::launch(spec, &root, &managed()).expect("it was just installed");
        assert_eq!(launch.source, Source::Managed, "the fixture has no copy of its own, so the app's is used");
        let mut child = launch.command(&root).stderr(Stdio::piped()).spawn().unwrap_or_else(|e| panic!("starting {}: {e}", launch.program.display()));
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = Tail::default();
        stderr.follow(child.stderr.take().unwrap());
        let (sender, incoming) = mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            while let Some(body) = read_message(&mut reader) {
                if sender.send(serde_json::from_slice::<Value>(&body).expect("servers send JSON")).is_err() {
                    break;
                }
            }
        });
        let mut session = Session { server: spec.name, root, child, stdin, incoming, stderr, next: 0, diagnostics: HashMap::new() };
        let params = initialize_params(&session.root, &launch.initialization_options);
        let answer = session.request("initialize", params).unwrap_or_else(|e| panic!("{server} refused initialize: {e}"));
        assert!(answer["capabilities"]["hoverProvider"] != Value::Null, "{server} offers hover: {answer}");
        assert!(answer["capabilities"]["definitionProvider"] != Value::Null, "{server} offers definition: {answer}");
        session.notify("initialized", json!({}));
        session
    }

    /// One item of a `workspace/configuration` request: null ("your defaults"), except where `SETTINGS` in protocol.ts says otherwise.
    fn setting(&self, item: &Value) -> Value {
        match (self.server, item["section"].as_str()) {
            ("csharp", Some("csharp")) => json!({}),
            _ => Value::Null,
        }
    }

    fn send(&mut self, message: Value) {
        write_message(&mut self.stdin, &message).unwrap_or_else(|e| panic!("the server is gone ({e}); it said:\n{}", self.stderr.text()));
    }

    fn notify(&mut self, method: &str, params: Value) {
        self.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    /// Send a request and deal with whatever arrives until its answer does. Err is the server's error answer.
    fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.next += 1;
        let id = self.next;
        self.send(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            let message = self
                .incoming
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .unwrap_or_else(|_| panic!("no answer to {method}; the server said:\n{}", self.stderr.text()));
            match message["method"].as_str() {
                Some(asked) if !message["id"].is_null() => {
                    // The server asks the client something; answer as `Client.answer` in protocol.ts does.
                    let result = match asked {
                        "workspace/configuration" => message["params"]["items"].as_array().map(|items| items.iter().map(|item| self.setting(item)).collect()).unwrap_or_else(|| json!([])),
                        "workspace/workspaceFolders" => json!([{ "uri": file_uri(&self.root), "name": self.root.file_name().unwrap().to_string_lossy() }]),
                        _ => Value::Null,
                    };
                    self.send(json!({ "jsonrpc": "2.0", "id": message["id"], "result": result }));
                }
                Some("textDocument/publishDiagnostics") => {
                    let uri = uri_path(message["params"]["uri"].as_str().unwrap_or_default());
                    self.diagnostics.insert(uri, message["params"]["diagnostics"].as_array().cloned().unwrap_or_default());
                }
                Some(_) => {}
                None if message["id"].as_i64() == Some(id) => {
                    return match &message["error"] {
                        Value::Null => Ok(message["result"].clone()),
                        error => Err(error.to_string()),
                    };
                }
                None => {}
            }
        }
    }

    /// Servers index in the background, so an early question can come back empty: ask until the answer is good.
    fn eventually<T>(&mut self, what: &str, mut ask: impl FnMut(&mut Session) -> Result<T, String>) -> T {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            match ask(self) {
                Ok(answer) => return answer,
                Err(last) if Instant::now() > deadline => panic!("{what}: gave up; last answer: {last}\nthe server said:\n{}", self.stderr.text()),
                Err(_) => std::thread::sleep(Duration::from_millis(500)),
            }
        }
    }

    /// didOpen, as the frontend sends it. Returns the URI and the text.
    fn open(&mut self, file: &str, language_id: &str) -> (String, String) {
        let path = self.root.join(file);
        let (uri, text) = (file_uri(&path), std::fs::read_to_string(&path).unwrap());
        self.notify("textDocument/didOpen", json!({ "textDocument": { "uri": uri, "languageId": language_id, "version": 1, "text": text } }));
        (uri, text)
    }

    /// Hover on the first `needle` until it mentions `expected`. Returns the hover's contents as JSON text.
    fn hover(&mut self, (uri, text): &(String, String), needle: &str, expected: &str) -> String {
        let params = json!({ "textDocument": { "uri": uri }, "position": position(text, needle) });
        self.eventually(&format!("hover on {needle}"), |session| {
            let contents = session.request("textDocument/hover", params.clone())?["contents"].to_string();
            if contents.contains(expected) {
                Ok(contents)
            } else {
                Err(contents)
            }
        })
    }

    /// Go to definition on the first `needle` until it lands in `file`. Returns the line of text it lands on.
    fn definition(&mut self, (uri, text): &(String, String), needle: &str, file: &str) -> String {
        let params = json!({ "textDocument": { "uri": uri }, "position": position(text, needle) });
        let target = self.root.join(file);
        let wanted = uri_path(&file_uri(&target));
        let line = self.eventually(&format!("definition of {needle}"), |session| {
            let answer = session.request("textDocument/definition", params.clone())?;
            // A Location, a list of them, or LocationLinks (we said linkSupport).
            let list = match &answer {
                Value::Array(list) => list.clone(),
                Value::Null => Vec::new(),
                one => vec![one.clone()],
            };
            list.iter()
                .find(|l| uri_path(l["targetUri"].as_str().or(l["uri"].as_str()).unwrap_or_default()) == wanted)
                .and_then(|l| [&l["targetSelectionRange"], &l["range"]].into_iter().find_map(|range| range["start"]["line"].as_u64()))
                .ok_or_else(|| answer.to_string())
        });
        std::fs::read_to_string(&target).unwrap().lines().nth(line as usize).unwrap_or_default().trim().to_string()
    }

    /// Wait for an error-severity diagnostic on the file whose message mentions `expected`.
    fn error_diagnostic(&mut self, (uri, _): &(String, String), expected: &str) -> String {
        let key = uri_path(uri);
        self.eventually(&format!("diagnostics for {uri}"), |session| {
            // Any request pumps the messages that arrived meanwhile.
            session.request("textDocument/documentSymbol", json!({ "textDocument": { "uri": uri } }))?;
            let seen = session.diagnostics.get(&key).cloned().unwrap_or_default();
            seen.iter().filter(|d| d["severity"].as_u64().unwrap_or(1) == 1).filter_map(|d| d["message"].as_str()).find(|m| m.contains(expected)).map(str::to_string).ok_or_else(|| format!("{seen:?}"))
        })
    }

    fn finish(mut self) {
        let _ = self.request("shutdown", Value::Null);
        self.notify("exit", Value::Null);
        std::thread::sleep(Duration::from_millis(200));
        let _ = self.child.kill();
        let _ = self.child.wait();
        // Only a passing test tidies up; a failing one leaves the project to look at.
        if let Some(work) = self.root.parent() {
            let _ = std::fs::remove_dir_all(work);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
#[ignore = "e2e: installs typescript-language-server from npm (network, node) and runs it"]
fn typescript_hover_and_definition() {
    let mut session = Session::start("typescript");
    let main = session.open("src/main.ts", "typescript");
    let hover = session.hover(&main, "greet(visitor", "greet(name: string): string");
    assert!(hover.contains("Builds the line the fixture prints."), "the doc comment comes along: {hover}");
    assert_eq!(session.definition(&main, "greet(visitor", "src/greeter.ts"), "export function greet(name: string): string {");
    assert_eq!(session.definition(&main, "Visitor =", "src/greeter.ts"), "export interface Visitor {");

    // .tsx has to be announced as typescriptreact, or the JSX in it is a syntax error.
    let badge = session.open("src/badge.tsx", "typescriptreact");
    session.hover(&badge, "greet(name)", "greet(name: string): string");
    // Plain JavaScript gets its types from JSDoc.
    let legacy = session.open("src/legacy.js", "javascript");
    session.hover(&legacy, "double(2)", "double(amount: number): number");

    let broken = session.open("src/broken.ts", "typescript");
    assert_eq!(session.error_diagnostic(&broken, "not assignable"), "Type 'string' is not assignable to type 'number'.");
    assert!(session.diagnostics.get(&uri_path(&badge.0)).is_none_or(|list| list.is_empty()), "badge.tsx is clean: {:?}", session.diagnostics);
    session.finish();
}

#[test]
#[ignore = "e2e: installs intelephense from npm (network, node) and runs it"]
fn php_hover_and_definition() {
    let mut session = Session::start("php");
    let index = session.open("index.php", "php");
    let hover = session.hover(&index, "greet('world')", "function greet(string $name): string");
    assert!(hover.contains("Builds the line the fixture prints."), "the doc comment comes along: {hover}");
    assert_eq!(session.definition(&index, "greet('world')", "src/Greeter.php"), "public function greet(string $name): string");
    assert_eq!(session.definition(&index, "Greeter()", "src/Greeter.php"), "class Greeter");

    let broken = session.open("broken.php", "php");
    assert!(session.error_diagnostic(&broken, "Undefined function").contains("fixture_function_that_does_not_exist"));
    // The index went where we said, not into the system temp folder.
    assert!(managed().join("storage").join("php").join("cache").is_dir());
    session.finish();
}

#[test]
#[ignore = "e2e: installs csharp-ls from NuGet (network, dotnet SDK) and runs it"]
fn csharp_hover_and_definition() {
    let mut session = Session::start("csharp");
    let program = session.open("Program.cs", "csharp");
    let hover = session.hover(&program, "Greet(\"world\")", "string Greeter.Greet(string name)");
    assert!(hover.contains("Builds the line the fixture prints."), "the doc comment comes along: {hover}");
    assert_eq!(session.definition(&program, "Greet(\"world\")", "Greeter.cs"), "public string Greet(string name)");
    assert_eq!(session.definition(&program, "Greeter()", "Greeter.cs"), "public class Greeter");

    let broken = session.open("Broken.cs", "csharp");
    assert!(session.error_diagnostic(&broken, "Cannot implicitly convert").contains("'string' to 'int'"));
    session.finish();
}

#[test]
#[ignore = "e2e: installs and removes servers in a fresh folder (network, npm, dotnet)"]
fn managed_install_and_removal() {
    let dir = real({
        let dir = scratch().join(format!("install {}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    });
    for name in ["php", "csharp", "typescript"] {
        let spec = servers::named(name).unwrap();
        let before = servers::info(spec, None, &dir);
        assert!(!before.managed && before.installable && before.prerequisite_found, "{before:?}");

        servers::install(spec, &dir).unwrap_or_else(|e| panic!("installing {name}: {e}"));
        let after = servers::info(spec, None, &dir);
        assert_eq!(after.source, Some(Source::Managed), "{after:?}");
        assert!(after.managed && after.problem.is_none(), "{after:?}");
        assert!(after.version.as_deref().is_some_and(|v| v.starts_with(|c: char| c.is_ascii_digit())), "{after:?}");
        assert!(Path::new(after.path.as_deref().unwrap()).starts_with(&dir), "inside the app's folder, never global: {after:?}");
        // Again is an update, not an error.
        servers::install(spec, &dir).unwrap_or_else(|e| panic!("installing {name} again: {e}"));

        if name == "typescript" {
            // A TypeScript the server can drive came with it, and php, installed first into the same folder, is still there.
            let options = servers::launch(spec, &dir, &dir).unwrap().initialization_options;
            assert!(Path::new(options["tsserver"]["path"].as_str().unwrap()).is_file(), "{options}");
            assert!(servers::managed_binary(servers::named("php").unwrap(), &dir).is_some());
        }
    }
    let listed = servers::list(None, &dir);
    assert_eq!(listed.iter().map(|s| s.name).collect::<Vec<_>>(), ["typescript", "php", "csharp", "rust"]);

    for name in ["typescript", "csharp", "php"] {
        let spec = servers::named(name).unwrap();
        servers::uninstall(spec, &dir).unwrap_or_else(|e| panic!("removing {name}: {e}"));
        assert!(servers::managed_binary(spec, &dir).is_none());
        assert!(!servers::info(spec, None, &dir).managed);
    }
    let _ = std::fs::remove_dir_all(&dir);
}

// ---- the frontend's own client, in Node ------------------------------------------------

/// Start the server as the app would, then let `scripts/lsp-smoke.mjs` drive it with
/// src/services/lsp/protocol.ts and check the answers after they have been through its conversions.
fn app_client(server: &str, checks: Value) {
    let spec = installed(server);
    let root = fixture(server);
    let launch = servers::launch(spec, &root, &managed()).expect("it was just installed");
    let plan = json!({
        "server": spec.name,
        "binary": launch.program.to_string_lossy(),
        "args": launch.args,
        "env": launch.env.iter().cloned().collect::<HashMap<String, String>>(),
        "root": root.to_string_lossy(),
        "initializationOptions": launch.initialization_options,
        "checks": checks,
    });
    let work = root.parent().unwrap().to_path_buf();
    let plan_file = work.join("plan.json");
    std::fs::write(&plan_file, serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = proc::command("node").arg(project.join("scripts").join("lsp-smoke.mjs")).arg(&plan_file).current_dir(project).output().expect("node runs");
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "the app's client failed against {server}:\n{stdout}\n{stderr}");
    println!("{stdout}");
    let _ = std::fs::remove_dir_all(work);
}

#[test]
#[ignore = "e2e: runs the frontend's client in Node against typescript-language-server (network, node)"]
fn app_client_typescript() {
    app_client(
        "typescript",
        json!([
            { "file": "src/main.ts", "language": "typescript",
              "hover": { "needle": "greet(visitor", "contains": "greet(name: string): string" },
              "completion": { "after": "greet(visitor.", "contains": ["name", "visits"], "resolve": { "label": "name", "contains": "Visitor.name: string" } },
              "signature": { "after": "= greet(", "contains": "greet(name: string): string" },
              "highlights": { "needle": "visitor.name", "count": 2 },
              "rename": { "needle": "greet(visitor", "to": "welcome", "files": ["src/main.ts", "src/greeter.ts", "src/badge.tsx"] },
              "symbol": { "query": "gree", "contains": "greet" },
              "definition": { "needle": "greet(visitor", "file": "src/greeter.ts", "text": "export function greet" },
              "symbols": ["message", "visitor"], "diagnostics": null,
              "edit": { "after": "greet(visitor.name);", "insert": "\nconst again = gret(visitor.name);", "diagnostics": "Cannot find name 'gret'",
                        "fix": { "title": "Change spelling to 'greet'", "text": "const again = greet(visitor.name);" } } },
            // Monaco calls .tsx "typescript"; languageId() must turn that into typescriptreact.
            { "file": "src/badge.tsx", "language": "typescript", "hover": { "needle": "greet(name)", "contains": "greet(name: string): string" }, "symbols": ["badge"], "diagnostics": null },
            { "file": "src/legacy.js", "language": "javascript", "hover": { "needle": "double(2)", "contains": "double(amount: number): number" } },
            { "file": "src/broken.ts", "language": "typescript", "diagnostics": "not assignable" },
        ]),
    );
}

/// The same for a server the app never installs (rust-analyzer, Pyright): whatever this machine has
/// on its PATH, or nothing to run, which is said and is not a failure.
fn app_client_found(server: &str, checks: Value) {
    let spec = servers::named(server).unwrap();
    let root = fixture(server);
    let Some(launch) = servers::launch(spec, &root, &managed()) else {
        println!("skipped: {} is not installed on this machine", spec.program);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
        return;
    };
    let plan = json!({
        "server": spec.name,
        "binary": launch.program.to_string_lossy(),
        "args": launch.args,
        "env": launch.env.iter().cloned().collect::<HashMap<String, String>>(),
        "root": root.to_string_lossy(),
        "initializationOptions": launch.initialization_options,
        "checks": checks,
    });
    let work = root.parent().unwrap().to_path_buf();
    let plan_file = work.join("plan.json");
    std::fs::write(&plan_file, serde_json::to_vec_pretty(&plan).unwrap()).unwrap();
    let project = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let out = proc::command("node").arg(project.join("scripts").join("lsp-smoke.mjs")).arg(&plan_file).current_dir(project).output().expect("node runs");
    let (stdout, stderr) = (String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    assert!(out.status.success(), "the app's client failed against {server}:\n{stdout}\n{stderr}");
    println!("{stdout}");
    let _ = std::fs::remove_dir_all(work);
}

#[test]
#[ignore = "e2e: runs the frontend's client in Node against the rust-analyzer on PATH, if there is one (node, cargo)"]
fn app_client_rust() {
    app_client_found(
        "rust",
        json!([
            { "file": "src/main.rs", "language": "rust",
              "hover": { "needle": "greet(\"world\")", "contains": "fn greet(name: &str) -> String" },
              "rename": { "needle": "greet(\"world\")", "to": "welcome", "files": ["src/main.rs", "src/greeter.rs"] },
              "symbol": { "query": "gree", "contains": "greet" },
              "definition": { "needle": "greet(\"world\")", "file": "src/greeter.rs", "text": "pub fn greet" } },
        ]),
    );
}

#[test]
#[ignore = "e2e: runs the frontend's client in Node against the pyright-langserver on PATH, if there is one (node)"]
fn app_client_python() {
    app_client_found(
        "python",
        json!([
            { "file": "main.py", "language": "python",
              "hover": { "needle": "greet(\"world\")", "contains": "greet(name: str) -> str" },
              "rename": { "needle": "greet(\"world\")", "to": "welcome", "files": ["main.py", "greeter.py"] },
              "definition": { "needle": "greet(\"world\")", "file": "greeter.py", "text": "def greet" },
              "diagnostics": null },
        ]),
    );
}

#[test]
#[ignore = "e2e: runs the frontend's client in Node against intelephense (network, node)"]
fn app_client_php() {
    app_client(
        "php",
        json!([
            { "file": "index.php", "language": "php",
              "hover": { "needle": "greet('world')", "contains": "function greet(string $name): string" },
              "completion": { "after": "$greeter->", "contains": ["greet"] },
              "signature": { "after": "$greeter->greet(", "contains": "(string $name)" },
              "highlights": { "needle": "greeter->greet", "count": 2 },
              "definition": { "needle": "greet('world')", "file": "src/Greeter.php", "text": "public function greet" },
              "symbols": ["greeter"], "diagnostics": null,
              // Rename is intelephense's paid half: without a licence key it says it has none, and the editor says why (RENAME_NOTES).
              "offers": { "renameProvider": false },
              "edit": { "after": "greet('world');", "insert": "\nmissing_function();", "diagnostics": "Undefined function" } },
            { "file": "src/Greeter.php", "language": "php", "symbols": ["Greeter", "greet"] },
            { "file": "broken.php", "language": "php", "diagnostics": "Undefined function",
              "disk": { "file": "src/extra.php", "text": "<?php\n\nfunction fixture_function_that_does_not_exist(): void {}\n", "clears": "Undefined function" } },
        ]),
    );
}

#[test]
#[ignore = "e2e: runs the frontend's client in Node against csharp-ls (network, node, dotnet SDK)"]
fn app_client_csharp() {
    app_client(
        "csharp",
        json!([
            { "file": "Program.cs", "language": "csharp",
              "hover": { "needle": "Greet(\"world\")", "contains": "string Greeter.Greet(string name)" },
              "completion": { "after": "WriteLine(greeter.", "contains": ["Greet"] },
              "signature": { "after": "greeter.Greet(", "contains": "Greet(string name)" },
              "highlights": { "needle": "greeter.Greet", "count": 2 },
              "rename": { "needle": "Greet(\"world\")", "to": "Welcome", "files": ["Program.cs", "Greeter.cs"] },
              "symbol": { "query": "Greet", "contains": "Greet" },
              "definition": { "needle": "Greet(\"world\")", "file": "Greeter.cs", "text": "public string Greet" },
              "diagnostics": null,
              "edit": { "after": "Greet(\"world\"));", "insert": "\nint wrong = \"text\";", "diagnostics": "Cannot implicitly convert" } },
            { "file": "Greeter.cs", "language": "csharp", "symbols": ["Greeter", "Greet"],
              "edit": { "after": "return $\"Hello, {name}!\";", "insert": "\n        var extra = new Extra();", "diagnostics": "Extra" },
              "disk": { "file": "Extra.cs", "text": "namespace Fixture;\n\npublic class Extra { }\n", "clears": "Extra" } },
            { "file": "Broken.cs", "language": "csharp", "diagnostics": "Cannot implicitly convert" },
        ]),
    );
}
