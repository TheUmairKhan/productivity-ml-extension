"""
Generate the data the client extractor needs, straight from Python's own tables.

    python models/export_client_assets.py

The TypeScript extractor has to reproduce html.parser.HTMLParser token for token.
The part most likely to drift silently is character-reference decoding: an
undecoded "&amp;" does not merely render wrong, it becomes the *token* "amp",
which then gets a word embedding and shifts the page vector. Rather than
hand-maintaining an entity table, emit Python's html.entities verbatim so both
sides are decoding against identical data.

Writes into assets/ (served from the extension package):
    entities.json         html5 named refs + the two invalid-codepoint tables
    extractor-config.json M, TAG_TO_IDX, and the tag sets
    token2idx.json        copied from the checkpoint
    jfcnn.onnx            copied from the checkpoint
"""

from __future__ import annotations

import json
import shutil
import sys
from html.entities import html5
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from html.parser import HTMLParser  # noqa: F401  (documents the reference impl)

import config
from loader import CHECKPOINT_DIR
from semantic_structure.extractor import (
    _EXCLUDE_TAGS,
    _INNERTEXT_TAGS,
    _META_NAMES,
    _VOID_ELEMENTS,
)

ASSETS = Path(__file__).parent.parent / "assets"


def main() -> None:
    ASSETS.mkdir(exist_ok=True)

    # html.unescape consults these two private tables before falling back to
    # chr(); mirroring them is what keeps numeric refs in agreement.
    from html import _invalid_charrefs, _invalid_codepoints  # type: ignore[attr-defined]

    with open(ASSETS / "entities.json", "w") as f:
        json.dump(
            {
                "html5": html5,
                "invalid_charrefs": {str(k): v for k, v in _invalid_charrefs.items()},
                "invalid_codepoints": sorted(_invalid_codepoints),
            },
            f,
        )

    with open(ASSETS / "extractor-config.json", "w") as f:
        json.dump(
            {
                "max_tokens": config.M,
                "tag_to_idx": config.TAG_TO_IDX,
                "innertext_tags": sorted(_INNERTEXT_TAGS),
                "exclude_tags": sorted(_EXCLUDE_TAGS),
                "void_elements": sorted(_VOID_ELEMENTS),
                "meta_names": sorted(_META_NAMES),
                # html.parser switches to CDATA mode inside these, so markup in a
                # JS string never reaches the tag stack. noscript is deliberately
                # absent: Python parses its contents as markup and relies on the
                # exclude-depth counter instead.
                "cdata_elements": ["script", "style"],
            },
            f,
            indent=2,
        )

    for name in ("token2idx.json", "jfcnn.onnx"):
        src = CHECKPOINT_DIR / name
        if not src.exists():
            raise SystemExit(f"missing {src} -- run models/export_onnx.py first")
        shutil.copy2(src, ASSETS / name)

    for path in sorted(ASSETS.iterdir()):
        print(f"  {path.name:24s} {path.stat().st_size / 1e6:8.2f} MB")


if __name__ == "__main__":
    main()
