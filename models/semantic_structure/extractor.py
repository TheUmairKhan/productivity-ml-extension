"""
Feature extraction pipeline for the semantic & structure model.

Produces the formal representation R = {(t, e, p) | t ∈ T, e ∈ E, p ∈ P} where:
  t = token string
  e = word embedding vector (GloVe, dim K)
  p = structural embedding vector (which HTML tag, dim N, Gaussian initialized)

All token vectors are stacked into the feature matrix:
  Ω' ∈ R^{m × (k+n)}   where m = M (truncated/padded), k = K, n = N
"""

import os
import re
from html.parser import HTMLParser
from typing import Dict, List, Tuple

import numpy as np
from tqdm import tqdm

from config import TAG_TO_IDX, NUM_TAGS

_PUNCT_RE = re.compile(r"[^a-z0-9'\-]")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_VOID_ELEMENTS = {
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
}
_EXCLUDE_TAGS = {"script", "style", "noscript"}
_INNERTEXT_TAGS = {"title", "h1", "h2", "h3", "h4", "h5", "strong", "em", "span", "p", "table"}
_META_NAMES = {"description", "keywords", "og:title", "og:description", "twitter:description"}


# ---------------------------------------------------------------------------
# Stage 1: HTML parsing
# ---------------------------------------------------------------------------

def _tokenize(text: str) -> List[str]:
    """Lowercase, keep alphanumeric + hyphens/apostrophes, split on whitespace."""
    return _PUNCT_RE.sub(" ", text.lower()).split()


class _StructuredParser(HTMLParser):
    """Parses HTML and yields (token, tag_name) pairs for structural tags."""

    def __init__(self, max_tokens: int):
        super().__init__()
        self._stack: List[str] = []
        self._exclude_depth: int = 0
        self._max_tokens = max_tokens
        self.pairs: List[Tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs):
        tag = tag.lower()

        if tag == "meta":
            attrs_dict = dict(attrs)
            name = (attrs_dict.get("name") or attrs_dict.get("property") or "").lower()
            if name in _META_NAMES:
                content = attrs_dict.get("content") or ""
                for tok in _tokenize(content):
                    if len(self.pairs) >= self._max_tokens:
                        return
                    self.pairs.append((tok, "meta_desc"))
            return  # void element — never push stack

        if tag in _VOID_ELEMENTS:
            return

        if tag in _EXCLUDE_TAGS:
            self._exclude_depth += 1

        self._stack.append(tag)

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in _VOID_ELEMENTS:
            return
        if tag in _EXCLUDE_TAGS:
            self._exclude_depth = max(0, self._exclude_depth - 1)

        for i in range(len(self._stack) - 1, -1, -1):
            if self._stack[i] == tag:
                self._stack.pop(i)
                break

    def handle_data(self, data: str):
        if len(self.pairs) >= self._max_tokens:
            return
        if self._exclude_depth > 0 or not self._stack:
            return
        top = self._stack[-1]
        if top not in _INNERTEXT_TAGS:
            return
        for tok in _tokenize(data):
            self.pairs.append((tok, top))
            if len(self.pairs) >= self._max_tokens:
                return


def _parse_html(html_path: str, max_tokens: int) -> List[Tuple[str, str]]:
    """
    Parse an HTML file into ordered (token, tag_name) pairs.
    """
    try:
        with open(html_path, encoding="utf-8", errors="replace") as f:
            content = f.read()
        parser = _StructuredParser(max_tokens)
        parser.feed(content)
        return parser.pairs
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Stage 2: Vocabulary + embeddings
# ---------------------------------------------------------------------------

