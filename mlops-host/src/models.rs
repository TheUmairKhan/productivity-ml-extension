use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(tag = "type")]
pub enum HostMessage {
    #[serde(rename = "capture")]
    Capture {
        raw_url: String,
        url: String,
        html: Option<String>,
        screenshot: Option<String>,
        captured_at: String,
        label: String,
    },
    #[serde(rename = "get_status")]
    GetStatus { url: String },
}

#[derive(Serialize)]
pub struct CaptureResponse {
    pub ok: bool,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Serialize)]
pub struct StatusResponse {
    pub ok: bool,
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug)]
pub enum PersistError {
    Missing(&'static str),
    Io(std::io::Error),
    Sql(rusqlite::Error),
    Base64(base64::DecodeError),
}

impl std::fmt::Display for PersistError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PersistError::Missing(field) => write!(f, "missing required field: {field}"),
            PersistError::Io(e) => write!(f, "io error: {e}"),
            PersistError::Sql(e) => write!(f, "sqlite error: {e}"),
            PersistError::Base64(e) => write!(f, "base64 decode error: {e}"),
        }
    }
}

impl From<std::io::Error> for PersistError { fn from(e: std::io::Error) -> Self { Self::Io(e) } }
impl From<rusqlite::Error> for PersistError { fn from(e: rusqlite::Error) -> Self { Self::Sql(e) } }
impl From<base64::DecodeError> for PersistError { fn from(e: base64::DecodeError) -> Self { Self::Base64(e) } }
impl std::error::Error for PersistError {}
