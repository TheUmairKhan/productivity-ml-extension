#!/Users/umair/mlops/models/.venv/bin/python3
"""
Native messaging host for JFCNN real-time page classification.
Chrome spawns this process via connectNative('com.predictor').
Stays alive; model loads once at startup.
"""
import sys
import json
import struct
import os
import numpy as np
import torch

_HERE = os.path.dirname(os.path.abspath(__file__))
_REPO = os.path.dirname(_HERE)
sys.path.insert(0, os.path.join(_REPO, "models"))

from semantic_structure.extractor import _StructuredParser
from semantic_structure.model import JFCNN
from config import TAG_TO_IDX, LABEL_TO_IDX, M

CHECKPOINTS = os.path.join(_REPO, "models", "checkpoints")

# -- Native Messaging I/O --
def read_message() -> dict | None:
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    length = struct.unpack('<I', raw)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode('utf-8'))

def send_message(msg: dict):
    data = json.dumps(msg).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


## -- Model loading at startup --
def load_model():
    embeddings = np.load(os.path.join(CHECKPOINTS, "embeddings.npz"))
    with open(os.path.join(CHECKPOINTS, "train_config.json")) as f:
        config = json.load(f)

    model = JFCNN(
        embeddings["word_matrix"], embeddings["struct_matrix"],
        num_filters=config["num_filters"],
        kernel_sizes=config["kernel_sizes"],
        fc_hidden=config["fc_hidden"],
        dropout=0.0,
        num_classes=config["num_classes"],
    )
    model.load_state_dict(torch.load(
        os.path.join(CHECKPOINTS, "jfcnn.pt"), map_location="cpu"
    ))
    model.eval()
    with open(os.path.join(CHECKPOINTS, "token2idx.json")) as f:
        token2idx = json.load(f)
    return model, token2idx

# -- Inference --
@torch.no_grad()
def predict(model, token2idx, html: str) -> dict:
    parser = _StructuredParser(max_tokens=M)
    parser.feed(html)
    pairs = parser.pairs

    word_idx = torch.zeros(1, M, dtype=torch.long)
    tag_idx  = torch.zeros(1, M, dtype=torch.long)
    for i, (tok, tag) in enumerate(pairs[:M]):
        word_idx[0, i] = token2idx.get(tok, 1)   # 1 = UNK
        tag_idx[0, i]  = TAG_TO_IDX.get(tag, 0)   # 0 = PAD

    logits = model(word_idx, tag_idx)[0]  # shape [2]
    probs = torch.softmax(logits, dim=0)
    p_productive = float(probs[LABEL_TO_IDX["productive"]])
    p_waste      = float(probs[LABEL_TO_IDX["waste"]])
    label = "productive" if p_productive >= p_waste else "waste"
    return {"label": label, "p_productive": p_productive,
            "p_waste": p_waste, "n_tokens": len(pairs)}


def main():
    model, token2idx = load_model()
    while True:
        msg = read_message()
        if msg is None:
            break
        req_id = msg.get("reqId")
        try:
            result = predict(model, token2idx, msg.get("html", ""))
            send_message({"reqId": req_id, **result})
        except Exception as e:
            send_message({"reqId": req_id, "error": str(e)})
        

if __name__ == "__main__":
    main()