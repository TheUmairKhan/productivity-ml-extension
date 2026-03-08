import os

STRUCTURAL_TAGS = [
    "title", "meta_desc",
    "h1", "h2", "h3", "h4", "h5",
    "strong", "em",
    "span", "p", "table",
]

TAG_TO_IDX = {t: i + 1 for i, t in enumerate(STRUCTURAL_TAGS)}  # 0 = PAD
NUM_TAGS = len(STRUCTURAL_TAGS)  # 12

M = 512    # max tokens per page (truncation limit)
N = 16     # structural embedding dimension (Gaussian initialized)

DB_PATH = os.path.expanduser("~/Library/Application Support/mlops/pages.db")
GLOVE_PATH = os.path.join(os.path.dirname(__file__), "semantic_structure", "GloVe", "dolma_300_2024_1.2M.100_combined.txt")

LABEL_TO_IDX = {"productive": 0, "waste": 1, "skip": 2}
IDX_TO_LABEL = {v: k for k, v in LABEL_TO_IDX.items()}
