//! The language servers the app knows: where a copy of each lives, whether it
//! runs, how it wants to be started, and how to install one into the app's own
//! folder. Nothing here touches Tauri, so the end-to-end tests use it directly.

use crate::error::{AppError, Result};
use crate::proc;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::time::{Duration, Instant};

/// How a server gets onto the machine.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    /// An npm package, installed into `<managed>/node`.
    Npm,
    /// A .NET tool, installed into `<managed>/dotnet`.
    Dotnet,
    /// Something the user installs; we only look for it.
    External,
}

pub struct Spec {
    /// What `lsp_install` and the frontend call it.
    pub name: &'static str,
    pub label: &'static str,
    pub program: &'static str,
    pub args: &'static [&'static str],
    /// Monaco language ids it serves.
    pub languages: &'static [&'static str],
    pub kind: Kind,
    /// What a managed install installs.
    pub packages: &'static [&'static str],
    /// Arguments that make it print its version and exit, to check a copy really runs.
    pub probe: Option<&'static [&'static str]>,
    /// For servers we cannot install: the command that does.
    pub hint: Option<&'static str>,
}

pub const SERVERS: &[Spec] = &[
    Spec {
        name: "typescript",
        label: "TypeScript and JavaScript",
        program: "typescript-language-server",
        args: &["--stdio"],
        languages: &["typescript", "javascript", "typescriptreact", "javascriptreact"],
        kind: Kind::Npm,
        // The server drives tsserver.js, which TypeScript 7 (the native compiler, npm's `latest`) no longer ships.
        packages: &["typescript-language-server", "typescript@6"],
        probe: Some(&["--version"]),
        hint: None,
    },
    Spec {
        name: "php",
        label: "PHP",
        program: "intelephense",
        args: &["--stdio"],
        languages: &["php"],
        kind: Kind::Npm,
        packages: &["intelephense"],
        // It has no version flag; anything but --stdio makes it crash.
        probe: None,
        hint: None,
    },
    Spec { name: "csharp", label: "C#", program: "csharp-ls", args: &[], languages: &["csharp"], kind: Kind::Dotnet, packages: &["csharp-ls"], probe: Some(&["--version"]), hint: None },
    Spec {
        name: "rust",
        label: "Rust",
        program: "rust-analyzer",
        args: &[],
        languages: &["rust"],
        kind: Kind::External,
        packages: &[],
        probe: Some(&["--version"]),
        hint: Some("rustup component add rust-analyzer"),
    },
    Spec { name: "python", label: "Python", program: "pyright-langserver", args: &["--stdio"], languages: &["python"], kind: Kind::External, packages: &[], probe: None, hint: None },
    Spec { name: "go", label: "Go", program: "gopls", args: &[], languages: &["go"], kind: Kind::External, packages: &[], probe: Some(&["version"]), hint: None },
];

pub fn for_language(language: &str) -> Option<&'static Spec> {
    SERVERS.iter().find(|s| s.languages.contains(&language))
}

pub fn named(name: &str) -> Option<&'static Spec> {
    SERVERS.iter().find(|s| s.name == name)
}

impl Spec {
    /// The program the install itself needs.
    pub fn prerequisite(&self) -> Option<&'static str> {
        match self.kind {
            Kind::Npm => Some("npm"),
            Kind::Dotnet => Some("dotnet"),
            Kind::External => None,
        }
    }

    /// Shown in Settings: the ones we can install, and the ones we can at least say how to get.
    fn listed(&self) -> bool {
        self.kind != Kind::External || self.hint.is_some()
    }
}

// ---- where copies live -----------------------------------------------------------

/// The npm prefix for managed servers. They share one, so installs must not overlap.
pub fn node_dir(managed: &Path) -> PathBuf {
    managed.join("node")
}

fn node_modules(managed: &Path) -> PathBuf {
    node_dir(managed).join("node_modules")
}

pub fn dotnet_dir(managed: &Path) -> PathBuf {
    managed.join("dotnet")
}

