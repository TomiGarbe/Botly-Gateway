import hmac

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import get_settings
from app.services.google_auth import get_auth_service


_PUBLIC_PATHS = {"/health", "/webhooks/evolution", "/webhooks/meta"}
_PUBLIC_PREFIXES = ("/auth/",)
_COOKIE = "botly_gateway_session"


def _gateway_api_key(request: Request) -> str:
    direct = str(request.headers.get("x-api-key") or "").strip()
    if direct:
        return direct
    authorization = str(request.headers.get("authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return ""


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)
        if any(request.url.path.startswith(prefix) for prefix in _PUBLIC_PREFIXES):
            return await call_next(request)
        expected_key = str(get_settings().gateway_api_key or "").strip()
        provided_key = _gateway_api_key(request)
        if expected_key and provided_key and hmac.compare_digest(provided_key, expected_key):
            request.state.auth_method = "gateway_api_key"
            return await call_next(request)
        user = get_auth_service().current_user(request.cookies.get(_COOKIE, ""))
        if user is None:
            return JSONResponse(status_code=401, content={"detail": "Iniciá sesión para continuar."})
        request.state.user = user
        return await call_next(request)
