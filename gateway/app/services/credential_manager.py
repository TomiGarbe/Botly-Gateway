from __future__ import annotations

import hashlib
import json
import os
import time
from dataclasses import dataclass, field
from typing import Any

from app.core.config import get_settings
from app.core.logging import get_logger
from app.services.audit import audit_event

logger = get_logger(__name__)


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _hash_secret(secret: str) -> str:
    return hashlib.sha256(secret.encode("utf-8")).hexdigest()


_BLOCKED_METADATA_KEYS = {
    "cloudApiActive",
    "coexistence",
    "coexistenceState",
    "health",
    "healthChecks",
    "lifecycleSignals",
    "permissionsInsufficient",
    "status",
    "tokenConfigured",
    "tokenExpired",
    "tokenStatus",
    "webhookConfigured",
    "webhookInvalid",
    "webhookStatus",
    "whatsappBusinessAppAvailable",
}


def _sanitize_metadata(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        return {}
    return {str(key): value for key, value in metadata.items() if str(key) not in _BLOCKED_METADATA_KEYS}


@dataclass(frozen=True)
class OfficialCredentialRecord:
    instance_name: str
    phone_number_id: str
    business_account_id: str
    access_token_ref: str
    access_token_hash: str | None = None
    source: str = "unknown"
    created_at: str | None = None
    updated_at: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def public_dict(self) -> dict[str, Any]:
        return {
            "instanceName": self.instance_name,
            "phoneNumberId": self.phone_number_id,
            "businessAccountId": self.business_account_id,
            "accessTokenRef": self.access_token_ref,
            "hasAccessTokenHash": bool(self.access_token_hash),
            "source": self.source,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "metadata": dict(self.metadata),
        }


class CredentialManager:
    def _path(self) -> str:
        return get_settings().official_credentials_path

    def _load(self) -> dict[str, Any]:
        path = self._path()
        if not os.path.exists(path):
            return {"official": {}}
        try:
            with open(path, "r", encoding="utf-8") as handle:
                payload = json.load(handle)
            if isinstance(payload, dict) and isinstance(payload.get("official"), dict):
                return payload
        except Exception as exc:
            logger.warning("credential_store_load_failed", path=path, error=str(exc))
        return {"official": {}}

    def _save(self, payload: dict[str, Any]) -> None:
        path = self._path()
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=True, indent=2, sort_keys=True)
        try:
            os.chmod(tmp_path, 0o600)
        except OSError:
            logger.debug("credential_store_chmod_skipped", path=tmp_path)
        os.replace(tmp_path, path)

    def upsert_official_credentials(
        self,
        *,
        instance_name: str,
        access_token: str,
        phone_number_id: str,
        business_account_id: str,
        source: str,
        metadata: dict[str, Any] | None = None,
    ) -> OfficialCredentialRecord:
        now = _now_iso()
        payload = self._load()
        official = payload["official"]
        previous = official.get(instance_name) if isinstance(official.get(instance_name), dict) else {}
        access_token_ref = f"meta://waba/{business_account_id}/phones/{phone_number_id}/token"
        record = {
            "instanceName": instance_name,
            "phoneNumberId": phone_number_id,
            "businessAccountId": business_account_id,
            "accessTokenRef": access_token_ref,
            "accessTokenHash": _hash_secret(access_token),
            "source": source,
            "createdAt": previous.get("createdAt") or now,
            "updatedAt": now,
            "metadata": _sanitize_metadata(metadata),
        }
        official[instance_name] = record
        self._save(payload)
        audit_event("official_credentials_upserted", instance=instance_name, source=source, phoneNumberId=phone_number_id, businessAccountId=business_account_id)
        return self._record_from_dict(record)

    def get_official_credentials_info(self, instance_name: str) -> OfficialCredentialRecord | None:
        record = self._load()["official"].get(instance_name)
        if not isinstance(record, dict):
            return None
        return self._record_from_dict(record)

    def find_instance_by_phone_number_id(self, phone_number_id: str) -> str | None:
        """Resolve the Cloud API phone id supplied by Meta to a Gateway instance."""
        target = str(phone_number_id or "").strip()
        if not target:
            return None
        for instance_name, record in self._load()["official"].items():
            if isinstance(record, dict) and str(record.get("phoneNumberId") or "").strip() == target:
                return str(instance_name)
        return None

    def delete_official_credentials(self, instance_name: str) -> None:
        payload = self._load()
        official = payload["official"]
        if instance_name in official:
            official.pop(instance_name, None)
            self._save(payload)
            audit_event("official_credentials_deleted", instance=instance_name)

    def _record_from_dict(self, record: dict[str, Any]) -> OfficialCredentialRecord:
        return OfficialCredentialRecord(
            instance_name=str(record.get("instanceName") or ""),
            phone_number_id=str(record.get("phoneNumberId") or ""),
            business_account_id=str(record.get("businessAccountId") or ""),
            access_token_ref=str(record.get("accessTokenRef") or ""),
            access_token_hash=str(record.get("accessTokenHash") or "") or None,
            source=str(record.get("source") or "unknown"),
            created_at=record.get("createdAt"),
            updated_at=record.get("updatedAt"),
            metadata=record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
        )


def get_credential_manager() -> CredentialManager:
    return CredentialManager()
