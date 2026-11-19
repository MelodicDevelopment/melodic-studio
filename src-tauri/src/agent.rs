//! AI agent sessions: Claude Code run headless inside a checkout of a registered
//! repository. We do not reimplement the agent; we start the user's own `claude`
//! CLI, stream its JSON events to the window, and let the session id carry the
//! conversation between turns.

use crate::commands::main_repo;
use crate::error::{AppError, Result};
use crate::worktree;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::{Emitter, State};

#[derive(Default)]
pub struct Agents {
    running: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    key: String,
    event: serde_json::Value,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentDone {
    key: String,
    ok: bool,
    error: String,
}

/// Extras for one turn. Everything is optional; an agent session sends none of it.
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct RunOptions {
    /// Permission rules to pre-approve (`Read`, `Bash(git log:*)`). An empty list means no tools at all.
    pub tools: Option<Vec<String>>,
    /// A model alias or id (`haiku`, `sonnet`, `opus`).
    pub model: Option<String>,
    /// A one-shot question: skip MCP servers and skills so it starts fast, and keep no session.
    pub quick: bool,
    /// Skip MCP servers and skills like `quick`, but keep the session so the next turn can resume it.
    pub lean: bool,
    /// The built-in tools Claude can see at all (`Read`, `Grep`). None leaves the usual set. This is
    /// what makes a read-only session read-only whatever the user's own settings allow.
    pub builtin: Option<Vec<String>>,
    /// The turn belongs to an investigation: it gets Studio's own tools for running the app
    /// (`investigate.rs`) and none of the user's settings, so nothing else can start it.
    pub investigate: Option<Investigate>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Investigate {
    /// The run target the error came from, when it came from one.
    pub target: Option<String>,
}

fn plain(s: &str, extra: &str) -> bool {
    !s.is_empty() && s.chars().all(|ch| ch.is_ascii_alphanumeric() || extra.contains(ch))
}

/// The command line for one turn (everything after `claude`). The prompt is not on it.
/// `mcp` is the `--mcp-config` file of an investigation's turn.
fn turn_args(mode: &str, resume: Option<&str>, options: &RunOptions, mcp: Option<&str>) -> Result<Vec<String>> {
    if !matches!(mode, "default" | "plan" | "acceptEdits" | "bypassPermissions") {
        return Err(AppError::msg("Unknown permission mode"));
    }
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", mode].map(String::from).to_vec();
    if let Some(session) = resume.filter(|s| plain(s, "-") && !s.starts_with('-')) {
        args.extend(["--resume".to_string(), session.to_string()]);
    }
    if let Some(config) = mcp {
        // Restricted: the user's own settings (their allow rules, their hooks) do not apply, so what the
        // session may run is exactly the rules below. Its only MCP server is ours.
        args.extend(["--restricted", "--strict-mcp-config", "--mcp-config", config, "--disable-slash-commands"].map(String::from));
    } else if options.quick || options.lean {
        args.extend(["--strict-mcp-config", "--disable-slash-commands"].map(String::from));
    }
    if options.quick {
        args.push("--no-session-persistence".into());
    }
    if let Some(model) = options.model.as_deref().filter(|m| plain(m, "-._[]")) {
        args.extend(["--model".to_string(), model.to_string()]);
    }
    match (options.builtin.as_deref(), options.tools.as_deref()) {
        (Some(names), _) => {
            if names.iter().any(|n| !plain(n, "_")) {
                return Err(AppError::msg("Invalid tool name"));
            }
            args.extend(["--tools".to_string(), names.join(",")]);
        }
        (None, Some([])) => args.extend(["--tools".to_string(), String::new()]),
        _ => {}
    }
    // Last, because the option takes every argument that follows it.
    if let Some(rules) = options.tools.as_deref().filter(|r| !r.is_empty()) {
        if rules.iter().any(|r| r.is_empty() || r.starts_with('-')) {
            return Err(AppError::msg("Invalid tool rule"));
        }
        args.push("--allowedTools".into());
        args.extend(rules.iter().cloned());
    }
    Ok(args)
}

fn claude() -> Command {
    let mut c = crate::proc::command("claude");
    // Started from inside another Claude Code session these would make the child think it is nested.
    for name in crate::terminal::CLAUDE_MARKERS {
        c.env_remove(name);
    }
    // `claude -p` counts as the SDK, where the Artifact tool is off unless this is set (checked with 2.1.327).
    // The user's own `enableArtifact: false` still wins, and so does their own CLAUDE_CODE_ARTIFACT.
    if std::env::var_os(ARTIFACT_ENV).is_none() {
        c.env(ARTIFACT_ENV, "1");
    }
    c
}

const ARTIFACT_ENV: &str = "CLAUDE_CODE_ARTIFACT";

/// The installed Claude Code version, or None when the CLI is not on PATH.
#[tauri::command]
pub async fn agent_available() -> Result<Option<String>> {
    Ok(claude().arg("--version").output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()))
}

/// Only the events the transcript shows; hooks, rate-limit and token ticks are noise.
fn wanted(event: &serde_json::Value) -> bool {
    match event.get("type").and_then(|t| t.as_str()) {
        Some("assistant") | Some("user") | Some("result") => true,
        Some("system") => event.get("subtype").and_then(|s| s.as_str()) == Some("init"),
        _ => false,
    }
}

/// Run one turn. `key` names the session in the UI; `resume` is Claude's own
/// session id from an earlier turn. `mode` is a Claude Code permission mode.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn agent_start(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    agents: State<'_, Agents>,
    id: String,
    cwd: String,
    key: String,
    prompt: String,
    mode: String,
    resume: Option<String>,
    options: Option<RunOptions>,
) -> Result<()> {
    let mut options = options.unwrap_or_default();
    if options.investigate.is_some() {
        // Our own tools ask the user themselves, so Claude Code does not have to.
        options.tools.get_or_insert_with(Vec::new).extend(crate::investigate::tool_rules());
    }
    let (git, _) = main_repo(&state, &id)?;
    if !worktree::belongs(&git, Path::new(&cwd)) {
        return Err(AppError::msg("Agents can only run inside this repository or one of its worktrees"));
    }
    let mcp = match &options.investigate {
        // The user's own checkout is never what an investigation edits or runs.
        Some(_) if crate::paths::same(&cwd, &git.dir) => return Err(AppError::msg("An investigation works in a worktree of its own")),
        Some(investigation) => Some(crate::investigate::prepare(&app, &key, Path::new(&cwd), investigation.target.clone())?),
        None => None,
    };
    let args = turn_args(&mode, resume.as_deref(), &options, mcp.as_ref().map(|file| file.to_string_lossy()).as_deref())?;
    if prompt.trim().is_empty() {
        return Err(AppError::msg("Give the agent something to do"));
    }
    if agents.running.lock().unwrap().contains_key(&key) {
        return Err(AppError::msg("This agent is still working"));
    }

    let mut c = claude();
    c.current_dir(&cwd).args(args);
    let investigating = mcp.is_some();
    if investigating {
        // A tool of ours waits for the user's answer, which can take as long as the user does.
        c.env("MCP_TOOL_TIMEOUT", "3600000");
    }
    c.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = c.spawn().map_err(|e| AppError::msg(format!("Could not start Claude Code: {e}. Is the `claude` CLI installed?")))?;

    // The prompt goes in on stdin so nothing in it can be read as a command-line option.
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(prompt.as_bytes())?;
    }
    let stdout = child.stdout.take().ok_or_else(|| AppError::msg("No output from Claude Code"))?;
    let mut stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    agents.running.lock().unwrap().insert(key.clone(), child.clone());

    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(pipe) = stderr.as_mut() {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });

    let app2 = app.clone();
    std::thread::spawn(move || {
        use tauri::Manager;
        for line in BufReader::new(stdout).lines().map_while(|l| l.ok()) {
            if let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) {
                if wanted(&event) {
                    let _ = app2.emit("agent-event", AgentEvent { key: key.clone(), event });
                }
            }
        }
        let ok = child.lock().unwrap().wait().map(|s| s.success()).unwrap_or(false);
        let error = errors.join().unwrap_or_default();
        if investigating {
            // The app it started does not outlive the turn, and nothing keeps waiting for an answer.
            crate::investigate::turn_ended(&app2, &key);
        }
        app2.state::<Agents>().running.lock().unwrap().remove(&key);
        let tail: String = error.trim().chars().rev().take(600).collect::<Vec<_>>().into_iter().rev().collect();
        let _ = app2.emit("agent-done", AgentDone { key, ok, error: tail });
    });
    Ok(())
}

