"""
Dump Python's extraction of the whole local corpus, for the TS port to diff against.

    python models/dump_corpus_pairs.py
    npx vitest run tests/extractor-corpus.test.ts

The committed fixtures in tests/fixtures/extractor-cases.json cover the rules
one at a time; this covers what real pages actually contain -- malformed markup,
unusual entities, deeply nested structure. Output is gitignored because it points
at a local capture store (230 KB median per page) that only exists on the machine
that collected it.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config
from semantic_structure.db import load_records
from semantic_structure.extractor import _StructuredParser

OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "corpus-pairs.jsonl"


def main() -> None:
    records = load_records(config.DB_PATH)
    OUT.parent.mkdir(parents=True, exist_ok=True)

    with open(OUT, "w") as out:
        for url, html_path, label in records:
            with open(html_path, encoding="utf-8", errors="replace") as f:
                html = f.read()
            parser = _StructuredParser(max_tokens=config.M)
            parser.feed(html)
            out.write(
                json.dumps(
                    {
                        "url": url,
                        "html_path": html_path,
                        "label": label,
                        "pairs": [list(p) for p in parser.pairs],
                    }
                )
                + "\n"
            )

    print(f"Wrote {len(records)} pages to {OUT}")


if __name__ == "__main__":
    main()
