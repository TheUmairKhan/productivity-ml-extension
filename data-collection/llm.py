"""
Claude API client for generating topics and search queries.
"""

import json
import re

import anthropic

from config import (
    ANTHROPIC_API_KEY,
    CLAUDE_MAX_TOKENS,
    CLAUDE_MODEL,
    NUM_TOPICS,
    QUERIES_PER_LABEL_PER_TOPIC,
)

_QUERY_EXAMPLES = {
    "productive": [
        # computer graphics
        "real time rendering lighting techniques shadows reflections optimization",
        # cooking
        "how to cook chicken breast juicy methods",
        # coding
        "python asyncio event loop blocking calls debug",
        # finance
        "index fund vs ETF expense ratio long term returns comparison",
        # data science
        "pandas groupby aggregate multiple columns tutorial",
    ],
    "waste": [
        # gaming
        "funniest minecraft fails compilation 2024",
        # memes
        "most cursed reddit memes this week",
        # social media
        "celebrity drama twitter beef latest",
        # youtube
        "satisfying oddly videos compilation",
        # cooking (procrastination angle)
        "gordon ramsay roasting bad cooks funniest moments",
    ],
}

_client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def _claude(prompt: str) -> str:
    message = _client.messages.create(
        model=CLAUDE_MODEL,
        max_tokens=CLAUDE_MAX_TOKENS,
        messages=[{"role": "user", "content": prompt}],
    )
    block = message.content[0]
    return block.text


def generate_topics() -> list[str]:
    prompt = f"""Generate exactly {NUM_TOPICS} diverse topic categories for a browser activity dataset.
The dataset needs both 'productive' and 'waste' browsing examples across all topics.

Topics should span a wide range such as: coding, computer graphics, gaming, memes, Reddit communities,
YouTube entertainment, online shopping, academic research, news media, social media, productivity tools,
cybersecurity, personal finance, cooking/recipes, sports, music, job searching, cloud infrastructure,
data science, and similar categories.

Each topic must be unique — do not repeat or rephrase the same topic twice.

Return ONLY a JSON array of {NUM_TOPICS} unique topic name strings, no explanation.
Example format: ["coding", "gaming", ...]"""

    raw = _claude(prompt)
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        raise ValueError(f"Could not parse topics from response:\n{raw}")
    topics = json.loads(match.group())

    # Deduplicate while preserving order (case-insensitive)
    seen: set[str] = set()
    unique_topics = []
    for t in topics:
        key = t.strip().lower()
        if key not in seen:
            seen.add(key)
            unique_topics.append(t)

    if len(unique_topics) != NUM_TOPICS:
        raise ValueError(f"Expected {NUM_TOPICS} unique topics, got {len(unique_topics)}")
    return unique_topics


def generate_queries(topic: str) -> list[dict]:
    n = QUERIES_PER_LABEL_PER_TOPIC

    productive_examples = "\n".join(f'  - "{q}"' for q in _QUERY_EXAMPLES["productive"])
    waste_examples = "\n".join(f'  - "{q}"' for q in _QUERY_EXAMPLES["waste"])

    prompt = f"""Generate exactly {n} 'productive' and {n} 'waste' search queries for the topic: "{topic}"

IMPORTANT: The productive/waste distinction is about the *intent and nature of the browsing activity*,
NOT the topic itself. Any topic can yield both productive and waste queries:
  - "gaming" can be productive: e.g. reinforcement learning research using Pokemon environments
  - "coding" can be waste: e.g. browsing programming memes or watching fail compilations
  - "cooking" can be productive: e.g. learning specific culinary techniques
  - "cooking" can be waste: e.g. watching Gordon Ramsay roast people for entertainment

Productive queries: the person has a clear goal — learning, building, researching, solving a problem.
Waste queries: the person is passively consuming entertainment, procrastinating, or mindlessly browsing.

Make each query hyper-specific and realistic — what an actual person would type into a search engine.
Match the specificity and natural phrasing of these examples:

Productive examples:
{productive_examples}

Waste examples:
{waste_examples}

Return ONLY a JSON array of {n * 2} objects with this exact shape:
[{{"text": "<query>", "label": "productive"}}, {{"text": "<query>", "label": "waste"}}, ...]

No explanation, just the JSON array."""

    raw = _claude(prompt)
    match = re.search(r"\[.*\]", raw, re.DOTALL)
    if not match:
        raise ValueError(f"Could not parse queries for topic '{topic}':\n{raw}")
    return json.loads(match.group())
