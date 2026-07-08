import hashlib
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
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