/// Index caches and the like, per server.
fn storage_dir(managed: &Path, spec: &Spec) -> PathBuf {
    managed.join("storage").join(spec.name)
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// The checkout's own `node_modules/.bin`.
    Project,
    /// Installed by the app, in its data folder.
    Managed,
    /// On PATH.
    Path,
}

pub fn managed_binary(spec: &Spec, managed: &Path) -> Option<PathBuf> {
    match spec.kind {
        Kind::Npm => proc::find_in(&node_modules(managed).join(".bin"), spec.program),
        Kind::Dotnet => proc::find_in(&dotnet_dir(managed), spec.program),
        Kind::External => None,
    }
}

/// The copy to start: the project's own, then the one the app installed, then PATH.
pub fn locate(spec: &Spec, root: Option<&Path>, managed: &Path) -> Option<(PathBuf, Source)> {
    root.and_then(|root| proc::find_in(&root.join("node_modules").join(".bin"), spec.program))
        .map(|p| (p, Source::Project))
        .or_else(|| managed_binary(spec, managed).map(|p| (p, Source::Managed)))
        .or_else(|| proc::find(spec.program).map(|p| (p, Source::Path)))
}

// ---- starting ----------------------------------------------------------------------

/// Everything needed to start one server in one checkout.
pub struct Launch {
    /// The copy that was found.
    pub binary: PathBuf,
    pub source: Source,
    /// What to run: the copy itself, or `node` when the copy is an npm shim (the script is then the first argument).
    pub program: PathBuf,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// What the client should send as `initializationOptions` (null for none).
    pub initialization_options: Value,
}

