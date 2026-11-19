//! Run targets: what in a checkout can be started, found by reading the project files that are
//! already there (launchSettings.json, package.json, Cargo.toml, go.mod, pyproject.toml). Nothing
//! is set up by the user and `launch.json` / `tasks.json` are not read.
//!
//! A target is a name, a group, a repository-relative working folder and an argv. There is never
//! a shell line: `run.rs` starts the argv as it is.

use crate::commands::repo;
use crate::error::Result;
use crate::AppState;
use serde::Serialize;
use std::collections::{BTreeSet, VecDeque};
use std::path::Path;
use tauri::State;

/// How far below the checkout's root to look, and how many folders to read at most.
const MAX_DEPTH: usize = 6;
const MAX_FOLDERS: usize = 6_000;
/// A project file larger than this is not read.
const MAX_FILE: u64 = 1024 * 1024;
/// Go files are only read far enough to see their `package` line.
const GO_HEAD: usize = 8 * 1024;

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Dotnet,
    Node,
    Rust,
    Go,
    Python,
}

impl Runtime {
    fn tag(self) -> &'static str {
        match self {
            Runtime::Dotnet => "dotnet",
            Runtime::Node => "node",
            Runtime::Rust => "rust",
            Runtime::Go => "go",
            Runtime::Python => "python",
        }
    }
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// Starts the app.
    Run,
    /// Runs its tests.
    Test,
}

#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    /// Stable for as long as the project files say the same: what the window remembers and sends back.
    pub id: String,
    pub name: String,
    /// Where it came from, as the list's heading: "Shop.Api · launch profiles", "web · package.json".
    pub group: String,
    /// Repository-relative working folder, `/` separated; empty for the root.
    pub cwd: String,
    pub argv: Vec<String>,
    pub kind: Kind,
    pub runtime: Runtime,
    /// The file it was read from, by name ("launchSettings.json"), for the list's footer.
    pub source: String,
}

impl Target {
    #[allow(clippy::too_many_arguments)]
    fn new(runtime: Runtime, kind: Kind, cwd: &str, key: &str, name: &str, group: &str, source: &str, argv: &[&str]) -> Target {
        Target {
            id: format!("{}:{}:{}", runtime.tag(), cwd, key),
            name: name.to_string(),
            group: group.to_string(),
            cwd: cwd.to_string(),
            argv: argv.iter().map(|a| a.to_string()).collect(),
            kind,
            runtime,
            source: source.to_string(),
        }
    }
}

/// Folders that hold no project of the user's own, or are too big to walk.
fn skipped(name: &str) -> bool {
    name.starts_with('.') || name.ends_with(".worktrees") || matches!(name, "node_modules" | "bower_components" | "vendor" | "target" | "bin" | "obj" | "dist" | "build" | "out" | "__pycache__" | "venv" | "env" | "site-packages" | "Pods" | "DerivedData")
}

fn read(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_FILE {
        return None;
    }
    let text = String::from_utf8(std::fs::read(path).ok()?).ok()?;
    // Visual Studio writes a byte order mark, which no parser here wants.
    Some(text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or(text))
}

/// The last segment of a repository-relative folder, or `fallback` for the root.
fn folder<'a>(rel: &'a str, fallback: &'a str) -> &'a str {
    match rel.rsplit('/').next() {
        Some(name) if !name.is_empty() => name,
        _ => fallback,
    }
}

fn join(rel: &str, name: &str) -> String {
    if rel.is_empty() {
        name.to_string()
    } else {
        format!("{rel}/{name}")
    }
}

/// One folder of the walk: its files and folders by name.
struct Dir<'a> {
    path: &'a Path,
    /// Repository-relative, `/` separated.
    rel: &'a str,
    files: &'a BTreeSet<String>,
    dirs: &'a BTreeSet<String>,
}

impl Dir<'_> {
    fn has(&self, name: &str) -> bool {
        self.files.contains(name)
    }
    fn text(&self, name: &str) -> Option<String> {
        self.has(name).then(|| read(&self.path.join(name))).flatten()
    }
}

