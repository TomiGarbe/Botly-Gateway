"""Bounded, idempotent compensation for incomplete connection setups."""
from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta, timezone
from typing import Any

from app.connections import ConnectionManager, get_connection_manager
from app.core.config import get_settings
from app.core.secret_protection import SecretRedactor
from app.services.connection_registry import ConnectionRegistry, get_connection_registry
from app.services.connection_setups import ConnectionSetupService, get_connection_setup_service


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


class ConnectionSetupCleanupService:
    def __init__(self, manager: ConnectionManager | None = None, registry: ConnectionRegistry | None = None, setups: ConnectionSetupService | None = None) -> None:
        self._manager = manager or get_connection_manager()
        self._registry = registry or get_connection_registry()
        self._setups = setups or get_connection_setup_service()

    async def cleanup(self, setup_id: str) -> dict[str, Any] | None:
        with _locks_guard:
            lock = _locks.setdefault(setup_id, threading.Lock())
        if not lock.acquire(blocking=False):
            return None
        try:
            record = self._setups.raw(setup_id)
            if record.get("state") not in {"expired", "cleanup_pending"}:
                return record
            resources = [item for item in record.get("external_resources", []) if isinstance(item, dict)]
            if not resources:
                return record
            cleanup = dict(record.get("cleanup") or {})
            attempt = int(cleanup.get("attempts") or 0) + 1
            remaining: list[dict[str, Any]] = []
            results: list[dict[str, Any]] = []
            for resource in resources:
                result = await self._cleanup_resource(record, resource)
                results.append(result)
                if not result["completed"]:
                    remaining.append(resource)
            cleanup.update({"attempts": attempt, "last_attempt_at": _now(), "resources": results})
            if remaining:
                cleanup["next_attempt_at"] = (datetime.now(timezone.utc) + timedelta(seconds=min(3600, 30 * (2 ** min(attempt, 6))))).replace(microsecond=0).isoformat().replace("+00:00", "Z")
                cleanup["last_error"] = next((item.get("error") for item in results if item.get("error")), None)
                return self._registry.update_setup_record(setup_id, {"state": "cleanup_pending", "cleanup_required": True, "cleanup": cleanup, "updated_at": _now()})
            final_state = str(record.get("cleanup_final_state") or "expired")
            cleanup["completed_at"] = _now()
            cleanup["last_error"] = None
            return self._registry.update_setup_record(setup_id, {"state": final_state, "cleanup_required": False, "cleanup": cleanup, "external_resources": [], "updated_at": _now()})
        finally:
            lock.release()

    async def _cleanup_resource(self, setup: dict[str, Any], resource: dict[str, Any]) -> dict[str, Any]:
        kind = str(resource.get("kind") or "")
        identifier = str(resource.get("identifier") or "")
        if kind != "evolution_instance" or not identifier or identifier != str(setup.get("runtime_name") or "") or resource.get("ownership_confirmed") is not True:
            return {"kind": kind, "identifier": identifier, "completed": False, "error": "manual_verification_required"}
        try:
            await self._manager.delete(identifier, connection_type="baileys")
            return {"kind": kind, "identifier": identifier, "completed": True, "result": "deleted"}
        except KeyError:
            return {"kind": kind, "identifier": identifier, "completed": True, "result": "already_absent"}
        except Exception as exc:
            return {"kind": kind, "identifier": identifier, "completed": False, "error": SecretRedactor.redact_url(str(exc))[:300]}

    async def run_once(self) -> int:
        self._setups.expire_active()
        batch = max(1, int(getattr(get_settings(), "connection_setup_cleanup_batch_size", 25)))
        now = datetime.now(timezone.utc)
        def retry_due(item: dict[str, Any]) -> bool:
            value = (item.get("cleanup") or {}).get("next_attempt_at") if isinstance(item.get("cleanup"), dict) else None
            try:
                return not value or datetime.fromisoformat(str(value).replace("Z", "+00:00")) <= now
            except ValueError:
                return True
        candidates = [item for item in self._registry.snapshot().get("setups", {}).values() if isinstance(item, dict) and item.get("state") in {"expired", "cleanup_pending"} and item.get("external_resources") and retry_due(item)][:batch]
        completed = 0
        for item in candidates:
            result = await self.cleanup(str(item["id"]))
            completed += int(bool(result) and not bool(result.get("cleanup_required")))
        return completed


class ConnectionSetupCleanupWorker:
    def __init__(self, service: ConnectionSetupCleanupService | None = None) -> None:
        self._service = service or ConnectionSetupCleanupService()
        self._task: asyncio.Task | None = None
        self._stopping = False

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        while not self._stopping:
            try:
                await self._service.run_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                # A transient provider/storage failure must not stop future retries.
                pass
            await asyncio.sleep(max(10, int(getattr(get_settings(), "connection_setup_cleanup_interval_seconds", 60))))

    async def stop(self) -> None:
        self._stopping = True
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