impl Launch {
    /// The process, with its input and output piped; the caller decides about stderr.
    pub fn command(&self, root: &Path) -> Command {
        let mut command = proc::command(&self.program);
        command.args(&self.args).envs(self.env.iter().map(|(k, v)| (k, v))).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped());
        command
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

/// A TypeScript the server can drive: the project's, else the managed one. TypeScript 7 has no
/// tsserver.js, so a project on it is served by the managed TypeScript 6 instead.
fn tsserver(root: &Path, managed: &Path) -> Option<PathBuf> {
    [root.join("node_modules"), node_modules(managed)].into_iter().map(|modules| modules.join("typescript").join("lib").join("tsserver.js")).find(|p| p.is_file())
}

/// What an npm shim in `node_modules/.bin` stands for: the script its package names as `bin`.
/// Running `node <script>` ourselves leaves no shell in between, which matters on Windows: there
/// the shim is a .cmd file, and stopping it would stop cmd.exe and leave the server running.
fn node_script(spec: &Spec, shim: &Path) -> Option<PathBuf> {
    let package = shim.parent()?.parent()?.join(spec.packages.first()?);
    let manifest: Value = serde_json::from_slice(&std::fs::read(package.join("package.json")).ok()?).ok()?;
    let entry = match manifest.get("bin")? {
        Value::String(only) => only.as_str(),
        Value::Object(by_name) => by_name.get(spec.program)?.as_str()?,
        _ => return None,
    };
    let script = entry.split('/').filter(|part| !part.is_empty() && *part != ".").fold(package, |path, part| path.join(part));
    script.is_file().then_some(script)
}

/// Where the .NET runtime is, for a tool's launcher that cannot find it by itself (Homebrew, ~/.dotnet).
fn dotnet_root() -> Option<PathBuf> {
    if cfg!(windows) || std::env::var_os("DOTNET_ROOT").is_some() {
        return None;
    }
    let dotnet = std::fs::canonicalize(proc::find("dotnet")?).ok()?;
    let dir = dotnet.parent()?;
    dir.join("host").join("fxr").is_dir().then(|| dir.to_path_buf())
}

fn env(spec: &Spec) -> Vec<(String, String)> {
    match spec.kind {
        Kind::Dotnet => dotnet_root().map(|dir| ("DOTNET_ROOT".to_string(), text(&dir))).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// None when no copy of the server is installed anywhere.
pub fn launch(spec: &'static Spec, root: &Path, managed: &Path) -> Option<Launch> {
    let (binary, source) = locate(spec, Some(root), managed)?;
    let mut program = binary.clone();
    let mut args: Vec<String> = Vec::new();
    if spec.kind == Kind::Npm && source != Source::Path {
        if let (Some(node), Some(script)) = (proc::find("node"), node_script(spec, &binary)) {
            program = node;
            args.push(text(&script));
        }
    }
    args.extend(spec.args.iter().map(|a| a.to_string()));
    let mut initialization_options = Value::Null;
    match spec.name {
        "typescript" => {
            if let Some(path) = tsserver(root, managed) {
                initialization_options = json!({ "tsserver": { "path": text(&path) } });
            }
        }
        "php" => {
            // Without a storage path intelephense indexes into the system temp folder and starts cold every time.
            let storage = storage_dir(managed, spec);
            let cache = storage.join("cache");
            let _ = std::fs::create_dir_all(&cache);
            initialization_options = json!({ "storagePath": text(&cache), "globalStoragePath": text(&storage), "clearCache": false });
        }
        // csharp-ls needs nothing: it loads the solution in the root, or with none (or several) the projects under it.
        _ => {}
    }
    Some(Launch { binary, source, program, args, env: env(spec), initialization_options })
}

// ---- running things briefly ----------------------------------------------------------

fn drain(pipe: Option<impl Read + Send + 'static>) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut bytes = Vec::new();
        if let Some(mut pipe) = pipe {
            let _ = pipe.read_to_end(&mut bytes);
        }
        bytes
    })
}

/// Run to the end, or kill it after `limit`. Ok(None) means it was still going.
fn output_within(mut command: Command, limit: Duration) -> std::io::Result<Option<Output>> {
    let mut child = command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let (stdout, stderr) = (drain(child.stdout.take()), drain(child.stderr.take()));
    let deadline = Instant::now() + limit;
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(Output { status, stdout: stdout.join().unwrap_or_default(), stderr: stderr.join().unwrap_or_default() }));
        }
        if Instant::now() >= deadline {
            // Something it started may still hold the pipes, so the readers are left to finish on their own.
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// The line of a program's error output worth showing: the first that reads like an error, else the last.
pub fn error_line(output: &str) -> Option<String> {
    const SIGNS: [&str; 8] = ["error", "exception", "fatal", "unknown", "not found", "cannot", "could not", "no such"];
    // A minified stack frame can be one line of 60 KB; nothing that long is a message.
    let lines: Vec<&str> = output.lines().map(str::trim).filter(|l| !l.is_empty() && l.len() <= 400).collect();
    let line = lines
        .iter()
        .find(|l| {
            let lower = l.to_ascii_lowercase();
            SIGNS.iter().any(|sign| lower.contains(sign))
        })
        .or(lines.last())?;
    Some(line.to_string())
}

/// The first `1.2.3`-looking thing in a program's version output.
fn version_in(output: &str) -> Option<String> {
    output.split(|c: char| !(c.is_ascii_alphanumeric() || c == '.' || c == '-')).map(|word| word.trim_start_matches('v')).find(|word| {
        let mut parts = word.split('.');
        word.contains('.') && parts.next().is_some_and(|first| !first.is_empty() && first.bytes().all(|b| b.is_ascii_digit()))
    }).map(str::to_string)
}

/// For an npm shim in `node_modules/.bin`: the version in the package beside it.
fn package_version(spec: &Spec, binary: &Path) -> Option<String> {
    let package = spec.packages.first()?;
    let manifest = binary.parent()?.parent()?.join(package).join("package.json");
    let json: Value = serde_json::from_slice(&std::fs::read(manifest).ok()?).ok()?;
    json.get("version")?.as_str().map(str::to_string)
}

/// Does this copy actually run? A file being there says little: `~/.cargo/bin/rust-analyzer` can be a
/// rustup stand-in for a component that is not installed. Ok(version if it told us), Err(why not).
fn check(spec: &Spec, binary: &Path) -> std::result::Result<Option<String>, String> {
    if spec.kind == Kind::Npm && proc::find("node").is_none() {
        return Err("Node.js was not found on PATH".to_string());
    }
    let Some(args) = spec.probe else {
        return Ok(package_version(spec, binary));
    };
    let mut command = proc::command(binary);
    command.args(args).envs(env(spec));
    match output_within(command, Duration::from_secs(4)) {
        Err(e) => Err(format!("Could not be started: {e}")),
        // Still going after four seconds: it starts, which is what we wanted to know.
        Ok(None) => Ok(package_version(spec, binary)),
        Ok(Some(out)) if out.status.success() => Ok(version_in(&String::from_utf8_lossy(&out.stdout)).or_else(|| package_version(spec, binary))),
        Ok(Some(out)) => {
            let said = format!("{}\n{}", String::from_utf8_lossy(&out.stderr), String::from_utf8_lossy(&out.stdout));
            Err(error_line(&said).unwrap_or_else(|| format!("Stopped at once ({})", out.status)))
        }
    }
}

// ---- what Settings shows -------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: &'static str,
    pub label: &'static str,
    pub program: &'static str,
    /// Where the copy that would be started was found; None when there is none.
    pub source: Option<Source>,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Found, but it does not run: what it said.
    pub problem: Option<String>,
    /// The app has its own copy (which Remove deletes), whichever copy is in use.
    pub managed: bool,
    /// The app can install it.
    pub installable: bool,
    /// What the install needs (`npm`, `dotnet`), and whether that is on this computer.
    pub prerequisite: Option<&'static str>,
    pub prerequisite_found: bool,
    /// For servers the app cannot install: the command that does.
    pub hint: Option<&'static str>,
}

