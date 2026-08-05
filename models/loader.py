"""
Shared encoder loading for every consumer of the item tower.

`embed_pages.py`, `export_onnx.py` and `fit_globals.py` all need the same thing:
a JFCNN in eval mode plus the token2idx it was trained against. They used to each
roll their own, against two different on-disk layouts:

  bundle  — a single .pt written by train.py, holding model_state_dict,
            word_matrix, struct_matrix, token2idx, config and train_metrics.
  split   — a bare state_dict .pt alongside embeddings.npz / token2idx.json /
            train_config.json, which is what the notebook writes.

`load_encoder()` accepts either and returns the same triple.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import numpy as np
import torch

import config
from semantic_structure.extractor import _StructuredParser
from semantic_structure.model import JFCNN

CHECKPOINT_DIR = Path(__file__).parent / "checkpoints"

# JFCNN kwargs, in the order the constructor takes them. dropout is deliberately
# absent: encoding must be deterministic, so it is always forced to 0.0.
_MODEL_KEYS = ("num_filters", "kernel_sizes", "fc_hidden", "num_classes", "freeze_word_emb")


def _model_kwargs(model_cfg: dict[str, Any]) -> dict[str, Any]:
    kwargs = {k: model_cfg[k] for k in _MODEL_KEYS if k in model_cfg}
    kwargs["dropout"] = 0.0
    return kwargs


def _from_bundle(bundle: dict) -> tuple[JFCNN, dict[str, int], dict]:
    # train.py nests model/training under `paths` (see configs/jfcnn.yaml), so
    # look there first and fall back to the flat layout the plan documented.
    cfg = bundle["config"]
    model_cfg = cfg.get("paths", {}).get("model") or cfg["model"]

    model = JFCNN(
        word_matrix=bundle["word_matrix"],
        struct_matrix=bundle["struct_matrix"],
        **_model_kwargs(model_cfg),
    )
    model.load_state_dict(bundle["model_state_dict"])
    return model, bundle["token2idx"], model_cfg


def _from_split(state_dict: dict, ckpt_dir: Path) -> tuple[JFCNN, dict[str, int], dict]:
    embeddings = np.load(ckpt_dir / "embeddings.npz")
    with open(ckpt_dir / "train_config.json") as f:
        model_cfg = json.load(f)

    model = JFCNN(
        word_matrix=embeddings["word_matrix"],
        struct_matrix=embeddings["struct_matrix"],
        **_model_kwargs(model_cfg),
    )
    model.load_state_dict(state_dict)

    with open(ckpt_dir / "token2idx.json") as f:
        token2idx = json.load(f)
    return model, token2idx, model_cfg


def load_encoder(
    ckpt_path: Path | str | None = None,
) -> tuple[JFCNN, dict[str, int], dict]:
    """
    Load the item tower in eval mode.

    Returns (model, token2idx, model_config). Call `model.encode()` for z_raw;
    the classifier head is loaded too but the two-tower path never uses it.
    """
    ckpt_path = Path(ckpt_path) if ckpt_path else CHECKPOINT_DIR / "jfcnn.pt"
    blob = torch.load(ckpt_path, map_location="cpu", weights_only=False)

    if "model_state_dict" in blob:
        model, token2idx, model_cfg = _from_bundle(blob)
    else:
        model, token2idx, model_cfg = _from_split(blob, ckpt_path.parent)

    model.eval()
    return model, token2idx, model_cfg


def html_to_indices(html: str, token2idx: dict[str, int]) -> tuple[np.ndarray, np.ndarray]:
    """
    Turn raw HTML into the (word_idx, tag_idx) pair the encoder consumes.

    Both are int64 [M], zero-padded. This is the exact sequence the TypeScript
    port in src/services/extractor.ts has to reproduce token for token.
    """
    parser = _StructuredParser(max_tokens=config.M)
    parser.feed(html)

    word_idx = np.zeros(config.M, dtype=np.int64)
    tag_idx = np.zeros(config.M, dtype=np.int64)
    for i, (tok, tag) in enumerate(parser.pairs[: config.M]):
        word_idx[i] = token2idx.get(tok, 1)              # 1 = UNK
        tag_idx[i] = config.TAG_TO_IDX.get(tag, 0)       # 0 = PAD
    return word_idx, tag_idx


@torch.no_grad()
def encode_html(model: JFCNN, token2idx: dict[str, int], htmls: list[str]) -> np.ndarray:
    """Batch HTML -> z_raw [len(htmls), 384]. No preprocessing applied."""
    if not htmls:
        return np.zeros((0, model.fc1.in_features), dtype=np.float32)

    pairs = [html_to_indices(h, token2idx) for h in htmls]
    word_idx = torch.from_numpy(np.stack([w for w, _ in pairs]))
    tag_idx = torch.from_numpy(np.stack([t for _, t in pairs]))
    return model.encode(word_idx, tag_idx).numpy().astype(np.float32)


def encoder_version(ckpt_path: Path | str | None = None) -> str:
    """
    Content hash of the checkpoint, recorded on every fit so a set of global
    params can be traced back to the encoder that produced the embeddings.
    """
    import hashlib

    ckpt_path = Path(ckpt_path) if ckpt_path else CHECKPOINT_DIR / "jfcnn.pt"
    h = hashlib.sha256()
    with open(ckpt_path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]
