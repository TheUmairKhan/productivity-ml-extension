"""
compare_extractors.py — diff Python vs Rust HTML parser/extractor output.

Run from models/:
    python compare_extractors.py

Reports:
  1. First N differing (token, tag) pairs per page
  2. Aggregate mismatch stats across the corpus
  3. Character-level breakdown of where tokenization diverges
"""

import sys
sys.path.insert(0, '.')

import config
import rust_extractor
from semantic_structure.db import load_records
from semantic_structure.extractor import _parse_html, _tokenize

SHOW_DIFFS = 10   # max differing pairs to show per page
MAX_PAGES  = None # set to e.g. 3 to limit


# ── helpers ────────────────────────────────────────────────────────────────

def char_diff(py_tok: str, rs_tok: str) -> str:
    """Show which characters differ between two tokens."""
    py_ord = [f"U+{ord(c):04X}({c!r})" for c in py_tok]
    rs_ord = [f"U+{ord(c):04X}({c!r})" for c in rs_tok]
    return f"  py chars: {py_ord}\n  rs chars: {rs_ord}"


def compare_pairs(py_pairs, rs_pairs, html_path: str, page_label: str) -> int:
    """Print diffs between two (token,tag) lists. Returns number of mismatches."""
    n_py, n_rs = len(py_pairs), len(rs_pairs)

    if n_py != n_rs:
        print(f"  COUNT MISMATCH: py={n_py}  rs={n_rs}")

    mismatches = 0
    shown = 0
    for i, ((tp, tg_p), (tr, tg_r)) in enumerate(zip(py_pairs, rs_pairs)):
        tok_match = (tp == tr)
        tag_match = (tg_p == tg_r)
        if not tok_match or not tag_match:
            mismatches += 1
            if shown < SHOW_DIFFS:
                shown += 1
                print(f"  [{i:4d}]  py=({tp!r:30s}, {tg_p})  rs=({tr!r:30s}, {tg_r})")
                if not tok_match:
                    print(char_diff(tp, tr))
    if mismatches > SHOW_DIFFS:
        print(f"  ... and {mismatches - SHOW_DIFFS} more mismatches (suppressed)")
    return mismatches


def find_entity_tokens(py_pairs, rs_pairs):
    """Return pairs where the tokens differ and the py token contains non-ASCII."""
    results = []
    for (tp, _), (tr, _) in zip(py_pairs, rs_pairs):
        if tp != tr and any(ord(c) > 127 for c in tp + tr):
            results.append((tp, tr))
    return results


# ── main ───────────────────────────────────────────────────────────────────

def main():
    records = load_records(config.DB_PATH)
    if MAX_PAGES:
        records = records[:MAX_PAGES]

    total_mismatches = 0
    total_tokens     = 0
    entity_examples  = []

    print(f"Comparing Python vs Rust parse_html across {len(records)} pages")
    print(f"M = {config.M}\n")
    print("=" * 80)

    for url, html_path, label in records:
        py_pairs = _parse_html(html_path, config.M)
        rs_pairs = rust_extractor.parse_html_py(html_path, config.M)

        # Token-level comparison
        mismatches = compare_pairs(py_pairs, rs_pairs, html_path, label)
        total_mismatches += mismatches
        total_tokens     += len(py_pairs)

        # Collect entity examples
        entity_examples.extend(find_entity_tokens(py_pairs, rs_pairs))

        status = "OK" if mismatches == 0 else f"MISMATCH ({mismatches})"
        print(f"[{label:10s}] {url}  →  {status}")

    print()
    print("=" * 80)
    print(f"Total tokens compared : {total_tokens}")
    print(f"Total token mismatches: {total_mismatches}  ({100*total_mismatches/max(total_tokens,1):.2f}%)")

    if entity_examples:
        print()
        print("── Non-ASCII token diff examples ──")
        seen = set()
        for py_tok, rs_tok in entity_examples[:20]:
            key = (py_tok, rs_tok)
            if key not in seen:
                seen.add(key)
                print(f"  py={py_tok!r}  rs={rs_tok!r}")
                print(char_diff(py_tok, rs_tok))

    # ── Deep-dive: show raw HTML context for first mismatch ──────────────────
    print()
    print("── Raw text context for first mismatch ──")
    for url, html_path, label in records:
        py_pairs = _parse_html(html_path, config.M)
        rs_pairs = rust_extractor.parse_html_py(html_path, config.M)
        for i, ((tp, tg_p), (tr, tg_r)) in enumerate(zip(py_pairs, rs_pairs)):
            if tp != tr:
                # Find the raw HTML snippet around where this text appears
                with open(html_path, encoding='utf-8', errors='replace') as f:
                    content = f.read()
                # Search for the python token in the raw HTML
                lower_content = content.lower()
                idx = lower_content.find(tp)
                if idx >= 0:
                    snippet = content[max(0, idx-80):idx+80]
                    print(f"  page : {url}")
                    print(f"  pair : {i}  py={tp!r}  rs={tr!r}")
                    print(f"  html snippet (±80 chars):")
                    print(f"    {snippet!r}")
                print()
                break  # one example per page is enough
        else:
            continue
        break  # stop after first page with mismatch


if __name__ == "__main__":
    main()
