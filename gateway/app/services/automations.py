"""Provider-neutral operational automation engine.

The scheduler only decides *when* an automation runs.  This module owns the
definition, condition evaluation, execution history and action registry so
new providers can be added without changing scheduling infrastructure.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Awaitable, Callable, Iterable

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)
_LOCK = threading.Lock()
TRIGGER_TYPES = {
    "manual", "schedule", "interval", "hourly", "daily", "weekly", "monthly",
    "state_change", "event_received", "error_detected", "webhook",
    "provisioning_completed", "smoke_test_completed", "connection_created",
}
ACTION_TYPES = {
    "run_smoke_test", "reconnect_connection", "retry_provisioning", "refresh_health",
    "refresh_dashboard", "create_alert", "close_alert", "register_event", "register_audit",
}
ACTIVE_STATUSES = {"active", "paused", "error"}
EVENT_TRIGGERS = TRIGGER_TYPES - {"manual", "schedule", "interval", "hourly", "daily", "weekly", "monthly"}


def _now() -> int:
    return int(time.time() * 1000)


def _path() -> Path:
    return Path(str(getattr(get_settings(), "automations_path", "/tmp/botly_automations.json")))


def _read_unlocked() -> dict[str, Any]:
    path = _path()
    if not path.exists():
        return {"automations": [], "executions": []}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict) and isinstance(raw.get("automations"), list) and isinstance(raw.get("executions"), list):
            return raw
    except Exception as exc:
        logger.warning("automation_store_read_failed", path=str(path), error=str(exc))
    return {"automations": [], "executions": []}


def _write_unlocked(payload: dict[str, Any]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    try:
        os.chmod(temp, 0o600)
    except OSError:
        pass
    temp.replace(path)


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _safe_trigger(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    kind = str(source.get("type") or "manual").lower()
    if kind not in TRIGGER_TYPES:
        raise ValueError("Tipo de trigger no soportado")
    result = {"type": kind}
    if kind == "interval":
        result["intervalMinutes"] = max(1, min(_as_int(source.get("intervalMinutes"), 60), 43_200))
    if kind == "schedule":
        result["at"] = str(source.get("at") or "00:00")[:5]
    if kind in EVENT_TRIGGERS:
        result["event"] = str(source.get("event") or "").strip() or None
    return result


def _safe_conditions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    conditions: list[dict[str, Any]] = []
    for item in value[:20]:
        if not isinstance(item, dict) or not str(item.get("field") or "").strip():
            continue
        conditions.append({
            "field": str(item["field"]).strip(),
            "operator": str(item.get("operator") or "equals").lower(),
            "value": item.get("value"),
        })
    return conditions


def _safe_actions(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise ValueError("Una automatización requiere al menos una acción")
    actions: list[dict[str, Any]] = []
    for item in value[:10]:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "").lower()
        if kind not in ACTION_TYPES:
            raise ValueError(f"Acción no soportada: {kind}")
        params = item.get("params") if isinstance(item.get("params"), dict) else {}
        actions.append({"type": kind, "params": params})
    if not actions:
        raise ValueError("Una automatización requiere acciones válidas")
    return actions


def _safe_retry(value: Any) -> dict[str, Any]:
    source = value if isinstance(value, dict) else {}
    attempts = _as_int(source.get("maxAttempts"), 0)
    if attempts not in {0, 1, 3}:
        attempts = 0
    return {"maxAttempts": attempts, "backoff": bool(source.get("backoff", False))}


def _next_run(trigger: dict[str, Any], from_ms: int | None = None) -> int | None:
    now = from_ms or _now()
    kind = trigger.get("type")
    if kind == "interval":
        return now + _as_int(trigger.get("intervalMinutes"), 60) * 60_000
    cadence = {"hourly": 3_600_000, "daily": 86_400_000, "weekly": 7 * 86_400_000, "monthly": 30 * 86_400_000}
    if kind in cadence:
        return now + cadence[kind]
    if kind == "schedule":
        hour, _, minute = str(trigger.get("at") or "00:00").partition(":")
        target = (now // 86_400_000) * 86_400_000 + max(0, min(_as_int(hour), 23)) * 3_600_000 + max(0, min(_as_int(minute), 59)) * 60_000
        return target if target > now else target + 86_400_000
    return None


def _public(item: dict[str, Any]) -> dict[str, Any]:
    return dict(item)


def create_automation(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()[:120]
    if not name:
        raise ValueError("El nombre es obligatorio")
    trigger = _safe_trigger(payload.get("trigger"))
    now = _now()
    item = {
        "id": str(uuid.uuid4()), "name": name, "description": str(payload.get("description") or "").strip()[:500] or None,
        "status": "active", "provider": str(payload.get("provider") or "").strip() or None,
        "company": str(payload.get("company") or "").strip() or None,
        "connection": str(payload.get("connection") or "").strip() or None,
        "trigger": trigger, "conditions": _safe_conditions(payload.get("conditions")),
        "actions": _safe_actions(payload.get("actions")), "retryPolicy": _safe_retry(payload.get("retryPolicy")),
        "createdAt": now, "updatedAt": now, "lastExecutionAt": None, "lastResult": None,
        "nextExecutionAt": _next_run(trigger, now),
    }
    with _LOCK:
        store = _read_unlocked()
        store["automations"].append(item)
        _write_unlocked(store)
    return _public(item)


def list_automations(*, status: str | None = None, connection: str | None = None) -> list[dict[str, Any]]:
    with _LOCK:
        items = list(_read_unlocked()["automations"])
    return sorted([_public(item) for item in items if (not status or item.get("status") == status) and (not connection or item.get("connection") in {None, "", connection})], key=lambda item: _as_int(item.get("updatedAt")), reverse=True)


def get_automation(automation_id: str) -> dict[str, Any] | None:
    return next((item for item in list_automations() if item.get("id") == automation_id), None)


def update_automation(automation_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "description", "provider", "company", "connection", "status", "trigger", "conditions", "actions", "retryPolicy"}
    with _LOCK:
        store = _read_unlocked()
        item = next((value for value in store["automations"] if value.get("id") == automation_id), None)
        if not item:
            return None
        if "status" in payload:
            status = str(payload["status"]).lower()
            if status not in ACTIVE_STATUSES:
                raise ValueError("Estado de automatización inválido")
            item["status"] = status
        for key in allowed & payload.keys():
            if key == "status":
                continue
            if key == "trigger":
                item[key] = _safe_trigger(payload[key])
                item["nextExecutionAt"] = _next_run(item[key])
            elif key == "conditions":
                item[key] = _safe_conditions(payload[key])
            elif key == "actions":
                item[key] = _safe_actions(payload[key])
            elif key == "retryPolicy":
                item[key] = _safe_retry(payload[key])
            else:
                item[key] = str(payload[key]).strip()[:500] or None
        item["updatedAt"] = _now()
        _write_unlocked(store)
        return _public(item)


def list_executions(*, automation_id: str | None = None, connection: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    with _LOCK:
        items = list(_read_unlocked()["executions"])
    matched = [item for item in items if (not automation_id or item.get("automationId") == automation_id) and (not connection or item.get("connection") == connection)]
    return sorted((_public(item) for item in matched), key=lambda item: _as_int(item.get("startedAt")), reverse=True)[:max(1, min(limit, 1000))]


def summary() -> dict[str, Any]:
    automations = list_automations()
    executions = list_executions(limit=20)
    return {
        "active": sum(item.get("status") == "active" for item in automations),
        "paused": sum(item.get("status") == "paused" for item in automations),
        "errors": sum(item.get("status") == "error" for item in automations),
        "failedExecutions": sum(item.get("status") == "failed" for item in executions),
        "recentExecutions": executions[:8],
    }


def _condition_value(instance: dict[str, Any] | None, event: dict[str, Any] | None, field: str) -> Any:
    instance = instance or {}
    event = event or {}
    if field == "status": return instance.get("status")
    if field == "health": return instance.get("health")
    if field == "provider": return instance.get("connectionType") or instance.get("integration")
    if field == "company": return instance.get("profileName")
    if field == "event": return event.get("event")
    if field == "result": return event.get("result") or (event.get("pipeline") or {}).get("status")
    if field == "severity": return event.get("severity")
    if field == "inactive":
        last_seen = _as_int(instance.get("lastSeen"))
        return bool(last_seen and _now() - last_seen > 7 * 86_400_000)
    if field == "smoke_test_failed":
        return str(event.get("event") or "") == "SMOKE_TEST" and str(event.get("result") or "").lower() in {"failed", "error"}
    return None


def _matches_conditions(automation: dict[str, Any], instance: dict[str, Any] | None, event: dict[str, Any] | None) -> bool:
    for condition in automation.get("conditions") or []:
        actual = _condition_value(instance, event, str(condition.get("field") or ""))
        expected = condition.get("value")
        operator = condition.get("operator")
        if operator == "equals" and str(actual).lower() != str(expected).lower(): return False
        if operator == "not_equals" and str(actual).lower() == str(expected).lower(): return False
        if operator == "less_than" and not (_as_int(actual, 10**9) < _as_int(expected)): return False
        if operator == "greater_than" and not (_as_int(actual) > _as_int(expected)): return False
        if operator == "is_true" and actual is not True: return False
        if operator == "is_false" and actual is not False: return False
    return True


async def _execute_action(action: dict[str, Any], *, instance: dict[str, Any] | None, execution_id: str) -> dict[str, Any]:
    """Small action registry; unsupported provider-specific work is explicit."""
    kind = action["type"]
    params = action.get("params") or {}
    connection = str((instance or {}).get("name") or params.get("connection") or "").strip() or None
    from app.services.normalization import save_pipeline_event
    from app.services.audit import audit_event

    if kind == "reconnect_connection":
        if not connection:
            raise RuntimeError("La acción requiere una conexión")
        from app.connections import get_connection_manager
        await get_connection_manager().reconnect(connection)
        audit_event("automation_reconnect", instance=connection, automationExecutionId=execution_id)
        return {"status": "succeeded", "message": "Reconexión solicitada al proveedor."}
    if kind == "create_alert":
        from app.services.alerts import create_manual_alert
        create_manual_alert(alert_type=str(params.get("alertType") or "automation_attention"), severity=str(params.get("severity") or "MEDIUM"), connection=connection, company=(instance or {}).get("profileName"), component=str(params.get("component") or "Automation"), message=str(params.get("message") or "Una automatización requiere atención."), action=str(params.get("action") or "Revisa el historial de automatizaciones."))
        return {"status": "succeeded", "message": "Alerta operativa registrada."}
    if kind == "close_alert":
        from app.services.alerts import update_alert
        alert_id = str(params.get("alertId") or "")
        if not alert_id or not update_alert(alert_id, status="resolved"):
            raise RuntimeError("No se encontró la alerta a cerrar")
        return {"status": "succeeded", "message": "Alerta resuelta."}
    if kind == "register_audit":
        audit_event(str(params.get("event") or "automation_executed"), instance=connection, automationExecutionId=execution_id)
        return {"status": "succeeded", "message": "Auditoría registrada."}
    if kind in {"register_event", "refresh_health", "refresh_dashboard"}:
        save_pipeline_event(stage="automation", status="completed", instance=connection, request_id=execution_id, event="AUTOMATION_ACTION", component="Automation", severity="SUCCESS", details={"action": kind, "params": params, "automationSource": True}, action="Consulta el historial de automatizaciones.")
        return {"status": "succeeded", "message": "Evento operativo registrado."}
    # These actions are present in the generic contract but need a provider-side
    # executor. Recording a skipped result is more honest than simulating work.
    return {"status": "skipped", "message": f"La acción {kind} está preparada, pero no tiene ejecutor de backend disponible."}


async def execute_automation(automation_id: str, *, instances: Iterable[dict[str, Any]], trigger: str = "manual", event: dict[str, Any] | None = None, operator: str | None = None) -> dict[str, Any] | None:
    automation = get_automation(automation_id)
    if not automation:
        return None
    targets = [item for item in instances if not automation.get("connection") or item.get("name") == automation.get("connection")]
    if not targets:
        targets = [None]
    started = _now()
    execution = {"id": str(uuid.uuid4()), "automationId": automation_id, "automationName": automation["name"], "connection": automation.get("connection"), "trigger": trigger, "operator": operator, "startedAt": started, "completedAt": None, "durationMs": None, "status": "running", "attempts": [], "logs": [], "error": None}
    with _LOCK:
        store = _read_unlocked(); store["executions"].append(execution); _write_unlocked(store)
    try:
        any_success = False
        all_skipped = True
        for target in targets:
            if not _matches_conditions(automation, target, event):
                execution["logs"].append({"level": "INFO", "message": "Condiciones no cumplidas; ejecución omitida."})
                continue
            for action in automation["actions"]:
                attempts = max(1, _as_int((automation.get("retryPolicy") or {}).get("maxAttempts"), 0) + 1)
                for attempt in range(1, attempts + 1):
                    attempt_started = _now()
                    try:
                        result = await _execute_action(action, instance=target, execution_id=execution["id"])
                        execution["attempts"].append({"action": action["type"], "attempt": attempt, "startedAt": attempt_started, "completedAt": _now(), **result})
                        execution["logs"].append({"level": "INFO", "message": result["message"]})
                        any_success = any_success or result["status"] == "succeeded"
                        all_skipped = all_skipped and result["status"] == "skipped"
                        break
                    except Exception as exc:
                        execution["attempts"].append({"action": action["type"], "attempt": attempt, "startedAt": attempt_started, "completedAt": _now(), "status": "failed", "message": str(exc)[:500]})
                        if attempt == attempts:
                            raise
                        if (automation.get("retryPolicy") or {}).get("backoff"):
                            await asyncio.sleep(min(2 ** (attempt - 1), 8))
        execution["status"] = "skipped" if all_skipped and not any_success else "succeeded"
    except Exception as exc:
        execution["status"] = "failed"; execution["error"] = str(exc)[:500]
        logger.warning("automation_execution_failed", automation_id=automation_id, error=str(exc))
    execution["completedAt"] = _now(); execution["durationMs"] = execution["completedAt"] - started
    with _LOCK:
        store = _read_unlocked()
        stored = next((item for item in store["executions"] if item.get("id") == execution["id"]), None)
        if stored: stored.update(execution)
        item = next((item for item in store["automations"] if item.get("id") == automation_id), None)
        if item:
            item["lastExecutionAt"] = execution["completedAt"]; item["lastResult"] = execution["status"]
            item["nextExecutionAt"] = _next_run(item.get("trigger") or {}, execution["completedAt"])
            item["status"] = "error" if execution["status"] == "failed" else item.get("status", "active")
            item["updatedAt"] = _now()
        _write_unlocked(store)
    return _public(execution)


async def run_due_automations(*, instances: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    now = _now(); executed = []
    for automation in list_automations(status="active"):
        if automation.get("trigger", {}).get("type") in EVENT_TRIGGERS | {"manual"}: continue
        if _as_int(automation.get("nextExecutionAt")) <= now:
            result = await execute_automation(automation["id"], instances=instances, trigger="scheduler")
            if result: executed.append(result)
    return executed


def _event_trigger(event: dict[str, Any]) -> str | None:
    name = str(event.get("event") or "").upper()
    stage = str((event.get("pipeline") or {}).get("stage") or "").lower()
    result = str(event.get("result") or "").lower()
    if name == "SMOKE_TEST": return "smoke_test_completed"
    if "webhook" in name.lower() or "webhook" in stage: return "webhook"
    if name == "AUDIT_CONNECTION_CREATED": return "connection_created"
    if "provision" in stage and result in {"completed", "ready", "passed"}: return "provisioning_completed"
    if str(event.get("severity") or "").upper() in {"ERROR", "CRITICAL"} or result in {"failed", "error"}: return "error_detected"
    return "event_received"


async def dispatch_event_automations(event: dict[str, Any], *, instances: Iterable[dict[str, Any]]) -> list[dict[str, Any]]:
    if (event.get("details") or {}).get("automationSource"):
        return []
    trigger = _event_trigger(event); executed = []
    for automation in list_automations(status="active"):
        configured = automation.get("trigger") or {}
        if configured.get("type") != trigger: continue
        expected = configured.get("event")
        if expected and expected != event.get("event"): continue
        result = await execute_automation(automation["id"], instances=instances, trigger=trigger, event=event)
        if result: executed.append(result)
    return executed


class AutomationScheduler:
    def __init__(self, instance_supplier: Callable[[], Awaitable[list[dict[str, Any]]]]):
        self._instance_supplier = instance_supplier
        self._task: asyncio.Task | None = None
        self._stopping = False

    async def _loop(self) -> None:
        while not self._stopping:
            try:
                await run_due_automations(instances=await self._instance_supplier())
            except Exception as exc:
                logger.warning("automation_scheduler_tick_failed", error=str(exc))
            await asyncio.sleep(60)

    def start(self) -> None:
        if self._task is None and bool(getattr(get_settings(), "automation_scheduler_enabled", True)):
            self._task = asyncio.create_task(self._loop(), name="automation-scheduler")

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None
