# Plan: JFCNN Training Scripts, YAML Config, and CLI for `z_i` Embeddings

## Context

The MVP architecture defines an item embedding:

```text
z_i = ss(i)
```

where `ss(i)` is produced by a semantic + structural encoder.

The JFCNN, located in `models/semantic_structure/`, is that encoder. Currently, training only exists in a Jupyter notebook:

```text
train_jfcnn.ipynb
```

The goal is to:

1. Make the JFCNN emit `z_i` directly by adding an `encode()` method.
2. Replace the notebook with a reproducible training script driven by a YAML config.
3. Add an embedding extraction script that writes `z_i` for all labeled pages to disk.

---

# Files to Create or Modify

## 1. `models/requirements.txt`

Add `pyyaml`:

```txt
pyyaml>=6.0
```

Then install it inside the virtual environment:

```bash
pip install pyyaml
```

---

## 2. `models/semantic_structure/model.py`

Add an `encode()` method after `forward()`.

This method stops before the fully connected classification head and returns the pooled CNN representation. With the default settings, this representation is 384-dimensional and serves as `z_i`.

No dropout is used here because this should be a deterministic fixed-length representation.

```python
def encode(self, word_idx: torch.Tensor, tag_idx: torch.Tensor) -> torch.Tensor:
    """
    Return z_i: the pooled CNN representation before the FC head.

    Shape:
        (B, num_filters * len(kernel_sizes))

    With default settings:
        (B, 384)

    Used by the two-tower scorer.
    """
    x = torch.cat(
        [self.word_emb(word_idx), self.struct_emb(tag_idx)],
        dim=-1,
    )

    x = x.permute(0, 2, 1)

    pooled = [
        self.relu(conv(x)).max(dim=-1).values
        for conv in self.convs
    ]

    return torch.cat(pooled, dim=1)
```

---

## 3. `models/configs/jfcnn.yaml`

Create the directory:

```bash
mkdir -p models/configs
```

Then create:

```text
models/configs/jfcnn.yaml
```

```yaml
paths:
  db_path: "~/Library/Application Support/mlops/pages.db"
  glove_path: "models/semantic_structure/GloVe/dolma_300_2024_1.2M.100_combined.txt"
  checkpoint_dir: "models/checkpoints"
  checkpoint_name: "jfcnn.pt"

model:
  num_filters: 128
  kernel_sizes: [3, 4, 5]
  fc_hidden: 256
  dropout: 0.5
  num_classes: 2
  freeze_word_emb: false # fine-tune GloVe during training

training:
  seed: 42
  val_split: 0.10
  test_split: 0.20
  batch_size: 32
  num_epochs: 500
  lr: 0.001
  weight_decay: 0.0001
  log_interval: 10

embed:
  output_name: "page_embeddings.npz"
  batch_size: 64
```

---

## 4. `models/train.py`

Create a new training script.

Run it from the project root:

```bash
python models/train.py --config models/configs/jfcnn.yaml
```

### Required Bootstrap

At the top of the file, add:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
```

This is needed because `extractor.py` imports from `config`, so `models/` must be on `sys.path`.

### Imports

The script should import from:

```python
from config import LABEL_TO_IDX, TAG_TO_IDX, M, N
from semantic_structure import db, dataset, extractor, model
```

### Training Flow

The script should:

1. Parse `--config`.
2. Load the YAML config.
3. Load records from the database:

```python
load_records(db_path)
```

4. Build the vocabulary and embedding matrices:

```python
build_corpus_vocab(records, glove_path, n=N, m=M)
```

This should return:

```python
token2idx, word_matrix, struct_matrix
```

5. Construct a `PageDataset`.

The dataset should receive all records, including `skip`; `PageDataset` will drop skipped pages.

6. Create a stratified train/validation/test split using the same logic as the notebook:

```text
per-class shuffle → carve train/val/test
```

7. Construct the JFCNN model using the YAML model hyperparameters.

8. Train using:

```python
Adam(lr, weight_decay)
CrossEntropyLoss
```

9. Log validation metrics every `log_interval` epochs:

```text
loss
accuracy
F1
```

10. Run final test evaluation with:

```text
accuracy
F1
precision
recall
AUC
```

11. Save a single checkpoint bundle to:

```text
checkpoint_dir/checkpoint_name
```

Example checkpoint structure:

```python
torch.save(
    {
        "model_state_dict": model.state_dict(),

        # Save post-finetuning embeddings, not the original matrices.
        "word_matrix": model.word_emb.weight.detach().cpu().numpy(),
        "struct_matrix": model.struct_emb.weight.detach().cpu().numpy(),

        "token2idx": token2idx,
        "config": cfg,
        "train_metrics": {
            "val": history[-1],
            "test": test_metrics,
        },
    },
    ckpt_path,
)
```

### Device Priority

Use this priority order:

```text
MPS → CUDA → CPU
```

Implement this with a helper such as:

```python
def _auto_device():
    ...
