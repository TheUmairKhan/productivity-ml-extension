from fastapi_users.db import SQLAlchemyBaseUserTableUUID
from sqlalchemy import Column, String
from .db import Base

class User(SQLAlchemyBaseUserTableUUID, Base):
    __tablename__ = "users"

    google_sub = Column(String, unique=True, nullable=True)