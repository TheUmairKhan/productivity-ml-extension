import sqlite3
import os
from typing import List, Tuple


def load_records(db_path: str) -> List[Tuple[str, str, str]]:
    """
    Read labeled page records from SQLite.

    Returns list of (url, html_path, label) for rows where:
    - label is not NULL
    - html_path exists on disk
    """
    path = os.path.expanduser(db_path)
    conn = sqlite3.connect(path)
    rows = conn.execute(
        "SELECT url, html_path, label FROM pages WHERE label IS NOT NULL"
    ).fetchall()
    conn.close()

    return [
        (url, html_path, label)
        for url, html_path, label in rows
        if os.path.exists(html_path)
    ]
