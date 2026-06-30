"""
Joint Semantic + Structural CNN (JFCNN)

Architecture:
  Input  : word_idx [B, M] + tag_idx [B, M]
  Embed  : word_emb [V, k]  (GloVe-initialized, optionally frozen)
           struct_emb [T+1, n] (Gaussian-initialized, always trained)
  Concat : x = [e_i || s_i]  →  [B, M, k+n]
  Conv   : Conv1D(kernel_size=p, filters=F) per p in kernel_sizes
           ReLU → max-over-time pooling  →  [B, F] per p
  Cat    : [B, F * |kernel_sizes|]
  FC     : Linear(F*|ks|, fc_hidden) → ReLU → Dropout
           Linear(fc_hidden, num_classes)
  Output : logits [B, num_classes]  (use CrossEntropyLoss)
"""

from __future__ import annotations

from typing import List

import numpy as np
import torch
import torch.nn as nn


class JFCNN(nn.Module):
    """
    Joint Semantic + Structural CNN for HTML page classification.

    Args:
        word_matrix:    ndarray [vocab_size, k] — GloVe word embeddings
        struct_matrix:  ndarray [num_tags+1, n] — Gaussian structural embeddings
        num_filters:    Conv filters per kernel size (default 128)
        kernel_sizes:   Conv kernel sizes (default [3, 4, 5])
        fc_hidden:      FC hidden layer size (default 256)
        dropout:        Dropout probability (default 0.5)
        num_classes:    Output classes (default 3: productive/waste/skip)
        freeze_word_emb: Freeze GloVe weights during training (default True)
    """

    def __init__(
        self,
        word_matrix: np.ndarray,
        struct_matrix: np.ndarray,
        num_filters: int = 128,
        kernel_sizes: List[int] | None = None,
        fc_hidden: int = 256,
        dropout: float = 0.5,
        num_classes: int = 2,
        freeze_word_emb: bool = True,
    ) -> None:
        super().__init__()

        if kernel_sizes is None:
            kernel_sizes = [3, 4, 5]

        k = word_matrix.shape[1]    # word embedding dim (100 for dolma GloVe)
        n = struct_matrix.shape[1]  # structural embedding dim (N=16)
        input_dim = k + n           # per-token channel width (116)

        # --- Embedding tables ---
        self.word_emb = nn.Embedding.from_pretrained(
            torch.from_numpy(word_matrix),
            freeze=freeze_word_emb,
            padding_idx=0,
        )
        self.struct_emb = nn.Embedding.from_pretrained(
            torch.from_numpy(struct_matrix),
            freeze=False,
            padding_idx=0,
        )

        # --- Parallel Conv1D towers ---
        # Input layout for Conv1d: (B, input_dim, M)
        # Output per tower after pooling: (B, num_filters)
        self.convs = nn.ModuleList([
            nn.Conv1d(in_channels=input_dim, out_channels=num_filters, kernel_size=ks, stride=1)
            for ks in kernel_sizes
        ])
        self.relu = nn.ReLU()
        self.dropout = nn.Dropout(dropout)

        # --- FC head ---
        conv_out = num_filters * len(kernel_sizes)
        self.fc1 = nn.Linear(conv_out, fc_hidden)
        self.fc2 = nn.Linear(fc_hidden, num_classes)

    def encode(self, word_idx: torch.Tensor, tag_idx: torch.Tensor) -> torch.Tensor:
        """
        Return z_i: the pooled CNN representation before the FC head.

        Shape:
            (B, num_filters * len(kernel_sizes))

        Used by the two-tower scorer.
        """
        # Lookup + concatenate embeddings: (B, M, k+n)
        x = torch.cat([self.word_emb(word_idx), self.struct_emb(tag_idx)], dim=-1)

        # Conv1d expects (B, channels, seq_len)
        x = x.permute(0, 2, 1)  # → (B, k+n, M)

        # Conv → ReLU → global max pool, one tower per kernel size
        pooled = [
            self.relu(conv(x)).max(dim=-1).values   # (B, num_filters)
            for conv in self.convs
        ]

        return torch.cat(pooled, dim=1)  # (B, num_filters * |kernel_sizes|)



    def forward(self, word_idx: torch.Tensor, tag_idx: torch.Tensor) -> torch.Tensor:
        """
        Args:
            word_idx : (B, M) int64 — token indices, 0=PAD
            tag_idx  : (B, M) int64 — tag indices,   0=PAD

        Returns:
            logits: (B, num_classes)
        """
        # Concatenate towers: (B, num_filters * |kernel_sizes|)
        out = self.dropout(self.encode(word_idx, tag_idx))

        # FC layers
        out = self.dropout(self.relu(self.fc1(out)))
        return self.fc2(out)
