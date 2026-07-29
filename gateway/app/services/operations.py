"""Persistent, provider-neutral bulk operation queue.

Jobs snapshot their targets when enqueued.  UI callers only create jobs; the
worker claims and executes them independently, making the store replaceable by
a distributed queue in a future deployment.
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
OPERATION_TYPES = {
    "smoke_test", "reconnect", "provisioning_retry", "credentials_revalidate",
    "health_refresh", "reindex", "synchronize", "export", "import", "retry",
}
JOB_STATUSES = {"pending", "running", "completed", "error", "cancelled", "retrying"}


def _now() -> int: return int(time.time() * 1000)
def _as_int(value: Any, default: int = 0) -> int:
    try: return int(value)
    except (TypeError, ValueError): return default
def _path() -> Path: return Path(str(getattr(get_settings(), "operations_path", "/tmp/botly_operations.json")))


def _read_unlocked() -> dict[str, Any]:
    path = _path()
    if not path.exists(): return {"jobs": [], "workers": {}}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(value, dict) and isinstance(value.get("jobs"), list):
            value.setdefault("workers", {})
            return value
    except Exception as exc:
        logger.warning("operations_store_read_failed", path=str(path), error=str(exc))
    return {"jobs": [], "workers": {}}


def _write_unlocked(payload: dict[str, Any]) -> None:
    path = _path(); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=True, separators=(",", ":")), encoding="utf-8")
    try: os.chmod(temporary, 0o600)
    except OSError: pass
    temporary.replace(path)


def _progress(job: dict[str, Any]) -> dict[str, Any]:
    results = [item for item in job.get("results", []) if isinstance(item, dict)]
    total = len(job.get("targets", []))
    completed = sum(item.get("status") in {"completed", "skipped"} for item in results)
    errors = sum(item.get("status") == "error" for item in results)
    processed = completed + errors
    started = _as_int(job.get("startedAt")); elapsed = max(0, (_now() - started) if started else 0)
    velocity = round(processed / (elapsed / 1000), 2) if elapsed and processed else None
    remaining = total - processed
    estimated = round(remaining / velocity * 1000) if velocity else None
    return {"total": total, "completed": completed, "pending": max(0, total - processed), "errors": errors, "durationMs": elapsed or None, "velocityPerSecond": velocity, "estimatedRemainingMs": estimated}


def _public(job: dict[str, Any]) -> dict[str, Any]:
    item = dict(job); item["progress"] = _progress(item); return item


def create_job(*, operation_type: str, targets: list[str], operator: str | None = None, policy: dict[str, Any] | None = None, source_job_id: str | None = None) -> dict[str, Any]:
    kind = str(operation_type or "").lower()
    if kind not in OPERATION_TYPES: raise ValueError("Tipo de operación no soportado")
    unique = list(dict.fromkeys(str(item).strip() for item in targets if str(item).strip()))
    if not unique: raise ValueError("La operación requiere al menos una conexión")
    max_attempts = _as_int((policy or {}).get("maxAttempts"), 0)
    if max_attempts not in {0, 1, 3}: max_attempts = 0
    now = _now()
    job = {
        "id": str(uuid.uuid4()), "operation": {"type": kind, "policy": {"maxAttempts": max_attempts, "backoff": bool((policy or {}).get("backoff", False))}},
        "targets": unique, "operator": str(operator or "").strip() or None, "status": "pending", "createdAt": now, "startedAt": None, "completedAt": None,
        "updatedAt": now, "workerId": None, "leaseExpiresAt": None, "cancelRequested": False, "results": [], "error": None, "sourceJobId": source_job_id,
    }
    with _LOCK:
        store = _read_unlocked(); store["jobs"].append(job); _write_unlocked(store)
    return _public(job)


def list_jobs(*, status: str | None = None, connection: str | None = None, limit: int = 500) -> list[dict[str, Any]]:
    with _LOCK: jobs = list(_read_unlocked()["jobs"])
    matched = [job for job in jobs if (not status or job.get("status") == status) and (not connection or connection in job.get("targets", []))]
    return sorted((_public(job) for job in matched), key=lambda item: _as_int(item.get("createdAt")), reverse=True)[:max(1, min(limit, 1000))]


def get_job(job_id: str) -> dict[str, Any] | None:
    return next((item for item in list_jobs(limit=1000) if item.get("id") == job_id), None)


def cancel_job(job_id: str) -> dict[str, Any] | None:
    with _LOCK:
        store = _read_unlocked(); job = next((item for item in store["jobs"] if item.get("id") == job_id), None)
        if not job: return None
        if job.get("status") == "pending": job["status"] = "cancelled"; job["completedAt"] = _now()
        elif job.get("status") in {"running", "retrying"}: job["cancelRequested"] = True
        job["updatedAt"] = _now(); _write_unlocked(store); return _public(job)


def retry_job(job_id: str, *, operator: str | None = None) -> dict[str, Any] | None:
    job = get_job(job_id)
    if not job: return None
    failures = [item.get("connection") for item in job.get("results", []) if item.get("status") == "error" and item.get("connection")]
    return create_job(operation_type=job["operation"]["type"], targets=failures or list(job["targets"]), operator=operator or job.get("operator"), policy=job["operation"].get("policy"), source_job_id=job_id)


def duplicate_job(job_id: str, *, operator: str | None = None) -> dict[str, Any] | None:
    job = get_job(job_id)
    if not job: return None
    return create_job(operation_type=job["operation"]["type"], targets=list(job["targets"]), operator=operator or job.get("operator"), policy=job["operation"].get("policy"), source_job_id=job_id)


def queue_summary() -> dict[str, Any]:
    jobs = list_jobs(limit=1000)
    workers = worker_summary()
    return {"active": sum(job["status"] in {"running", "retrying"} for job in jobs), "queued": sum(job["status"] == "pending" for job in jobs), "errors": sum(job["status"] == "error" for job in jobs), "recent": jobs[:8], "workers": workers}


def worker_summary() -> list[dict[str, Any]]:
    with _LOCK: workers = dict(_read_unlocked().get("workers") or {})
    return [{"id": key, **value, "status": "online" if _now() - _as_int(value.get("lastHeartbeat")) < 90_000 else "offline"} for key, value in workers.items() if isinstance(value, dict)]


def _claim_next(worker_id: str) -> dict[str, Any] | None:
    now = _now()
    with _LOCK:
        store = _read_unlocked()
        store.setdefault("workers", {})[worker_id] = {"lastHeartbeat": now, "concurrency": max(1, _as_int(getattr(get_settings(), "operations_target_concurrency", 8), 8))}
        job = next((item for item in sorted(store["jobs"], key=lambda value: _as_int(value.get("createdAt"))) if item.get("status") == "pending" or (item.get("status") == "running" and _as_int(item.get("leaseExpiresAt")) < now)), None)
        if job:
            job.update({"status": "running", "startedAt": job.get("startedAt") or now, "updatedAt": now, "workerId": worker_id, "leaseExpiresAt": now + 120_000})
        _write_unlocked(store)
        return dict(job) if job else None


def _append_result(job_id: str, result: dict[str, Any]) -> bool:
    with _LOCK:
        store = _read_unlocked(); job = next((item for item in store["jobs"] if item.get("id") == job_id), None)
        if not job: return True
        if job.get("cancelRequested"): return True
        job.setdefault("results", []).append(result); job["updatedAt"] = _now(); job["leaseExpiresAt"] = _now() + 120_000; _write_unlocked(store)
        return False


def _mark_retrying(job_id: str) -> bool:
    with _LOCK:
        store = _read_unlocked(); job = next((item for item in store["jobs"] if item.get("id") == job_id), None)
        if not job: return True
        if job.get("cancelRequested"): return True
        job["status"] = "retrying"; job["updatedAt"] = _now(); _write_unlocked(store)
        return False


async def _execute_target(operation: str, connection: str, instance: dict[str, Any] | None, job_id: str) -> dict[str, Any]:
    started = _now()
    try:
        if not instance: raise RuntimeError("La conexión ya no está disponible")
        if operation == "reconnect":
            from app.connections import get_connection_manager
            await get_connection_manager().reconnect(connection)
            message, status = "Reconexión solicitada al proveedor.", "completed"
        elif operation in {"health_refresh", "synchronize", "reindex", "retry"}:
            from app.services.normalization import save_pipeline_event
            save_pipeline_event(stage="bulk_operation", status="completed", instance=connection, request_id=job_id, event="OPERATION_ACTION", component="Operations", severity="SUCCESS", details={"operation": operation, "operationSource": True}, action="Consulta el detalle del Job.")
            message, status = "Se registró la actualización operativa.", "completed"
        else:
            message, status = f"{operation} está preparado para un ejecutor de proveedor; no se simuló su resultado.", "skipped"
        return {"connection": connection, "status": status, "startedAt": started, "completedAt": _now(), "durationMs": _now() - started, "message": message, "error": None}
    except Exception as exc:
        return {"connection": connection, "status": "error", "startedAt": started, "completedAt": _now(), "durationMs": _now() - started, "message": "La operación no pudo completarse.", "error": str(exc)[:500]}


async def _run_job(job: dict[str, Any], *, instances: list[dict[str, Any]]) -> None:
    instance_map = {str(item.get("name")): item for item in instances}
    concurrency = max(1, min(_as_int(getattr(get_settings(), "operations_target_concurrency", 8), 8), 64))
    semaphore = asyncio.Semaphore(concurrency)
    async def run_target(connection: str) -> None:
        async with semaphore:
            policy = job["operation"].get("policy") or {}
            attempts = max(1, _as_int(policy.get("maxAttempts")) + 1)
            result: dict[str, Any] = {}
            for attempt in range(1, attempts + 1):
                result = await _execute_target(job["operation"]["type"], connection, instance_map.get(connection), job["id"])
                result["attempt"] = attempt
                if result["status"] != "error" or attempt == attempts:
                    break
                if _mark_retrying(job["id"]):
                    return
                if policy.get("backoff"):
                    await asyncio.sleep(min(2 ** (attempt - 1), 8))
            _append_result(job["id"], result)
    await asyncio.gather(*(run_target(connection) for connection in job["targets"]))
    with _LOCK:
        store = _read_unlocked(); stored = next((item for item in store["jobs"] if item.get("id") == job["id"]), None)
        if not stored: return
        progress = _progress(stored)
        stored["completedAt"] = _now(); stored["updatedAt"] = _now(); stored["leaseExpiresAt"] = None
        if stored.get("cancelRequested"): stored["status"] = "cancelled"
        elif progress["errors"] == progress["total"]: stored["status"] = "error"; stored["error"] = "Todos los targets devolvieron error."
        else: stored["status"] = "completed"
        _write_unlocked(store)


async def run_next_job(*, worker_id: str, instances: list[dict[str, Any]]) -> dict[str, Any] | None:
    job = _claim_next(worker_id)
    if not job: return None
    await _run_job(job, instances=instances)
    return get_job(job["id"])


class OperationWorker:
    def __init__(self, instance_supplier: Callable[[], Awaitable[list[dict[str, Any]]]]):
        self._instance_supplier = instance_supplier; self._task: asyncio.Task | None = None; self._stopping = False
        self.worker_id = f"gateway-{uuid.uuid4().hex[:8]}"
    async def _loop(self) -> None:
        while not self._stopping:
            try:
                job = await run_next_job(worker_id=self.worker_id, instances=await self._instance_supplier())
                await asyncio.sleep(0.2 if job else 1)
            except Exception as exc:
                logger.warning("operation_worker_tick_failed", error=str(exc)); await asyncio.sleep(1)
    def start(self) -> None:
        if self._task is None and bool(getattr(get_settings(), "operations_worker_enabled", True)):
            self._task = asyncio.create_task(self._loop(), name="operations-worker")
    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
            try: await self._task
            except asyncio.CancelledError: pass
            self._task = None
