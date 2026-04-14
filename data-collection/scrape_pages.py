"""
Fetch rendered HTML for every URL in urls_dataset.json and insert each page
into pages.db, mirroring the structure created by the Rust mlops-host service.

Requires env vars:  (none — reads from config.py via OUTPUT_FILE only)

Usage:
  python scrape_pages.py
"""

import asyncio
import hashlib
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from playwright.async_api import async_playwright

from config import (
    OUTPUT_FILE,
    SCRAPE_CONCURRENCY,
    SCRAPE_DOMAIN_DELAY_S,
    SCRAPE_PAGE_TIMEOUT_MS,
)

# ---------------------------------------------------------------------------
# Paths (mirror the Rust mlops-host layout)
# ---------------------------------------------------------------------------
MLOPS_DIR = Path.home() / "Library" / "Application Support" / "mlops"
CAPTURES_DIR = MLOPS_DIR / "captures"
DB_PATH = MLOPS_DIR / "pages.db"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def url_key(url: str) -> str:
    """SHA256 hex digest of the raw URL — matches Rust url_key()."""
    return hashlib.sha256(url.encode()).hexdigest()


def load_dataset() -> dict[str, str]:
    """Return {url: label} from urls_dataset.json, deduplicated by URL."""
    with open(OUTPUT_FILE, encoding="utf-8") as f:
        data = json.load(f)
    entries: dict[str, str] = {}
    for topic in data["topics"]:
        for query in topic["queries"]:
            label = query["label"]
            for url in query["urls"]:
                if url not in entries:
                    entries[url] = label
    return entries


def load_existing_urls() -> set[str]:
    """Return URLs already present in pages.db."""
    if not DB_PATH.exists():
        return set()
    con = sqlite3.connect(DB_PATH)
    rows = con.execute("SELECT url FROM pages").fetchall()
    con.close()
    return {r[0] for r in rows}


def insert_page(url: str, html_path: str, label: str) -> None:
    con = sqlite3.connect(DB_PATH)
    con.execute(
        """
        INSERT OR REPLACE INTO pages
            (url, raw_url, html_path, screenshot_path, captured_at, label)
        VALUES (?, ?, ?, '', ?, ?)
        """,
        (url, url, html_path, datetime.now(timezone.utc).isoformat(), label),
    )
    con.commit()
    con.close()


# ---------------------------------------------------------------------------
# Async scraper
# ---------------------------------------------------------------------------

async def fetch_and_store(
    url: str,
    label: str,
    browser,
    semaphore: asyncio.Semaphore,
    domain_locks: dict[str, asyncio.Lock],
) -> bool:
    """Fetch a single URL, save HTML, insert DB row. Returns True on success."""
    from urllib.parse import urlparse
    domain = urlparse(url).netloc

    async with semaphore:
        # Per-domain rate limiting
        if domain not in domain_locks:
            domain_locks[domain] = asyncio.Lock()
        async with domain_locks[domain]:
            await asyncio.sleep(SCRAPE_DOMAIN_DELAY_S)

        page = await browser.new_page()
        try:
            await page.goto(url, wait_until="load", timeout=SCRAPE_PAGE_TIMEOUT_MS)
            html = await page.content()
        except Exception as e:
            print(f"  FAIL  {url}  ({e})")
            return False
        finally:
            await page.close()

    # Save HTML to disk
    key = url_key(url)
    capture_path = CAPTURES_DIR / key
    capture_path.mkdir(parents=True, exist_ok=True)
    html_path = capture_path / "page.html"
    html_path.write_text(html, encoding="utf-8")

    insert_page(url, str(html_path), label)
    return True


async def main() -> None:
    CAPTURES_DIR.mkdir(parents=True, exist_ok=True)

    entries = load_dataset()
    existing = load_existing_urls()

    pending = {url: label for url, label in entries.items() if url not in existing}
    print(f"Total URLs in dataset : {len(entries)}")
    print(f"Already in DB         : {len(existing)}")
    print(f"To scrape             : {len(pending)}\n")

    if not pending:
        print("Nothing to do.")
        return

    semaphore = asyncio.Semaphore(SCRAPE_CONCURRENCY)
    domain_locks: dict[str, asyncio.Lock] = {}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(headless=True)

        tasks = [
            fetch_and_store(url, label, browser, semaphore, domain_locks)
            for url, label in pending.items()
        ]

        results = []
        for i, coro in enumerate(asyncio.as_completed(tasks), 1):
            ok = await coro
            results.append(ok)
            status = "OK  " if ok else "FAIL"
            print(f"[{i}/{len(tasks)}] {status}")

        await browser.close()

    succeeded = sum(results)
    failed = len(results) - succeeded
    print(f"\nDone. Succeeded: {succeeded}  Failed: {failed}")
    print(f"DB: {DB_PATH}")


if __name__ == "__main__":
    asyncio.run(main())
