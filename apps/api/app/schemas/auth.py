from pydantic import BaseModel


class LoginRequest(BaseModel):
    username: str
    password: str


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    id: int
    username: str
    email: str | None
    role: str
    is_active: bool

    model_config = {"from_attributes": True}


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    user: UserResponse


class SetupStatusResponse(BaseModel):
    needs_setup: bool


class SetupRequest(BaseModel):
    username: str
    email: str | None = None
    password: str
