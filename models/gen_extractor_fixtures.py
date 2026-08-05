"""
Generate extractor parity fixtures from the Python reference implementation.

    python models/gen_extractor_fixtures.py

The cases are hand-written to hit every rule the TypeScript port has to
reproduce, but the *expectations* are whatever Python actually produces -- so a
fixture can never encode a mistaken belief about the reference behaviour. Real
corpus pages are too large to commit (230 KB median); those are covered by
models/check_extractor_parity.py, which diffs the full 912-page corpus on demand.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import config
from semantic_structure.extractor import _StructuredParser

OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "extractor-cases.json"

CASES: dict[str, str] = {
    "plain_text": "<html><body><p>Hello there world</p></body></html>",

    "innermost_tag_wins":
        "<p>outer text <strong>inner text</strong> after</p>",

    "non_innertext_parent_drops_text":
        "<div>dropped</div><p>kept</p><li>also dropped</li>",

    # html.parser never implicitly closes: two <p> stay open, so 'b' is still
    # attributed to <p>. A DOM parser would disagree, which is why this matters.
    "no_implicit_close": "<p>a<p>b",

    "unmatched_end_tag": "<p>a</span>b</p>c",

    # </em> removes the <em> entry but leaves <strong> above it on the stack.
    "interleaved_tags": "<p>a<strong>b<em>c</strong>d</em>e</p>",

    "void_element_not_pushed": "<p>before<br>after<img src=x>tail</p>",

    "self_closing": "<p>a<span/>b</p>",

    "script_is_cdata": "<p>keep<script>var x = '<p>hidden</p>';</script>tail</p>",

    "style_excluded": "<p>a<style>p { color: red }</style>b</p>",

    "noscript_excluded": "<p>a<noscript><p>hidden</p></noscript>b</p>",

    "meta_description":
        '<meta name="description" content="A page about widgets">',

    "meta_property_og":
        '<meta property="og:title" content="Widget Central">',

    "meta_ignored_name":
        '<meta name="viewport" content="width=device-width">',

    "meta_entities":
        '<meta name="description" content="Tom &amp; Jerry &mdash; cartoons">',

    "entities_named": "<p>Tom &amp; Jerry &lt;tag&gt; caf&eacute;</p>",

    "entities_numeric": "<p>&#72;&#101;llo &#x57;orld &#39;quoted&#39;</p>",

    # html.unescape falls back to the longest matching prefix: "&notit;" is
    # "not" + "it;", not a literal.
    "entities_prefix_fallback": "<p>&notit; &notin;</p>",

    "entities_unknown": "<p>&nosuchentity; &amp</p>",

    "title_and_headers":
        "<title>Page Title</title><h1>Main</h1><h2>Sub</h2><h6>Too deep</h6>",

    "table_text": "<table><p>cell text</p></table><table>direct</table>",

    "comment_splits_text": "<p>hel<!-- comment -->lo</p>",

    "doctype_and_pi": "<!DOCTYPE html><?xml version='1.0'?><p>after</p>",

    # A '>' inside a quoted attribute value must not end the tag.
    "attribute_with_gt": '<p title="a > b">text</p>',

    "attribute_single_quoted": "<p title='a > b'>text</p>",

    "attribute_unquoted": "<p title=ab>text</p>",

    "uppercase_tags": "<P>Upper</P><STRONG>Bold</STRONG>",

    "punctuation_and_case":
        "<p>Don't split hyphen-word, but drop periods. UPPER lower 123</p>",

    "empty": "",

    "no_tags": "bare text with no markup",

    "stray_lt": "<p>a < b</p>",
}


def main() -> None:
    fixtures = []
    for name, html in CASES.items():
        parser = _StructuredParser(max_tokens=config.M)
        parser.feed(html)
        fixtures.append(
            {"name": name, "html": html, "pairs": [list(p) for p in parser.pairs]}
        )

    # Truncation, checked separately so max_tokens stays out of the case table.
    long_html = "<p>" + " ".join(f"word{i}" for i in range(config.M + 50)) + "</p>"
    parser = _StructuredParser(max_tokens=config.M)
    parser.feed(long_html)
    assert len(parser.pairs) == config.M, "truncation fixture did not truncate"
    fixtures.append(
        {"name": "truncation", "html": long_html,
         "pairs": [list(p) for p in parser.pairs]}
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"max_tokens": config.M, "cases": fixtures}, f, indent=1)

    total = sum(len(c["pairs"]) for c in fixtures)
    print(f"Wrote {len(fixtures)} cases ({total} pairs) to {OUT}")


if __name__ == "__main__":
    main()
