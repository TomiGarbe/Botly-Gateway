"""Shared redaction and at-rest protection helpers for sensitive values."""
from __future__ import annotations

import hashlib
import json
import re
from base64 import urlsafe_b64encode
from copy import deepcopy
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from cryptography.fernet import Fernet, InvalidToken


REDACTED = "[REDACTED]"
_ENCRYPTED_PREFIX = "fernet:v1:"
_SENSITIVE_EXACT = {
    "authorization", "proxyauthorization", "apikey", "clientkey", "accesstoken",
    "refreshtoken", "idtoken", "token", "secret", "password", "passwd",
    "credential", "credentials", "cookie", "setcookie", "session", "sessionid",
    "signature", "webhooksecret", "webhooktoken", "clientsecret", "mediakey",
}
_SENSITIVE_PARTS = {"token", "secret", "password", "passwd", "credential", "signature", "cookie"}


class SecretRedactor:
    """Redact named credentials while retaining safe operational metadata."""

    @staticmethod
    def is_sensitive_name(name: object) -> bool:
        normalized = re.sub(r"[^a-z0-9]", "", str(name or "").lower())
        if not normalized:
            return False
        if normalized in _SENSITIVE_EXACT:
            return True
        if any(part in normalized for part in _SENSITIVE_PARTS):
            return True
        return normalized.endswith("apikey") or normalized.endswith("clientkey")

    @classmethod
    def redact_headers(cls, headers: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(headers, dict):
            return {}
        return {
            str(key): REDACTED if cls.is_sensitive_name(key) else value
            for key, value in headers.items()
        }

    @classmethod
    def redact_json(cls, value: Any) -> Any:
        if isinstance(value, dict):
            return {
                str(key): REDACTED if cls.is_sensitive_name(key) else cls.redact_json(item)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [cls.redact_json(item) for item in value]
        if isinstance(value, tuple):
            return [cls.redact_json(item) for item in value]
        return deepcopy(value)

    @classmethod
    def redact_json_preview(cls, value: str, *, max_chars: int | None = None) -> str:
        raw = str(value or "")
        try:
            safe = json.dumps(cls.redact_json(json.loads(raw)), ensure_ascii=True, default=str)
        except (TypeError, ValueError, json.JSONDecodeError):
            safe = raw
        return safe[:max_chars] if max_chars is not None else safe

    @classmethod
    def redact_url(cls, url: str) -> str:
        raw = str(url or "")
        try:
            parsed = urlsplit(raw)
            if not parsed.query:
                return raw
            query = [
                (key, REDACTED if cls.is_sensitive_name(key) else value)
                for key, value in parse_qsl(parsed.query, keep_blank_values=True)
            ]
            return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))
        except ValueError:
            return raw

    @classmethod
    def structlog_processor(cls, _logger: Any, _method_name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
        return cls.redact_json(event_dict)


class SecretCipher:
    """Fernet envelope encryption with explicit legacy plaintext detection."""

    def __init__(self, material: str) -> None:
        clean = str(material or "").strip()
        if not clean:
            raise RuntimeError("No hay clave configurada para proteger secretos de webhook")
        self._cipher = Fernet(urlsafe_b64encode(hashlib.sha256(clean.encode("utf-8")).digest()))

    @staticmethod
    def is_encrypted(value: object) -> bool:
        return isinstance(value, str) and value.startswith(_ENCRYPTED_PREFIX)

    def encrypt(self, value: str) -> str:
        if self.is_encrypted(value):
            return value
        return f"{_ENCRYPTED_PREFIX}{self._cipher.encrypt(value.encode('utf-8')).decode('ascii')}"

    def decrypt_or_legacy(self, value: object) -> tuple[str, bool]:
        raw = str(value or "")
        if not self.is_encrypted(raw):
            return raw, False
        try:
            return self._cipher.decrypt(raw[len(_ENCRYPTED_PREFIX):].encode("ascii")).decode("utf-8"), True
        except (InvalidToken, UnicodeDecodeError) as exc:
            raise RuntimeError("No se pudo descifrar un secreto de webhook") from exc
