"""Remember Evolution's last connection state so the panel can explain failed QR links."""

from datetime import datetime, timezone
from typing import Any

from app.services.connection_registry import get_connection_registry

_STATES = {"open", "connecting", "close"}


def record_connection_update(payload: dict[str, Any], *, registry=None) -> bool:
    if str(payload.get("event") or "").lower().replace("_", ".") != "connection.update":
        return False
    data = payload.get("data") if isinstance(payload.get("data"), dict) else {}
    state = data.get("state")
    if state not in _STATES:
        return False
    registry = registry or get_connection_registry()
    record = registry.connection_record(str(payload.get("instance") or ""))
    if not record:
        return False
    reason = data.get("statusReason")
    current = record.get("provider_session") or {}
    if current.get("state") == state and current.get("statusReason") == reason:
        return False  # QR cycles repeat "connecting"; avoid rewriting the registry
    registry.update_connection_record(record["id"], {"provider_session": {
        "state": state, "statusReason": reason, "at": datetime.now(timezone.utc).isoformat(),
    }})
    return True
