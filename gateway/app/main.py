from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address

from app.core.config import get_settings
from app.core.logging import setup_logging, get_logger
from app.middleware.auth import AuthMiddleware
from app.middleware.logging import RequestLoggingMiddleware
from app.routers import instances, messages, webhooks

settings = get_settings()
setup_logging(settings.log_level)
logger = get_logger(__name__)

# Rate limiter — usa IP como clave por defecto
limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit_default])


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("gateway_starting", port=settings.gateway_port, evolution_url=settings.evolution_url)
    yield
    logger.info("gateway_stopped")


app = FastAPI(
    title="Botly Evolution Gateway",
    version="1.0.0",
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

# Middlewares — en Starlette `add_middleware` inserta al inicio de la pila:
# el ÚLTIMO agregado es el MÁS EXTERNO. CORS tiene que ir último para:
#   1) responder el preflight OPTIONS antes que AuthMiddleware,
#   2) agregar headers Access-Control-* también a respuestas de error.
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

app.add_middleware(RequestLoggingMiddleware)
app.add_middleware(AuthMiddleware)
app.add_middleware(SlowAPIMiddleware)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],   # en producción reemplazar por el dominio del frontend
    allow_methods=["*"],
    allow_headers=["*"],
)

# Routers
app.include_router(instances.router)
app.include_router(messages.router)
app.include_router(webhooks.router)


@app.get("/health", tags=["system"])
async def health():
    return {"status": "ok", "service": "evolution-gateway"}


@app.exception_handler(Exception)
async def unhandled_exception_handler(request, exc):
    logger.error("unhandled_exception", path=str(request.url.path), error=str(exc))
    return JSONResponse(status_code=500, content={"detail": "Error interno del servidor"})
