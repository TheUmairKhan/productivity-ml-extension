import os
import uuid
from datetime import datetime

from typing import Any

from fastapi_users.db import SQLAlchemyBaseUserTableUUID
from pgvector.sqlalchemy import Vector
from sqlalchemy import Boolean, DateTime, Float, Integer, String, ForeignKey, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID as PGUUID
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

EMBEDDING_DIM = int(os.environ["EMBEDDING_DIM"])

class User(SQLAlchemyBaseUserTableUUID, Base):
    __tablename__ = "users"

    google_sub: Mapped[str | None] = mapped_column(String, unique=True, nullable=True)
    embedding_productive: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    embedding_waste: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)

class Page(Base):
    __tablename__ = "pages"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    url: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    raw_url: Mapped[str] = mapped_column(String, nullable=False)
    r2_key: Mapped[str | None] = mapped_column(String, nullable=True)
    embedding: Mapped[list[float] | None] = mapped_column(Vector(EMBEDDING_DIM), nullable=True)
    captured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))

class PageLabel(Base):
    __tablename__ = "page_labels"
    __table_args__ = (UniqueConstraint("user_id", "page_id", name="uq_page_labels_user_id_page_id"),)

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    page_id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), ForeignKey("pages.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String, nullable=False)
    labeled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))

class GlobalParams(Base):
    """
    The parameters every device needs to score locally, fit on pooled donated
    data by models/fit_globals.py and refit periodically.

    Rows are immutable and versioned; exactly one is active at a time. Devices
    poll GET /params and cache whatever the active row says.
    """
    __tablename__ = "global_params"

    id: Mapped[uuid.UUID] = mapped_column(
        PGUUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )
    version: Mapped[int] = mapped_column(Integer, unique=True, nullable=False)

    sigma: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM), nullable=False)
    z_global: Mapped[list[float]] = mapped_column(Vector(EMBEDDING_DIM), nullable=False)
    a: Mapped[float] = mapped_column(Float, nullable=False)
    b: Mapped[float] = mapped_column(Float, nullable=False)
    kappa: Mapped[float] = mapped_column(Float, nullable=False)
    threshold: Mapped[float] = mapped_column(Float, nullable=False)

    # Which encoder produced the embeddings this fit was derived from. Retraining
    # the CNN invalidates sigma and z_global, so params and encoder travel together.
    encoder_version: Mapped[str] = mapped_column(String, nullable=False)

    metrics: Mapped[dict[str, Any] | None] = mapped_column(JSONB, nullable=True)
    n_pages: Mapped[int | None] = mapped_column(Integer, nullable=True)
    n_labels: Mapped[int | None] = mapped_column(Integer, nullable=True)
    n_users: Mapped[int | None] = mapped_column(Integer, nullable=True)

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    fitted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
