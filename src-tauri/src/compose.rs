//! Compose files as run targets: each service of a `compose.yaml` / `docker-compose.yml` is started with the
//! user's own `docker compose`, like git and gh. No Docker API.
//!
//! In the main checkout the command is what the user would type (`docker compose up --build <service>`), so
//! their override file and `.env` apply as always. A worktree's copy must not collide with it, so it gets a
//! project name of its own (`-p`) and a second compose file of ours (in the app's cache folder, never in the
//! repository) that moves every published port to a free one, chosen once and remembered.
//!
//! Stopping: `docker compose up` stops its containers on Ctrl+C, but a tab that is closed only hangs up on it
//! (terminated outright on Windows), which can leave them running. So a run of a compose target carries a
//! `docker compose stop` that the terminal runs when it is cut off (`terminal::on_close`).

use crate::error::{AppError, Result};
use crate::host_cli;
use crate::run::Runs;
use crate::targets::Target;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::Manager;

/// The names `docker compose` looks for in a folder, in its own order of preference.
pub const FILES: &[&str] = &["compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"];
/// The override file it adds by itself, which naming our own files (`-f`) would otherwise leave out.
const OVERRIDES: &[&str] = &["compose.override.yml", "compose.override.yaml", "docker-compose.override.yml", "docker-compose.override.yaml"];
/// How long `docker compose config` may take to print the project.
const CONFIG_LIMIT: Duration = Duration::from_secs(20);
/// A stop that takes longer than this is no longer waited for (docker gives a container 10 s by default).
const STOP_LIMIT: Duration = Duration::from_secs(60);

fn service_name(name: &str) -> bool {
    name.starts_with(|c: char| c.is_ascii_alphanumeric()) && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c))
}

/// The services a compose file names, in the file's order. Only the block form everyone writes is read
/// (`services:` at the left edge, one service per line under it); a file written another way has no targets.
pub fn services(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let (mut inside, mut level) = (false, None);
    for line in text.lines() {
        let bare = line.trim_end();
        let content = bare.trim_start_matches(' ');
        if content.is_empty() || content.starts_with('#') {
            continue;
        }
        let depth = bare.len() - content.len();
        if depth == 0 {
            let rest = content.strip_prefix("services:").map(str::trim_start);
            inside = rest.is_some_and(|r| r.is_empty() || r.starts_with('#'));
            level = None;
            continue;
        }
        // The first line under `services:` sets how far its services are indented; deeper lines belong to one of them.
        if !inside || depth != *level.get_or_insert(depth) {
            continue;
        }
        let Some((key, rest)) = content.split_once(':') else { continue };
        let key = key.trim().trim_matches(|c| c == '"' || c == '\'');
        if service_name(key) && (rest.is_empty() || rest.starts_with(' ')) && !out.iter().any(|s| s == key) {
            out.push(key.to_string());
        }
    }
    out
}

/// The service a target starts; None for "All services". The argv is `docker compose up --build [service]`.
fn service_of(target: &Target) -> Option<&str> {
    target.argv.get(4).map(String::as_str)
}

/// A project name for the copy in the worktree at `checkout`: the repository, the worktree and the compose
/// file's folder, in the characters compose allows. `php.melodic.dev.worktrees/agent-fix` -> `php-melodic-dev-agent-fix`.
pub fn project_name(checkout: &Path, cwd: &str) -> String {
    let part = |p: Option<&Path>| p.and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let repository = part(checkout.parent());
    let repository = repository.strip_suffix(".worktrees").unwrap_or(&repository);
    let raw = [repository, &part(Some(checkout)), cwd].iter().filter(|s| !s.is_empty()).map(|s| s.to_string()).collect::<Vec<_>>().join("-");
    let mut name = String::new();
    for c in raw.to_lowercase().chars() {
        let c = if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' { c } else { '-' };
        if !(c == '-' && (name.is_empty() || name.ends_with('-'))) {
            name.push(c);
        }
    }
    let name: String = name.trim_start_matches('_').chars().take(60).collect();
    let name = name.trim_end_matches('-');
    if name.is_empty() { "studio".to_string() } else { name.to_string() }
}

/// From the project as `docker compose config --format json` prints it: a compose file that replaces every
/// published port with the one `pick` gives for (service, container port, protocol), and those ports by service.
/// None when nothing is published.
pub fn remap(config: &Value, mut pick: impl FnMut(&str, u64, &str) -> Option<u16>) -> (Option<String>, Vec<(String, u16)>) {
    let mut lines = vec![];
    let mut chosen = vec![];
    for (service, definition) in config.get("services").and_then(|s| s.as_object()).into_iter().flatten() {
        let Some(ports) = definition.get("ports").and_then(|p| p.as_array()) else { continue };
        let mut changed = false;
        let moved: Vec<Value> = ports
            .iter()
            .map(|port| {
                let published = port.get("published").is_some_and(|p| p.as_str().is_some_and(|s| !s.is_empty()) || p.is_number());
                let (Some(target), true) = (port.get("target").and_then(|t| t.as_u64()), published) else { return port.clone() };
                let protocol = port.get("protocol").and_then(|p| p.as_str()).unwrap_or("tcp");
                let Some(new) = pick(service, target, protocol) else { return port.clone() };
                let mut port = port.clone();
                port["published"] = Value::String(new.to_string());
                chosen.push((service.clone(), new));
                changed = true;
                port
            })
            .collect();
        if changed {
            // JSON is YAML too: the name and the list go in as they are, and `!override` makes the list replace theirs.
            lines.push(format!("  {}:\n    ports: !override {}", Value::String(service.clone()), Value::Array(moved)));
        }
    }
    let file = (!lines.is_empty()).then(|| format!("# Written by Melodic Studio: the ports of this worktree's own copy. Safe to delete.\nservices:\n{}\n", lines.join("\n")));
    (file, chosen)
}

