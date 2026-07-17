from __future__ import annotations

from typing import Any

from app.core.logging import get_logger

logger = get_logger("app.audit")

SECRET_KEYS = {"token", "access_token", "apiKey", "api_key", "password", "secret", "client_secret"}


def _safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: ("[redacted]" if key in SECRET_KEYS or "secret" in key.lower() or "token" in key.lower() else _safe(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe(item) for item in value]
    return value


def audit_event(event: str, **fields: Any) -> None:
    logger.info("audit_event", auditEvent=event, **_safe(fields))
