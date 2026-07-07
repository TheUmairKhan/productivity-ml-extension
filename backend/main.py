from fastapi import FastAPI, Depends

from .auth import auth_backend, fastapi_users, current_active_user
from .users import UserCreate, UserRead
from .models import User

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

@app.get("/users/me")
async def get_me(user: User = Depends(current_active_user)):
    return {"email": user.email}
