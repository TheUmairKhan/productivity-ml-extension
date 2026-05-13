"""
PyTorch Dataset for the JFCNN model.

Wraps the feature extractor so the DataLoader receives
(word_idx, tag_idx, label) integer tensors of fixed length M.
"""

from __future__ import annotations

from typing import Dict, List, Tuple

import numpy as np
import torch
from torch.utils.data import Dataset

from .extractor import _parse_html


BINARY_LABELS = {"productive", "waste"}


class PageDataset(Dataset):
    """
    Binary dataset: productive (0) vs waste (1). Skip records are dropped.

    Args:
        records:    List of (url, html_path, label_str) from db.load_records()
        token2idx:  Dict[str, int] from build_corpus_vocab()
        tag2idx:    TAG_TO_IDX from config
        label2idx:  LABEL_TO_IDX from config  (must contain productive/waste keys)
        m:          Max sequence length M from config
    """

    def __init__(
        self,
        records: List[Tuple[str, str, str]],
        token2idx: Dict[str, int],
        tag2idx: Dict[str, int],
        label2idx: Dict[str, int],
        m: int,
    ) -> None:
        self.records = [r for r in records if r[2] in BINARY_LABELS]
        self.token2idx = token2idx
        self.tag2idx = tag2idx
        self.label2idx = label2idx
        self.m = m
        self._cache: List[Tuple[torch.Tensor, torch.Tensor, torch.Tensor]] = [None] * len(self.records)  # type: ignore[list-item]

    def __len__(self) -> int:
        return len(self.records)

    def __getitem__(self, idx: int) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        if self._cache[idx] is not None:
            return self._cache[idx]

        _, html_path, label_str = self.records[idx]

        pairs = _parse_html(html_path, self.m)

        word_idx = np.zeros(self.m, dtype=np.int64)
        tag_idx  = np.zeros(self.m, dtype=np.int64)

        for i, (tok, tag) in enumerate(pairs):
            word_idx[i] = self.token2idx.get(tok, 1)   # 1 = <UNK>
            tag_idx[i]  = self.tag2idx.get(tag, 0)     # 0 = PAD/unknown

        label = self.label2idx[label_str]

        item = (
            torch.from_numpy(word_idx),
            torch.from_numpy(tag_idx),
            torch.tensor(label, dtype=torch.long),
        )
        self._cache[idx] = item
        return item