```

### Important Note

Save `word_matrix` from the model, not the original loaded matrix. This captures GloVe fine-tuning when:

```yaml
freeze_word_emb: false
```

---

## 5. `models/embed.py`

Create a new embedding extraction script.

Run it from the project root:

```bash
python models/embed.py --config models/configs/jfcnn.yaml
```

### Required Bootstrap

Use the same `sys.path` bootstrap as `train.py`:

```python
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
```

### Supported Modes

The script should support:

```bash
python models/embed.py --config models/configs/jfcnn.yaml
```

and optional override flags:

```bash
python models/embed.py \
  --checkpoint models/checkpoints/jfcnn.pt \
  --db-path "~/Library/Application Support/mlops/pages.db"
```

### Extraction Flow

The script should:

1. Load the checkpoint bundle:

```python
torch.load(ckpt_path, map_location="cpu", weights_only=False)
```

Use `weights_only=False` because the bundle contains NumPy arrays.

2. Reconstruct the JFCNN from:

```python
bundle["config"]["model"]
bundle["word_matrix"]
bundle["struct_matrix"]
```

3. Load the trained weights:

```python
model.load_state_dict(bundle["model_state_dict"])
model.eval()
```

4. Load records from the database.

5. Build a `PageDataset` using:

```python
bundle["token2idx"]
```

6. Create a `DataLoader` with:

```python
shuffle=False
```

7. Run batched embedding extraction:

```python
model.encode(word_idx, tag_idx)
```

8. Save the embeddings with:

```python
np.savez(out_path, urls=np.array(urls), embeddings=np.vstack(all_z))
```

### Output Format

The output file should be:

```text
models/checkpoints/page_embeddings.npz
```

It should contain two parallel arrays:

```text
urls:        shape (N,), string
embeddings: shape (N, 384), float32
```

The `embeddings` array contains the `z_i` vectors.

---

# End-to-End Usage

From the project root:

```bash
cd /Users/umair/mlops
```

## 1. Install `pyyaml`

```bash
source models/.venv/bin/activate
pip install pyyaml
```

## 2. Train JFCNN

```bash
python models/train.py --config models/configs/jfcnn.yaml
```

Expected runtime:

```text
~2 minutes on MPS for 500 epochs
```

## 3. Extract `z_i` Embeddings

```bash
python models/embed.py --config models/configs/jfcnn.yaml
```

Expected output:

```text
models/checkpoints/page_embeddings.npz
```

## 4. Load Embeddings Downstream

```python
import numpy as np

data = np.load(
    "models/checkpoints/page_embeddings.npz",
    allow_pickle=True,
)

z_i = dict(zip(data["urls"], data["embeddings"]))
```

This gives:

```text
url → 384-dimensional vector
```

---

# Verification

## 1. Training Metrics

`train.py` should print validation metrics during training:

```text
validation loss
validation accuracy
validation F1
```

Check that validation accuracy improves and stabilizes.

The notebook previously achieved approximately:

```text
90%+ accuracy
```

## 2. Embedding Output

`embed.py` should print something like:

```text
Saved N embeddings of shape (N, 384)
```

`N` should match the number of labeled pages after `skip` pages are dropped.

## 3. Sanity-Check `z_i`

Run:

```python
np.linalg.norm(data["embeddings"], axis=1)
```

The norms should vary.

They should not be:

```text
all zeros
all identical
```

## 4. Validate Checkpoint Bundle

Run:

```python
torch.load(
    "models/checkpoints/jfcnn.pt",
    weights_only=False,
).keys()
```

Expected top-level keys:

```python
{
    "model_state_dict",
    "word_matrix",
    "struct_matrix",
    "token2idx",
    "config",
    "train_metrics",
}
```

---

# Notes and Pitfalls

## Path Resolution

The `glove_path` in the YAML is project-root-relative.

Inside `train.py`, resolve it using something like:

```python
project_root = Path(__file__).parent.parent
glove_path = project_root / cfg["paths"]["glove_path"]
```

## Do Not Hardcode `M` and `N`

Pass these values from `config.py`:

```python
from config import M, N
```

Then use:

```python
build_corpus_vocab(records, glove_path, n=N, m=M)
```

Do not hardcode:

```text
512
16
```

## DataLoader Workers

Use:

```python
DataLoader(..., num_workers=0)
```

`PageDataset` uses an in-memory cache, so multiprocessing is not useful here.

## Embedding Scope

`embed.py` should only embed productive and waste pages.

This is correct because `PageDataset` drops `skip` pages, and the two-tower scorer should only consume labeled productive/waste examples.
