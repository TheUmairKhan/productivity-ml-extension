import os

ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
BRAVE_API_KEY: str = os.environ["BRAVE_API_KEY"]
CLAUDE_MODEL = "claude-sonnet-4-6"
CLAUDE_MAX_TOKENS = 4096

NUM_TOPICS = 20
QUERIES_PER_LABEL_PER_TOPIC = 5   # productive + waste each → 200 queries total
URLS_PER_QUERY = 5                 # target URLs per query → ~1000 URLs total


BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search"
BRAVE_FETCH_COUNT = 10             # fetch extra to survive dedup filtering
BRAVE_REQUEST_DELAY = 0.5          # seconds between API calls

DOMAIN_CAP = 2          # max URLs per domain across the whole dataset
SUBREDDIT_CAP = 2       # max URLs per subreddit (reddit.com only)
UNLIMITED_DOMAINS: frozenset[str] = frozenset({
    "youtube.com",
    "wikipedia.org",
})

OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "urls_dataset.json")