pub fn info(spec: &Spec, root: Option<&Path>, managed: &Path) -> ServerInfo {
    let found = locate(spec, root, managed);
    let (version, problem) = match found.as_ref().map(|(binary, _)| check(spec, binary)) {
        Some(Ok(version)) => (version, None),
        Some(Err(why)) => (None, Some(why)),
        None => (None, None),
    };
    ServerInfo {
        name: spec.name,
        label: spec.label,
        program: spec.program,
        source: found.as_ref().map(|(_, source)| *source),
        path: found.as_ref().map(|(binary, _)| text(binary)),
        version,
        problem,
        managed: managed_binary(spec, managed).is_some(),
        installable: spec.kind != Kind::External,
        prerequisite: spec.prerequisite(),
        prerequisite_found: spec.prerequisite().is_none_or(|program| proc::find(program).is_some()),
        hint: spec.hint,
    }
}

/// Every server Settings lists, each checked (at the same time, since each check starts a program).
pub fn list(root: Option<&Path>, managed: &Path) -> Vec<ServerInfo> {
    std::thread::scope(|scope| {
        let checks: Vec<_> = SERVERS.iter().filter(|spec| spec.listed()).map(|spec| scope.spawn(move || info(spec, root, managed))).collect();
        checks.into_iter().filter_map(|check| check.join().ok()).collect()
    })
}

// ---- installing ----------------------------------------------------------------------

fn run(mut command: Command, what: &str) -> Result<()> {
    let out = command.stdin(Stdio::null()).output().map_err(|e| AppError::msg(format!("Could not run {what}: {e}")))?;
    if out.status.success() {
        return Ok(());
    }
    let said = format!("{}\n{}", String::from_utf8_lossy(&out.stdout).trim(), String::from_utf8_lossy(&out.stderr).trim());
    let said = said.trim();
    // The end of the output is where npm and dotnet say what went wrong.
    let tail: String = said.chars().skip(said.chars().count().saturating_sub(1200)).collect();
    Err(AppError::msg(if tail.is_empty() { format!("{what} failed ({})", out.status) } else { tail }))
}

fn npm(dir: &Path, verb: &str, packages: &[&str]) -> Result<()> {
    let npm = proc::find("npm").ok_or_else(|| AppError::msg("npm was not found. Install Node.js, then try again."))?;
    let mut command = proc::command(npm);
    command.arg(verb).arg("--prefix").arg(dir).args(["--no-audit", "--no-fund", "--no-update-notifier", "--loglevel=error"]).args(packages).current_dir(dir);
    run(command, &format!("npm {verb}"))
}