// ---- .NET -------------------------------------------------------------------

/// Launch profiles that start the project itself (not IIS Express, not a Docker profile), by name.
fn launch_profiles(text: &str) -> Vec<String> {
    let Ok(json) = serde_json::from_str::<serde_json::Value>(text) else {
        return vec![];
    };
    let Some(profiles) = json.get("profiles").and_then(|p| p.as_object()) else {
        return vec![];
    };
    profiles.iter().filter(|(_, p)| p.get("commandName").and_then(|c| c.as_str()) == Some("Project")).map(|(name, _)| name.clone()).collect()
}

fn dotnet(dir: &Dir, out: &mut Vec<Target>) {
    let projects: Vec<&String> = dir.files.iter().filter(|f| f.ends_with(".csproj") || f.ends_with(".fsproj")).collect();
    for file in &projects {
        let Some(text) = dir.text(file) else { continue };
        let project = file.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(file);
        // `dotnet run` picks the project by itself only when the folder has exactly one.
        let which: Vec<&str> = if projects.len() > 1 { vec!["--project", file.as_str()] } else { vec![] };
        if text.contains("Microsoft.NET.Test.Sdk") {
            let argv = [vec!["dotnet", "test"], if projects.len() > 1 { vec![file.as_str()] } else { vec![] }].concat();
            out.push(Target::new(Runtime::Dotnet, Kind::Test, dir.rel, &format!("{project}/test"), "All tests", project, file, &argv));
            continue;
        }
        let settings = dir.path.join("Properties").join("launchSettings.json");
        let profiles = if dir.dirs.contains("Properties") { read(&settings).map(|t| launch_profiles(&t)).unwrap_or_default() } else { vec![] };
        for profile in &profiles {
            // A profile name goes on the command line; one that reads as an option is not offered.
            if profile.is_empty() || profile.starts_with('-') {
                continue;
            }
            let argv = [vec!["dotnet", "run"], which.clone(), vec!["--launch-profile", profile.as_str()]].concat();
            out.push(Target::new(Runtime::Dotnet, Kind::Run, dir.rel, &format!("{project}/{profile}"), profile, &format!("{project} · launch profiles"), "launchSettings.json", &argv));
        }
        let runnable = text.contains("Microsoft.NET.Sdk.Web") || text.contains("Microsoft.NET.Sdk.Worker") || text.to_ascii_lowercase().contains("<outputtype>exe</outputtype>") || text.to_ascii_lowercase().contains("<outputtype>winexe</outputtype>");
        if profiles.is_empty() && runnable {
            let argv = [vec!["dotnet", "run"], which.clone()].concat();
            out.push(Target::new(Runtime::Dotnet, Kind::Run, dir.rel, &format!("{project}/run"), project, project, file, &argv));
        }
    }
}

// ---- Node -------------------------------------------------------------------

/// The package manager a lockfile in `dir` names.
fn package_manager(files: &BTreeSet<String>) -> Option<&'static str> {
    if files.contains("pnpm-lock.yaml") {
        Some("pnpm")
    } else if files.contains("yarn.lock") {
        Some("yarn")
    } else if files.contains("bun.lockb") || files.contains("bun.lock") {
        Some("bun")
    } else if files.contains("package-lock.json") || files.contains("npm-shrinkwrap.json") {
        Some("npm")
    } else {
        None
    }
}

fn node(dir: &Dir, manager: &str, out: &mut Vec<Target>) {
    let Some(text) = dir.text("package.json") else { return };
    let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) else { return };
    let Some(scripts) = json.get("scripts").and_then(|s| s.as_object()) else { return };
    let group = if dir.rel.is_empty() { "package.json".to_string() } else { format!("{} · package.json", folder(dir.rel, "")) };
    for (name, command) in scripts {
        if name.is_empty() || name.starts_with('-') || !command.is_string() {
            continue;
        }
        // npm's lifecycle hooks run by themselves around the script they belong to.
        if (name.starts_with("pre") && scripts.contains_key(&name[3..])) || (name.starts_with("post") && scripts.contains_key(&name[4..])) {
            continue;
        }
        let test = name == "test" || name.starts_with("test:");
        let argv: Vec<&str> = if name == "test" || name == "start" { vec![manager, name] } else { vec![manager, "run", name] };
        out.push(Target::new(Runtime::Node, if test { Kind::Test } else { Kind::Run }, dir.rel, name, name, &group, "package.json", &argv));
    }
}

