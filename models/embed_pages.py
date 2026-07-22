import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

import torch
from sqlalchemy import select

import config
from semantic_structure.extractor import _StructuredParser
from semantic_structure.model import JFCNN
from backend.db import async_session_maker
from backend.models import Page
from backend.storage import r2_client

def load_checkpoint(ckpt_path: Path) -> tuple[JFCNN, dict]:
    """
    Load the train.py-saved checkpoint bundle and rebuild the JFCNN
    with its trained weights, in eval mode.

    Returns (model, token2idx).
    """
    bundle = torch.load(ckpt_path, map_location="cpu", weights_only=False)

    model_cfg = bundle["config"]["paths"]["model"]
    model = JFCNN(
        word_matrix     = bundle["word_matrix"],
        struct_matrix   = bundle["struct_matrix"],
        num_filters     = model_cfg["num_filters"],
        kernel_sizes    = model_cfg["kernel_sizes"],
        fc_hidden       = model_cfg["fc_hidden"],
        dropout         = model_cfg["dropout"],
        num_classes     = model_cfg["num_classes"],
        freeze_word_emb = model_cfg["freeze_word_emb"],
    )
    model.load_state_dict(bundle["model_state_dict"])
    model.eval()

    return model, bundle["token2idx"]


async def pages_to_embed() -> list[Page]:
    """
    Return all Page rows that don't have an embedding yet.
    """
    async with async_session_maker() as session:
        result = await session.execute(
            select(Page).where(Page.embedding.is_(None))
        )
        return list(result.scalars().all())

def get_html(pages: list[Page]) -> list[tuple[Page, str]]:
    """
    Retrieve pages from R2 that don't have embeddings.

    Skips pages with no r2_key, since there's nothing to download.
    """
    results = []
    for page in pages:
        if page.r2_key is None:
            continue
        html = r2_client.download_html(page.r2_key)
        results.append((page, html))
    return results


@torch.no_grad()
def embed_html(model: JFCNN, token2idx: dict, html: str) -> list[float]:
    """
    Tokenize raw HTML and run it through JFCNN.encode() to get z_i.
    """
    parser = _StructuredParser(max_tokens=config.M)
    parser.feed(html)
    pairs = parser.pairs

    word_idx = torch.zeros(1, config.M, dtype=torch.long)
    tag_idx = torch.zeros(1, config.M, dtype=torch.long)
    for i, (tok, tag) in enumerate(pairs[:config.M]):
        word_idx[0, i] = token2idx.get(tok, 1)   # 1 = UNK
        tag_idx[0, i] = config.TAG_TO_IDX.get(tag, 0)   # 0 = PAD

    z = model.encode(word_idx, tag_idx)
    return z[0].tolist()


async def write_embeddings(model: JFCNN, token2idx: dict, html_pages: list[tuple[Page, str]]) -> None:
    """
    Compute and store the 384-d embedding for each page.
    """
    # TODO: batch commits instead of committing after every page
    async with async_session_maker() as session:
        for page, html in html_pages:
            embedding = embed_html(model, token2idx, html)
            merged_page = await session.merge(page)
            merged_page.embedding = embedding
            await session.commit()


async def main() -> None:
    project_root = Path(__file__).parent.parent
    ckpt_path = project_root / "models" / "checkpoints" / "jfcnn.pt"

    model, token2idx = load_checkpoint(ckpt_path)
    print(f"Loaded JFCNN with {len(token2idx)} vocab entries")

    pages = await pages_to_embed()
    print(f"Found {len(pages)} pages needing embeddings")

    pages_with_html = get_html(pages)
    await write_embeddings(model, token2idx, pages_with_html)
    print(f"Wrote embeddings for {len(pages_with_html)} pages")


if __name__ == "__main__":
    asyncio.run(main())
