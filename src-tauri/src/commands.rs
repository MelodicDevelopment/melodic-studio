//! Tauri commands. Thin: look up the repository, delegate to `git`.
//! Everything that runs git is `async` so a slow fetch never blocks the window.

use crate::config::RepoRef;
use crate::error::{AppError, Result};
use crate::git::{self, Branch, Commit, DiffResult, FileChange, FileRef, Git, Identity, Origin, RebaseStep, RepoStatus, UndoneCommit};
use crate::AppState;
use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    /// The folder is gone or no longer a repository.
    pub missing: bool,
    /// Set while the app is looking at a linked worktree instead of the main checkout.
    pub worktree: Option<String>,
    /// Where `origin` (else the first remote) lives; `None` without a remote. Groups the repository list.
    pub origin: Option<Origin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub repos: Vec<RepoSummary>,
    pub current: Option<String>,
    pub git_version: Option<String>,
    pub author_name: String,
    pub author_email: String,
    pub app_version: String,
}

fn summary(r: &RepoRef, origin: Option<Origin>) -> RepoSummary {
    RepoSummary { id: r.id.clone(), name: r.name.clone(), path: r.path.to_string_lossy().to_string(), missing: !r.path.join(".git").exists(), worktree: r.worktree.as_ref().filter(|w| w.is_dir()).map(|w| w.to_string_lossy().to_string()), origin }
}

/// The origin of each repository. One git call per repository, run a few at a time and kept
/// until that repository's `.git/config` changes, so listing a hundred repositories stays cheap.
pub(crate) fn origins(state: &State<'_, AppState>, paths: &[PathBuf]) -> Vec<Option<Origin>> {
    let stamp = |p: &Path| std::fs::metadata(p.join(".git").join("config")).and_then(|m| m.modified()).ok();
    let stamps: Vec<_> = paths.iter().map(|p| stamp(p)).collect();
    let mut out: Vec<Option<Option<Origin>>> = {
        let cache = state.origins.lock().unwrap();
        paths.iter().zip(&stamps).map(|(p, s)| cache.get(p).filter(|(t, _)| s.is_some() && t == s).map(|(_, o)| o.clone())).collect()
    };
    let missing: Vec<usize> = (0..paths.len()).filter(|&i| out[i].is_none()).collect();
    for chunk in missing.chunks(8) {
        let found: Vec<(usize, Option<Origin>)> = std::thread::scope(|s| {
            let jobs: Vec<_> = chunk.iter().map(|&i| (i, s.spawn(move || Git::at(&paths[i]).origin_url().and_then(|u| git::origin(&u))))).collect();
            jobs.into_iter().map(|(i, j)| (i, j.join().ok().flatten())).collect()
        });
        let mut cache = state.origins.lock().unwrap();
        for (i, o) in found {
            cache.insert(paths[i].clone(), (stamps[i], o.clone()));
            out[i] = Some(o);
        }
    }
    out.into_iter().map(Option::flatten).collect()
}