#[tauri::command]
pub async fn agent_stop(agents: State<'_, Agents>, key: String) -> Result<()> {
    if let Some(child) = agents.running.lock().unwrap().get(&key) {
        // The whole tree: on Windows `claude` is a .cmd shim, and killing that leaves node running.
        crate::proc::kill_tree(&mut child.lock().unwrap());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(mode: &str, resume: Option<&str>, options: RunOptions) -> Vec<String> {
        turn_args(mode, resume, &options, None).unwrap()
    }

    #[test]
    fn command_line() {
        let base = ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode"];
        assert_eq!(args("acceptEdits", None, RunOptions::default()), [&base[..], &["acceptEdits"]].concat());
        assert_eq!(args("plan", Some("abc-123"), RunOptions::default())[6..], ["--resume", "abc-123"]);
        assert_eq!(args("plan", Some("--evil"), RunOptions::default()).len(), 6, "a session id that could be read as an option is dropped");
        assert!(turn_args("yolo", None, &RunOptions::default(), None).is_err());

        // A one-shot question: no MCP, no skills, no session, no tools.
        let quick = args("default", None, RunOptions { quick: true, tools: Some(vec![]), model: Some("haiku".into()), ..Default::default() });
        assert_eq!(quick[6..], ["--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--model", "haiku", "--tools", ""]);

        // A read-only chat: starts as fast, keeps its session, sees only the tools it is allowed.
        let rules = vec!["Read".to_string(), "Bash(git log:*)".to_string()];
        let ask = args("default", Some("s1"), RunOptions { lean: true, tools: Some(rules), builtin: Some(vec!["Read".into(), "Bash".into()]), ..Default::default() });
        assert_eq!(ask[6..], ["--resume", "s1", "--strict-mcp-config", "--disable-slash-commands", "--tools", "Read,Bash", "--allowedTools", "Read", "Bash(git log:*)"]);
        assert!(!ask.contains(&"--no-session-persistence".to_string()));

        // An investigation: none of the user's settings, only our MCP server, then its own tools and rules.
        let rules = vec!["Edit".to_string(), "Bash(dotnet build:*)".to_string(), "mcp__studio__run_target".to_string()];
        let investigate = turn_args("acceptEdits", Some("s2"), &RunOptions { tools: Some(rules), builtin: Some(vec!["Edit".into(), "Bash".into()]), investigate: Some(Investigate::default()), ..Default::default() }, Some("/cache/x.json")).unwrap();
        assert_eq!(investigate[6..], ["--resume", "s2", "--restricted", "--strict-mcp-config", "--mcp-config", "/cache/x.json", "--disable-slash-commands", "--tools", "Edit,Bash", "--allowedTools", "Edit", "Bash(dotnet build:*)", "mcp__studio__run_target"]);

        assert!(turn_args("default", None, &RunOptions { tools: Some(vec!["--dangerously-skip-permissions".into()]), ..Default::default() }, None).is_err());
        assert!(turn_args("default", None, &RunOptions { builtin: Some(vec!["Read,Edit".into()]), ..Default::default() }, None).is_err());
    }
}