def build_corpus_vocab(
    records: List[Tuple[str, str, str]],
    glove_path: str,
    n: int,
    m: int,
) -> Tuple[Dict[str, int], np.ndarray, np.ndarray]:
    """
    Build vocabulary and embedding matrices from the full labeled corpus.

    Args:
        records:    List of (url, html_path, label) from db.load_records()
        glove_path: Path to GloVe embeddings file
        n:          Structural embedding dimension
        m:          Max tokens per page (truncation limit)

    Returns:
        token2idx:     Dict mapping token string → integer index
                       Index 0 = <PAD> (zero vector)
                       Index 1 = <UNK> (mean of known GloVe vectors in corpus)
        word_matrix:   ndarray [vocab_size, k] — GloVe word embeddings;
        struct_matrix: ndarray [NUM_TAGS+1, n] — structural embeddings,
    """
    glove_path = os.path.expanduser(glove_path)
    if not os.path.exists(glove_path):
        raise FileNotFoundError(
            f"GloVe file not found at {glove_path}. "
            "Run python3 download_glove.py first."
        )

    # Parse all pages to collect corpus tokens
    print("Parsing HTML corpus ...")
    corpus_tokens: set = set()
    for _, html_path, _ in tqdm(records, unit="page"):
        pairs = _parse_html(html_path, m)
        corpus_tokens.update(tok for tok, _ in pairs)

    # Single-pass GloVe load: infer k from first line, then continue reading
    print(f"Loading GloVe from {glove_path} ...")
    glove_vecs: Dict[str, np.ndarray] = {}
    with open(glove_path, encoding="utf-8") as f:
        first_parts = f.readline().rstrip().split(" ")
        k = len(first_parts) - 1
        if first_parts[0] in corpus_tokens:
            glove_vecs[first_parts[0]] = np.array(first_parts[1:], dtype=np.float32)
        for line in tqdm(f, unit=" lines", miniters=10000):
            parts = line.rstrip().split(" ")
            word = parts[0]
            if word in corpus_tokens:
                glove_vecs[word] = np.array(parts[1:], dtype=np.float32)
    print(f"GloVe dimension: {k}")

    # Build token → index mapping: 0=PAD, 1=UNK, 2..N=corpus tokens
    token2idx: Dict[str, int] = {"<PAD>": 0, "<UNK>": 1}
    for i, tok in enumerate(sorted(corpus_tokens), start=2):
        token2idx[tok] = i

    vocab_size = len(token2idx)
    word_matrix = np.zeros((vocab_size, k), dtype=np.float32)

    known_vecs: List[np.ndarray] = []
    for tok, idx in token2idx.items():
        if tok in glove_vecs:
            word_matrix[idx] = glove_vecs[tok]
            known_vecs.append(glove_vecs[tok])

    if known_vecs:
        word_matrix[1] = np.mean(known_vecs, axis=0)

    struct_matrix = np.random.normal(
        loc=0.0,
        scale=1.0 / (n ** 0.5),
        size=(NUM_TAGS + 1, n),
    ).astype(np.float32)
    struct_matrix[0] = 0.0  # PAD row is always zero

    coverage = len(known_vecs) / max(len(corpus_tokens), 1) * 100
    print(
        f"Vocab: {vocab_size} tokens | "
        f"GloVe coverage: {len(known_vecs)}/{len(corpus_tokens)} ({coverage:.1f}%)"
    )

    return token2idx, word_matrix, struct_matrix


# ---------------------------------------------------------------------------
# Stage 3: Feature matrix construction (per page)
# ---------------------------------------------------------------------------

def extract_page(
    html_path: str,
    token2idx: Dict[str, int],
    word_matrix: np.ndarray,
    struct_matrix: np.ndarray,
    m: int,
) -> Tuple[List[Tuple[str, np.ndarray, np.ndarray]], np.ndarray, np.ndarray]:
    """
    Extract the feature representation for a single page.

    Args:
        html_path:     Path to stored page.html
        token2idx:     Token → index mapping from build_corpus_vocab()
        word_matrix:   ndarray [V, K] from build_corpus_vocab()
        struct_matrix: ndarray [NUM_TAGS+1, N] from build_corpus_vocab()
        m:             Max tokens (truncation limit, config.M)

    Returns:
        R:      List of (token_str, word_vec [K], struct_vec [N]) tuples
                The formal R = {(t, e, p)} representation
        omega:  ndarray [M, K+N] — the Ω' feature matrix
                Rows: Ω_i = [E_i ; S_j], zero-padded to M rows
        mask:   ndarray [M] bool — True for real tokens, False for padding
    """
    pairs = _parse_html(html_path, m)
    L = len(pairs)

    k = word_matrix.shape[1]
    n = struct_matrix.shape[1]

    omega = np.zeros((m, k + n), dtype=np.float32)
    mask = np.zeros(m, dtype=bool)

    if L > 0:
        tok_indices = np.fromiter(
            (token2idx.get(tok, 1) for tok, _ in pairs), dtype=np.intp, count=L
        )
        tag_indices = np.fromiter(
            (TAG_TO_IDX.get(tag, 0) for _, tag in pairs), dtype=np.intp, count=L
        )
        omega[:L, :k] = word_matrix[tok_indices]
        omega[:L, k:] = struct_matrix[tag_indices]
        mask[:L] = True

    R = [
        (tok, word_matrix[token2idx.get(tok, 1)], struct_matrix[TAG_TO_IDX.get(tag, 0)])
        for tok, tag in pairs
    ]

    return R, omega, mask
