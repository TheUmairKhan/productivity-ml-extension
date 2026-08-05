"""
Generate end-to-end item-tower fixtures: HTML in, z_raw out.

    python models/gen_embedding_fixtures.py

The other parity checks each cover one link in the chain -- the extractor against
html.parser, the ONNX graph against PyTorch. This one covers the whole chain at
once, which is the only way to catch a mismatch in how the two sides wire the
links together (index dtypes, padding, truncation, tensor layout).

Uses small synthetic documents so the fixture stays committable: 384 floats per
case is a few KB, whereas real corpus pages are 230 KB of HTML each.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config
from loader import encode_html, html_to_indices, load_encoder

OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "embedding-cases.json"

CASES: dict[str, str] = {
    "article": (
        "<html><head><title>Understanding React Hooks</title>"
        '<meta name="description" content="A deep dive into useEffect and cleanup functions">'
        "</head><body><h1>React Hooks</h1>"
        "<p>The useEffect hook runs after render and can return a cleanup function.</p>"
        "<p>Dependencies control when the effect re-runs.</p></body></html>"
    ),
    "entertainment": (
        "<html><head><title>Top 10 Funniest Cat Memes of 2024</title></head>"
        "<body><h1>Cat Memes</h1><p>You will not believe number seven!</p>"
        "<span>Share this on social media</span></body></html>"
    ),
    "with_script_and_style": (
        "<html><head><title>Page</title><style>p{color:red}</style>"
        "<script>var x = '<p>hidden text</p>';</script></head>"
        "<body><p>visible text only</p></body></html>"
    ),
    "entities": (
        "<html><head><title>Tom &amp; Jerry &mdash; caf&eacute;</title></head>"
        "<body><p>Fish &amp; chips cost &pound;5</p></body></html>"
    ),
    "empty_body": "<html><head><title>Nothing here</title></head><body></body></html>",
    "no_extractable_text": "<html><body><div>div text is not extracted</div></body></html>",
    "truncation": (
        "<html><body><p>" + " ".join(f"token{i}" for i in range(config.M + 100))
        + "</p></body></html>"
    ),
}


def main() -> None:
    model, token2idx, _ = load_encoder()

    cases = []
    for name, html in CASES.items():
        word_idx, tag_idx = html_to_indices(html, token2idx)
        z_raw = encode_html(model, token2idx, [html])[0]
        cases.append(
            {
                "name": name,
                "html": html,
                "n_tokens": int((word_idx != 0).sum()),
                # Only the populated prefix, so the fixture is not 512 zeros.
                "word_idx_head": word_idx[:24].tolist(),
                "tag_idx_head": tag_idx[:24].tolist(),
                "z_raw": [round(float(v), 6) for v in z_raw],
            }
        )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"max_tokens": config.M, "dim": len(cases[0]["z_raw"]), "cases": cases}, f)

    size_kb = OUT.stat().st_size / 1e3
    print(f"Wrote {len(cases)} cases ({size_kb:.0f} KB) to {OUT}")


if __name__ == "__main__":
    main()
