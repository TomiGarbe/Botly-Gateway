from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from app.core.config import get_settings
from app.services.google_auth import GoogleAccessDeniedError, GoogleTokenValidationError, get_auth_service


router = APIRouter(prefix="/auth", tags=["auth"])
_service = get_auth_service()
_COOKIE = "botly_gateway_session"


class GoogleLoginRequest(BaseModel):
    credential: str = Field(min_length=20, max_length=8192)


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