/// How a compose target is started and stopped in one checkout.
#[derive(Debug)]
pub struct Plan {
    pub argv: Vec<String>,
    /// The port its service is published on, when this copy was given ports of its own.
    pub port: Option<u16>,
    /// The command that stops what `argv` started.
    pub stop: Vec<String>,
}

fn words(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

fn stop_after(prefix: &[String], service: Option<&str>) -> Vec<String> {
    prefix.iter().cloned().chain(std::iter::once("stop".to_string())).chain(service.map(str::to_string)).collect()
}

/// `target` in `dir` (its folder in `checkout`). With `own_ports`, as a copy of its own: see the top of this file.
pub fn plan(app: &tauri::AppHandle, runs: &Runs, checkout: &Path, dir: &Path, target: &Target, own_ports: bool) -> Result<Plan> {
    let service = service_of(target);
    if !own_ports {
        return Ok(Plan { argv: target.argv.clone(), port: None, stop: stop_after(&words(&["docker", "compose"]), service) });
    }
    if crate::proc::find("docker").is_none() {
        return Err(AppError::msg("`docker` was not found. Install Docker and make sure `docker compose` runs in a terminal, then try again."));
    }
    let mut prefix = words(&["docker", "compose", "-p", &project_name(checkout, &target.cwd), "-f", &target.source]);
    if let Some(theirs) = OVERRIDES.iter().find(|f| dir.join(f).is_file()) {
        prefix.extend(words(&["-f", theirs]));
    }
    let mut config = crate::proc::command("docker");
    config.args(&prefix[1..]).args(["config", "--format", "json"]).current_dir(dir);
    let out = host_cli::run(config, None, CONFIG_LIMIT, "docker compose")?;
    if !out.ok {
        return Err(host_cli::failure("docker compose", &out));
    }
    let project: Value = serde_json::from_str(&out.stdout).map_err(|e| AppError::msg(format!("docker compose printed a project that could not be read: {e}")))?;
    let (file, ports) = remap(&project, |service, port, protocol| runs.port_for(app, checkout, &format!("docker:{}:{service}:{port}/{protocol}", target.cwd)));
    if let Some(text) = file {
        let folder = app.path().app_cache_dir().map_err(|e| AppError::msg(e.to_string()))?.join("compose");
        std::fs::create_dir_all(&folder)?;
        let path: PathBuf = folder.join(format!("{}.yaml", project_name(checkout, &target.cwd)));
        std::fs::write(&path, text)?;
        prefix.extend(["-f".to_string(), path.to_string_lossy().to_string()]);
    }
    let port = ports.iter().find(|(name, _)| service.is_none_or(|s| s == name)).map(|(_, port)| *port);
    let argv = prefix.iter().cloned().chain(target.argv.iter().skip(2).cloned()).collect();
    Ok(Plan { argv, port, stop: stop_after(&prefix, service) })
}

/// The `docker compose stop`s under way, so a restart can wait for them: an `up` started while its
/// containers are still being stopped attaches to them and ends when they do.
#[derive(Default, Clone)]
pub struct Stops(Arc<(Mutex<usize>, Condvar)>);

impl Stops {
    /// What a terminal runs when a compose target is cut off: `argv` (a `docker compose … stop`) in `dir`.
    /// It is started at once, so it also outlives the app when that is quitting, and only waited for elsewhere.
    pub fn stopper(&self, dir: PathBuf, argv: Vec<String>) -> impl FnOnce() + Send + 'static {
        let stops = self.0.clone();
        move || {
            let Some((program, args)) = argv.split_first() else { return };
            let mut command = crate::proc::command(program);
            command.args(args).current_dir(&dir).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let Ok(mut child) = command.spawn() else { return };
            *stops.0.lock().unwrap() += 1;
            std::thread::spawn(move || {
                let deadline = Instant::now() + STOP_LIMIT;
                while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
                // Reaped if it is done; one that is still going is left to finish by itself.
                let _ = child.try_wait();
                *stops.0.lock().unwrap() -= 1;
                stops.1.notify_all();
            });
        }
    }

    /// Wait until no stop is under way.
    pub fn settle(&self) {
        let (count, changed) = &*self.0;
        let _ = changed.wait_timeout_while(count.lock().unwrap(), STOP_LIMIT, |n| *n > 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::targets::{Kind, Runtime};

    #[test]
    fn reads_the_services_of_a_compose_file() {
        let text = "# The site\nname: shop\n\nservices:   # all of them\n  web:\n    image: php:8.2-apache\n    ports:\n      - \"8080:80\"\n    command: >\n      bash -c \"a2enmod rewrite && apache2-foreground\"\n\n  \"db\": &db\n    image: postgres\n    environment:\n      services: nope\n  <<: *shared\n  -bad:\n    image: x\n  worker: { image: x }\n  web:\n    image: twice\n\nvolumes:\n  data:\n  cache:\n";
        assert_eq!(services(text), ["web", "db", "worker"]);
        assert_eq!(services("version: '3'\nservices:\n    api:\n        build: .\n        depends_on:\n            - db\n    db:\n        image: mysql\n"), ["api", "db"]);
        assert!(services("services: {web: {image: x}}\n").is_empty(), "the flow form is not read");
        assert!(services("volumes:\n  data:\n").is_empty());
        assert!(services("").is_empty());
    }

    #[test]
    fn a_worktrees_copy_has_a_project_name_of_its_own() {
        let checkout = Path::new("Source").join("php.melodic.dev.worktrees").join("agent-Fix_nav");
        assert_eq!(project_name(&checkout, ""), "php-melodic-dev-agent-fix_nav");
        assert_eq!(project_name(&checkout, "apps/Web Site"), "php-melodic-dev-agent-fix_nav-apps-web-site");
        assert_eq!(project_name(Path::new("__"), ""), "studio");
        assert!(project_name(&Path::new("r.worktrees").join("x".repeat(90)), "").len() <= 60);
    }

    #[test]
    fn published_ports_move_and_the_rest_stays() {
        let config = serde_json::json!({ "name": "x", "services": {
            "web": { "image": "nginx", "ports": [
                { "mode": "ingress", "target": 80, "published": "8080", "protocol": "tcp" },
                { "mode": "ingress", "host_ip": "127.0.0.1", "target": 443, "published": "8443", "protocol": "tcp" },
                { "mode": "ingress", "target": 9000, "protocol": "tcp" }
            ] },
            "db": { "image": "postgres", "ports": [{ "mode": "ingress", "target": 5432, "protocol": "tcp" }] },
            "worker": { "image": "x" }
        } });
        let mut asked = vec![];
        let mut next = 50_000;
        let (file, ports) = remap(&config, |service, port, protocol| {
            asked.push(format!("{service}:{port}/{protocol}"));
            next += 1;
            Some(next)
        });
        assert_eq!(asked, ["web:80/tcp", "web:443/tcp"], "only published ports are given a new one");
        assert_eq!(ports, [("web".to_string(), 50_001), ("web".to_string(), 50_002)]);
        let file = file.unwrap();
        assert!(file.contains("  \"web\":\n    ports: !override [{"), "{file}");
        assert!(file.contains("\"published\":\"50001\"") && file.contains("\"published\":\"50002\"") && file.contains("\"host_ip\":\"127.0.0.1\""), "{file}");
        assert!(file.contains("\"target\":9000") && !file.contains("db") && !file.contains("8080"), "{file}");
        assert_eq!(remap(&serde_json::json!({ "services": { "db": { "ports": [{ "target": 5432 }] } } }), |_, _, _| Some(1)).0, None);
        assert_eq!(remap(&config, |_, _, _| None).0, None, "no free port: their file is left as it is");
    }

    #[test]
    fn the_main_checkout_runs_what_the_user_would_type() {
        let target = |argv: &[&str]| Target { id: "t".into(), name: "t".into(), group: "g".into(), cwd: String::new(), argv: words(argv), kind: Kind::Run, runtime: Runtime::Docker, source: "compose.yaml".into() };
        assert_eq!(service_of(&target(&["docker", "compose", "up", "--build", "web"])), Some("web"));
        assert_eq!(service_of(&target(&["docker", "compose", "up", "--build"])), None);
        assert_eq!(stop_after(&words(&["docker", "compose"]), Some("web")), ["docker", "compose", "stop", "web"]);
        assert_eq!(stop_after(&words(&["docker", "compose", "-p", "x", "-f", "compose.yaml"]), None), ["docker", "compose", "-p", "x", "-f", "compose.yaml", "stop"]);
    }

    #[test]
    fn a_restart_waits_for_the_stop_before_it() {
        let stops = Stops::default();
        stops.settle();
        // `git --version` stands in for the stop: a real program that ends by itself.
        stops.stopper(std::env::temp_dir(), words(&["git", "--version"]))();
        stops.settle();
        assert_eq!(*stops.0 .0.lock().unwrap(), 0);
        // One that cannot be started is not waited for.
        stops.stopper(std::env::temp_dir(), words(&["no-such-program-anywhere"]))();
        assert_eq!(*stops.0 .0.lock().unwrap(), 0);
        stops.stopper(std::env::temp_dir(), vec![])();
    }
}
