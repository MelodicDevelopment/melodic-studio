use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Message(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Git(String),
    #[error("Merge conflicts need to be resolved")]
    Conflict(Vec<String>),
}

impl AppError {
    pub fn msg(s: impl Into<String>) -> Self {
        AppError::Message(s.into())
    }
}

/// What the frontend sees. `kind` lets the UI branch (conflict, auth)
/// without parsing the message.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppErrorPayload {
    pub kind: &'static str,
    pub message: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}

fn is_auth(m: &str) -> bool {
    let m = m.to_ascii_lowercase();
    m.contains("authentication failed") || m.contains("could not read username") || m.contains("permission denied (publickey") || m.contains("terminal prompts disabled")
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> std::result::Result<S::Ok, S::Error> {
        let (kind, paths) = match self {
            AppError::Conflict(p) => ("conflict", p.clone()),
            AppError::Git(m) if is_auth(m) => ("auth", vec![]),
            AppError::Git(_) => ("git", vec![]),
            _ => ("error", vec![]),
        };
        AppErrorPayload { kind, message: self.to_string(), paths }.serialize(s)
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
