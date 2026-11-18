//! File > New Project: a template list, and the ecosystem's own tool run to scaffold one.
//!
//! Templates are data: what they need, their options, and the argv steps to run. Nothing is
//! bundled and nothing is installed for the user; a missing tool is named with its install page.
//! Every step goes through `proc::command` (no shell), its output streams to the window as
//! `project-output` events, and a run can be stopped. Afterwards the frontend hands the new folder
//! to the setup wizard (git init, .gitignore, first commit, the remote).

use crate::error::{AppError, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Choice {
    pub value: String,
    pub label: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TemplateOption {
    /// A tick box; `default` is whether it starts ticked.
    Flag { id: String, label: String, default: bool },
    /// One of a few values, the first being the default.
    Pick { id: String, label: String, choices: Vec<Choice> },
    /// A short name (validated like the project name). Shown only while `when` (a flag's id) is ticked.
    Name { id: String, label: String, default: String, when: Option<String> },
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tool {
    pub program: String,
    /// Shown when it is missing.
    pub name: String,
    pub install_page: String,
    pub found: bool,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    pub id: String,
    pub name: String,
    pub description: String,
    /// `melodic`, `popular`, `blank`.
    pub group: String,
    /// A Phosphor icon name.
    pub icon: String,
    pub tools: Vec<Tool>,
    pub options: Vec<TemplateOption>,
    /// What the name has to look like, for the dialog's message.
    pub name_rule: String,
}

/// One command of a scaffold: `program args...` in `dir`.
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub label: String,
    pub dir: PathBuf,
    pub program: String,
    pub args: Vec<String>,
}

fn flag(id: &str, label: &str, default: bool) -> TemplateOption {
    TemplateOption::Flag { id: id.into(), label: label.into(), default }
}

fn pick(id: &str, label: &str, choices: &[(&str, &str)]) -> TemplateOption {
    TemplateOption::Pick { id: id.into(), label: label.into(), choices: choices.iter().map(|(v, l)| Choice { value: (*v).into(), label: (*l).into() }).collect() }
}

fn tool(program: &str, name: &str, page: &str) -> Tool {
    Tool { program: program.into(), name: name.into(), install_page: page.into(), found: false }
}

const NODE: (&str, &str, &str) = ("npx", "Node.js (with npm)", "https://nodejs.org");
const NPM: (&str, &str, &str) = ("npm", "Node.js (with npm)", "https://nodejs.org");
const COMPOSER: (&str, &str, &str) = ("composer", "Composer", "https://getcomposer.org/download/");
const PHP: (&str, &str, &str) = ("php", "PHP 8.2 or later", "https://www.php.net/downloads");
const DOTNET: (&str, &str, &str) = ("dotnet", "the .NET SDK", "https://dotnet.microsoft.com/download");
const CARGO: (&str, &str, &str) = ("cargo", "Rust (rustup)", "https://rustup.rs");

/// The names npm packages (and so every Node scaffolder) accept.
const NPM_RULE: &str = "lowercase letters, digits and single dashes, starting with a letter (my-app)";
const PLAIN_RULE: &str = "letters, digits, dashes and underscores, starting with a letter (my-app)";

#[allow(clippy::too_many_arguments)] // a table row, read column by column in `catalog`
fn template(id: &str, name: &str, description: &str, group: &str, icon: &str, tools: &[(&str, &str, &str)], options: Vec<TemplateOption>, npm_name: bool) -> Template {
    Template {
        id: id.into(),
        name: name.into(),
        description: description.into(),
        group: group.into(),
        icon: icon.into(),
        tools: tools.iter().map(|(p, n, u)| tool(p, n, u)).collect(),
        options,
        name_rule: if npm_name { NPM_RULE } else { PLAIN_RULE }.into(),
    }
}

/// Every template, Melodic first. `found` is filled in by `templates()`.
pub fn catalog() -> Vec<Template> {
    let vite = |id: &str, name: &str, description: &str, icon: &str| template(id, name, description, "popular", icon, &[NODE, NPM], vec![], true);
    vec![
        template(
            "melodic-js",
            "Melodic JS",
            "A Melodic app with Melodic Components, through the Melodic CLI.",
            "melodic",
            "music-notes",
            &[NODE, NPM],
            vec![flag("monorepo", "Monorepo (apps/ and libs/ with npm workspaces)", false), TemplateOption::Name { id: "app".into(), label: "First app's name".into(), default: "web".into(), when: Some("monorepo".into()) }, flag("testing", "Add testing (Vitest)", true)],
            true,
        ),
        template(
            "melodic-php",
            "Melodic PHP",
            "A Melodic PHP framework project, through its make:project command.",
            "melodic",
            "music-notes",
            &[COMPOSER, PHP],
            vec![pick("type", "Kind", &[("full", "Full: MVC pages and an API"), ("api", "API only"), ("mvc", "MVC pages only")])],
            false,
        ),
        template("angular", "Angular", "The Angular CLI's new workspace.", "popular", "triangle", &[NODE], vec![pick("style", "Styles", &[("scss", "SCSS"), ("css", "CSS")]), flag("ssr", "Server-side rendering", false)], true),
        vite("react", "React", "React with TypeScript, on Vite.", "atom"),
        vite("vue", "Vue", "Vue with TypeScript, on Vite.", "file-vue"),
        vite("svelte", "Svelte", "Svelte with TypeScript, on Vite.", "fire"),
        template("next", "Next.js", "create-next-app: React, TypeScript, the App Router.", "popular", "arrow-fat-right", &[NODE], vec![flag("tailwind", "Tailwind CSS", true)], true),
        template("laravel", "Laravel", "composer create-project laravel/laravel.", "popular", "file-php", &[COMPOSER, PHP], vec![], false),
        template(
            "dotnet",
            ".NET",
            "dotnet new, from the SDK's own templates.",
            "popular",
            "file-c-sharp",
            &[DOTNET],
            vec![pick("kind", "Kind", &[("webapi", "Web API"), ("mvc", "ASP.NET Core MVC"), ("blazor", "Blazor web app"), ("console", "Console app"), ("classlib", "Class library")])],
            false,
        ),
        template("rust", "Rust", "cargo new.", "popular", "gear-six", &[CARGO], vec![pick("kind", "Kind", &[("bin", "Binary"), ("lib", "Library")])], false),
        template("empty", "Empty folder", "Just the folder; the setup wizard does the rest.", "blank", "folder-simple", &[], vec![], false),
    ]
}

/// The catalog, with which tools this computer has.
pub fn with_tools(mut list: Vec<Template>) -> Vec<Template> {
    for t in &mut list {
        for tool in &mut t.tools {
            tool.found = crate::proc::find(&tool.program).is_some();
        }
    }
    list
}

pub fn check_name(template: &Template, name: &str) -> Result<()> {
    let ok = if template.name_rule == NPM_RULE {
        let mut parts = name.split('-');
        name.len() <= 100 && name.starts_with(|c: char| c.is_ascii_lowercase()) && parts.all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
    } else {
        name.len() <= 100 && name.starts_with(|c: char| c.is_ascii_alphabetic()) && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    if ok {
        Ok(())
    } else {
        Err(AppError::msg(format!("Use {} for the name", template.name_rule)))
    }
}

fn opt<'a>(options: &'a HashMap<String, String>, id: &str, default: &'a str) -> &'a str {
    options.get(id).map(String::as_str).filter(|v| !v.is_empty()).unwrap_or(default)
}

fn on(options: &HashMap<String, String>, id: &str, template: &Template) -> bool {
    match options.get(id) {
        Some(v) => v == "true",
        None => template.options.iter().any(|o| matches!(o, TemplateOption::Flag { id: i, default: true, .. } if i == id)),
    }
}

/// A picked value must be one of the template's own choices.
fn chosen(template: &Template, options: &HashMap<String, String>, id: &str) -> Result<String> {
    let Some(TemplateOption::Pick { choices, .. }) = template.options.iter().find(|o| matches!(o, TemplateOption::Pick { id: i, .. } if i == id)) else {
        return Err(AppError::msg("Unknown option"));
    };
    let value = opt(options, id, &choices[0].value).to_string();
    if choices.iter().any(|c| c.value == value) {
        Ok(value)
    } else {
        Err(AppError::msg(format!("\"{value}\" is not one of the choices")))
    }
}

fn step(label: &str, dir: &Path, program: &str, args: &[&str]) -> Step {
    Step { label: label.into(), dir: dir.to_path_buf(), program: program.into(), args: args.iter().map(|a| a.to_string()).collect() }
}

/// The commands that make `parent/name` from `template`. `scratch` is a temporary folder some need.
pub fn plan(template: &Template, parent: &Path, name: &str, options: &HashMap<String, String>, scratch: &Path) -> Result<Vec<Step>> {
    check_name(template, name)?;
    let project = parent.join(name);
    Ok(match template.id.as_str() {
        "melodic-js" => {
            let mut init = vec!["--yes", "@melodicdev/cli@latest", "init", name];
            let app;
            if on(options, "monorepo", template) {
                app = format!("--app-name={}", opt(options, "app", "web"));
                check_name(template, opt(options, "app", "web")).map_err(|_| AppError::msg(format!("Use {NPM_RULE} for the app's name")))?;
                init.extend(["--monorepo", app.as_str()]);
            }
            let mut steps = vec![step("Create the project", parent, "npx", &init), step("Install packages", &project, "npm", &["install"])];
            if on(options, "testing", template) {
                steps.push(step("Add testing", &project, "npx", &["--yes", "@melodicdev/cli@latest", "add", "testing"]));
                steps.push(step("Install test packages", &project, "npm", &["install"]));
            }
            steps
        }
        "melodic-php" => {
            let kind = format!("--type={}", chosen(template, options, "type")?);
            let cli = scratch.join("vendor").join("bin").join("melodic");
            vec![
                step("Get the Melodic PHP command", scratch, "composer", &["require", "melodicdev/framework", "--no-interaction", "--no-progress"]),
                Step { label: "Create the project".into(), dir: parent.to_path_buf(), program: "php".into(), args: vec![cli.to_string_lossy().to_string(), "make:project".into(), name.into(), kind] },
                step("Install packages", &project, "composer", &["install", "--no-interaction", "--no-progress"]),
            ]
        }
        "angular" => {
            let style = format!("--style={}", chosen(template, options, "style")?);
            let ssr = format!("--ssr={}", on(options, "ssr", template));
            vec![step("Create the workspace", parent, "npx", &["--yes", "@angular/cli@latest", "new", name, "--defaults", "--skip-git", &style, &ssr])]
        }
        "react" | "vue" | "svelte" => {
            let flavour = format!("{}-ts", template.id);
            vec![step("Create the project", parent, "npx", &["--yes", "create-vite@latest", name, "--template", &flavour, "--no-interactive"]), step("Install packages", &project, "npm", &["install"])]
        }
        "next" => {
            let tailwind = if on(options, "tailwind", template) { "--tailwind" } else { "--no-tailwind" };
            vec![step("Create the project", parent, "npx", &["--yes", "create-next-app@latest", name, "--ts", "--eslint", "--app", "--src-dir", tailwind, "--import-alias=@/*", "--use-npm", "--disable-git", "--yes"])]
        }
        "laravel" => vec![step("Create the project", parent, "composer", &["create-project", "laravel/laravel", name, "--no-interaction", "--no-progress"])],
        "dotnet" => {
            let kind = chosen(template, options, "kind")?;
            vec![step("Create the project", parent, "dotnet", &["new", &kind, "--output", name])]
        }
        "rust" => {
            let kind = if chosen(template, options, "kind")? == "lib" { "--lib" } else { "--bin" };
            vec![step("Create the project", parent, "cargo", &["new", name, "--vcs=none", kind])]
        }
        "empty" => vec![],
        _ => return Err(AppError::msg("Unknown template")),
    })
}

// ---- running a plan -----------------------------------------------------------

/// The scaffold in progress (one at a time), so Stop can end it.
#[derive(Default)]
pub struct Scaffolds {
    running: Mutex<Option<Child>>,
    stopped: Mutex<bool>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProjectOutput {
    /// `step`: a step starts (`text` is its label and command); `out`: a line it printed.
    kind: String,
    text: String,
}

fn say(app: &AppHandle, kind: &str, text: impl Into<String>) {
    let _ = app.emit("project-output", ProjectOutput { kind: kind.into(), text: text.into() });
}

fn pump(app: &AppHandle, pipe: impl Read + Send + 'static) -> std::thread::JoinHandle<()> {
    let app = app.clone();
    std::thread::spawn(move || {
        // Progress bars redraw with `\r`; each redraw becomes its own line.
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        while reader.read_until(b'\n', &mut buf).map(|n| n > 0).unwrap_or(false) {
            for part in String::from_utf8_lossy(&buf).split('\r') {
                let line = strip_ansi(part.trim_end());
                if !line.trim().is_empty() {
                    say(&app, "out", line);
                }
            }
            buf.clear();
        }
    })
}

/// Colour and cursor codes, which some tools print even when told not to.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn run_step(app: &AppHandle, scaffolds: &Scaffolds, s: &Step) -> Result<()> {
    say(app, "step", format!("{}: {} {}", s.label, s.program, s.args.join(" ")));
    let mut c = crate::proc::command(&s.program);
    c.args(&s.args)
        .current_dir(&s.dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // Nothing here can answer a question: the tools must take their defaults instead of asking.
        .env("CI", "1")
        .env("NO_COLOR", "1")
        .env("npm_config_yes", "true")
        .env("npm_config_fund", "false")
        .env("npm_config_update_notifier", "false")
        .env("NG_CLI_ANALYTICS", "false")
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .env("COMPOSER_NO_INTERACTION", "1");
    // Its own process group, so Stop ends what it started too (npx starts npm starts node).
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut c, 0);
    let mut child = c.spawn().map_err(|e| AppError::msg(format!("Could not start {}: {e}", s.program)))?;
    let readers = [child.stdout.take().map(|p| pump(app, p)), child.stderr.take().map(|p| pump(app, p))];
    *scaffolds.running.lock().unwrap() = Some(child);
    let status = loop {
        let mut running = scaffolds.running.lock().unwrap();
        let Some(child) = running.as_mut() else { break None };
        if let Some(status) = child.try_wait()? {
            running.take();
            break Some(status);
        }
        drop(running);
        std::thread::sleep(std::time::Duration::from_millis(50));
    };
    for r in readers.into_iter().flatten() {
        let _ = r.join();
    }
    match status {
        _ if *scaffolds.stopped.lock().unwrap() => Err(AppError::msg("Stopped")),
        Some(st) if st.success() => Ok(()),
        Some(st) => Err(AppError::msg(format!("{} failed{}", s.label, st.code().map(|c| format!(" (exit code {c})")).unwrap_or_default()))),
        None => Err(AppError::msg("Stopped")),
    }
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let _ = crate::proc::command("kill").args(["-TERM", &format!("-{}", child.id())]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    crate::proc::kill_tree(child);
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewProject {
    pub template: String,
    pub parent: String,
    pub name: String,
    #[serde(default)]
    pub options: HashMap<String, String>,
}

/// The templates, and which of their tools this computer has.
#[tauri::command]
pub async fn project_templates() -> Result<Vec<Template>> {
    tauri::async_runtime::spawn_blocking(|| Ok(with_tools(catalog()))).await.map_err(|e| AppError::msg(e.to_string()))?
}

/// Make the project and answer its folder. Its output arrives as `project-output` events.
/// A folder half made by a failed run is left for the user to look at.
#[tauri::command]
pub async fn project_create(app: AppHandle, scaffolds: State<'_, Scaffolds>, request: NewProject) -> Result<String> {
    let template = with_tools(catalog()).into_iter().find(|t| t.id == request.template).ok_or_else(|| AppError::msg("Unknown template"))?;
    if let Some(missing) = template.tools.iter().find(|t| !t.found) {
        return Err(AppError::msg(format!("{} needs {}: install it from {}, then try again.", template.name, missing.name, missing.install_page)));
    }
    let parent = crate::paths::typed(&request.parent);
    if !parent.is_dir() {
        return Err(AppError::msg("Choose a folder that exists to put the project in"));
    }
    let name = request.name.trim().to_string();
    let project = parent.join(&name);
    if std::fs::symlink_metadata(&project).is_ok() {
        return Err(AppError::msg(format!("{} already exists", project.display())));
    }
    if scaffolds.running.lock().unwrap().is_some() {
        return Err(AppError::msg("Another project is being created"));
    }
    let scratch = std::env::temp_dir().join(format!("melodic-studio-scaffold-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)));
    let steps = plan(&template, &parent, &name, &request.options, &scratch)?;
    *scaffolds.stopped.lock().unwrap() = false;
    let app2 = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<PathBuf> {
        let scaffolds = app2.state::<Scaffolds>();
        if steps.iter().any(|s| s.dir == scratch) {
            std::fs::create_dir_all(&scratch)?;
        }
        let outcome = (|| {
            if steps.is_empty() {
                std::fs::create_dir(&project)?;
            }
            for s in &steps {
                run_step(&app2, &scaffolds, s)?;
            }
            if !project.is_dir() {
                return Err(AppError::msg(format!("The tool finished, but {} was not created", project.display())));
            }
            Ok(project.clone())
        })();
        let _ = std::fs::remove_dir_all(&scratch);
        outcome
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))??;
    Ok(crate::paths::native(&result).to_string_lossy().to_string())
}

#[tauri::command]
pub async fn project_stop(scaffolds: State<'_, Scaffolds>) -> Result<()> {
    *scaffolds.stopped.lock().unwrap() = true;
    if let Some(child) = scaffolds.running.lock().unwrap().as_mut() {
        stop_child(child);
    }
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;

    fn opts(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    fn get(id: &str) -> Template {
        catalog().into_iter().find(|t| t.id == id).unwrap()
    }

    fn commands(steps: &[Step]) -> Vec<String> {
        steps.iter().map(|s| format!("{} {}", s.program, s.args.join(" "))).collect()
    }

    #[test]
    fn names_follow_each_ecosystem() {
        let js = get("react");
        for ok in ["app", "my-app", "a1-b2"] {
            assert!(check_name(&js, ok).is_ok(), "{ok}");
        }
        for bad in ["", "My-App", "-app", "app-", "a--b", "1app", "a b", "a/b", "..", "a_b"] {
            assert!(check_name(&js, bad).is_err(), "{bad}");
        }
        let plain = get("dotnet");
        assert!(check_name(&plain, "My_App-2").is_ok());
        for bad in ["", "_a", "-a", "a b", "a/b", r"a\b", "a.b", "--help"] {
            assert!(check_name(&plain, bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn plans_are_plain_argv() {
        let parent = Path::new("/p");
        let scratch = Path::new("/tmp/s");
        let melodic = plan(&get("melodic-js"), parent, "site", &opts(&[]), scratch).unwrap();
        assert_eq!(commands(&melodic), ["npx --yes @melodicdev/cli@latest init site", "npm install", "npx --yes @melodicdev/cli@latest add testing", "npm install"]);
        assert_eq!(melodic[1].dir, parent.join("site"));
        let mono = plan(&get("melodic-js"), parent, "site", &opts(&[("monorepo", "true"), ("app", "admin"), ("testing", "false")]), scratch).unwrap();
        assert_eq!(commands(&mono), ["npx --yes @melodicdev/cli@latest init site --monorepo --app-name=admin", "npm install"]);
        assert!(plan(&get("melodic-js"), parent, "site", &opts(&[("monorepo", "true"), ("app", "--x")]), scratch).is_err());

        let php = plan(&get("melodic-php"), parent, "api", &opts(&[("type", "api")]), scratch).unwrap();
        assert_eq!(php[0].dir, scratch);
        assert_eq!(php[1].args[1..], ["make:project", "api", "--type=api"]);
        assert!(Path::new(&php[1].args[0]).ends_with(Path::new("vendor").join("bin").join("melodic")));
        // A value that is not one of the choices is refused, not passed on.
        assert!(plan(&get("melodic-php"), parent, "api", &opts(&[("type", "--evil")]), scratch).is_err());

        assert_eq!(commands(&plan(&get("angular"), parent, "web", &opts(&[]), scratch).unwrap()), ["npx --yes @angular/cli@latest new web --defaults --skip-git --style=scss --ssr=false"]);
        assert_eq!(commands(&plan(&get("vue"), parent, "web", &opts(&[]), scratch).unwrap())[0], "npx --yes create-vite@latest web --template vue-ts --no-interactive");
        assert_eq!(commands(&plan(&get("dotnet"), parent, "Api", &opts(&[("kind", "console")]), scratch).unwrap()), ["dotnet new console --output Api"]);
        assert_eq!(commands(&plan(&get("rust"), parent, "tool", &opts(&[("kind", "lib")]), scratch).unwrap()), ["cargo new tool --vcs=none --lib"]);
        assert!(plan(&get("empty"), parent, "x", &opts(&[]), scratch).unwrap().is_empty());
        assert!(plan(&get("react"), parent, "Bad Name", &opts(&[]), scratch).is_err());
    }

    #[test]
    fn output_loses_terminal_codes() {
        assert_eq!(strip_ansi("\u{1b}[32m✔\u{1b}[0m done"), "✔ done");
        assert_eq!(strip_ansi("plain"), "plain");
    }

    #[test]
    fn every_template_lists_its_tools() {
        for t in catalog() {
            assert!(t.id == "empty" || !t.tools.is_empty(), "{}", t.id);
            for tool in &t.tools {
                assert!(tool.install_page.starts_with("https://"));
            }
        }
    }
}