/// Only repositories the user added can be operated on.
pub(crate) fn repo(state: &State<'_, AppState>, id: &str) -> Result<Git> {
    let config = state.config.lock().unwrap();
    let r = config.find(id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    Ok(Git::at(r.active_path()))
}

/// The repository's main checkout (whatever worktree is active), plus the active worktree.
pub(crate) fn main_repo(state: &State<'_, AppState>, id: &str) -> Result<(Git, Option<PathBuf>)> {
    let config = state.config.lock().unwrap();
    let r = config.find(id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    Ok((Git::at(&r.path), r.worktree.clone().filter(|w| w.is_dir())))
}

pub(crate) fn save_worktree(state: &State<'_, AppState>, id: &str, worktree: Option<PathBuf>) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    let r = config.repos.iter_mut().find(|r| r.id == id).ok_or_else(|| AppError::msg("That repository is no longer in Melodic Studio"))?;
    r.worktree = worktree;
    config.save(&state.config_path)
}

/// Add `path` to the list (once) and return its id.
fn insert(config: &mut crate::config::AppConfig, path: &Path) -> String {
    let id = path.to_string_lossy().to_string();
    if config.find(&id).is_none() {
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| id.clone());
        config.repos.push(RepoRef { id: id.clone(), name, path: path.to_path_buf(), worktree: None });
        config.repos.sort_by_key(|r| r.name.to_lowercase());
    }
    id
}

pub(crate) fn register(app: &tauri::AppHandle, state: &State<'_, AppState>, path: &Path) -> Result<RepoSummary> {
    crate::recent::note(app, path);
    let r = {
        let mut config = state.config.lock().unwrap();
        let id = insert(&mut config, path);
        config.current = Some(id.clone());
        config.save(&state.config_path)?;
        config.find(&id).unwrap().clone()
    };
    let origin = origins(state, std::slice::from_ref(&r.path)).pop().flatten();
    Ok(summary(&r, origin))
}

/// Quit and start again, after an update has been installed. See `proc::relaunch`.
#[tauri::command]
pub async fn app_relaunch(app: tauri::AppHandle) -> Result<()> {
    if crate::proc::relaunch().is_ok() {
        // `exit` rather than `std::process::exit`, so RunEvent::Exit still stops what we started.
        app.exit(0);
        return Ok(());
    }
    app.restart()
}

#[tauri::command]
pub async fn app_status(app: tauri::AppHandle, state: State<'_, AppState>) -> Result<AppStatus> {
    let (refs, current) = {
        let config = state.config.lock().unwrap();
        (config.repos.clone(), config.current.clone())
    };
    let paths: Vec<PathBuf> = refs.iter().map(|r| r.path.clone()).collect();
    let repos = refs.iter().zip(origins(&state, &paths)).map(|(r, o)| summary(r, o)).collect();
    Ok(AppStatus {
        repos,
        current,
        git_version: Git::version(),
        author_name: Git::global_config("user.name"),
        author_email: Git::global_config("user.email"),
        app_version: app.package_info().version.to_string(),
    })
}

// ---- repositories -----------------------------------------------------------

#[tauri::command]
pub async fn repo_add(app: tauri::AppHandle, state: State<'_, AppState>, path: String) -> Result<RepoSummary> {
    let top = Git::toplevel(&crate::paths::typed(&path))?;
    register(&app, &state, &top)
}

/// A repository found by `repo_scan`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanHit {
    pub path: String,
    pub name: String,
    /// Already in Melodic Studio.
    pub added: bool,
    pub origin: Option<Origin>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanResult {
    pub repos: Vec<ScanHit>,
    /// A depth, folder or time limit stopped the search before it saw everything.
    pub truncated: bool,
}

/// Every repository under a folder the user chose. Adds nothing: `repo_add_many` does, with the ones they tick.
#[tauri::command]
pub async fn repo_scan(state: State<'_, AppState>, root: String) -> Result<ScanResult> {
    let root = crate::paths::typed(&root);
    if !root.is_dir() {
        return Err(AppError::msg("That folder does not exist"));
    }
    let (found, truncated) = tauri::async_runtime::spawn_blocking(move || crate::scan::find(&root, crate::scan::MAX_DEPTH, crate::scan::MAX_FOLDERS, crate::scan::MAX_TIME))
        .await
        .map_err(|e| AppError::msg(format!("The scan stopped unexpectedly: {e}")))?;
    // Compared by real path (`paths::same`), resolved once per side rather than per pair.
    let added: Vec<PathBuf> = state.config.lock().unwrap().repos.iter().map(|r| r.path.canonicalize().unwrap_or_else(|_| r.path.clone())).collect();
    let origins = origins(&state, &found);
    let repos = found
        .iter()
        .zip(origins)
        .map(|(p, origin)| {
            let real = p.canonicalize().unwrap_or_else(|_| p.clone());
            ScanHit { path: p.to_string_lossy().to_string(), name: p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(), added: added.contains(&real), origin }
        })
        .collect();
    Ok(ScanResult { repos, truncated })
}

/// Add several repositories at once (the ones ticked after a scan). The current repository stays
/// as it is unless there was none. Folders that are not repositories are skipped.
#[tauri::command]
pub async fn repo_add_many(state: State<'_, AppState>, paths: Vec<String>) -> Result<usize> {
    let tops: Vec<PathBuf> = paths.iter().filter_map(|p| Git::toplevel(&crate::paths::typed(p)).ok()).collect();
    if tops.is_empty() {
        return Err(AppError::msg("None of those folders is a git repository"));
    }
    let mut config = state.config.lock().unwrap();
    let before = config.repos.len();
    for top in &tops {
        if !config.repos.iter().any(|r| crate::paths::same(&r.path, top)) {
            let id = insert(&mut config, top);
            if config.current.is_none() {
                config.current = Some(id);
            }
        }
    }
    let added = config.repos.len() - before;
    config.save(&state.config_path)?;
    Ok(added)
}

#[tauri::command]
pub async fn repo_create(app: tauri::AppHandle, state: State<'_, AppState>, parent: String, name: String, readme: bool) -> Result<RepoSummary> {
    let name = name.trim();
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err(AppError::msg("Give the repository a simple folder name"));
    }
    let dir = crate::paths::typed(&parent).join(name);
    if dir.join(".git").exists() {
        return Err(AppError::msg("A repository already exists there. Use Add existing instead."));
    }
    let g = Git::init(&dir)?;
    if readme && !dir.join("README.md").exists() {
        std::fs::write(dir.join("README.md"), format!("# {name}\n"))?;
        // Best effort: without a configured identity the file is simply left as a first change.
        let _ = g.commit(&["README.md".into()], "Initial commit", "", false);
    }
    let top = Git::toplevel(&dir)?;
    register(&app, &state, &top)
}

