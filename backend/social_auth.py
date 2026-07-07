import secrets

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi_users.db import SQLAlchemyUserDatabase
from fastapi_users.password import PasswordHelper
from pydantic import BaseModel
from sqlalchemy import select

from .auth import get_jwt_strategy, get_user_db
from .models import User

router = APIRouter()

GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

password_helper = PasswordHelper()


class GoogleLoginRequest(BaseModel):
    access_token: str


async def get_or_create_google_user(
user_db: SQLAlchemyUserDatabase, 
sub: str, 
email: str | None
) -> User:
    result = await user_db.session.execute(select(User).where(User.google_sub == sub))
    user = result.scalar_one_or_none()
    if user is not None:
        return user

    if email is not None:
        user = await user_db.get_by_email(email)
        if user is not None:
            user.google_sub = sub
            await user_db.session.commit()
            return user

    return await user_db.create(
        {
            "email": email,
            "hashed_password": password_helper.hash(secrets.token_urlsafe(32)),
            "is_active": True,
            "is_verified": True,
            "google_sub": sub,
        }
    )


@router.post("/google")
async def google_login(
    body: GoogleLoginRequest,
    user_db: SQLAlchemyUserDatabase = Depends(get_user_db),
):
    async with httpx.AsyncClient() as client:
        response = await client.get(
            GOOGLE_USERINFO_URL,
            headers={"Authorization": f"Bearer {body.access_token}"},
        )

    if response.status_code != 200:
        raise HTTPException(status_code=401, detail="Invalid Google access token")

    payload = response.json()
    sub = payload["sub"]
    email = payload.get("email")

    user = await get_or_create_google_user(user_db, sub, email)

    strategy = get_jwt_strategy()
    token = await strategy.write_token(user)

    return {"access_token": token, "token_type": "bearer"}
