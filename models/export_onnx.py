"""
Export the item tower to ONNX so it can run in the extension.

Only `encode()` is exported -- the classifier head is dead weight in the
two-tower path. Output is z_raw; preprocessing (divide by sigma, L2 normalize)
happens on the client against the shipped global params, so the graph does not
have to be re-exported when sigma is refit.

Every export is gated on numerical parity with PyTorch. A silent drift here
would be invisible in every downstream metric, so the check is an assert, not
a warning.

    python models/export_onnx.py [--fp16] [--sample 200]
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch
import torch.nn as nn

import config
from loader import CHECKPOINT_DIR, encoder_version, html_to_indices, load_encoder
from semantic_structure.db import load_records

PARITY_TOL = 1e-4


class ItemTower(nn.Module):
    """Thin wrapper so torch.onnx.export traces encode() rather than forward()."""

    def __init__(self, jfcnn):
        super().__init__()
        self.jfcnn = jfcnn

    def forward(self, word_idx: torch.Tensor, tag_idx: torch.Tensor) -> torch.Tensor:
        return self.jfcnn.encode(word_idx, tag_idx)


def build_parity_batch(
    token2idx: dict[str, int], limit: int
) -> tuple[torch.Tensor, torch.Tensor]:
    """
    Real pages from the training corpus, falling back to random indices if the
    local capture store is gone. Random indices still exercise the graph, but
    real pages exercise the padding and truncation paths that matter.
    """
    try:
        records = load_records(config.DB_PATH)[:limit]
    except Exception:
        records = []

    pairs = []
    for _, html_path, _ in records:
        try:
            with open(html_path, encoding="utf-8", errors="replace") as f:
                pairs.append(html_to_indices(f.read(), token2idx))
        except OSError:
            continue

    if not pairs:
        print("  no corpus available; falling back to random indices")
        rng = np.random.default_rng(0)
        vocab = len(token2idx)
        pairs = [
            (
                rng.integers(0, vocab, config.M, dtype=np.int64),
                rng.integers(0, len(config.TAG_TO_IDX) + 1, config.M, dtype=np.int64),
            )
            for _ in range(16)
        ]

    word_idx = torch.from_numpy(np.stack([w for w, _ in pairs]))
    tag_idx = torch.from_numpy(np.stack([t for _, t in pairs]))
    return word_idx, tag_idx


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(CHECKPOINT_DIR / "jfcnn.onnx"))
    parser.add_argument("--sample", type=int, default=200,
                        help="pages to check parity against")
    parser.add_argument("--fp16", action="store_true",
                        help="halve the word-embedding table; re-checks parity after")
    args = parser.parse_args()

    out_path = Path(args.out)
    model, token2idx, model_cfg = load_encoder()
    tower = ItemTower(model).eval()

    print(f"Exporting encoder (vocab {len(token2idx)}, d={model.fc1.in_features})")
    word_idx, tag_idx = build_parity_batch(token2idx, args.sample)
    print(f"  parity batch: {word_idx.shape[0]} pages")

    torch.onnx.export(
        tower,
        (word_idx[:1], tag_idx[:1]),
        str(out_path),
        input_names=["word_idx", "tag_idx"],
        output_names=["z_raw"],
        dynamic_axes={
            "word_idx": {0: "batch"},
            "tag_idx": {0: "batch"},
            "z_raw": {0: "batch"},
        },
        # 18 is what the exporter natively produces for this graph; asking for 17
        # sends it through a version downgrade that fails on the Gather nodes and
        # silently falls back to 18 anyway. onnxruntime-web handles 18 fine.
        opset_version=18,
        do_constant_folding=True,
    )

    # The exporter spills weights to a sidecar .onnx.data. Fold them back inline
    # so the extension bundles exactly one file and onnxruntime-web does not have
    # to be told where the external data lives.
    import onnx

    consolidated = onnx.load(str(out_path))  # resolves external data
    onnx.save(consolidated, str(out_path), save_as_external_data=False)
    sidecar = out_path.with_suffix(".onnx.data")
    if sidecar.exists():
        sidecar.unlink()

    if args.fp16:
        from onnxconverter_common import float16

        model_fp16 = float16.convert_float_to_float16(
            consolidated, keep_io_types=True
        )
        onnx.save(model_fp16, str(out_path), save_as_external_data=False)
        print("  converted weights to fp16")

    # --- Parity gate ---
    import onnxruntime as ort

    with torch.no_grad():
        expected = tower(word_idx, tag_idx).numpy()

    session = ort.InferenceSession(str(out_path), providers=["CPUExecutionProvider"])
    actual = session.run(
        ["z_raw"],
        {"word_idx": word_idx.numpy(), "tag_idx": tag_idx.numpy()},
    )[0]

    max_abs = float(np.abs(actual - expected).max())
    print(f"  max|onnx - torch| = {max_abs:.3e} (tol {PARITY_TOL:.0e})")
    assert max_abs < PARITY_TOL, (
        f"ONNX export diverges from PyTorch by {max_abs:.3e}. "
        "Refusing to ship an encoder that does not match the reference."
    )

    meta_path = out_path.with_suffix(".json")
    with open(meta_path, "w") as f:
        json.dump(
            {
                "encoder_version": encoder_version(),
                "embedding_dim": model.fc1.in_features,
                "max_tokens": config.M,
                "vocab_size": len(token2idx),
                "tag_to_idx": config.TAG_TO_IDX,
                "model_config": model_cfg,
                "fp16": args.fp16,
                "parity_max_abs": max_abs,
            },
            f,
            indent=2,
        )

    size_mb = out_path.stat().st_size / 1e6
    print(f"Wrote {out_path} ({size_mb:.1f} MB) and {meta_path.name}")


if __name__ == "__main__":
    main()
