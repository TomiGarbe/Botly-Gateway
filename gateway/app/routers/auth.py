from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.services.google_auth import GoogleAccessDeniedError, GoogleTokenValidationError, get_auth_service
from app.services.users import META_REVIEW_BUSINESS_ID, get_user_repository


router = APIRouter(prefix="/auth", tags=["auth"])
_service = get_auth_service()
_COOKIE = "botly_gateway_session"


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=20, max_length=8192)


class PasswordLoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=1, max_length=1024)


class CreateUserRequest(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=12, max_length=1024)
    role: str = Field(default="operator", pattern="^(operator|meta_reviewer)$")
    business_id: str | None = Field(default=None, max_length=128)


class ResetPasswordRequest(BaseModel):
    password: str = Field(min_length=12, max_length=1024)


@router.get("/config")
async def auth_config():
    """Expose only the public Google client identifier needed by GIS."""
    return {"google_client_id": get_settings().google_client_id}


def _set_session_cookie(response: Response, token: str, ttl: int) -> None:
    settings = get_settings()
    response.set_cookie(
        key=_COOKIE,
        value=token,
        max_age=ttl,
        httponly=True,
        secure=not settings.debug,
        samesite="lax",
        path="/",
    )


@router.post("/google")
async def google_login(body: GoogleLoginRequest, response: Response):
    try:
        user, token, ttl = await _service.sign_in(body.credential)
    except GoogleAccessDeniedError:
        raise HTTPException(status_code=403, detail="Acceso denegado.")
    except GoogleTokenValidationError:
        raise HTTPException(status_code=401, detail="No pudimos validar tu cuenta de Google.")
    _set_session_cookie(response, token, ttl)
    return {"user": user.public_dict()}


@router.post("/login")
async def password_login(body: PasswordLoginRequest, response: Response):
    try:
        user, token, ttl = _service.sign_in_with_password(body.email, body.password)
    except (GoogleAccessDeniedError, GoogleTokenValidationError):
        raise HTTPException(status_code=401, detail="Email o contraseña incorrectos.")
    _set_session_cookie(response, token, ttl)
    return {"user": user.public_dict()}


@router.get("/session")
async def get_session(request: Request):
    user = _service.current_user(request.cookies.get(_COOKIE, ""))
    if user is None:
        raise HTTPException(status_code=401, detail="Iniciá sesión para continuar.")
    return {"user": user.public_dict()}


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response):
    _service.sign_out(request.cookies.get(_COOKIE, ""))
    response.delete_cookie(_COOKIE, path="/")
    return Response(status_code=204, headers=dict(response.headers))


def _require_admin(request: Request) -> None:
    if getattr(getattr(request.state, "user", None), "role", "") != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Solo un administrador puede gestionar cuentas.")


@router.get("/users")
async def list_users(request: Request):
    _require_admin(request)
    return {"items": [{"id": user.id, "name": user.name, "email": user.email, "role": user.role, "business_id": user.business_id, "active": user.active} for user in get_user_repository().list()]}


@router.post("/users", status_code=status.HTTP_201_CREATED)
async def create_user(body: CreateUserRequest, request: Request):
    _require_admin(request)
    try:
        business_id = META_REVIEW_BUSINESS_ID if body.role == "meta_reviewer" else body.business_id
        account = get_user_repository().create(name=body.name, email=body.email, password=body.password, role=body.role, business_id=business_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"user": {"id": account.id, "name": account.name, "email": account.email, "role": account.role, "business_id": account.business_id, "active": account.active}}


@router.patch("/users/{user_id}/disable", status_code=status.HTTP_204_NO_CONTENT)
async def disable_user(user_id: str, request: Request):
    _require_admin(request)
    if request.state.user.id == user_id:
        raise HTTPException(status_code=422, detail="No podés deshabilitar tu propia cuenta.")
    repository = get_user_repository()
    account = next((user for user in repository.list() if user.id == user_id), None)
    repository.set_active(user_id, False)
    if account:
        _service.sign_out_email(account.email)
    return Response(status_code=204)


@router.patch("/users/{user_id}/password", status_code=status.HTTP_204_NO_CONTENT)
async def reset_user_password(user_id: str, body: ResetPasswordRequest, request: Request):
    _require_admin(request)
    try:
        repository = get_user_repository()
        account = next((user for user in repository.list() if user.id == user_id), None)
        repository.reset_password(user_id, body.password)
        if account:
            _service.sign_out_email(account.email)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return Response(status_code=204)