#[tauri::command]
pub async fn repo_clone(app: tauri::AppHandle, state: State<'_, AppState>, url: String, parent: String) -> Result<RepoSummary> {
    let url = url.trim();
    if url.is_empty() {
        return Err(AppError::msg("Enter a repository URL"));
    }
    let dest = crate::paths::typed(&parent).join(git::repo_name(url));
    if dest.exists() {
        return Err(AppError::msg(format!("{} already exists", dest.display())));
    }
    Git::clone(url, &dest)?;
    let top = Git::toplevel(&dest)?;
    register(&app, &state, &top)
}

#[tauri::command]
pub async fn repo_remove(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    if let Some(r) = config.find(&id) {
        crate::recent::forget(&app, &r.path);
    }
    config.repos.retain(|r| r.id != id);
    if config.current.as_deref() == Some(id.as_str()) {
        config.current = config.repos.first().map(|r| r.id.clone());
    }
    config.save(&state.config_path)
}

#[tauri::command]
pub async fn repo_select(app: tauri::AppHandle, state: State<'_, AppState>, id: String) -> Result<()> {
    let mut config = state.config.lock().unwrap();
    let Some(r) = config.find(&id) else {
        return Err(AppError::msg("That repository is no longer in Melodic Studio"));
    };
    crate::recent::note(&app, &r.path);
    config.current = Some(id);
    config.save(&state.config_path)
}

// ---- changes ----------------------------------------------------------------

#[tauri::command]
pub async fn repo_status(state: State<'_, AppState>, id: String) -> Result<RepoStatus> {
    repo(&state, &id)?.status()
}

#[tauri::command]
pub async fn file_diff(state: State<'_, AppState>, id: String, path: String, old_path: Option<String>, status: String) -> Result<DiffResult> {
    repo(&state, &id)?.diff_worktree(&path, old_path.as_deref(), &status)
}

#[tauri::command]
pub async fn commit_changes(state: State<'_, AppState>, id: String, paths: Vec<String>, summary: String, description: String, amend: bool) -> Result<()> {
    repo(&state, &id)?.commit(&paths, &summary, &description, amend)
}

#[tauri::command]
pub async fn resolve_file(state: State<'_, AppState>, id: String, path: String, side: String) -> Result<()> {
    repo(&state, &id)?.resolve(&path, &side)
}

#[tauri::command]
pub async fn ignore_file(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    repo(&state, &id)?.ignore(&path)
}