// ---- Rust -------------------------------------------------------------------

fn rust(dir: &Dir, out: &mut Vec<Target>) {
    let Some(text) = dir.text("Cargo.toml") else { return };
    let Ok(manifest) = text.parse::<toml::Table>() else { return };
    let Some(package) = manifest.get("package").and_then(|p| p.as_table()) else {
        // A workspace with no package of its own: its members are found by the walk, the tests run here.
        if manifest.contains_key("workspace") {
            let group = format!("{} · Cargo.toml", folder(dir.rel, "workspace"));
            out.push(Target::new(Runtime::Rust, Kind::Test, dir.rel, "test", "All tests", &group, "Cargo.toml", &["cargo", "test", "--workspace"]));
        }
        return;
    };
    let name = package.get("name").and_then(|n| n.as_str()).unwrap_or_else(|| folder(dir.rel, "crate")).to_string();
    let group = format!("{name} · Cargo.toml");
    let mut bins: Vec<String> = vec![];
    let mut add = |bin: String| {
        if !bin.is_empty() && !bin.starts_with('-') && !bins.contains(&bin) {
            bins.push(bin);
        }
    };
    let src = dir.path.join("src");
    if src.join("main.rs").is_file() {
        add(name.clone());
    }
    if let Ok(entries) = std::fs::read_dir(src.join("bin")) {
        let mut found: Vec<String> = entries
            .flatten()
            .filter_map(|e| {
                let file = e.file_name().to_string_lossy().to_string();
                let kind = e.file_type().ok()?;
                if kind.is_file() {
                    file.strip_suffix(".rs").map(str::to_string)
                } else {
                    (kind.is_dir() && e.path().join("main.rs").is_file()).then_some(file)
                }
            })
            .collect();
        found.sort();
        found.into_iter().for_each(&mut add);
    }
    for bin in manifest.get("bin").and_then(|b| b.as_array()).into_iter().flatten() {
        if let Some(bin) = bin.get("name").and_then(|n| n.as_str()) {
            add(bin.to_string());
        }
    }
    let single = bins.len() == 1;
    for bin in &bins {
        let argv: Vec<&str> = if single { vec!["cargo", "run"] } else { vec!["cargo", "run", "--bin", bin.as_str()] };
        out.push(Target::new(Runtime::Rust, Kind::Run, dir.rel, &format!("bin/{bin}"), bin, &group, "Cargo.toml", &argv));
    }
    out.push(Target::new(Runtime::Rust, Kind::Test, dir.rel, "test", "All tests", &group, "Cargo.toml", &["cargo", "test"]));
}

// ---- Go ---------------------------------------------------------------------

/// Does this Go source file declare `package main`? Only its start is read.
fn is_main_package(path: &Path) -> bool {
    use std::io::Read;
    let mut head = vec![0u8; GO_HEAD];
    let Ok(n) = std::fs::File::open(path).and_then(|mut f| f.read(&mut head)) else {
        return false;
    };
    String::from_utf8_lossy(&head[..n]).lines().map(str::trim).find(|l| l.starts_with("package ")).is_some_and(|l| l.split_whitespace().nth(1) == Some("main"))
}

