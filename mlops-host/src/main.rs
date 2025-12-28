use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::fs::{self};
use std::path::{Path, PathBuf};
use base64::{engine::general_purpose, Engine as _};
use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

#[derive(Deserialize)]
struct PageCapture {
    raw_url: String,
    url: String,
    html: Option<String>,
    screenshot: Option<String>,
    captured_at: String,
    label: String,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    id: String,
    error: Option<String>,
}
fn main() -> io::Result<()>{    
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
                let resp = Response {
                    ok: false,
                    id: "".to_string(),
                    error: Some(format!("Failed to read message: {e}")),
                };
                let _ = write_message(&mut stdout, &resp);
                break;
            }
        };

        let parsed: Result<PageCapture, _> =serde_json::from_slice(&msg);
        let capture = match parsed {
            Ok(v) => v,
            Err(e) => {
                let resp = Response {
                    ok: false,
                    id: "".to_string(),
                    error: Some(format!("Invalid JSON: {e}"))
                };
                let _ = write_message(&mut stdout, &resp);
                continue;
            }
        };

        match persist_capture(&conn, &mlops_path, capture) {
            Ok(id) => {
                let resp = Response {
                    ok: true,
                    id,
                    error: None,
                };
                let _ = write_message(&mut stdout, &resp);
            }
            Err(e) => {
                let resp = Response {
                    ok: false,
                    id: "".to_string(),
                    error: Some(e),
                };
                let _ = write_message(&mut stdout, &resp);
            }
        }

    }
    Ok(())
}


fn read_message<R: Read>(r: &mut R) -> io::Result<Option<Vec<u8>>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }

    let len = u32::from_le_bytes(len_buf) as usize;
    if len == 0 {
        return Ok(Some(Vec::new()));
    }

    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}


fn write_message<W: Write, T: Serialize>(
    w: &mut W,
    payload: &T,
) -> io::Result<()> {
    let json = serde_json::to_vec(payload)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;

    let len = (json.len() as u32).to_le_bytes();

    w.write_all(&len)?;
    w.write_all(&json)?;
    w.flush()?;

    Ok(())
}


fn persist_capture(conn: &Connection, mlops_path: &Path, capture: PageCapture) -> Result<String, String> {
    let html = capture.html
        .as_deref()
        .ok_or_else(|| "capture.html is required but was None".to_string())?;

    let screenshot = capture.screenshot
        .as_deref()
        .ok_or_else(|| "capture.screenshot is required but was None".to_string())?;

    let captures_dir = mlops_path.join("captures");
    fs::create_dir_all(&captures_dir)
        .map_err(|e| format!("create captures dir failed: {e}"))?;

    let key = url_key(&capture.url);
    let page_dir = captures_dir.join(&key);
    fs::create_dir_all(&page_dir)
        .map_err(|e| format!("create page dir failed: {e}"))?;

    let html_path = page_dir.join("page.html");
    fs::write(&html_path, html.as_bytes())
        .map_err(|e| format!("write html failed: {e}"))?;

    let screenshot_bytes = decode_base64(screenshot)
        .map_err(|e| format!("decode screenshot failed: {e}"))?;
    let screenshot_path = page_dir.join("screenshot.jpg");
    fs::write(&screenshot_path, screenshot_bytes)
        .map_err(|e| format!("write screenshot failed: {e}"))?;

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
            capture.url,
            capture.raw_url,
            html_path.to_string_lossy().to_string(),
            screenshot_path.to_string_lossy().to_string(),
            capture.captured_at,
            capture.label,
        ]
    )
    .map_err(|e| format!("sqlite upsert failed: {e}"))?;

    Ok(key)
}


fn decode_base64(s: &str) -> Result<Vec<u8>, String> {
    general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| e.to_string())
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