#[tauri::command]
pub async fn stash_save(state: State<'_, AppState>, id: String, message: String) -> Result<()> {
    repo(&state, &id)?.stash_save(&message)
}

#[tauri::command]
pub async fn stash_pop(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.stash_pop(&name)
}

#[tauri::command]
pub async fn stash_drop(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.stash_drop(&name)
}

#[tauri::command]
pub async fn op_continue(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_continue()
}

#[tauri::command]
pub async fn op_abort(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_abort()
}

#[tauri::command]
pub async fn revert_commit(state: State<'_, AppState>, id: String, hash: String) -> Result<()> {
    repo(&state, &id)?.revert(&hash)
}

#[tauri::command]
pub async fn cherry_pick(state: State<'_, AppState>, id: String, hashes: Vec<String>) -> Result<()> {
    repo(&state, &id)?.cherry_pick(&hashes)
}

#[tauri::command]
pub async fn rebase_plan(state: State<'_, AppState>, id: String, upstream: Option<String>) -> Result<Vec<Commit>> {
    repo(&state, &id)?.rebase_plan(upstream.as_deref())
}

#[tauri::command]
pub async fn rebase_interactive(state: State<'_, AppState>, id: String, upstream: Option<String>, steps: Vec<RebaseStep>) -> Result<()> {
    repo(&state, &id)?.rebase_interactive(upstream.as_deref(), &steps)
}

#[tauri::command]
pub async fn reset_to(state: State<'_, AppState>, id: String, hash: String, mode: String) -> Result<()> {
    repo(&state, &id)?.reset(&hash, &mode)
}

#[tauri::command]
pub async fn checkout_commit(state: State<'_, AppState>, id: String, hash: String) -> Result<()> {
    repo(&state, &id)?.checkout_commit(&hash)
}

#[tauri::command]
pub async fn tag_create(state: State<'_, AppState>, id: String, name: String, hash: String, push: bool) -> Result<()> {
    repo(&state, &id)?.tag_create(name.trim(), &hash, push)
}

#[tauri::command]
pub async fn tag_delete(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.tag_delete(&name)
}

#[tauri::command]
pub async fn rebase_onto(state: State<'_, AppState>, id: String, onto: String) -> Result<()> {
    repo(&state, &id)?.rebase(&onto)
}

#[tauri::command]
pub async fn branch_delete_remote(state: State<'_, AppState>, id: String, name: String) -> Result<()> {
    repo(&state, &id)?.branch_delete_remote(&name)
}

#[tauri::command]
pub async fn discard_changes(state: State<'_, AppState>, id: String, files: Vec<FileRef>) -> Result<()> {
    repo(&state, &id)?.discard(&files)
}

#[tauri::command]
pub async fn undo_commit(state: State<'_, AppState>, id: String) -> Result<UndoneCommit> {
    repo(&state, &id)?.undo_commit()
}

// ---- history ----------------------------------------------------------------

#[tauri::command]
pub async fn history(state: State<'_, AppState>, id: String, skip: usize, limit: usize, path: Option<String>) -> Result<Vec<Commit>> {
    let g = repo(&state, &id)?;
    match path.filter(|p| !p.is_empty()) {
        Some(path) => g.file_log(&path, skip, limit.clamp(1, 500)),
        None => g.log(skip, limit.clamp(1, 500)),
    }
}