/// `module` is the repository-relative folder of the nearest go.mod at or above `dir`.
fn go(dir: &Dir, module: &str, out: &mut Vec<Target>) {
    let group = format!("{} · go.mod", folder(module, "go"));
    if dir.has("go.mod") {
        out.push(Target::new(Runtime::Go, Kind::Test, dir.rel, "test", "All tests", &group, "go.mod", &["go", "test", "./..."]));
    }
    let main = dir.files.iter().filter(|f| f.ends_with(".go") && !f.ends_with("_test.go")).any(|f| is_main_package(&dir.path.join(f)));
    if !main {
        return;
    }
    // The package as `go run` names it from the module's root.
    let inside = dir.rel.strip_prefix(module).unwrap_or(dir.rel).trim_start_matches('/');
    let package = if inside.is_empty() { ".".to_string() } else { format!("./{inside}") };
    let name = folder(dir.rel, folder(module, "main"));
    out.push(Target::new(Runtime::Go, Kind::Run, module, &format!("run/{inside}"), name, &group, "go.mod", &["go", "run", &package]));
}

// ---- Python -----------------------------------------------------------------

/// The interpreter to use from `dir`: the project's own virtual environment when it has one.
fn python(dir: &Dir) -> String {
    for venv in [".venv", "venv"] {
        let (unix, windows) = (format!("{venv}/bin/python"), format!("{venv}/Scripts/python.exe"));
        if dir.path.join(&windows).is_file() {
            return windows;
        }
        if dir.path.join(&unix).is_file() {
            return unix;
        }
    }
    if cfg!(windows) { "python" } else { "python3" }.to_string()
}

/// A `module:function` entry point is only ever passed on as Python source, so it must be nothing but names.
fn entry_point(spec: &str) -> Option<(&str, &str)> {
    let (module, function) = spec.split_once(':')?;
    let function = function.split('[').next().unwrap_or(function).trim();
    let names = |s: &str| !s.is_empty() && s.split('.').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') && !part.starts_with(|c: char| c.is_ascii_digit()));
    (names(module.trim()) && names(function)).then_some((module.trim(), function))
}

fn python_targets(dir: &Dir, out: &mut Vec<Target>) {
    let pyproject = dir.text("pyproject.toml").and_then(|t| t.parse::<toml::Table>().ok());
    if !dir.has("pyproject.toml") && !dir.has("manage.py") && !dir.has("pytest.ini") {
        return;
    }
    let python = python(dir);
    let group = if dir.rel.is_empty() { "Python".to_string() } else { format!("{} · Python", folder(dir.rel, "")) };
    let uv = dir.has("uv.lock");
    if let Some(scripts) = pyproject.as_ref().and_then(|p| p.get("project")).and_then(|p| p.get("scripts")).and_then(|s| s.as_table()) {
        for (name, spec) in scripts {
            let Some((module, function)) = spec.as_str().and_then(entry_point) else { continue };
            if name.is_empty() || name.starts_with('-') {
                continue;
            }
            // What the console script pip would generate does, without needing the project installed.
            let code = format!("import sys; from {module} import {function}; sys.exit({function}())");
            let argv: Vec<&str> = if uv { vec!["uv", "run", name.as_str()] } else { vec![python.as_str(), "-c", code.as_str()] };
            out.push(Target::new(Runtime::Python, Kind::Run, dir.rel, &format!("script/{name}"), name, &group, "pyproject.toml", &argv));
        }
    }
    if dir.has("manage.py") {
        out.push(Target::new(Runtime::Python, Kind::Run, dir.rel, "runserver", "runserver", &group, "manage.py", &[&python, "manage.py", "runserver"]));
    }
    let in_pyproject = pyproject.as_ref().and_then(|p| p.get("tool")).and_then(|t| t.get("pytest")).is_some();
    let in_ini = |file: &str, section: &str| dir.text(file).is_some_and(|t| t.lines().any(|l| l.trim() == section));
    let source = if in_pyproject {
        Some("pyproject.toml")
    } else if dir.has("pytest.ini") {
        Some("pytest.ini")
    } else if in_ini("tox.ini", "[pytest]") {
        Some("tox.ini")
    } else if in_ini("setup.cfg", "[tool:pytest]") {
        Some("setup.cfg")
    } else {
        None
    };
    if let Some(source) = source {
        let argv: Vec<&str> = if uv { vec!["uv", "run", "pytest"] } else { vec![python.as_str(), "-m", "pytest"] };
        out.push(Target::new(Runtime::Python, Kind::Test, dir.rel, "pytest", "pytest", &group, source, &argv));
    }
}

