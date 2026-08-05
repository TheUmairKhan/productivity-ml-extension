import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import current_active_user
from .db import get_async_session
from .models import GlobalParams, User

router = APIRouter()


class GlobalParamsOut(BaseModel):
    version: int
    sigma: list[float]
    z_global: list[float]
    a: float
    b: float
    kappa: float
    threshold: float
    encoder_version: str
    fitted_at: datetime


@router.get("/params", response_model=GlobalParamsOut)
async def get_params(
    user: User = Depends(current_active_user),
    session: AsyncSession = Depends(get_async_session),
) -> GlobalParamsOut:
    """
    The active global parameter set.

    Devices cache this and score entirely locally against it: they preprocess
    their own page embeddings with sigma, fall back to z_global while they have
    too few labels to estimate a user vector, and calibrate with a, b, threshold.
    Nothing here is user-specific, so the response is identical for every caller.
    """
    params = (
        await session.execute(
            select(GlobalParams).where(GlobalParams.is_active).limit(1)
        )
    ).scalar_one_or_none()

    if params is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="NO_ACTIVE_PARAMS",
        )

    return GlobalParamsOut(
        version=params.version,
        sigma=list(params.sigma),
        z_global=list(params.z_global),
        a=params.a,
        b=params.b,
        kappa=params.kappa,
        threshold=params.threshold,
        encoder_version=params.encoder_version,
        fitted_at=params.fitted_at,
    )
