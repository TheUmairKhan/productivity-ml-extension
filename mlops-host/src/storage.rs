use std::fs;
use std::path::Path;
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

use crate::models::PersistError;

pub fn persist_capture(
    conn: &Connection,
    mlops_path: &Path,
    raw_url: String,
    url: String,
    html: Option<String>,
    screenshot: Option<String>,
    captured_at: String,
    label: String,
) -> Result<String, PersistError> {
    let html = html
        .as_deref()
        .ok_or(PersistError::Missing("capture.html"))?;

    let screenshot = screenshot
        .as_deref()
        .ok_or(PersistError::Missing("capture.screenshot"))?;

    let captures_dir = mlops_path.join("captures");
    fs::create_dir_all(&captures_dir)?;

    let key = url_key(&url);
    let page_dir = captures_dir.join(&key);
    fs::create_dir_all(&page_dir)?;

    let html_path = page_dir.join("page.html");
    fs::write(&html_path, html.as_bytes())?;

    let screenshot_bytes = decode_base64(screenshot)?;
    let screenshot_path = page_dir.join("screenshot.jpg");
    fs::write(&screenshot_path, screenshot_bytes)?;

    conn.execute(
        r#"
        INSERT INTO pages (
            url,
            raw_url,
            html_path,
            screenshot_path,
            captured_at,
            label
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        ON CONFLICT(url) DO UPDATE SET
            raw_url         = excluded.raw_url,
            html_path       = excluded.html_path,
            screenshot_path = excluded.screenshot_path,
            captured_at     = excluded.captured_at,
            label           = excluded.label
        "#,
        params![
            url,
            raw_url,
            html_path.to_string_lossy().to_string(),
            screenshot_path.to_string_lossy().to_string(),
            captured_at,
            label,
        ]
    )?;

    Ok(key)
}

pub fn get_page_status(conn: &Connection, url: &str) -> Result<Option<String>, rusqlite::Error> {
    match conn.query_row(
        "SELECT label FROM pages WHERE url = ?1",
        params![url],
        |row| row.get::<_, String>(0),
    ) {
        Ok(label) => Ok(Some(label)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

fn decode_base64(s: &str) -> Result<Vec<u8>, PersistError> {
    Ok(general_purpose::STANDARD.decode(s.trim())?)
}

fn url_key(url: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(url.as_bytes());
    let digest = hasher.finalize();

    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}