// ---- the walk ---------------------------------------------------------------

/// A folder still to visit, with what it inherits from above.
struct Visit {
    path: std::path::PathBuf,
    /// Repository-relative.
    rel: String,
    depth: usize,
    /// The folder of the Go module it is in.
    module: Option<String>,
    /// The package manager a lockfile above it names.
    manager: Option<&'static str>,
}

/// Everything that can be run in the checkout at `root`, in walk order (shallow folders first).
pub fn discover(root: &Path) -> Vec<Target> {
    let mut out = Vec::new();
    let mut queue = VecDeque::from([Visit { path: root.to_path_buf(), rel: String::new(), depth: 0, module: None, manager: None }]);
    let mut seen = 0usize;
    while let Some(Visit { path, rel, depth, module, manager }) = queue.pop_front() {
        if seen >= MAX_FOLDERS {
            break;
        }
        seen += 1;
        let Ok(entries) = std::fs::read_dir(&path) else { continue };
        let (mut files, mut dirs) = (BTreeSet::new(), BTreeSet::new());
        for entry in entries.flatten() {
            let Ok(name) = entry.file_name().into_string() else { continue };
            // `file_type` does not follow symlinks, so a link cannot lead the walk in circles.
            match entry.file_type() {
                Ok(t) if t.is_dir() => drop(dirs.insert(name)),
                Ok(t) if t.is_file() => drop(files.insert(name)),
                _ => {}
            }
        }
        let dir = Dir { path: &path, rel: &rel, files: &files, dirs: &dirs };
        let module = if dir.has("go.mod") { Some(rel.clone()) } else { module };
        let manager = package_manager(&files).or(manager);

        dotnet(&dir, &mut out);
        node(&dir, manager.unwrap_or("npm"), &mut out);
        rust(&dir, &mut out);
        if let Some(module) = &module {
            go(&dir, module, &mut out);
        }
        python_targets(&dir, &mut out);

        if depth < MAX_DEPTH {
            for name in dirs.iter().filter(|n| !skipped(n)) {
                queue.push_back(Visit { path: path.join(name), rel: join(&rel, name), depth: depth + 1, module: module.clone(), manager });
            }
        }
    }
    out
}

