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
    safe_fields = _safe(fields)
    logger.info("audit_event", auditEvent=event, **safe_fields)
    # Audit records are operational activity too.  Keeping this bridge here
    # makes existing important actions visible without duplicating their logic.
    try:
        from app.services.normalization import save_pipeline_event

        instance = str(safe_fields.get("instance") or "").strip() or None
        failed = "failed" in event or "invalid" in event
        save_pipeline_event(
            stage=event,
            status="failed" if failed else "completed",
            instance=instance,
            event=f"AUDIT_{event.upper()}",
            details=safe_fields,
            component="Gateway",
            severity="ERROR" if failed else "SUCCESS",
        )
    except Exception as exc:
        # Observability must never interrupt the business operation it observes.
        logger.warning("audit_activity_record_failed", auditEvent=event, error=str(exc))
