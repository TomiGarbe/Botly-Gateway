import time
import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware
from fastapi import Request

from app.core.logging import get_logger

logger = get_logger(__name__)


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    """Loguea cada request con tenant/instancia, duración y status code."""

    async def dispatch(self, request: Request, call_next):
        request_id = str(uuid.uuid4())[:8]
        start = time.perf_counter()

        # Extraer instanceName de la ruta si viene (/instances/{name}/...)
        path_parts = request.url.path.strip("/").split("/")
        instance_name = None
        if len(path_parts) >= 2 and path_parts[0] == "instances":
            instance_name = path_parts[1]

        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(
            request_id=request_id,
            instance=instance_name,
            method=request.method,
            path=request.url.path,
        )

        response = await call_next(request)

        duration_ms = round((time.perf_counter() - start) * 1000, 2)
        logger.info(
            "request",
            status=response.status_code,
            duration_ms=duration_ms,
        )

        return response
