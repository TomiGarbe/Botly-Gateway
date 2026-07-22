from __future__ import annotations

import json
import os
import time
from typing import Any, Callable

from app.core.config import get_settings
from app.core.logging import get_logger
from app.domain.models import ChannelId, ChannelStatus, MethodId, ProvisionedChannel, RuntimeId

logger = get_logger(__name__)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


class ChannelStore:
    def __init__(self, *, path_factory: Callable[[], str] | None = None) -> None:
        self._path_factory = path_factory or (lambda: get_settings().channel_records_path)

    def _path(self) -> str:
        return self._path_factory()

    def _load(self) -> dict[str, Any]:
        path = self._path()
        if not os.path.exists(path):
            return {"channels": {}}
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict) and isinstance(payload.get("channels"), dict):
                return payload
        except Exception as exc:
            logger.warning("channel_store_load_failed", path=path, error=str(exc))
        return {"channels": {}}

    def _save(self, payload: dict[str, Any]) -> None:
        path = self._path()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
        os.replace(tmp_path, path)

    def list(self) -> tuple[ProvisionedChannel, ...]:
        records = self._load()["channels"]
        channels = [self._record_from_dict(record) for record in records.values() if isinstance(record, dict)]
        return tuple(sorted(channels, key=lambda item: item.id))

    def get(self, channel_record_id: str) -> ProvisionedChannel | None:
        record = self._load()["channels"].get(channel_record_id)
        if not isinstance(record, dict):
            return None
        return self._record_from_dict(record)

    def find_by_resource(self, source_resource_id: str) -> ProvisionedChannel | None:
        for channel in self.list():
            if channel.metadata.get("sourceResourceId") == source_resource_id:
                return channel
        return None

    def upsert(self, channel: ProvisionedChannel) -> ProvisionedChannel:
        now = _now_iso()
        payload = self._load()
        channels = payload["channels"]
        previous = channels.get(channel.id) if isinstance(channels.get(channel.id), dict) else {}
        record = {
            "id": channel.id,
            "channelId": channel.channel_id.value,
            "methodId": channel.method_id.value,
            "integrationId": channel.integration_id,
            "runtimeId": channel.runtime_id.value,
            "displayName": channel.display_name,
            "status": channel.status.value,
            "metadata": dict(channel.metadata),
            "createdAt": previous.get("createdAt") or channel.created_at or now,
            "updatedAt": now,
        }
        channels[channel.id] = record
        self._save(payload)
        return self._record_from_dict(record)

    def _record_from_dict(self, record: dict[str, Any]) -> ProvisionedChannel:
        return ProvisionedChannel(
            id=str(record.get("id") or ""),
            channel_id=ChannelId(str(record.get("channelId") or "")),
            method_id=MethodId(str(record.get("methodId") or "")),
            integration_id=str(record.get("integrationId") or ""),
            runtime_id=RuntimeId(str(record.get("runtimeId") or "")),
            display_name=str(record.get("displayName") or ""),
            status=ChannelStatus(str(record.get("status") or ChannelStatus.ACTIVE.value)),
            metadata=record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
            created_at=record.get("createdAt") if isinstance(record.get("createdAt"), str) else None,
            updated_at=record.get("updatedAt") if isinstance(record.get("updatedAt"), str) else None,
        )


def get_channel_store() -> ChannelStore:
    return ChannelStore()
