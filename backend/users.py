import uuid

from fastapi import APIRouter, Depends
from fastapi_users import schemas
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_active_user
from .db import get_async_session
from .models import Page, PageLabel, User

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