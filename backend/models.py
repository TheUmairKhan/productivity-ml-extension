from fastapi_users.db import SQLAlchemyBaseUserTableUUID
from .db import Base

class User(SQLAlchemyBaseUserTableUUID, Base):
    __tablename__ = "users"