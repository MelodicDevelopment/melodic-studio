mod agent;
mod ai_git;
mod commands;
mod config;
mod error;
mod files;
mod git;
mod lsp;
mod paths;
mod proc;
mod worktree;

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub config_path: PathBuf,
    pub config: Mutex<config::AppConfig>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    paths::fix_path();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("repositories.json");
            let config = config::AppConfig::load(&config_path).unwrap_or_default();
            app.manage(AppState { config_path, config: Mutex::new(config) });
            app.manage(agent::Agents::default());
            app.manage(lsp::Lsp::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_status,
            commands::repo_add,
            commands::repo_create,
            commands::repo_clone,
            commands::repo_remove,
            commands::repo_select,
            commands::repo_status,
            commands::file_diff,
            commands::commit_changes,
            commands::discard_changes,
            commands::resolve_file,
            commands::ignore_file,
            commands::stash_save,
            commands::stash_pop,
            commands::stash_drop,
            commands::op_continue,
            commands::op_abort,
            commands::revert_commit,
            commands::cherry_pick,
            commands::reset_to,
            commands::checkout_commit,
            commands::tag_create,
            commands::tag_delete,
            commands::rebase_onto,
            commands::branch_delete_remote,
            commands::undo_commit,
            commands::history,
            commands::commit_files,
            commands::commit_diff,
            ai_git::ai_selected_diff,
            ai_git::ai_commit_patch,
            ai_git::ai_push_diff,
            ai_git::ai_range_file_diff,
            ai_git::ai_conflict_file,
            ai_git::ai_resolution_preview,
            ai_git::ai_resolution_apply,
            commands::branches,
            commands::branch_create,
            commands::branch_checkout,
            commands::branch_delete,
            commands::branch_rename,
            commands::merge_branch,
            commands::merge_abort,
            commands::fetch,
            commands::pull,
            commands::push,
            commands::remote_set,
            commands::open_in,
            commands::set_editor,
            commands::pick_folder,
            worktree::worktree_list,
            worktree::worktree_add,
            worktree::worktree_select,
            worktree::worktree_remove,
            agent::agent_available,
            agent::agent_start,
            agent::agent_stop,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Melodic Studio");
}
