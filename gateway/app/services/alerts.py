from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Iterable

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)
_LOCK = threading.Lock()
_ACTIVE_STATES = {"new", "acknowledged", "in_progress"}
_ALL_STATES = _ACTIVE_STATES | {"resolved", "dismissed"}
_SEVERITIES = {"INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _path() -> Path:
    return Path(str(getattr(get_settings(), "alerts_path", "/tmp/botly_alerts.json")))


def _read_unlocked() -> dict[str, Any]:
    path = _path()
    if not path.exists():
        return {"alerts": []}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) and isinstance(value.get("alerts"), list) else {"alerts": []}
    except Exception as exc:
        logger.warning("alerts_store_read_failed", path=str(path), error=str(exc))
        return {"alerts": []}


def _write_unlocked(payload: dict[str, Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    try:
        os.chmod(temporary, 0o600)
    except OSError:
        pass
    temporary.replace(path)


def _timestamp(value: Any) -> int:
    try:
        number = int(value)
        return number * 1000 if number and number < 1_000_000_000_000 else number
    except (TypeError, ValueError):
        return 0


def _severity(event: dict[str, Any]) -> str:
    explicit = str(event.get("severity") or "").upper()
    if explicit in {"ERROR", "CRITICAL"}:
        return explicit
    text = f"{event.get('event', '')} {((event.get('pipeline') or {}).get('status', ''))}".lower()
    return "ERROR" if any(token in text for token in ("failed", "error", "fail", "dropped")) else "WARNING" if "warning" in text or "retry" in text else "INFO"


def _component(event: dict[str, Any]) -> str:
    explicit = str(event.get("component") or "").strip()
    if explicit:
        return explicit
    text = f"{event.get('event', '')} {((event.get('pipeline') or {}).get('stage', ''))}".lower()
    if any(value in text for value in ("meta", "oauth", "token", "discovery", "phone")):
        return "Meta"
    if "webhook" in text or "dispatch" in text:
        return "Webhook"
    if "evolution" in text:
        return "Evolution"
    if "message" in text or "send" in text:
        return "Mensajería"
    return "Gateway"


def _instance_state(instance: dict[str, Any]) -> str:
    lifecycle = str(instance.get("lifecycleState") or "")
    health = str(instance.get("health") or "")
    status = str(instance.get("status") or "")
    if lifecycle in {"failed", "token_expired", "webhook_invalid"} or health == "unhealthy":
        return "error"
    if lifecycle in {"provisioning", "configured"} or status == "connecting":
        return "provisioning"
    if lifecycle in {"warning", "needs_attention"} or health == "degraded":
        return "warning"
    return "ready" if status == "open" else "disconnected"


def _candidate(*, alert_type: str, severity: str, instance: dict[str, Any], component: str, message: str, action: str, evidence: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "type": alert_type,
        "severity": severity,
        "company": instance.get("profileName") or None,
        "connection": instance.get("name"),
        "component": component,
        "message": message,
        "action": action,
        "evidence": evidence or {},
    }


def evaluate_alerts(instances: Iterable[dict[str, Any]], events: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    """Persist only actionable conditions derived from existing data."""
    now = _now_ms()
    by_instance: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        name = str(event.get("instance") or "").strip()
        if name:
            by_instance.setdefault(name, []).append(event)
    candidates: list[dict[str, Any]] = []
    for instance in instances:
        name = str(instance.get("name") or "").strip()
        if not name:
            continue
        own_events = sorted(by_instance.get(name, []), key=lambda item: _timestamp(item.get("timestamp")), reverse=True)
        state = _instance_state(instance)
        created = _timestamp(instance.get("createdAt"))
        last_seen = _timestamp(instance.get("lastSeen"))
        error_events = [event for event in own_events if _severity(event) in {"ERROR", "CRITICAL"}]
        recent_errors = [event for event in error_events if now - _timestamp(event.get("timestamp")) <= 24 * 3600 * 1000]
        webhook_events = [event for event in own_events if _component(event) == "Webhook"]
        smoke_failures = [event for event in error_events if "smoke" in f"{event.get('event', '')} {(event.get('pipeline') or {}).get('stage', '')}".lower()]
        reconnects = [event for event in own_events if "reconnect" in f"{event.get('event', '')} {(event.get('pipeline') or {}).get('stage', '')}".lower() and now - _timestamp(event.get("timestamp")) <= 24 * 3600 * 1000]
        retries = sum(int((event.get("details") or {}).get("retriesUsed") or (event.get("details") or {}).get("retryCount") or 0) for event in own_events if isinstance(event.get("details"), dict))

        if state == "provisioning":
            candidates.append(_candidate(alert_type="provisioning_incomplete", severity="MEDIUM", instance=instance, component="Provisioning", message="El provisioning de la conexión sigue incompleto.", action="Abre el Workspace y retoma la etapa indicada por el onboarding."))
        if state == "error":
            component = "Meta" if str(instance.get("lifecycleState") or "") == "token_expired" else "Webhook" if str(instance.get("lifecycleState") or "") == "webhook_invalid" else "Gateway"
            candidates.append(_candidate(alert_type="connection_not_ready", severity="HIGH", instance=instance, component=component, message="La conexión perdió su estado operativo READY.", action="Abre Diagnóstico, corrige el componente afectado y vuelve a comprobar la conexión."))
        if str(instance.get("lifecycleState") or "") == "token_expired":
            candidates.append(_candidate(alert_type="credentials_invalid", severity="HIGH", instance=instance, component="Meta", message="Las credenciales de la conexión requieren renovación.", action="Vuelve a conectar la cuenta oficial desde el Workspace."))
        if smoke_failures:
            candidates.append(_candidate(alert_type="smoke_test_failed", severity="HIGH", instance=instance, component="Centro de Pruebas", message="El último Smoke Test disponible falló.", action="Abre el Centro de Pruebas y revisa el detalle antes de reintentar.", evidence={"eventId": smoke_failures[0].get("id")}))
        if len(recent_errors) >= 3:
            candidates.append(_candidate(alert_type="repeated_errors", severity="HIGH", instance=instance, component=_component(recent_errors[0]), message="Se registraron errores repetidos durante las últimas 24 horas.", action="Abre el Centro de Actividad para identificar la causa común.", evidence={"count": len(recent_errors)}))
        if len(reconnects) >= 3:
            candidates.append(_candidate(alert_type="frequent_reconnects", severity="MEDIUM", instance=instance, component="Gateway", message="La conexión requirió varias reconexiones en las últimas 24 horas.", action="Revisa la estabilidad del proveedor y ejecuta un Smoke Test.", evidence={"count": len(reconnects)}))
        if retries >= 3:
            candidates.append(_candidate(alert_type="many_retries", severity="MEDIUM", instance=instance, component="Webhook", message="La actividad disponible registra varios reintentos.", action="Revisa el destino del webhook y sus últimos errores.", evidence={"count": retries}))
        # Do not warn brand-new connections: this rule only uses established
        # connections for which a full day of observation is available.
        age = now - (created or last_seen)
        if state == "ready" and age > 24 * 3600 * 1000 and not webhook_events:
            candidates.append(_candidate(alert_type="webhook_without_events", severity="MEDIUM", instance=instance, component="Webhook", message="No hay eventos de webhook registrados para una conexión ya operativa.", action="Revisa el callback y envía un mensaje entrante de verificación."))
        last_activity = max([last_seen, *[_timestamp(event.get("timestamp")) for event in own_events]], default=0)
        if state == "ready" and last_activity and now - last_activity > 7 * 24 * 3600 * 1000:
            candidates.append(_candidate(alert_type="connection_inactive", severity="LOW", instance=instance, component="Mensajería", message="La conexión no registra actividad durante más de siete días.", action="Confirma si la conexión sigue en uso o ejecuta un Smoke Test."))
    return _upsert_candidates(candidates)


def _upsert_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    now = _now_ms()
    with _LOCK:
        payload = _read_unlocked()
        alerts = [item for item in payload.get("alerts", []) if isinstance(item, dict)]
        existing = {(str(item.get("type")), str(item.get("connection"))): item for item in alerts}
        changed = False
        for candidate in candidates:
            key = (str(candidate["type"]), str(candidate["connection"]))
            item = existing.get(key)
            if item:
                # A manually resolved/dismissed incident stays historical; a
                # future rule engine can explicitly reopen it on a new episode.
                if str(item.get("status")) in _ACTIVE_STATES:
                    item.update({**candidate, "updatedAt": now})
                    changed = True
                continue
            alerts.append({"id": str(uuid.uuid4()), "status": "new", "createdAt": now, "updatedAt": now, **candidate})
            changed = True
        if changed:
            payload["alerts"] = alerts
            _write_unlocked(payload)
        return sorted(alerts, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)


def list_alerts(*, status: str | None = None, severity: str | None = None, instance: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    with _LOCK:
        items = [item for item in _read_unlocked().get("alerts", []) if isinstance(item, dict)]
    result = [item for item in items if (not status or item.get("status") == status) and (not severity or item.get("severity") == severity) and (not instance or item.get("connection") == instance)]
    return sorted(result, key=lambda item: int(item.get("updatedAt") or 0), reverse=True)[: max(1, min(limit, 1000))]


def update_alert(alert_id: str, *, status: str) -> dict[str, Any] | None:
    if status not in _ALL_STATES:
        return None
    with _LOCK:
        payload = _read_unlocked()
        for item in payload.get("alerts", []):
            if isinstance(item, dict) and item.get("id") == alert_id:
                item["status"] = status
                item["updatedAt"] = _now_ms()
                _write_unlocked(payload)
                return item
    return None


def create_manual_alert(*, alert_type: str, severity: str, connection: str | None, company: str | None, component: str, message: str, action: str) -> dict[str, Any]:
    """Persist an actionable incident created by an automation or operator."""
    level = severity.upper()
    if level not in _SEVERITIES:
        level = "MEDIUM"
    now = _now_ms()
    item = {
        "id": str(uuid.uuid4()), "type": alert_type[:80], "severity": level, "status": "new",
        "company": company, "connection": connection, "component": component[:120],
        "createdAt": now, "updatedAt": now, "message": message[:500], "action": action[:500],
        "evidence": {"source": "automation"},
    }
    with _LOCK:
        payload = _read_unlocked()
        payload["alerts"].append(item)
        _write_unlocked(payload)
    return item


def alert_summary(items: Iterable[dict[str, Any]]) -> dict[str, Any]:
    active = [item for item in items if str(item.get("status")) in _ACTIVE_STATES]
    by_severity = {severity: sum(1 for item in active if item.get("severity") == severity) for severity in sorted(_SEVERITIES)}
    by_connection: dict[str, int] = {}
    for item in active:
        connection = str(item.get("connection") or "")
        if connection:
            by_connection[connection] = by_connection.get(connection, 0) + 1
    return {"active": len(active), "critical": by_severity["CRITICAL"], "bySeverity": by_severity, "byConnection": by_connection}
