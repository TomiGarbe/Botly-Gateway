from __future__ import annotations

import hashlib
import json
import os
import secrets
import time
from base64 import urlsafe_b64encode
from dataclasses import dataclass, field
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

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
    has_registration_pin: bool = False
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
            # Never expose the WhatsApp two-step-verification PIN through the
            # connection or diagnostics APIs.  This boolean is enough for
            # support to know that a reusable PIN was safely persisted.
            "hasRegistrationPin": self.has_registration_pin,
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

    def _cipher(self) -> Fernet:
        """Return the local at-rest cipher without ever logging key material."""
        settings = get_settings()
        configured_key = str(getattr(settings, "official_credentials_encryption_key", "") or "").strip()
        # The API key is only a backwards-compatible fallback. It is not stored
        # in the credentials file, and deployments can (and should) set a
        # dedicated OFFICIAL_CREDENTIALS_ENCRYPTION_KEY.
        fallback_key = str(getattr(settings, "gateway_api_key", "") or "").strip()
        material = configured_key or fallback_key
        if not material:
            raise RuntimeError("No hay clave configurada para cifrar credenciales oficiales")
        return Fernet(urlsafe_b64encode(hashlib.sha256(material.encode("utf-8")).digest()))

    def _encrypt_secret(self, secret: str) -> str:
        return self._cipher().encrypt(secret.encode("utf-8")).decode("ascii")

    def _decrypt_secret(self, ciphertext: str, *, secret_name: str) -> str:
        try:
            return self._cipher().decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise RuntimeError(f"No se pudo descifrar {secret_name}; reconecta WhatsApp Oficial") from exc

    def _encrypt_access_token(self, access_token: str) -> str:
        return self._encrypt_secret(access_token)

    def _decrypt_access_token(self, ciphertext: str) -> str:
        return self._decrypt_secret(ciphertext, secret_name="la credencial oficial")

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
        is_same_phone = str(previous.get("phoneNumberId") or "") == phone_number_id
        record = {
            "instanceName": instance_name,
            "phoneNumberId": phone_number_id,
            "businessAccountId": business_account_id,
            "accessTokenRef": access_token_ref,
            "accessTokenHash": _hash_secret(access_token),
            "accessTokenCiphertext": self._encrypt_access_token(access_token),
            # Credential updates (for example, a fresh OAuth token during a
            # resumed onboarding) must not rotate the PIN that Meta already
            # associates with this phone number. A different phone number is
            # a new Cloud registration and therefore gets a new PIN.
            "registrationPinCiphertext": previous.get("registrationPinCiphertext") if is_same_phone else None,
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

    def get_official_access_token(self, instance_name: str) -> str | None:
        """Resolve the encrypted token solely for the outbound Graph request."""
        record = self._load()["official"].get(instance_name)
        if not isinstance(record, dict):
            return None
        ciphertext = record.get("accessTokenCiphertext")
        if not isinstance(ciphertext, str) or not ciphertext.strip():
            return None
        return self._decrypt_access_token(ciphertext)

    def get_or_create_registration_pin(self, instance_name: str, provided_pin: str | None = None) -> str:
        """Return the encrypted-at-rest 2FA PIN for a Cloud phone registration.

        If ``provided_pin`` is supplied (the number owner entered their existing
        two-step-verification PIN, or chose a new one), it is validated, stored
        and returned, overriding any previously generated value. Otherwise the
        stored PIN is returned, or a random one is generated only after the
        credential record exists, so an interrupted first registration can retry
        with exactly the same PIN. PIN values intentionally never leave this
        method except for the immediate outbound Graph API request.
        """
        payload = self._load()
        record = payload["official"].get(instance_name)
        if not isinstance(record, dict):
            raise RuntimeError("No hay credenciales oficiales para guardar el PIN de registro")

        if provided_pin is not None:
            pin = str(provided_pin).strip()
            if len(pin) != 6 or not pin.isascii() or not pin.isdigit():
                raise RuntimeError("El PIN debe contener exactamente seis digitos")
            record["registrationPinCiphertext"] = self._encrypt_secret(pin)
            record["updatedAt"] = _now_iso()
            self._save(payload)
            audit_event("official_registration_pin_set", instance=instance_name)
            return pin

        ciphertext = record.get("registrationPinCiphertext")
        if isinstance(ciphertext, str) and ciphertext.strip():
            pin = self._decrypt_secret(ciphertext, secret_name="el PIN de registro")
            if len(pin) == 6 and pin.isascii() and pin.isdigit():
                return pin
            raise RuntimeError("El PIN de registro almacenado no tiene seis digitos; reconecta WhatsApp Oficial")

        # A six-digit 2FA PIN has a deliberately small domain by Meta's API
        # contract.  `secrets` provides cryptographic randomness; the range
        # keeps its serialized representation at exactly six digits.
        pin = str(secrets.randbelow(900_000) + 100_000)
        record["registrationPinCiphertext"] = self._encrypt_secret(pin)
        record["updatedAt"] = _now_iso()
        self._save(payload)
        audit_event("official_registration_pin_created", instance=instance_name)
        return pin

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
            has_registration_pin=bool(str(record.get("registrationPinCiphertext") or "").strip()),
            source=str(record.get("source") or "unknown"),
            created_at=record.get("createdAt"),
            updated_at=record.get("updatedAt"),
            metadata=record.get("metadata") if isinstance(record.get("metadata"), dict) else {},
        )


def get_credential_manager() -> CredentialManager:
    return CredentialManager()
