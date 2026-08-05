from fastapi import FastAPI, Depends

from .auth import auth_backend, fastapi_users, current_active_user
from .social_auth import router as social_auth_router
from .users import UserCreate, UserRead, router as users_router
from .models import User
from .pages import router as pages_router
from .params import router as params_router
app = FastAPI()

# Registration
app.include_router(
    fastapi_users.get_register_router(UserRead, UserCreate),
    prefix="/auth",
    tags=["auth"]
)

# Login
app.include_router(
    fastapi_users.get_auth_router(auth_backend),
    prefix="/auth/jwt",
    tags=["auth"]
)

# Password reset
app.include_router(
    fastapi_users.get_reset_password_router(),
    prefix="/auth",
    tags=["auth"],
)

# Email verification
app.include_router(
    fastapi_users.get_verify_router(UserRead),
    prefix="/auth",
    tags=["auth"],
)

# Google social login
app.include_router(
    social_auth_router,
    prefix="/auth",
    tags=["auth"],
)

app.include_router(
    pages_router,
    tags=["pages"]
)

app.include_router(
    users_router,
    tags=["users"]
)

app.include_router(
    params_router,
    tags=["params"]
)
@app.get("/users/me")
async def get_me(user: User = Depends(current_active_user)):
    return {"email": user.email}