/// The run targets of the active checkout of repository `id`.
#[tauri::command]
pub async fn targets_list(state: State<'_, AppState>, id: String) -> Result<Vec<Target>> {
    Ok(discover(&repo(&state, &id)?.dir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Fixture(PathBuf);

    impl Fixture {
        fn new(name: &str) -> Fixture {
            let root = std::env::temp_dir().join(format!("studio-targets-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            Fixture(root)
        }
        fn file(&self, path: &str, text: &str) -> &Fixture {
            let full = self.0.join(path);
            std::fs::create_dir_all(full.parent().unwrap()).unwrap();
            std::fs::write(full, text).unwrap();
            self
        }
        /// Each target as `group | name | cwd | command line`.
        fn found(&self) -> Vec<String> {
            discover(&self.0).iter().map(|t| format!("{} | {} | {} | {}", t.group, t.name, t.cwd, t.argv.join(" "))).collect()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn dotnet_launch_profiles_and_tests() {
        let f = Fixture::new("dotnet");
        f.file("Shop.sln", "")
            .file("src/Shop.Api/Shop.Api.csproj", r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#)
            // With a byte order mark, as Visual Studio writes it.
            .file(
                "src/Shop.Api/Properties/launchSettings.json",
                "\u{feff}{ \"profiles\": { \"https\": { \"commandName\": \"Project\", \"applicationUrl\": \"https://localhost:7241\" }, \"http\": { \"commandName\": \"Project\" }, \"IIS Express\": { \"commandName\": \"IISExpress\" }, \"--evil\": { \"commandName\": \"Project\" } } }",
            )
            .file("src/Shop.Pricing/Shop.Pricing.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"></Project>"#)
            .file("src/Shop.Tests/Shop.Tests.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"><ItemGroup><PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.0.0" /></ItemGroup></Project>"#)
            .file("tools/Seed/Seed.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup></Project>"#)
            .file("src/Shop.Api/bin/Debug/Old.csproj", r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#);
        assert_eq!(
            f.found(),
            [
                "Shop.Api · launch profiles | http | src/Shop.Api | dotnet run --launch-profile http",
                "Shop.Api · launch profiles | https | src/Shop.Api | dotnet run --launch-profile https",
                "Shop.Tests | All tests | src/Shop.Tests | dotnet test",
                "Seed | Seed | tools/Seed | dotnet run",
            ]
        );
        let ids: Vec<String> = discover(&f.0).into_iter().map(|t| t.id).collect();
        assert_eq!(ids[1], "dotnet:src/Shop.Api:Shop.Api/https");
        assert_eq!(ids.iter().collect::<BTreeSet<_>>().len(), ids.len(), "ids are unique");
    }

    #[test]
    fn dotnet_names_the_project_when_a_folder_has_two() {
        let f = Fixture::new("dotnet-two");
        f.file("A.csproj", r#"<Project Sdk="Microsoft.NET.Sdk.Web"></Project>"#).file("B.csproj", r#"<Project Sdk="Microsoft.NET.Sdk"><PackageReference Include="Microsoft.NET.Test.Sdk" /></Project>"#);
        assert_eq!(f.found(), ["A | A |  | dotnet run --project A.csproj", "B | All tests |  | dotnet test B.csproj"]);
    }

    #[test]
    fn node_scripts_and_package_manager() {
        let f = Fixture::new("node");
        f.file("package.json", r#"{ "scripts": { "dev": "vite", "test": "node --test", "prebuild": "x", "build": "tsc", "weird": 3 } }"#)
            .file("pnpm-lock.yaml", "")
            .file("web/package.json", r#"{ "name": "web", "scripts": { "start": "node .", "test:unit": "vitest" } }"#)
            .file("api/package.json", r#"{ "scripts": { "dev": "nodemon" } }"#)
            .file("api/yarn.lock", "")
            .file("lib/package.json", r#"{ "name": "no-scripts" }"#)
            .file("node_modules/dep/package.json", r#"{ "scripts": { "dev": "x" } }"#);
        assert_eq!(
            f.found(),
            [
                "package.json | build |  | pnpm run build",
                "package.json | dev |  | pnpm run dev",
                "package.json | test |  | pnpm test",
                "api · package.json | dev | api | yarn run dev",
                // No lockfile of its own: the workspace's, from the folder above.
                "web · package.json | start | web | pnpm start",
                "web · package.json | test:unit | web | pnpm run test:unit",
            ]
        );
        let kinds: Vec<Kind> = discover(&f.0).iter().map(|t| t.kind).collect();
        assert_eq!(kinds, [Kind::Run, Kind::Run, Kind::Test, Kind::Run, Kind::Run, Kind::Test]);
    }

    #[test]
    fn cargo_binaries_and_tests() {
        let f = Fixture::new("cargo");
        f.file("Cargo.toml", "[workspace]\nmembers = [\"app\", \"tool\", \"lib\"]\n")
            .file("app/Cargo.toml", "[package]\nname = \"app\"\n")
            .file("app/src/main.rs", "fn main() {}")
            .file("tool/Cargo.toml", "[package]\nname = \"tool\"\n\n[[bin]]\nname = \"extra\"\npath = \"other.rs\"\n")
            .file("tool/src/main.rs", "fn main() {}")
            .file("tool/src/bin/seed.rs", "fn main() {}")
            .file("tool/src/bin/migrate/main.rs", "fn main() {}")
            .file("lib/Cargo.toml", "[package]\nname = \"lib\"\n")
            .file("lib/src/lib.rs", "")
            .file("target/debug/build/x/Cargo.toml", "[package]\nname = \"ignored\"\n");
        assert_eq!(
            f.found(),
            [
                "workspace · Cargo.toml | All tests |  | cargo test --workspace",
                "app · Cargo.toml | app | app | cargo run",
                "app · Cargo.toml | All tests | app | cargo test",
                "lib · Cargo.toml | All tests | lib | cargo test",
                "tool · Cargo.toml | tool | tool | cargo run --bin tool",
                "tool · Cargo.toml | migrate | tool | cargo run --bin migrate",
                "tool · Cargo.toml | seed | tool | cargo run --bin seed",
                "tool · Cargo.toml | extra | tool | cargo run --bin extra",
                "tool · Cargo.toml | All tests | tool | cargo test",
            ]
        );
    }

    #[test]
    fn go_main_packages_and_tests() {
        let f = Fixture::new("go");
        f.file("svc/go.mod", "module example.com/svc\n")
            .file("svc/main.go", "// Command svc.\npackage main\n\nfunc main() {}\n")
            .file("svc/cmd/worker/main.go", "package main\n")
            .file("svc/internal/store/store.go", "package store\n")
            .file("svc/internal/store/main_test.go", "package main\n")
            .file("loose/main.go", "package main\n");
        assert_eq!(f.found(), ["svc · go.mod | All tests | svc | go test ./...", "svc · go.mod | svc | svc | go run .", "svc · go.mod | worker | svc | go run ./cmd/worker"], "a main package outside any module is not offered");
    }

    #[test]
    fn python_scripts_django_and_pytest() {
        let f = Fixture::new("python");
        f.file("pyproject.toml", "[project]\nname = \"shop\"\n\n[project.scripts]\nshop = \"shop.cli:main\"\nbad = \"shop.cli:main; import os\"\n\n[tool.pytest.ini_options]\ntestpaths = [\"tests\"]\n")
            .file("site/manage.py", "")
            .file("site/pytest.ini", "[pytest]\n")
            .file("legacy/setup.cfg", "[tool:pytest]\n")
            .file("legacy/pyproject.toml", "[build-system]\n")
            .file("fast/pyproject.toml", "[project.scripts]\nserve = \"fast.app:run\"\n[tool.pytest.ini_options]\n")
            .file("fast/uv.lock", "");
        let python = if cfg!(windows) { "python" } else { "python3" };
        assert_eq!(
            f.found(),
            [
                format!("Python | shop |  | {python} -c import sys; from shop.cli import main; sys.exit(main())"),
                format!("Python | pytest |  | {python} -m pytest"),
                "fast · Python | serve | fast | uv run serve".to_string(),
                "fast · Python | pytest | fast | uv run pytest".to_string(),
                format!("legacy · Python | pytest | legacy | {python} -m pytest"),
                format!("site · Python | runserver | site | {python} manage.py runserver"),
                format!("site · Python | pytest | site | {python} -m pytest"),
            ]
        );
        assert_eq!(entry_point("pkg.mod:func"), Some(("pkg.mod", "func")));
        assert_eq!(entry_point("pkg.mod:func [extra]"), Some(("pkg.mod", "func")));
        assert_eq!(entry_point("pkg.mod"), None);
        assert_eq!(entry_point("pkg:__import__('os').system('x')"), None);
    }

    #[test]
    fn uses_the_projects_virtual_environment() {
        let f = Fixture::new("venv");
        f.file("manage.py", "").file(".venv/bin/python", "");
        assert_eq!(f.found(), ["Python | runserver |  | .venv/bin/python manage.py runserver"]);
    }

    #[test]
    fn an_empty_or_unreadable_checkout_has_no_targets() {
        let f = Fixture::new("empty");
        f.file("README.md", "").file("package.json", "{ not json").file("Cargo.toml", "= broken").file("x.csproj", "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>");
        assert!(f.found().is_empty());
        assert!(discover(&f.0.join("missing")).is_empty());
    }
}
