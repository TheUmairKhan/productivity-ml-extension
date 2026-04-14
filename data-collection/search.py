"""
Brave Search API client and per-query URL collection.
"""

import requests

from config import BRAVE_API_KEY, BRAVE_FETCH_COUNT, BRAVE_SEARCH_URL, URLS_PER_QUERY
from dedup import is_allowed, record_url


def brave_search(query: str) -> list[str]:
    """Return raw results [{url, title, description}] from Brave."""
    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": BRAVE_API_KEY,
    }
    params = {
        "q": query,
        "count": BRAVE_FETCH_COUNT,
        "safesearch": "off",
    }
    try:
        resp = requests.get(BRAVE_SEARCH_URL, headers=headers, params=params, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        results = data.get("web", {}).get("results", [])
        return [r.get("url", "") for r in results if r.get("url")]
    except Exception as e:
        print(f"  Brave search error for '{query}': {e}")
        return []


def collect_urls_for_query(query_text: str) -> list[str]:
    """Search Brave and return up to URLS_PER_QUERY deduplicated URLs."""
    accepted = []
    seen: set[str] = set()
    for url in brave_search(query_text):
        if url in seen:
            continue
        if is_allowed(url):
            accepted.append(url)
            record_url(url)
            seen.add(url)
            if len(accepted) >= URLS_PER_QUERY:
                break
    return accepted