#[tauri::command]
pub async fn compare_history(state: State<'_, AppState>, id: String, branch: String, ahead: bool, skip: usize, limit: usize) -> Result<Vec<Commit>> {
    repo(&state, &id)?.compare_log(&branch, ahead, skip, limit.clamp(1, 500))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCompare {
    pub name: String,
    pub ahead: u32,
    pub behind: u32,
}

/// Ahead/behind counts of the current branch against each of `branches` (at most 100; ones git cannot count are left out).
#[tauri::command]
pub async fn compare_counts(state: State<'_, AppState>, id: String, branches: Vec<String>) -> Result<Vec<BranchCompare>> {
    let g = repo(&state, &id)?;
    Ok(branches
        .into_iter()
        .take(100)
        .filter_map(|name| g.ahead_behind(&name).ok().map(|(ahead, behind)| BranchCompare { name, ahead, behind }))
        .collect())
}

#[tauri::command]
pub async fn commit_files(state: State<'_, AppState>, id: String, hash: String) -> Result<Vec<FileChange>> {
    repo(&state, &id)?.commit_files(&hash)
}

#[tauri::command]
pub async fn commit_diff(state: State<'_, AppState>, id: String, hash: String, path: String, old_path: Option<String>) -> Result<DiffResult> {
    repo(&state, &id)?.diff_commit(&hash, &path, old_path.as_deref())
}

// ---- branches ---------------------------------------------------------------

#[tauri::command]
pub async fn branches(state: State<'_, AppState>, id: String) -> Result<Vec<Branch>> {
    repo(&state, &id)?.branches()
}

#[tauri::command]
pub async fn branch_create(state: State<'_, AppState>, id: String, name: String, start: Option<String>) -> Result<()> {
    repo(&state, &id)?.branch_create(name.trim(), start.as_deref())
}

#[tauri::command]
pub async fn branch_checkout(state: State<'_, AppState>, id: String, name: String, is_remote: bool) -> Result<()> {
    repo(&state, &id)?.branch_checkout(&name, is_remote)
}

#[tauri::command]
pub async fn branch_delete(state: State<'_, AppState>, id: String, name: String, force: bool, remote: bool) -> Result<()> {
    repo(&state, &id)?.branch_delete(&name, force, remote)
}

#[tauri::command]
pub async fn branch_rename(state: State<'_, AppState>, id: String, from: String, to: String) -> Result<()> {
    repo(&state, &id)?.branch_rename(&from, to.trim())
}

#[tauri::command]
pub async fn merge_branch(state: State<'_, AppState>, id: String, from: String) -> Result<String> {
    repo(&state, &id)?.merge(&from)
}

#[tauri::command]
pub async fn merge_squash(state: State<'_, AppState>, id: String, from: String, message: String) -> Result<()> {
    repo(&state, &id)?.merge_squash(&from, &message)
}

#[tauri::command]
pub async fn merge_abort(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.op_abort()
}

// ---- remotes ----------------------------------------------------------------

#[tauri::command]
pub async fn fetch(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.fetch()
}

/// The window's own fetch every few minutes: asks for nothing, and is given up after a minute.
#[tauri::command]
pub async fn fetch_background(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.fetch_quiet()
}

#[tauri::command]
pub async fn pull(state: State<'_, AppState>, id: String) -> Result<()> {
    repo(&state, &id)?.pull()
}

#[tauri::command]
pub async fn push(state: State<'_, AppState>, id: String, force: bool) -> Result<()> {
    repo(&state, &id)?.push(force)
}

#[tauri::command]
pub async fn remote_set(state: State<'_, AppState>, id: String, url: String) -> Result<()> {
    repo(&state, &id)?.set_remote(url.trim())
}

// ---- the world outside ------------------------------------------------------

/// Open the repository somewhere else: `finder`, `reveal` (entries in `arg`, one per line), `terminal`
/// (at the folder `arg`, when given), or a page on its
/// host: `remote` (the repository), `issues`, `pulls`, `new-pull` (for the current branch)
/// or `commit` (with `arg` the hash).
#[tauri::command]
pub async fn open_in(app: tauri::AppHandle, state: State<'_, AppState>, id: String, target: String, arg: Option<String>) -> Result<()> {
    use tauri_plugin_opener::OpenerExt;
    let g = repo(&state, &id)?;
    let dir = g.dir.to_string_lossy().to_string();
    match target.as_str() {
        "finder" => app.opener().open_path(dir, None::<&str>).map_err(|e| AppError::msg(e.to_string())),
        // Select entries (repository-relative, one per line in `arg`) in the file manager.
        "reveal" => {
            let found = arg.as_deref().unwrap_or_default().lines().map(|rel| crate::files::locate(&g, rel)).collect::<Result<Vec<_>>>()?;
            app.opener().reveal_items_in_dir(found).map_err(|e| AppError::msg(e.to_string()))
        }
        "remote" | "issues" | "pulls" | "new-pull" | "commit" | "branch" => {
            let host = g.default_remote().and_then(|r| g.remote_url(&r)).and_then(|u| git::host(&u)).ok_or_else(|| AppError::msg("This repository has no web page to open"))?;
            let url = match target.as_str() {
                "remote" => Some(host.web.clone()),
                "issues" => host.issues.clone(),
                "pulls" => host.pulls.clone(),
                "new-pull" => {
                    let branch = g.run(&["symbolic-ref", "--short", "HEAD"]).map_err(|_| AppError::msg("Check out a branch first"))?;
                    host.new_pull(branch.trim())
                }
                "branch" => arg.as_deref().filter(|b| !b.is_empty()).and_then(|b| host.branch(b)),
                _ => arg.as_deref().filter(|h| h.chars().all(|c| c.is_ascii_hexdigit())).and_then(|h| host.commit(h)),
            }
            .ok_or_else(|| AppError::msg(format!("Melodic Studio does not know that page on {}", host.name)))?;
            app.opener().open_url(url, None::<&str>).map_err(|e| AppError::msg(e.to_string()))
        }
        "terminal" => match arg.as_deref().filter(|a| !a.is_empty()) {
            Some(rel) => {
                let at = crate::files::locate(&g, rel)?;
                let folder = if at.is_dir() { at } else { at.parent().map(Path::to_path_buf).unwrap_or_else(|| g.dir.clone()) };
                crate::proc::open_terminal(&folder.to_string_lossy())
            }
            None => crate::proc::open_terminal(&dir),
        },
        _ => Err(AppError::msg("Unknown target")),
    }
}

// ---- who commits ------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identities {
    pub global: Identity,
    /// The repository's own identity, when it overrides the global one.
    pub repo: Option<Identity>,
}

