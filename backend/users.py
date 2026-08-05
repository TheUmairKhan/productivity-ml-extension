import uuid

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi_users import schemas
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_active_user
from .db import get_async_session
from .models import GlobalParams, Page, PageLabel, User
from .pages import _collect_orphans
from .preprocessing import NEGATIVE_LABEL, POSITIVE_LABEL, preprocess

router = APIRouter()


class UserRead(schemas.BaseUser[uuid.UUID]):
    pass


class UserCreate(schemas.BaseUserCreate):
    pass


class UserEmbeddingsOut(BaseModel):
    """
    The caller's two class centroids, plus the counts behind them.

    The counts are not decoration: the device keeps running sums, and it can only
    reconstruct a sum from a centroid by multiplying it back out by the count.
    Without them a fresh install cannot seed its accumulators and would have to
    start cold even though the server knows better.
    """
    productive: list[float] | None
    waste: list[float] | None
    n_productive: int
    n_waste: int


async def _label_counts(session: AsyncSession, user_id: uuid.UUID) -> dict[str, int]:
    rows = (
        await session.execute(
            select(PageLabel.label, func.count())
            .join(Page, PageLabel.page_id == Page.id)
            .where(PageLabel.user_id == user_id, Page.embedding.is_not(None))
            .group_by(PageLabel.label)
        )
    ).all()
    return {label: count for label, count in rows}


@router.get("/users/me/embeddings", response_model=UserEmbeddingsOut)
async def get_user_embedding(
        user: User = Depends(current_active_user),
        session: AsyncSession = Depends(get_async_session)
        ) -> UserEmbeddingsOut:
    counts = await _label_counts(session, user.id)
    return UserEmbeddingsOut(
        productive=list(user.embedding_productive) if user.embedding_productive is not None else None,
        waste=list(user.embedding_waste) if user.embedding_waste is not None else None,
        n_productive=counts.get(NEGATIVE_LABEL, 0),
        n_waste=counts.get(POSITIVE_LABEL, 0),
    )


@router.post("/users/me/embeddings", response_model=UserEmbeddingsOut)
async def update_user_embedding(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> UserEmbeddingsOut:
    """
    Recompute the caller's class centroids from their donated pages.

    This deliberately does not use SQL AVG(embedding). Pages are stored as raw
    encoder output and have to be preprocessed first, and preprocessing ends in
    an L2 normalize, which does not commute with the mean: normalize(mean(z)) is
    not mean(normalize(z)). Averaging in SQL would let a single large-norm page
    dominate the centroid, which is the exact failure normalizing per page is
    there to prevent. So the aggregate happens here, after preprocessing.
    """
    sigma = (
        await session.execute(
            select(GlobalParams.sigma).where(GlobalParams.is_active).limit(1)
        )
    ).scalar_one_or_none()
    if sigma is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NO_ACTIVE_PARAMS",
        )
    sigma = np.asarray(sigma, dtype=np.float32)

    rows = (
        await session.execute(
            select(PageLabel.label, Page.embedding)
            .join(Page, PageLabel.page_id == Page.id)
            .where(PageLabel.user_id == user.id, Page.embedding.is_not(None))
        )
    ).all()

    by_label: dict[str, list[np.ndarray]] = {}
    for label, embedding in rows:
        by_label.setdefault(label, []).append(embedding)

    centroids: dict[str, list[float] | None] = {}
    for label, embeddings in by_label.items():
        z = preprocess(np.asarray(embeddings, dtype=np.float32), sigma)
        centroids[label] = z.mean(axis=0).tolist()

    if NEGATIVE_LABEL in centroids:
        user.embedding_productive = centroids[NEGATIVE_LABEL]
    if POSITIVE_LABEL in centroids:
        user.embedding_waste = centroids[POSITIVE_LABEL]

    session.add(user)
    await session.commit()

    return UserEmbeddingsOut(
        productive=list(user.embedding_productive) if user.embedding_productive is not None else None,
        waste=list(user.embedding_waste) if user.embedding_waste is not None else None,
        n_productive=len(by_label.get(NEGATIVE_LABEL, [])),
        n_waste=len(by_label.get(POSITIVE_LABEL, [])),
    )


@router.delete("/users/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_me(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> Response:
    """
    Delete the caller's account, their labels, and any page that nobody else labels.

    page_labels already cascades on user delete, but that would leave the Page rows and their
    R2 objects behind, so collect the orphans explicitly first.
    """
    page_ids = list(
        (
            await session.execute(select(PageLabel.page_id).where(PageLabel.user_id == user.id))
        )
        .scalars()
        .all()
    )

    await session.execute(delete(PageLabel).where(PageLabel.user_id == user.id))
    await session.flush()
    await _collect_orphans(session, page_ids)

    await session.delete(user)
    await session.commit()

    return Response(status_code=status.HTTP_204_NO_CONTENT)