"""
Global deduplication state and URL filtering rules.

Rules (from config):
- UNLIMITED_DOMAINS (youtube.com, wikipedia.org): no cap
- reddit.com: unlimited URLs but max SUBREDDIT_CAP per subreddit
- everything else: max DOMAIN_CAP per domain across the whole dataset
"""

import re
from urllib.parse import urlparse

from config import DOMAIN_CAP, SUBREDDIT_CAP, UNLIMITED_DOMAINS

domain_counts: dict[str, int] = {}
subreddit_counts: dict[str, int] = {}


def extract_domain(url: str) -> str:
    try:
        host = urlparse(url).netloc.lower()
        return host.removeprefix("www.")
    except Exception:
        return ""


def extract_subreddit(url: str) -> str:
    """Return subreddit name from a reddit.com URL, or '' if not a subreddit page."""
    match = re.search(r"/r/([^/?#]+)", url, re.IGNORECASE)
    return match.group(1).lower() if match else ""


def is_allowed(url: str) -> bool:
    domain = extract_domain(url)
    if not domain:
        return False
    if domain in UNLIMITED_DOMAINS:
        return True
    if domain == "reddit.com":
        sub = extract_subreddit(url)
        if not sub:
            return True  # non-subreddit reddit page (profile, search, etc.)
        return subreddit_counts.get(sub, 0) < SUBREDDIT_CAP
    return domain_counts.get(domain, 0) < DOMAIN_CAP


def record_url(url: str) -> None:
    """Increment the appropriate counter after a URL is accepted."""
    domain = extract_domain(url)
    if domain in UNLIMITED_DOMAINS:
        return
    if domain == "reddit.com":
        sub = extract_subreddit(url)
        if sub:
            subreddit_counts[sub] = subreddit_counts.get(sub, 0) + 1
        return
    domain_counts[domain] = domain_counts.get(domain, 0) + 1