/// The global identity, plus repository `id`'s override when one is given.
#[tauri::command]
pub async fn identity_get(state: State<'_, AppState>, id: Option<String>) -> Result<Identities> {
    let repo = match id {
        Some(id) => main_repo(&state, &id)?.0.local_identity(),
        None => None,
    };
    Ok(Identities { global: Git::global_identity(), repo })
}

/// Without `id`, set the global identity (`identity` required). With `id`, set that
/// repository's override, or remove it with `identity: null`.
#[tauri::command]
pub async fn identity_set(state: State<'_, AppState>, id: Option<String>, identity: Option<Identity>) -> Result<()> {
    match id {
        Some(id) => main_repo(&state, &id)?.0.set_local_identity(identity.as_ref()),
        None => Git::set_global_identity(&identity.ok_or_else(|| AppError::msg("Give both a name and an email"))?),
    }
}

// ---- files (the Files tab) ---------------------------------------------------

#[tauri::command]
pub async fn list_dir(state: State<'_, AppState>, id: String, path: String) -> Result<Vec<crate::files::TreeEntry>> {
    crate::files::list_dir(&repo(&state, &id)?, &path)
}

/// Opening a file by name lists the checkout's files; a checkout with more than this is cut there, and says so.
const FILES_LIMIT: usize = 200_000;

#[tauri::command]
pub async fn files_list(state: State<'_, AppState>, id: String) -> Result<crate::git::FileList> {
    let git = repo(&state, &id)?;
    tauri::async_runtime::spawn_blocking(move || git.files(FILES_LIMIT)).await.map_err(|e| AppError::msg(format!("Listing the files stopped unexpectedly: {e}")))?
}

/// Find in files, in the active checkout. More matching lines than this are not sent; the answer says so.
const SEARCH_LIMIT: usize = 2000;

#[tauri::command]
pub async fn files_search(state: State<'_, AppState>, id: String, pattern: String, options: crate::git::SearchOptions) -> Result<crate::git::SearchResult> {
    let git = repo(&state, &id)?;
    // git reads the whole checkout: off the thread that answers the window.
    tauri::async_runtime::spawn_blocking(move || git.grep(&pattern, &options, SEARCH_LIMIT)).await.map_err(|e| AppError::msg(format!("The search stopped unexpectedly: {e}")))?
}

