"""
JSON persistence and dataset metadata computation.
"""

import json
from datetime import datetime, timezone

from config import OUTPUT_FILE


def compute_metadata(topics: list[dict]) -> dict:
    total_urls = sum(len(q["urls"]) for t in topics for q in t["queries"])
    total_queries = sum(len(t["queries"]) for t in topics)
    productive = sum(1 for t in topics for q in t["queries"] if q["label"] == "productive")
    waste = sum(1 for t in topics for q in t["queries"] if q["label"] == "waste")
    return {
        "total_urls": total_urls,
        "total_queries": total_queries,
        "total_topics": len(topics),
        "productive_queries": productive,
        "waste_queries": waste,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def save(topics: list[dict]) -> dict:
    """Write the full dataset to disk and return the metadata dict."""
    metadata = compute_metadata(topics)
    dataset = {"metadata": metadata, "topics": topics}
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(dataset, f, indent=2, ensure_ascii=False)
    return metadata