fn dotnet_tool(dir: &Path, verb: &str, package: &str) -> Result<()> {
    let dotnet = proc::find("dotnet").ok_or_else(|| AppError::msg("dotnet was not found. Install the .NET SDK, then try again."))?;
    let mut command = proc::command(dotnet);
    command.args(["tool", verb, package, "--tool-path"]).arg(dir).env("DOTNET_NOLOGO", "1").env("DOTNET_CLI_TELEMETRY_OPTOUT", "1").current_dir(dir);
    run(command, &format!("dotnet tool {verb}"))
}

/// Install (or bring up to date) the app's own copy of a server, under `managed`. Never global.
/// Slow, and needs the network. The npm servers share a prefix: do not run two installs at once.
pub fn install(spec: &Spec, managed: &Path) -> Result<()> {
    match spec.kind {
        Kind::Npm => {
            let dir = node_dir(managed);
            std::fs::create_dir_all(&dir)?;
            let manifest = dir.join("package.json");
            if !manifest.exists() {
                // Makes the folder a project of its own, so npm never climbs to one above it.
                std::fs::write(&manifest, "{\n  \"name\": \"melodic-studio-language-servers\",\n  \"private\": true\n}\n")?;
            }
            npm(&dir, "install", spec.packages)?;
        }
        Kind::Dotnet => {
            let dir = dotnet_dir(managed);
            std::fs::create_dir_all(&dir)?;
            // `install` refuses when the tool is already there.
            let verb = if managed_binary(spec, managed).is_some() { "update" } else { "install" };
            for package in spec.packages {
                dotnet_tool(&dir, verb, package)?;
            }
        }
        Kind::External => return Err(AppError::msg(format!("Melodic Studio cannot install {}", spec.program))),
    }
    match managed_binary(spec, managed) {
        Some(_) => Ok(()),
        None => Err(AppError::msg(format!("The install finished, but {} is not where it should be", spec.program))),
    }
}