#[tauri::command]
pub async fn read_file(state: State<'_, AppState>, id: String, path: String) -> Result<crate::files::FileContent> {
    crate::files::read_file(&repo(&state, &id)?, &path)
}

#[tauri::command]
pub async fn write_file(state: State<'_, AppState>, id: String, path: String, text: String, root: String) -> Result<()> {
    let g = repo(&state, &id)?;
    // The editor says which checkout it read the file from. If the active worktree changed
    // since, the same relative path now names a different file: refuse rather than overwrite it.
    if !crate::files::same_dir(&g.dir, Path::new(&root)) {
        return Err(AppError::msg("The active checkout changed, so nothing was saved. Open the file again and retry."));
    }
    crate::files::write_file(&g, &path, &text)
}

/// The checkout a Files tab action was aimed at, refusing it when another one has become active since.
fn checkout(state: &State<'_, AppState>, id: &str, root: &str) -> Result<Git> {
    let g = repo(state, id)?;
    if !crate::files::same_dir(&g.dir, Path::new(root)) {
        return Err(AppError::msg("The active checkout changed, so nothing was done. Try again."));
    }
    Ok(g)
}

/// The formatter the project of a file in the active checkout brings (Prettier), if it brings one.
#[tauri::command]
pub async fn format_tool(state: State<'_, AppState>, id: String, path: String) -> Result<Option<crate::format::Tool>> {
    crate::format::tool(&repo(&state, &id)?.dir, &path)
}

/// `text`, the editor's copy of `path`, as the project's own formatter would write it; nothing when the
/// project has none for this file. The file on disk is not touched.
#[tauri::command]
pub async fn format_file(state: State<'_, AppState>, id: String, root: String, path: String, text: String) -> Result<Option<String>> {
    let g = checkout(&state, &id, &root)?;
    // It starts a process and waits for it: off the thread that answers the window.
    tauri::async_runtime::spawn_blocking(move || crate::format::format(&g.dir, &path, &text)).await.map_err(|e| AppError::msg(format!("Formatting stopped unexpectedly: {e}")))?
}

#[tauri::command]
pub async fn files_create(state: State<'_, AppState>, id: String, root: String, dir: String, name: String, is_dir: bool) -> Result<String> {
    crate::files::create(&checkout(&state, &id, &root)?, &dir, &name, is_dir)
}

/// Move `paths` into folder `to`; with `rename`, the single path also takes that name.
#[tauri::command]
pub async fn files_move(state: State<'_, AppState>, id: String, root: String, paths: Vec<String>, to: String, rename: Option<String>, on_conflict: crate::files::OnConflict) -> Result<crate::files::Placed> {
    crate::files::relocate(&checkout(&state, &id, &root)?, &paths, &to, rename.as_deref(), on_conflict)
}

#[tauri::command]
pub async fn files_duplicate(state: State<'_, AppState>, id: String, root: String, path: String) -> Result<String> {
    crate::files::duplicate(&checkout(&state, &id, &root)?, &path)
}

#[tauri::command]
pub async fn files_trash(state: State<'_, AppState>, id: String, root: String, paths: Vec<String>) -> Result<()> {
    crate::files::trash(&checkout(&state, &id, &root)?, &paths)
}

/// Copy files dropped on the window from outside (absolute paths) into folder `to`.
#[tauri::command]
pub async fn files_import(state: State<'_, AppState>, id: String, root: String, sources: Vec<String>, to: String, on_conflict: crate::files::OnConflict) -> Result<crate::files::Placed> {
    let sources: Vec<PathBuf> = sources.iter().map(PathBuf::from).collect();
    crate::files::import(&checkout(&state, &id, &root)?, &sources, &to, on_conflict)
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>> {
    use tauri_plugin_dialog::DialogExt;
    Ok(app.dialog().file().blocking_pick_folder().map(|p| p.to_string()))
}
