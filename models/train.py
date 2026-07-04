import sys
import argparse
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))

import yaml
import random
import numpy as np
import torch
import torch.nn as nn
from torch.utils.data import DataLoader, Subset
from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    roc_auc_score,
)

import config
from semantic_structure.db import load_records
from semantic_structure.extractor import build_corpus_vocab
from semantic_structure.dataset import PageDataset
from semantic_structure.model import JFCNN


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()

    parser.add_argument("--config", 
                        default=str(Path(__file__).parent / "configs" / "jfcnn.yaml"))

    # Training overrides
    parser.add_argument("--batch-size", type=int, default=None)
    parser.add_argument("--num-epochs", type=int, default=None)
    parser.add_argument("--lr", type=float, default=None)
    parser.add_argument("--wd", type=float, default=None)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--val-split", type=float, default=None)
    parser.add_argument("--test-split", type=float, default=None)
    parser.add_argument("--interval", type=int, default=None)

    # Model overrides
    parser.add_argument("--num-filters", type=int, default=None)
    parser.add_argument("--fc-hidden", type=int, default=None)
    parser.add_argument("--dropout", type=float, default=None)
    parser.add_argument("--freeze-word-emb", action="store_true")

    # Path overrides
    parser.add_argument("--db-path", type=str, default=None)
    parser.add_argument("--checkpoint-name", type=str, default=None)

    return parser.parse_args()