/// Delete the app's own copy. A copy in the project or on PATH is not ours to touch.
pub fn uninstall(spec: &Spec, managed: &Path) -> Result<()> {
    if managed_binary(spec, managed).is_some() {
        match spec.kind {
            Kind::Npm => {
                // `typescript@6` is installed as, and removed as, `typescript`.
                let names: Vec<&str> = spec.packages.iter().map(|p| p.rfind('@').filter(|at| *at > 0).map_or(*p, |at| &p[..at])).collect();
                npm(&node_dir(managed), "uninstall", &names)?;
            }
            Kind::Dotnet => {
                for package in spec.packages {
                    dotnet_tool(&dotnet_dir(managed), "uninstall", package)?;
                }
            }
            Kind::External => {}
        }
    }
    let _ = std::fs::remove_dir_all(storage_dir(managed, spec));
    match managed_binary(spec, managed) {
        None => Ok(()),
        Some(left) => Err(AppError::msg(format!("{} is still there after removing it", left.display()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("studio-lsp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn shim(dir: &Path, program: &str) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let file = dir.join(if cfg!(windows) { format!("{program}.cmd") } else { program.to_string() });
        std::fs::write(&file, "").unwrap();
        file
    }

    #[test]
    fn languages() {
        assert_eq!(for_language("rust").unwrap().program, "rust-analyzer");
        assert_eq!(for_language("typescript").unwrap().program, "typescript-language-server");
        assert_eq!(for_language("javascript").unwrap().name, "typescript");
        assert_eq!(for_language("csharp").unwrap().program, "csharp-ls");
        assert_eq!(for_language("php").unwrap().program, "intelephense");
        assert!(for_language("plaintext").is_none());
        assert_eq!(named("php").unwrap().prerequisite(), Some("npm"));
        assert_eq!(named("csharp").unwrap().prerequisite(), Some("dotnet"));
        let listed: Vec<&str> = SERVERS.iter().filter(|s| s.listed()).map(|s| s.name).collect();
        assert_eq!(listed, ["typescript", "php", "csharp", "rust"]);
    }

    #[test]
    fn lookup_order() {
        let dir = scratch("order");
        let (root, managed) = (dir.join("checkout"), dir.join("managed"));
        std::fs::create_dir_all(&root).unwrap();
        let spec = named("php").unwrap();
        // Nothing of ours anywhere: whatever PATH has, or nothing.
        assert!(locate(spec, Some(&root), &managed).is_none_or(|(_, source)| source == Source::Path));

        let ours = shim(&node_dir(&managed).join("node_modules").join(".bin"), "intelephense");
        assert_eq!(locate(spec, Some(&root), &managed).unwrap(), (ours.clone(), Source::Managed));
        assert_eq!(managed_binary(spec, &managed).unwrap(), ours);

        let theirs = shim(&root.join("node_modules").join(".bin"), "intelephense");
        assert_eq!(locate(spec, Some(&root), &managed).unwrap(), (theirs, Source::Project), "the project's own copy wins");
        assert_eq!(locate(spec, None, &managed).unwrap(), (ours, Source::Managed), "no checkout, no project copy");

        let tool = shim(&dotnet_dir(&managed), "csharp-ls");
        // A .cmd is not what dotnet makes on Windows, but the lookup is by name either way.
        assert_eq!(locate(named("csharp").unwrap(), Some(&root), &managed).unwrap(), (tool, Source::Managed));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn typescript_for_the_server() {
        let dir = scratch("tsserver");
        let (root, managed) = (dir.join("checkout"), dir.join("managed"));
        std::fs::create_dir_all(&root).unwrap();
        shim(&node_dir(&managed).join("node_modules").join(".bin"), "typescript-language-server");
        let spec = named("typescript").unwrap();
        assert_eq!(launch(spec, &root, &managed).unwrap().initialization_options, Value::Null, "no TypeScript anywhere: left to the server");

        let lib = |modules: PathBuf| {
            let lib = modules.join("typescript").join("lib");
            std::fs::create_dir_all(&lib).unwrap();
            std::fs::write(lib.join("tsserver.js"), "").unwrap();
            text(&lib.join("tsserver.js"))
        };
        let ours = lib(node_dir(&managed).join("node_modules"));
        let started = launch(spec, &root, &managed).unwrap();
        assert_eq!(started.initialization_options["tsserver"]["path"], ours);
        assert_eq!((&started.program, &started.args[..]), (&started.binary, &["--stdio".to_string()][..]), "a shim with no package beside it is run as it is");

        // A project on TypeScript 7 has the package but no tsserver.js: still the managed one.
        std::fs::create_dir_all(root.join("node_modules").join("typescript").join("lib")).unwrap();
        assert_eq!(launch(spec, &root, &managed).unwrap().initialization_options["tsserver"]["path"], ours);

        let theirs = lib(root.join("node_modules"));
        assert_eq!(launch(spec, &root, &managed).unwrap().initialization_options["tsserver"]["path"], theirs, "the project's TypeScript wins");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn npm_shims_are_run_through_node() {
        let dir = scratch("shim");
        let modules = dir.join("node_modules");
        let shim = shim(&modules.join(".bin"), "intelephense");
        let spec = named("php").unwrap();
        assert_eq!(node_script(spec, &shim), None, "no package beside it");

        let package = modules.join("intelephense");
        std::fs::create_dir_all(package.join("lib")).unwrap();
        std::fs::write(package.join("package.json"), r#"{ "version": "1.2.3", "bin": { "intelephense": "./lib/intelephense.js" } }"#).unwrap();
        assert_eq!(node_script(spec, &shim), None, "the script it names is missing");
        std::fs::write(package.join("lib").join("intelephense.js"), "").unwrap();
        let script = package.join("lib").join("intelephense.js");
        assert_eq!(node_script(spec, &shim).unwrap(), script);
        assert_eq!(package_version(spec, &shim).unwrap(), "1.2.3");

        std::fs::write(package.join("package.json"), r#"{ "bin": "lib/intelephense.js" }"#).unwrap();
        assert_eq!(node_script(spec, &shim).unwrap(), script, "a package with one program may name it bare");

        // The checkout's own copy, started: node with the script first (when this machine has node).
        let started = launch(spec, &dir, &dir.join("managed")).unwrap();
        assert_eq!((started.source, &started.binary), (Source::Project, &shim));
        match proc::find("node") {
            Some(node) => assert_eq!((started.program, started.args), (node, vec![text(&script), "--stdio".to_string()])),
            None => assert_eq!((started.program, started.args), (shim, vec!["--stdio".to_string()])),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn php_gets_somewhere_to_keep_its_index() {
        let dir = scratch("options");
        let (root, managed) = (dir.join("shop"), dir.join("managed"));
        std::fs::create_dir_all(&root).unwrap();
        shim(&node_dir(&managed).join("node_modules").join(".bin"), "intelephense");
        let options = launch(named("php").unwrap(), &root, &managed).unwrap().initialization_options;
        assert!(Path::new(options["storagePath"].as_str().unwrap()).is_dir());
        assert!(Path::new(options["globalStoragePath"].as_str().unwrap()).ends_with(Path::new("storage").join("php")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_copy_that_does_not_run_is_reported() {
        // git stands in for a server: it is on PATH wherever the tests run.
        let git = proc::find("git").unwrap();
        let works = Spec { name: "x", label: "X", program: "git", args: &[], languages: &[], kind: Kind::External, packages: &[], probe: Some(&["--version"]), hint: None };
        let version = check(&works, &git).unwrap().unwrap();
        assert!(version.starts_with(|c: char| c.is_ascii_digit()), "{version}");

        let broken = Spec { probe: Some(&["--no-such-option-anywhere"]), ..works };
        let why = check(&broken, &git).unwrap_err();
        assert!(why.to_lowercase().contains("unknown option"), "{why}");

        assert!(check(&works, Path::new("/no/such/folder/server")).unwrap_err().starts_with("Could not be started"));
        let unchecked = Spec { probe: None, ..broken };
        assert_eq!(check(&unchecked, &git), Ok(None));
    }

    #[test]
    fn reading_program_output() {
        assert_eq!(error_line("error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.\n").unwrap(), "error: Unknown binary 'rust-analyzer' in official toolchain 'stable'.");
        let trace = format!("/x/server.js:7\n{}\n\nTypeError: Cannot read properties of undefined\n    at main (/x/server.js:7:1)\n\nNode.js v24.0.0\n", "x".repeat(5000));
        assert_eq!(error_line(&trace).unwrap(), "TypeError: Cannot read properties of undefined");
        assert_eq!(error_line("starting\nstopped\n").unwrap(), "stopped");
        assert_eq!(error_line(" \n\n"), None);

        assert_eq!(version_in("6.1.0\n").unwrap(), "6.1.0");
        assert_eq!(version_in("csharp-ls, 0.28.0 (Klebiškis)+72671fc").unwrap(), "0.28.0");
        assert_eq!(version_in("rust-analyzer 1.91.0 (f8297e3 2026-10-28)").unwrap(), "1.91.0");
        assert_eq!(version_in("git version 2.47.0.windows.1").unwrap(), "2.47.0.windows.1");
        assert_eq!(version_in("golang.org/x/tools/gopls v0.20.0").unwrap(), "0.20.0");
        assert_eq!(version_in("no numbers here"), None);
    }

    #[test]
    fn nothing_to_install_for_external_servers() {
        let dir = scratch("external");
        assert!(install(named("rust").unwrap(), &dir).is_err());
        assert!(uninstall(named("php").unwrap(), &dir).is_ok(), "removing what is not there is fine");
        let info = info(named("rust").unwrap(), None, &dir);
        assert!(!info.installable && !info.managed && info.prerequisite_found);
        assert_eq!(info.hint, Some("rustup component add rust-analyzer"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
