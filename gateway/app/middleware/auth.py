from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.services.google_auth import get_auth_service


_PUBLIC_PATHS = {"/webhooks/evolution", "/webhooks/meta"}
_PUBLIC_PREFIXES = ("/auth/",)
_COOKIE = "botly_gateway_session"


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.method == "OPTIONS":
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)
        if any(request.url.path.startswith(prefix) for prefix in _PUBLIC_PREFIXES):
            return await call_next(request)
        user = get_auth_service().current_user(request.cookies.get(_COOKIE, ""))
        if user is None:
            return JSONResponse(status_code=401, content={"detail": "Iniciá sesión para continuar."})
        request.state.user = user
        return await call_next(request)
