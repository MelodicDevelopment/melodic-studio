mod agent;
mod commands;
mod config;
mod dev;
mod error;
mod files;
mod git;
mod init;
mod host_cli;
mod lsp;
mod paths;
mod proc;
mod terminal;
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
            // Debug builds can keep their settings somewhere else, so a test instance never touches the real ones.
            let config_dir = match std::env::var("STUDIO_CONFIG_DIR") {
                Ok(dir) if cfg!(debug_assertions) && !dir.is_empty() => PathBuf::from(dir),
                _ => app.path().app_config_dir()?,
            };
            std::fs::create_dir_all(&config_dir)?;
            let config_path = config_dir.join("repositories.json");
            let config = config::AppConfig::load(&config_path).unwrap_or_default();
            app.manage(AppState { config_path, config: Mutex::new(config) });
            app.manage(agent::Agents::default());
            app.manage(lsp::Lsp::default());
            dev::start(app.handle());
            app.manage(terminal::Terminals::default());
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
            dev::dev_log,
            init::folder_inspect,
            init::repo_init,
            init::open_url,
            terminal::term_open,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_close,
            commands::list_dir,
            commands::read_file,
            commands::write_file,
            host_cli::issues_status,
            host_cli::issues_list,
            host_cli::pr_context,
            host_cli::pr_changes,
            host_cli::pr_existing,
            host_cli::pr_create,
            host_cli::pr_web_url,
            host_cli::host_open,
            host_cli::host_clis,
            host_cli::host_owners,
            host_cli::host_repo_create,
        ])
        .on_window_event(terminal::on_window_event)
        .run(tauri::generate_context!())
        .expect("error while running Melodic Studio");
}
