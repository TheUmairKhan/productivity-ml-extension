import asyncio
import sys
from collections.abc import Sequence
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent))

from sqlalchemy import Row, func, select

from backend.db import async_session_maker
from backend.models import Page, PageLabel, User


async def get_user_embeddings() -> Sequence[Row]:
    """
    Return (user_id, label, avg_embedding) for every user/label pair
    that has at least one page with an embedding. Averaging happens
    in Postgres via AVG(vector), not in Python.
    """
    async with async_session_maker() as session:
        result = await session.execute(
            select(
                PageLabel.user_id,
                PageLabel.label,
                func.avg(Page.embedding).label("avg_embedding"),
            )
            .join(Page, PageLabel.page_id == Page.id)
            .where(Page.embedding.is_not(None))
            .group_by(PageLabel.user_id, PageLabel.label)
        )
        return list(result.all())
