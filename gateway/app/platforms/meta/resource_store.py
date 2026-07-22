from __future__ import annotations

import json
import os
import time
from typing import Any, Callable

from app.core.config import get_settings
from app.core.logging import get_logger
from app.platforms.meta.models import MetaResource, MetaResourceStatus, MetaResourceType

logger = get_logger(__name__)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _resource_status(value: Any) -> MetaResourceStatus:
    raw = str(value or MetaResourceStatus.DISCOVERED.value)
    if raw == "deleted":
        return MetaResourceStatus.REMOVED
    try:
        return MetaResourceStatus(raw)
    except ValueError:
        return MetaResourceStatus.DISCOVERED


class MetaResourceStore:
    def __init__(self, *, path_factory: Callable[[], str] | None = None) -> None:
        self._path_factory = path_factory or (lambda: get_settings().meta_resources_path)

    def _path(self) -> str:
        return self._path_factory()

    def _load(self) -> dict[str, Any]:
        path = self._path()
        if not os.path.exists(path):
            return {"resources": {}}
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict) and isinstance(payload.get("resources"), dict):
                return payload
        except Exception as exc:
            logger.warning("meta_resource_store_load_failed", path=path, error=str(exc))
        return {"resources": {}}

    def _save(self, payload: dict[str, Any]) -> None:
        path = self._path()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
        os.replace(tmp_path, path)

    def list(self, *, scope_id: str | None = None, include_deleted: bool = False) -> tuple[MetaResource, ...]:
        resources = self._load()["resources"]
        result: list[MetaResource] = []
        for record in resources.values():
            if not isinstance(record, dict):
                continue
            resource = self._record_from_dict(record)
            if scope_id and resource.metadata.get("discoveryScope") != scope_id:
                continue
            if not include_deleted and resource.deleted_at:
                continue
            result.append(resource)
        return tuple(sorted(result, key=lambda item: (item.resource_type.value, item.external_id)))

    def sync(self, *, resources: tuple[MetaResource, ...], scope_id: str) -> tuple[MetaResource, ...]:
        now = _now_iso()
        payload = self._load()
        stored = payload["resources"]
        discovered_ids = {resource.id for resource in resources}
        synced: list[MetaResource] = []

        for resource in resources:
            previous = stored.get(resource.id) if isinstance(stored.get(resource.id), dict) else {}
            metadata = {
                **(previous.get("metadata") if isinstance(previous.get("metadata"), dict) else {}),
                **dict(resource.metadata),
                "discoveryScope": scope_id,
            }
            record = {
                "id": resource.id,
                "platformId": resource.platform_id,
                "resourceType": resource.resource_type.value,
                "externalId": resource.external_id,
                "displayName": resource.display_name,
                "status": resource.status.value,
                "metadata": metadata,
                "createdAt": previous.get("createdAt") or now,
                "updatedAt": now,
                "deletedAt": None,
            }
            stored[resource.id] = record
            synced.append(self._record_from_dict(record))

        for resource_id, record in list(stored.items()):
            if not isinstance(record, dict):
                continue
            metadata = record.get("metadata") if isinstance(record.get("metadata"), dict) else {}
            if metadata.get("discoveryScope") != scope_id:
                continue
            if resource_id in discovered_ids or record.get("deletedAt"):
                continue
            record["status"] = MetaResourceStatus.REMOVED.value
            record["updatedAt"] = now
            record["deletedAt"] = now
            stored[resource_id] = record

        self._save(payload)
        return tuple(synced)

    def mark_active(self, resource_id: str) -> MetaResource | None:
        payload = self._load()
        record = payload["resources"].get(resource_id)
        if not isinstance(record, dict):
            return None
        now = _now_iso()
        record["status"] = MetaResourceStatus.ACTIVE.value
        record["updatedAt"] = now
        record["deletedAt"] = None
        payload["resources"][resource_id] = record
        self._save(payload)
        return self._record_from_dict(record)

    def _record_from_dict(self, record: dict[str, Any]) -> MetaResource:
        return MetaResource(
            id=str(record.get("id") or ""),
            platform_id=str(record.get("platformId") or "meta"),
            resource_type=MetaResourceType(str(record.get("resourceType") or record.get("type") or "")),
            external_id=str(record.get("externalId") or ""),
            display_name=str(record.get("displayName") or ""),
            status=_resource_status(record.get("status")),
            metadata=record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
            created_at=record.get("createdAt") if isinstance(record.get("createdAt"), str) else None,
            updated_at=record.get("updatedAt") if isinstance(record.get("updatedAt"), str) else None,
            deleted_at=record.get("deletedAt") if isinstance(record.get("deletedAt"), str) else None,
        )


def get_meta_resource_store() -> MetaResourceStore:
    return MetaResourceStore()
