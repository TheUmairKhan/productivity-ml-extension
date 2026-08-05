"""
Fit the global parameters the devices need: sigma, z_global, a, b, kappa, threshold.

    python models/fit_globals.py                  # bootstrap from the local corpus
    python models/fit_globals.py --source neon    # once real users have donated
    python models/fit_globals.py --write          # persist to global_params

Two sources, because Neon currently holds 3 pages and you cannot estimate a
384-dimensional sigma from that. The bootstrap source is the 912-page SQLite
corpus the CNN was trained on, with the 20 topics in data-collection/
urls_dataset.json standing in for users.

A topic is a sound proxy for a user *here specifically* because the user tower is
a difference of class means. Whatever a topic contributes to both the waste and
productive centroids cancels in the subtraction, so z_u ends up encoding the
waste-vs-productive direction within that topic -- which is exactly the quantity
personalization is supposed to capture. It is still a proxy: kappa should be
refit against real users once there are enough of them.

Evaluation is grouped by user and honest about leakage in both directions:
  - z_u for a page always excludes that page from the user's accumulators
  - sigma and z_global are refit on the training users of each fold
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score, log_loss
from sklearn.model_selection import GroupKFold

import config
from loader import encode_html, encoder_version, load_encoder
from backend.preprocessing import (
    NEGATIVE_LABEL,
    POSITIVE_LABEL,
    fit_sigma,
    preprocess,
    user_vector,
)
from semantic_structure.db import load_records

KAPPA_GRID = [0.5, 1.0, 2.0, 4.0, 8.0, 16.0, 32.0]
TARGET_BLOCK_PRECISION = 0.85
N_FOLDS = 5
DATASET_JSON = Path(__file__).parent.parent / "data-collection" / "urls_dataset.json"


# --------------------------------------------------------------------------
# Corpus loading
# --------------------------------------------------------------------------

def _topic_by_url() -> dict[str, str]:
    """URL -> topic name, from the data-collection manifest."""
    with open(DATASET_JSON) as f:
        dataset = json.load(f)
    mapping = {}
    for topic in dataset["topics"]:
        for query in topic["queries"]:
            for url in query["urls"]:
                mapping[url] = topic["name"]
    return mapping


def load_sqlite_corpus() -> tuple[list[str], np.ndarray, np.ndarray]:
    """
    Returns (htmls, labels, groups) for the local training corpus.

    Pages whose URL is not in the manifest get their own singleton group, so they
    contribute to sigma and z_global but never to the personalization estimate.
    """
    import sqlite3, os

    records = load_records(config.DB_PATH)
    conn = sqlite3.connect(os.path.expanduser(config.DB_PATH))
    raw_by_url = dict(conn.execute("SELECT url, raw_url FROM pages").fetchall())
    conn.close()

    topics = _topic_by_url()
    htmls, labels, groups = [], [], []
    unmatched = 0

    for url, html_path, label in records:
        if label not in (POSITIVE_LABEL, NEGATIVE_LABEL):
            continue  # 'skip' rows, as PageDataset does
        topic = topics.get(raw_by_url.get(url, ""))
        if topic is None:
            unmatched += 1
            topic = f"__unmatched_{len(groups)}"
        with open(html_path, encoding="utf-8", errors="replace") as f:
            htmls.append(f.read())
        labels.append(label)
        groups.append(topic)

    print(f"  {len(htmls)} pages, {len(set(groups)) - unmatched} topics"
          f"{f', {unmatched} unmatched' if unmatched else ''}")
    return htmls, np.array(labels), np.array(groups)


async def _load_neon_corpus():
    """Real users, real donated pages. Uses stored z_raw -- no re-encoding."""
    from sqlalchemy import select
    from backend.db import async_session_maker
    from backend.models import Page, PageLabel

    async with async_session_maker() as session:
        rows = (
            await session.execute(
                select(PageLabel.user_id, PageLabel.label, Page.embedding)
                .join(Page, PageLabel.page_id == Page.id)
                .where(Page.embedding.is_not(None))
            )
        ).all()

    rows = [r for r in rows if r.label in (POSITIVE_LABEL, NEGATIVE_LABEL)]
    z_raw = np.array([r.embedding for r in rows], dtype=np.float32)
    labels = np.array([r.label for r in rows])
    groups = np.array([str(r.user_id) for r in rows])
    print(f"  {len(rows)} labeled pages across {len(set(groups))} users")
    return z_raw, labels, groups


# --------------------------------------------------------------------------
# Scoring
# --------------------------------------------------------------------------

def loo_scores(
    Z: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    z_global: np.ndarray,
    kappa: float,
) -> np.ndarray:
    """
    s = z_u . z_i for every labeled pair, with i held out of u's accumulators.

    The leave-one-out is what stops a page from voting for its own label through
    the user vector. It is cheap because the accumulators are sums: subtract z_i
    and decrement the count.
    """
    s = np.zeros(len(Z), dtype=np.float32)

    for user in np.unique(groups):
        idx = np.flatnonzero(groups == user)
        pos_mask = y[idx] == 1
        s_pos_all = Z[idx][pos_mask].sum(axis=0)
        s_neg_all = Z[idx][~pos_mask].sum(axis=0)
        n_pos_all, n_neg_all = int(pos_mask.sum()), int((~pos_mask).sum())

        for j, i in enumerate(idx):
            if pos_mask[j]:
                s_pos, n_pos = s_pos_all - Z[i], n_pos_all - 1
                s_neg, n_neg = s_neg_all, n_neg_all
            else:
                s_pos, n_pos = s_pos_all, n_pos_all
                s_neg, n_neg = s_neg_all - Z[i], n_neg_all - 1
            z_u = user_vector(s_pos, n_pos, s_neg, n_neg, z_global, kappa)
            s[i] = float(z_u @ Z[i])

    return s


def evaluate(
    z_raw: np.ndarray,
    y: np.ndarray,
    groups: np.ndarray,
    kappa: float | None,
) -> tuple[float, float, np.ndarray]:
    """
    Grouped cross-validation. kappa=None forces w=0, i.e. the cold-start path
    where every user falls back to z_global.

    sigma and z_global are refit per fold on the training users only, so the
    held-out numbers do not quietly include the test pages in their own prior.
    """
    n_splits = min(N_FOLDS, len(np.unique(groups)))
    oof = np.full(len(y), np.nan, dtype=np.float64)
    aucs, losses = [], []

    for train_idx, test_idx in GroupKFold(n_splits=n_splits).split(z_raw, y, groups):
        sigma = fit_sigma(z_raw[train_idx])
        Z = preprocess(z_raw, sigma)

        tr_pos = Z[train_idx][y[train_idx] == 1].mean(axis=0)
        tr_neg = Z[train_idx][y[train_idx] == 0].mean(axis=0)
        z_global = (tr_pos - tr_neg).astype(np.float32)

        if kappa is None:
            s = Z @ z_global
        else:
            s = loo_scores(Z, y, groups, z_global, kappa)

        lr = LogisticRegression().fit(s[train_idx].reshape(-1, 1), y[train_idx])
        p = lr.predict_proba(s[test_idx].reshape(-1, 1))[:, 1]
        oof[test_idx] = p

        if len(np.unique(y[test_idx])) > 1:
            aucs.append(roc_auc_score(y[test_idx], p))
        losses.append(log_loss(y[test_idx], p, labels=[0, 1]))

    return float(np.mean(aucs)), float(np.mean(losses)), oof


def pick_threshold(y: np.ndarray, p: np.ndarray, target: float) -> tuple[float, float, float]:
    """
    Smallest threshold reaching the target precision on blocks.

    Precision is the metric that matters here and 0.5 is not the right default:
    blocking a page the user considers productive is a far worse failure than
    letting a time-sink through, because it is the one the user notices.
    """
    best = (0.5, 0.0, 0.0)
    for t in np.unique(np.round(p, 4)):
        blocked = p >= t
        if blocked.sum() == 0:
            continue
        precision = float((y[blocked] == 1).mean())
        recall = float(blocked[y == 1].sum() / max((y == 1).sum(), 1))
        if precision >= target:
            return float(t), precision, recall
        if precision > best[1]:
            best = (float(t), precision, recall)
    return best


# --------------------------------------------------------------------------

def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", choices=["sqlite", "neon"], default="sqlite")
    ap.add_argument("--target-precision", type=float, default=TARGET_BLOCK_PRECISION)
    ap.add_argument("--write", action="store_true", help="persist to global_params")
    ap.add_argument("--out", default=str(Path(__file__).parent / "checkpoints" / "global_params.json"))
    args = ap.parse_args()

    print(f"Loading corpus ({args.source}) ...")
    if args.source == "sqlite":
        htmls, labels, groups = load_sqlite_corpus()
        model, token2idx, _ = load_encoder()
        print("Encoding ...")
        z_raw = encode_html(model, token2idx, htmls)
    else:
        import asyncio
        z_raw, labels, groups = asyncio.run(_load_neon_corpus())

    y = (labels == POSITIVE_LABEL).astype(int)
    if len(np.unique(y)) < 2:
        raise SystemExit("Corpus has only one class; cannot fit a scorer.")
    print(f"  z_raw {z_raw.shape} | {int(y.sum())} waste / {int((1 - y).sum())} productive")

    # --- Cold start: what a zero-label user gets ---
    cold_auc, cold_loss, cold_oof = evaluate(z_raw, y, groups, kappa=None)
    print(f"\ncold start (w=0, z_u = z_global): AUC {cold_auc:.4f}  logloss {cold_loss:.4f}")

    # --- Personalized: grid-search kappa ---
    print("\nkappa search (grouped CV):")
    results = {}
    for kappa in KAPPA_GRID:
        auc, loss, oof = evaluate(z_raw, y, groups, kappa)
        results[kappa] = (auc, loss, oof)
        print(f"  kappa {kappa:5.1f}  AUC {auc:.4f}  logloss {loss:.4f}")

    best_kappa = max(results, key=lambda k: results[k][0])
    best_auc, best_loss, best_oof = results[best_kappa]
    print(f"\nbest kappa {best_kappa} -> AUC {best_auc:.4f} "
          f"({best_auc - cold_auc:+.4f} vs cold start)")

    # --- Final params on the full corpus ---
    sigma = fit_sigma(z_raw)
    Z = preprocess(z_raw, sigma)
    z_global = (Z[y == 1].mean(axis=0) - Z[y == 0].mean(axis=0)).astype(np.float32)
    s = loo_scores(Z, y, groups, z_global, best_kappa)

    lr = LogisticRegression().fit(s.reshape(-1, 1), y)
    a, b = float(lr.coef_[0][0]), float(lr.intercept_[0])

    threshold, precision, recall = pick_threshold(y, best_oof, args.target_precision)
    hit = precision >= args.target_precision
    print(f"\na = {a:.4f}  b = {b:.4f}")
    print(f"threshold {threshold:.4f} -> block precision {precision:.4f} "
          f"recall {recall:.4f}" + ("" if hit else f"  (below target {args.target_precision})"))

    params = {
        "sigma": sigma.tolist(),
        "z_global": z_global.tolist(),
        "a": a,
        "b": b,
        "kappa": best_kappa,
        "threshold": threshold,
        "encoder_version": encoder_version(),
        "metrics": {
            "source": args.source,
            "cold_start_auc": cold_auc,
            "cold_start_logloss": cold_loss,
            "personalized_auc": best_auc,
            "personalized_logloss": best_loss,
            "block_precision": precision,
            "block_recall": recall,
            "hit_target_precision": hit,
            "kappa_grid": {str(k): v[0] for k, v in results.items()},
        },
        "n_pages": int(len(y)),
        "n_labels": int(len(y)),
        "n_users": int(len(np.unique(groups))),
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w") as f:
        json.dump(params, f)
    print(f"\nWrote {out_path}")

    if args.write:
        import asyncio
        from write_globals import write_params
        version = asyncio.run(write_params(params))
        print(f"Activated global_params version {version}")


if __name__ == "__main__":
    main()
