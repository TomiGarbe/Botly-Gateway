from __future__ import annotations

import json
import os
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


def _path() -> str:
    return get_settings().connection_metadata_path


def _load() -> dict[str, dict[str, Any]]:
    path = _path()
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        if isinstance(payload, dict):
            return {str(key): value for key, value in payload.items() if isinstance(value, dict)}
    except Exception as exc:
        logger.warning("connection_metadata_load_failed", path=path, error=str(exc))
    return {}


def _save(data: dict[str, dict[str, Any]]) -> None:
    path = _path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp_path = f"{path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=True, indent=2, sort_keys=True)
    os.replace(tmp_path, path)


def get_connection_metadata(instance_name: str) -> dict[str, Any]:
    return dict(_load().get(instance_name, {}))


def set_connection_metadata(instance_name: str, metadata: dict[str, Any]) -> dict[str, Any]:
    data = _load()
    current = dict(data.get(instance_name, {}))
    if isinstance(metadata.get("metadata"), dict):
        current_metadata = dict(current.get("metadata") if isinstance(current.get("metadata"), dict) else {})
        current_metadata.update(metadata["metadata"])
        current["metadata"] = current_metadata
    data[instance_name] = current
    _save(data)
    return current


def delete_connection_metadata(instance_name: str) -> None:
    data = _load()
    if instance_name in data:
        data.pop(instance_name, None)
        _save(data)


def enrich_instance_payload(raw: dict[str, Any]) -> dict[str, Any]:
    name = str(raw.get("instanceName") or raw.get("name") or raw.get("instance", {}).get("instanceName") or "").strip()
    if not name:
        return raw
    stored = get_connection_metadata(name)
    if not stored:
        return raw
    enriched = dict(raw)
    metadata = dict(enriched.get("metadata") if isinstance(enriched.get("metadata"), dict) else {})
    metadata.update(stored.get("metadata") if isinstance(stored.get("metadata"), dict) else {})
    if metadata:
        enriched["metadata"] = metadata
    return enriched
