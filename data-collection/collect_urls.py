"""
URL dataset collector for productive/waste classifier training.

Requires env vars:
  ANTHROPIC_API_KEY
  BRAVE_SEARCH_API_KEY

Usage:
  python collect_urls.py
"""

import time

from config import BRAVE_REQUEST_DELAY, NUM_TOPICS, OUTPUT_FILE
from llm import generate_queries, generate_topics
from search import collect_urls_for_query
from storage import save


def main() -> None:
    topic_names = generate_topics()
    print(f"Topics: {topic_names}\n")

    topics: list[dict] = []

    for i, topic_name in enumerate(topic_names, 1):
        print(f"[{i}/{NUM_TOPICS}] Topic: {topic_name}")
        raw_queries = generate_queries(topic_name)
        topic_entry: dict = {"name": topic_name, "queries": []}

        for q in raw_queries:
            query_text = q.get("text", "").strip()
            label = q.get("label", "productive")

            print(f"  [{label}] {query_text}")
            urls = collect_urls_for_query(query_text)
            print(f"    -> {len(urls)} URLs collected")

            topic_entry["queries"].append({
                "text": query_text,
                "label": label,
                "urls": urls,
            })

            time.sleep(BRAVE_REQUEST_DELAY)

        topics.append(topic_entry)

        metadata = save(topics)
        print(f"  Saved. Running total: {metadata['total_urls']} URLs\n")

    metadata = save(topics)
    print("Done!")
    print(f"  Total URLs   : {metadata['total_urls']}")
    print(f"  Total queries: {metadata['total_queries']}")
    print(f"  Productive   : {metadata['productive_queries']}")
    print(f"  Waste        : {metadata['waste_queries']}")
    print(f"  Output       : {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
