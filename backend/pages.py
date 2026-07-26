import hashlib
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from .auth import current_active_user
from .db import get_async_session
from .models import Page, PageLabel, User
from .storage import r2_client

router = APIRouter()

class PageUploadRequest(BaseModel):
    url: str
    raw_url: str
    html: str
    label: str
    captured_at: datetime


class PageUploadResponse(BaseModel):
    page_id: uuid.UUID


class PageLabelOut(BaseModel):
    page_id: uuid.UUID
    url: str
    raw_url: str
    label: str
    captured_at: datetime


class DeleteResponse(BaseModel):
    deleted_labels: int
    deleted_pages: int


async def _collect_orphans(session: AsyncSession, page_ids: list[uuid.UUID]) -> int:
    """
    Drop Page rows (and their R2 objects) that no user labels any more.

    A Page is shared: several users can label the same URL, so deleting one user's label must
    not destroy another user's data. Only once the last label is gone does the page itself
    become garbage.
    """
    if not page_ids:
        return 0

    still_referenced = set(
        (
            await session.execute(
                select(PageLabel.page_id).where(PageLabel.page_id.in_(page_ids)).distinct()
            )
        )
        .scalars()
        .all()
    )
    orphan_ids = [pid for pid in page_ids if pid not in still_referenced]
    if not orphan_ids:
        return 0

    orphans = (
        (await session.execute(select(Page).where(Page.id.in_(orphan_ids)))).scalars().all()
    )

    for page in orphans:
        if page.r2_key:
            # Best-effort: a failed object delete must not strand the DB row, otherwise the
            # page becomes undeletable. Worst case is an orphaned blob in the bucket.
            try:
                await run_in_threadpool(r2_client.delete_html, page.r2_key)
            except Exception:
                pass

    await session.execute(delete(Page).where(Page.id.in_(orphan_ids)))
    return len(orphans)


@router.get("/pages/me", response_model=list[PageLabelOut])
async def list_my_pages(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> list[PageLabelOut]:
    result = await session.execute(
        select(PageLabel, Page)
        .join(Page, PageLabel.page_id == Page.id)
        .where(PageLabel.user_id == user.id)
    )

    return [
        PageLabelOut(
            page_id=page.id,
            url=page.url,
            raw_url=page.raw_url,
            label=page_label.label,
            captured_at=page.captured_at,
        )
        for page_label, page in result.all()
    ]


@router.post("/pages/upload", response_model=PageUploadResponse)
async def upload_page(
    body: PageUploadRequest,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session)
    ) -> PageUploadResponse:
    html_bytes = body.html.encode("utf-8")
    url_hash = hashlib.sha256(body.url.encode("utf-8")).hexdigest()
    r2_key = f"pages/{url_hash}.html"
    await run_in_threadpool(r2_client.upload_html, html_bytes, r2_key)

    result = await session.execute(select(Page).where(Page.url == body.url))
    page = result.scalar_one_or_none()

    if page is None:
        page = Page(
            url=body.url,
            raw_url=body.raw_url,
            r2_key=r2_key,
            captured_at=body.captured_at,
        )
        session.add(page)
        await session.flush()
    else:
        page.raw_url = body.raw_url
        page.r2_key = r2_key
        page.captured_at = body.captured_at

    result = await session.execute(
        select(PageLabel).where(
            PageLabel.user_id == user.id,
            PageLabel.page_id == page.id,
        )
    )
    page_label = result.scalar_one_or_none()

    if page_label is None:
        session.add(PageLabel(user_id=user.id, page_id=page.id, label=body.label))
    else:
        page_label.label = body.label

    await session.commit()
    return PageUploadResponse(page_id=page.id)


# Declared before /pages/{page_id} — that route types page_id as a UUID, so "me" would be
# rejected as invalid rather than falling through to this one.
@router.delete("/pages/me", response_model=DeleteResponse)
async def delete_my_pages(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> DeleteResponse:
    page_ids = list(
        (
            await session.execute(select(PageLabel.page_id).where(PageLabel.user_id == user.id))
        )
        .scalars()
        .all()
    )

    await session.execute(delete(PageLabel).where(PageLabel.user_id == user.id))
    await session.flush()

    deleted_pages = await _collect_orphans(session, page_ids)
    await session.commit()

    return DeleteResponse(deleted_labels=len(page_ids), deleted_pages=deleted_pages)


@router.delete("/pages/{page_id}", response_model=DeleteResponse)
async def delete_my_page(
    page_id: uuid.UUID,
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> DeleteResponse:
    result = await session.execute(
        select(PageLabel).where(
            PageLabel.user_id == user.id,
            PageLabel.page_id == page_id,
        )
    )
    page_label = result.scalar_one_or_none()
    if page_label is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="PAGE_NOT_LABELED")

    await session.delete(page_label)
    await session.flush()

    deleted_pages = await _collect_orphans(session, [page_id])
    await session.commit()

    return DeleteResponse(deleted_labels=1, deleted_pages=deleted_pages)