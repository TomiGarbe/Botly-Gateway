from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)

# Endpoints que no requieren auth (health check, webhooks de Evolution)
_PUBLIC_PATHS = {"/health", "/webhooks/evolution"}
_PUBLIC_PREFIXES = ("/media/upload/",)


class AuthMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        # Dejar pasar el preflight CORS — el browser no manda headers custom en OPTIONS
        if request.method == "OPTIONS":
            return await call_next(request)

        if request.url.path in _PUBLIC_PATHS:
            return await call_next(request)
        if any(request.url.path.startswith(prefix) for prefix in _PUBLIC_PREFIXES):
            return await call_next(request)

        api_key = request.headers.get("X-API-Key")
        settings = get_settings()

        if not api_key or api_key != settings.gateway_api_key:
            logger.warning(
                "auth_failed",
                path=request.url.path,
                ip=request.client.host if request.client else "unknown",
            )
            # Devolvemos Response en vez de raise — un HTTPException dentro de
            # BaseHTTPMiddleware se propaga por collapse_excgroups y rompe la respuesta.
            return JSONResponse(
                status_code=401,
                content={"detail": "API key inválida o ausente"},
            )

        return await call_next(request)
