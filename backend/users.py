import uuid

from fastapi import APIRouter, Depends, Response, status
from fastapi_users import schemas
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_active_user
from .db import get_async_session
from .models import Page, PageLabel, User
from .pages import _collect_orphans

router = APIRouter()


class UserRead(schemas.BaseUser[uuid.UUID]):
    pass


class UserCreate(schemas.BaseUserCreate):
    pass


@router.get("/users/me/embeddings")
async def get_user_embedding(
        user: User = Depends(current_active_user),
        session: AsyncSession =Depends(get_async_session)
        ) -> dict[str, list[float]] | None:
    result = await session.execute(select(User.embedding_productive, User.embedding_waste).where(User.id == user.id))
    embeddings = result.one_or_none()
    if embeddings is None:
        return None
    return {
        "productive": embeddings.embedding_productive,
        "waste": embeddings.embedding_waste,
    }

@router.post("/users/me/embeddings")
async def update_user_embedding(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> dict[str, list[float] | None]:
    result = await session.execute(
        select(
            PageLabel.label,
            func.avg(Page.embedding).label("avg_embedding"),
        )
        .join(Page, PageLabel.page_id == Page.id)
        .where(PageLabel.user_id == user.id, Page.embedding.is_not(None))
        .group_by(PageLabel.label)
    )

    for label, avg_embedding in result.all():
        if label == "productive":
            user.embedding_productive = avg_embedding
        elif label == "waste":
            user.embedding_waste = avg_embedding

    session.add(user)
    await session.commit()

    return {
        "productive": user.embedding_productive,
        "waste": user.embedding_waste,
    }


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