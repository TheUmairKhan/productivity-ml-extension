import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import select

from loader import encode_html, load_encoder
from backend.db import async_session_maker
from backend.models import Page
from backend.storage import r2_client

BATCH_SIZE = 32


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


async def write_embeddings(model, token2idx: dict, html_pages: list[tuple[Page, str]]) -> None:
    """
    Compute and store z_raw for each page, one commit per batch.

    Stores the *raw* encoder output, not the preprocessed vector: sigma is refit
    weekly, and re-deriving every row on each refit would mean re-downloading the
    whole corpus. Preprocessing is applied at read time instead.
    """
    async with async_session_maker() as session:
        for start in range(0, len(html_pages), BATCH_SIZE):
            batch = html_pages[start : start + BATCH_SIZE]
            z_raw = encode_html(model, token2idx, [html for _, html in batch])

            for (page, _), z in zip(batch, z_raw):
                merged_page = await session.merge(page)
                merged_page.embedding = z.tolist()
            await session.commit()


async def main() -> None:
    model, token2idx, _ = load_encoder()
    print(f"Loaded JFCNN with {len(token2idx)} vocab entries")

    pages = await pages_to_embed()
    print(f"Found {len(pages)} pages needing embeddings")

    pages_with_html = get_html(pages)
    await write_embeddings(model, token2idx, pages_with_html)
    print(f"Wrote embeddings for {len(pages_with_html)} pages")


if __name__ == "__main__":
    asyncio.run(main())
