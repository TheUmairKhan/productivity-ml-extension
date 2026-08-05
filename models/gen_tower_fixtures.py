"""
Generate two-tower fixtures from the Python reference implementation.

    python models/gen_tower_fixtures.py

backend/preprocessing.py is what fit_globals.py fits kappa, a and b against. If
the TypeScript tower disagrees even slightly, the shipped calibration describes a
scorer the device is not running. These fixtures pin the two together on exact
numbers rather than on a shared reading of the formula.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

import numpy as np

from backend.preprocessing import fit_sigma, preprocess, score, user_vector

OUT = Path(__file__).parent.parent / "tests" / "fixtures" / "tower-cases.json"
D = 8


def main() -> None:
    rng = np.random.default_rng(0)

    sigma = np.abs(rng.normal(1.0, 0.3, D)).astype(np.float32) + 0.1
    z_global = rng.normal(0, 0.5, D).astype(np.float32)
    a, b, kappa = 10.0571, 0.3805, 8.0

    cases = []

    # preprocess: the L2 normalize is the part that does not commute with the
    # mean, so it is checked on its own before anything is averaged.
    for name, z_raw in [
        ("typical", rng.normal(0, 1, D).astype(np.float32)),
        ("large_norm", (rng.normal(0, 1, D) * 50).astype(np.float32)),
        ("all_zero", np.zeros(D, dtype=np.float32)),
    ]:
        cases.append({
            "kind": "preprocess",
            "name": name,
            "z_raw": z_raw.tolist(),
            "sigma": sigma.tolist(),
            "expected": preprocess(z_raw, sigma).tolist(),
        })

    # user_vector: the degenerate cases are the point. Zero labels and one-sided
    # labels must both return exactly z_global.
    for name, n_pos, n_neg in [
        ("cold_start", 0, 0),
        ("only_waste", 9, 0),
        ("only_productive", 0, 9),
        ("one_each", 1, 1),
        ("balanced", 9, 9),
        ("lopsided", 40, 2),
    ]:
        s_pos = preprocess(rng.normal(0, 1, (max(n_pos, 1), D)).astype(np.float32), sigma)[:n_pos].sum(axis=0) \
            if n_pos else np.zeros(D, dtype=np.float32)
        s_neg = preprocess(rng.normal(0, 1, (max(n_neg, 1), D)).astype(np.float32), sigma)[:n_neg].sum(axis=0) \
            if n_neg else np.zeros(D, dtype=np.float32)

        z_u = user_vector(s_pos, n_pos, s_neg, n_neg, z_global, kappa)
        z_i = preprocess(rng.normal(0, 1, D).astype(np.float32), sigma)

        cases.append({
            "kind": "user_vector",
            "name": name,
            "s_pos": s_pos.tolist(), "n_pos": n_pos,
            "s_neg": s_neg.tolist(), "n_neg": n_neg,
            "z_global": z_global.tolist(), "kappa": kappa,
            "expected_z_u": z_u.tolist(),
            "z_i": z_i.tolist(), "a": a, "b": b,
            "expected_score": float(np.dot(z_u, z_i)),
            "expected_probability": float(score(z_u, z_i, a, b)),
        })

    # fit_sigma, including the dead-dimension floor that keeps the divide safe.
    z_raw = rng.normal(0, 1, (50, D)).astype(np.float32)
    z_raw[:, 3] = 0.0  # a dimension the max-pool never activates
    cases.append({
        "kind": "fit_sigma",
        "name": "with_dead_dimension",
        "z_raw": z_raw.tolist(),
        "expected": fit_sigma(z_raw).tolist(),
    })

    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"d": D, "cases": cases}, f, indent=1)
    print(f"Wrote {len(cases)} cases to {OUT}")


if __name__ == "__main__":
    main()
