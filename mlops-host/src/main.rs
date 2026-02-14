use std::io;
use std::path::PathBuf;
use rusqlite::Connection;

use mlops_host::models::{HostMessage, CaptureResponse, StatusResponse};
use mlops_host::messaging::{read_message, write_message};
use mlops_host::storage::{persist_capture, get_page_status};

fn main() -> io::Result<()> {
    let home = std::env::var("HOME").expect("Could not find HOME directory");
    let mlops_path = PathBuf::from(home)
        .join("Library")
        .join("Application Support")
        .join("mlops");
    let db_path = mlops_path.join("pages.db");

    let conn = Connection::open(db_path).expect("Failed to connect to pages DB");
    let mut stdin = io::stdin().lock();
    let mut stdout = io::stdout().lock();

    loop {
        let msg = match read_message(&mut stdin) {
            Ok(Some(m)) => m,
            Ok(None) => break,
            Err(e) => {
                let resp = CaptureResponse {
                    ok: false,
                    id: "".to_string(),
                    error: Some(format!("Failed to read message: {e}")),
                };
                let _ = write_message(&mut stdout, &resp);
                break;
            }
        };

        let parsed: Result<HostMessage, _> = serde_json::from_slice(&msg);
        match parsed {
            Ok(HostMessage::Capture { raw_url, url, html, screenshot, captured_at, label }) => {
                match persist_capture(&conn, &mlops_path, raw_url, url, html, screenshot, captured_at, label) {
                    Ok(id) => {
                        let resp = CaptureResponse { ok: true, id, error: None };
                        let _ = write_message(&mut stdout, &resp);
                    }
                    Err(e) => {
                        let resp = CaptureResponse { ok: false, id: "".to_string(), error: Some(e.to_string()) };
                        let _ = write_message(&mut stdout, &resp);
                    }
                }
            }
            Ok(HostMessage::GetStatus { url }) => {
                match get_page_status(&conn, &url) {
                    Ok(label) => {
                        let resp = StatusResponse { ok: true, label, error: None };
                        let _ = write_message(&mut stdout, &resp);
                    }
                    Err(e) => {
                        let resp = StatusResponse { ok: false, label: None, error: Some(e.to_string()) };
                        let _ = write_message(&mut stdout, &resp);
                    }
                }
            }
            Err(e) => {
                let resp = CaptureResponse {
                    ok: false,
                    id: "".to_string(),
                    error: Some(format!("Invalid JSON: {e}"))
                };
                let _ = write_message(&mut stdout, &resp);
            }
        }
    }
    Ok(())
}
