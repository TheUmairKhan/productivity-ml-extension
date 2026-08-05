"""
The two-tower math, in one place.

This module is the reference implementation for three consumers that must agree
exactly or the calibration is meaningless:

  - models/fit_globals.py   fits sigma / z_global / a / b / kappa / threshold
  - backend/users.py        builds each user's class centroids
  - src/services/*.ts       runs the whole thing on-device

It lives under backend/ rather than models/ because the dependency already runs
that way: models/embed_pages.py and models/fit_globals.py import backend.db and
backend.models, so pointing the arrow back would make the two packages circular.

Sign convention: positive = "waste" = block, negative = "productive" = allow.
So sigmoid(a*s + b) is directly P(block).
"""

from __future__ import annotations

import numpy as np

# Floor for sigma. The max-over-time pool leaves some dimensions dead (always
# zero) on a small corpus; without a floor those become division by zero.
SIGMA_FLOOR = 1e-6

POSITIVE_LABEL = "waste"
NEGATIVE_LABEL = "productive"


def fit_sigma(z_raw: np.ndarray) -> np.ndarray:
    """Per-dimension std over the pooled corpus, floored. z_raw is [N, d]."""
    return np.maximum(z_raw.std(axis=0), SIGMA_FLOOR).astype(np.float32)


def preprocess(z_raw: np.ndarray, sigma: np.ndarray) -> np.ndarray:
    """
    Divide by sigma, then L2 normalize. Accepts [d] or [N, d].

    Rescaling puts every dimension on comparable footing before the dot product;
    normalizing puts every page on the unit sphere so no single page can dominate
    a centroid by sheer norm. The normalize step is why callers must preprocess
    each page *before* averaging -- it does not commute with the mean.
    """
    z = np.asarray(z_raw, dtype=np.float32) / sigma
    norm = np.linalg.norm(z, axis=-1, keepdims=True)
    return (z / np.maximum(norm, 1e-12)).astype(np.float32)


def user_vector(
    s_pos: np.ndarray,
    n_pos: int,
    s_neg: np.ndarray,
    n_neg: int,
    z_global: np.ndarray,
    kappa: float,
) -> np.ndarray:
    """
    The user tower: a difference of class means, shrunk toward the global prior.

    The four accumulators are running sums and counts of *preprocessed* item
    embeddings, so this is O(1) per new label -- no retraining anywhere.

    Weighting uses the harmonic effective count, which is the right sample size
    for a difference of two means and is zero whenever either class is empty.
    That makes both degenerate cases fall out without special-casing: a user with
    no labels, and a user who has only ever labeled one way, both get exactly
    z_global -- the global classifier.
    """
    if n_pos <= 0 or n_neg <= 0:
        return np.asarray(z_global, dtype=np.float32).copy()

    n_eff = 2.0 * n_pos * n_neg / (n_pos + n_neg)
    w = n_eff / (n_eff + kappa)
    delta = s_pos / n_pos - s_neg / n_neg
    return (w * delta + (1.0 - w) * z_global).astype(np.float32)


def score(z_u: np.ndarray, z_i: np.ndarray, a: float, b: float) -> np.ndarray:
    """Dot the towers, then calibrate. Returns P(block). z_i may be [d] or [N, d]."""
    s = np.asarray(z_i, dtype=np.float32) @ np.asarray(z_u, dtype=np.float32)
    return 1.0 / (1.0 + np.exp(-(a * s + b)))
