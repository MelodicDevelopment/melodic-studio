//! App-level registry of repositories. Lives in the OS config dir, never in a repo.

use crate::error::Result;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RepoRef {
    /// The repository's top-level path as a string; doubles as its id.
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    /// The linked worktree the app is looking at instead of `path`, if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<PathBuf>,
}

impl RepoRef {
    /// Where commands run: the active worktree while it still exists, else the main checkout.
    pub fn active_path(&self) -> &PathBuf {
        self.worktree.as_ref().filter(|w| w.is_dir()).unwrap_or(&self.path)
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub repos: Vec<RepoRef>,
    pub current: Option<String>,
    /// Command used for "Open in editor" (default `code`).
    pub editor: Option<String>,
}

impl AppConfig {
    pub fn load(path: &Path) -> Result<Self> {
        if !path.exists() {
            return Ok(Self::default());
        }
        Ok(serde_json::from_str(&std::fs::read_to_string(path)?)?)
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(path, serde_json::to_string_pretty(self)?)?;
        Ok(())
    }

    pub fn find(&self, id: &str) -> Option<&RepoRef> {
        self.repos.iter().find(|r| r.id == id)
    }

    pub fn editor(&self) -> String {
        self.editor.clone().filter(|e| !e.trim().is_empty()).unwrap_or_else(|| "code".into())
    }
}
