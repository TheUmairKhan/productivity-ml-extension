import os
from collections.abc import AsyncGenerator
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from dotenv import load_dotenv
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

load_dotenv()

DATABASE_URL = os.getenv("DATABASE_URL")
if DATABASE_URL is None:
    raise RuntimeError("DATABASE_URL is not set")

DATABASE_URL = DATABASE_URL.replace("postgresql://", "postgresql+asyncpg://", 1)

# asyncpg doesn't accept libpq-only query params (channel_binding, sslmode);
# strip them and pass SSL via connect_args instead.
_split = urlsplit(DATABASE_URL)
_query = [(k, v) for k, v in parse_qsl(_split.query) if k not in ("channel_binding", "sslmode")]
DATABASE_URL = urlunsplit(_split._replace(query=urlencode(_query)))


class Base(DeclarativeBase):
    pass


engine = create_async_engine(
    DATABASE_URL,
    echo=True,          # False in prod
    pool_pre_ping=True,  # Checks stale connections before using them
    connect_args={"ssl": "require"},  # Neon requires TLS; asyncpg wants this via connect_args, not the URL
)

async_session_maker = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False
)


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    async with async_session_maker() as session:
        yield session