def apply_overrides(cfg: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    training_overrides = {
        "batch_size": args.batch_size,
        "num_epochs": args.num_epochs,
        "lr": args.lr,
        "wd": args.wd,
        "seed": args.seed,
        "val_split": args.val_split,
        "test_split": args.test_split,
        "interval": args.interval,
    }
    model_overrides = {
        "num_filters": args.num_filters,
        "fc_hidden": args.fc_hidden,
        "dropout": args.dropout,
    }

    path_overrides = {
        "db_path": args.db_path,
        "checkpoint_name": args.checkpoint_name,
    }

    for key, value in training_overrides.items():
        if value is not None:
            cfg["paths"]["training"][key] = value

    for key, value in model_overrides.items():
        if value is not None:
            cfg["paths"]["model"][key] = value

    for key, value in path_overrides.items():
        if value is not None:
            cfg["paths"][key] = value

    if args.freeze_word_emb:
        cfg["paths"]["model"]["freeze_word_emb"] = True

    return cfg

def _auto_device() -> torch.device:
    if torch.backends.mps.is_available():
        return torch.device("mps")
    if torch.cuda.is_available():
        return torch.device("cuda")
    return torch.device("cpu")


def _split_dataset(dataset: PageDataset, training_cfg: dict[str, Any]) -> tuple[Subset, Subset, Subset]:
    rng = random.Random(training_cfg["seed"])
    test_split = training_cfg["test_split"]
    val_split  = training_cfg["val_split"]

    by_class: dict[str, list[int]] = {}
    for i, (_, _, label_str) in enumerate(dataset.records):
        by_class.setdefault(label_str, []).append(i)

    train_indices, val_indices, test_indices = [], [], []
    for indices in by_class.values():
        rng.shuffle(indices)
        n_test = max(1, round(len(indices) * test_split))
        n_val  = max(1, round(len(indices) * val_split))
        test_indices.extend(indices[:n_test])
        val_indices.extend(indices[n_test: n_test + n_val])
        train_indices.extend(indices[n_test + n_val:])

    rng.shuffle(train_indices)
    rng.shuffle(val_indices)
    rng.shuffle(test_indices)

    return (
        Subset(dataset, train_indices),
        Subset(dataset, val_indices),
        Subset(dataset, test_indices),
    )


def _build_loaders(dataset: PageDataset, training_cfg: dict[str, Any]) -> tuple[DataLoader, DataLoader, DataLoader, int]:
    train_set, val_set, test_set = _split_dataset(dataset, training_cfg)
    batch_size = training_cfg["batch_size"]
    return (
        DataLoader(train_set, batch_size=batch_size, shuffle=True,  num_workers=0),
        DataLoader(val_set,   batch_size=batch_size, shuffle=False, num_workers=0),
        DataLoader(test_set,  batch_size=batch_size, shuffle=False, num_workers=0),
        len(train_set),
    )


def _build_model(
    word_matrix: np.ndarray,
    struct_matrix: np.ndarray,
    model_cfg: dict[str, Any],
    device: torch.device,
) -> JFCNN:
    return JFCNN(
        word_matrix     = word_matrix,
        struct_matrix   = struct_matrix,
        num_filters     = model_cfg["num_filters"],
        kernel_sizes    = model_cfg["kernel_sizes"],
        fc_hidden       = model_cfg["fc_hidden"],
        dropout         = model_cfg["dropout"],
        num_classes     = model_cfg["num_classes"],
        freeze_word_emb = model_cfg["freeze_word_emb"],
    ).to(device)


def evaluate(
    model: JFCNN,
    loader: DataLoader,
    criterion: nn.CrossEntropyLoss,
    device: torch.device,
) -> dict[str, float]:
    model.eval()
    all_labels, all_preds, all_probs = [], [], []
    total_loss = 0.0

    with torch.no_grad():
        for word_idx, tag_idx, labels in loader:
            word_idx = word_idx.to(device)
            tag_idx  = tag_idx.to(device)
            labels   = labels.to(device)

            logits = model(word_idx, tag_idx)
            total_loss += criterion(logits, labels).item() * len(labels)

            all_probs.extend(torch.softmax(logits, dim=-1)[:, 1].cpu().tolist())
            all_preds.extend(logits.argmax(dim=-1).cpu().tolist())
            all_labels.extend(labels.cpu().tolist())

    n = len(all_labels)
    return dict(
        loss      = total_loss / n,
        accuracy  = accuracy_score(all_labels, all_preds),
        precision = precision_score(all_labels, all_preds, zero_division=0),
        recall    = recall_score(all_labels, all_preds, zero_division=0),
        f1        = f1_score(all_labels, all_preds, zero_division=0),
        auc       = roc_auc_score(all_labels, all_probs),
    )


def train(
    model: JFCNN,
    train_loader: DataLoader,
    val_loader: DataLoader,
    n_train: int,
    optimizer: torch.optim.Adam,
    criterion: nn.CrossEntropyLoss,
    training_cfg: dict[str, Any],
    device: torch.device,
) -> list[dict[str, float]]:
    history  = []
    interval = training_cfg["interval"]

    print(f"{'Epoch':>6}  {'Train Loss':>10}  {'Val Loss':>8}  {'Acc':>6}  {'F1':>6}")
    for epoch in range(1, training_cfg["num_epochs"] + 1):
        model.train()
        train_loss = 0.0

        for word_idx, tag_idx, labels in train_loader:
            word_idx = word_idx.to(device)
            tag_idx  = tag_idx.to(device)
            labels   = labels.to(device)

            optimizer.zero_grad()
            logits = model(word_idx, tag_idx)
            loss   = criterion(logits, labels)
            loss.backward()
            optimizer.step()
            train_loss += loss.item() * len(labels)

        train_loss /= n_train
        val_metrics = evaluate(model, val_loader, criterion, device)
        history.append({"epoch": epoch, "train_loss": train_loss, **val_metrics})

        if epoch % interval == 0 or epoch == 1:
            print(
                f'{epoch:>6}  {train_loss:>10.4f}  '
                f'{val_metrics["loss"]:>8.4f}  '
                f'{val_metrics["accuracy"]:>6.3f}  '
                f'{val_metrics["f1"]:>6.3f}'
            )

    print("\nTraining complete.")
    return history


def main() -> None:
    args = parse_args()

    with open(args.config) as f:
        cfg = yaml.safe_load(f)

    cfg = apply_overrides(cfg, args)

    paths_cfg    = cfg["paths"]
    model_cfg    = paths_cfg["model"]
    training_cfg = paths_cfg["training"]

    project_root = Path(__file__).parent.parent
    db_path      = Path(paths_cfg["db_path"]).expanduser()
    glove_path   = project_root / paths_cfg["glove_path"]
    ckpt_dir     = project_root / paths_cfg["checkpoint_dir"]
    ckpt_path    = ckpt_dir / paths_cfg["checkpoint_name"]
    ckpt_dir.mkdir(parents=True, exist_ok=True)

    device = _auto_device()
    print(f"Device: {device}")

    all_records = load_records(db_path)
    token2idx, word_matrix, struct_matrix = build_corpus_vocab(
        all_records, glove_path, n=config.N, m=config.M
    )

    dataset = PageDataset(
        records   = all_records,
        token2idx = token2idx,
        tag2idx   = config.TAG_TO_IDX,
        label2idx = config.LABEL_TO_IDX,
        m         = config.M,
    )

    train_loader, val_loader, test_loader, n_train = _build_loaders(dataset, training_cfg)
    model     = _build_model(word_matrix, struct_matrix, model_cfg, device)
    optimizer = torch.optim.Adam(
        model.parameters(),
        lr=training_cfg["lr"],
        weight_decay=training_cfg["wd"],
    )
    criterion = nn.CrossEntropyLoss()

    history      = train(model, train_loader, val_loader, n_train, optimizer, criterion, training_cfg, device)
    test_metrics = evaluate(model, test_loader, criterion, device)

    print("\nTest metrics:")
    for k, v in test_metrics.items():
        print(f"  {k}: {v:.4f}")

    torch.save(
        {
            "model_state_dict": model.state_dict(),
            "word_matrix":      model.word_emb.weight.detach().cpu().numpy(),
            "struct_matrix":    model.struct_emb.weight.detach().cpu().numpy(),
            "token2idx":        token2idx,
            "config":           cfg,
            "train_metrics":    {"val": history[-1], "test": test_metrics},
        },
        ckpt_path,
    )
    print(f"Checkpoint saved to {ckpt_path}")


if __name__ == "__main__":
    main()
