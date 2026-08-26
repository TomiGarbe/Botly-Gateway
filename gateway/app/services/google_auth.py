from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import threading
import time
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Awaitable, Callable

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa

from app.core.config import Settings, get_settings
from app.services.authorization import role_for_email
from app.services.users import META_REVIEW_BUSINESS_ID, GatewayUser, UserRepository, get_user_repository, password_matches


_GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
_GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}
_LOCK = threading.Lock()


class GoogleTokenValidationError(ValueError):
    pass


class GoogleAccessDeniedError(ValueError):
    pass


@dataclass(frozen=True)
class AuthenticatedUser:
    id: str
    name: str
    email: str
    avatar_url: str | None = None
    role: str = "operator"
    business_id: str | None = None

    def public_dict(self) -> dict[str, str | None]:
        return asdict(self)


def _b64url(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _json_part(value: str) -> dict[str, Any]:
    try:
        parsed = json.loads(_b64url(value))
    except Exception as exc:
        raise GoogleTokenValidationError("Invalid Google credential") from exc
    if not isinstance(parsed, dict):
        raise GoogleTokenValidationError("Invalid Google credential")
    return parsed


class GoogleIdentityTokenValidator:
    """Verifies Google ID tokens against Google's rotating public keys."""

    def __init__(
        self,
        settings: Settings | None = None,
        jwks_fetcher: Callable[[], Awaitable[dict[str, Any]]] | None = None,
    ) -> None:
        self._settings = settings or get_settings()
        self._jwks_fetcher = jwks_fetcher or self._fetch_jwks
        self._keys: dict[str, dict[str, Any]] = {}
        self._keys_until = 0.0

    async def verify(self, credential: str) -> AuthenticatedUser:
        if not self._settings.google_client_id:
            raise GoogleTokenValidationError("Google login is not configured")
        parts = credential.split(".")
        if len(parts) != 3:
            raise GoogleTokenValidationError("Invalid Google credential")
        header, claims = _json_part(parts[0]), _json_part(parts[1])
        if header.get("alg") != "RS256" or not isinstance(header.get("kid"), str):
            raise GoogleTokenValidationError("Invalid Google credential")
        key = await self._key_for(header["kid"])
        self._verify_signature(parts, key)
        self._verify_claims(claims)
        email = str(claims.get("email") or "").strip().lower()
        if not email or not self._email_verified(claims.get("email_verified")):
            raise GoogleTokenValidationError("Invalid Google credential")
        return AuthenticatedUser(
            id=str(claims.get("sub") or email),
            name=str(claims.get("name") or email),
            email=email,
            avatar_url=str(claims.get("picture")) if claims.get("picture") else None,
        )

    async def _key_for(self, kid: str) -> dict[str, Any]:
        if time.monotonic() >= self._keys_until or kid not in self._keys:
            payload = await self._jwks_fetcher()
            keys = payload.get("keys") if isinstance(payload, dict) else None
            self._keys = {
                str(item.get("kid")): item
                for item in keys or []
                if isinstance(item, dict) and item.get("kty") == "RSA" and item.get("kid")
            }
            self._keys_until = time.monotonic() + 3600
        key = self._keys.get(kid)
        if key is None:
            raise GoogleTokenValidationError("Invalid Google credential")
        return key

    @staticmethod
    async def _fetch_jwks() -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=5.0) as client:
            response = await client.get(_GOOGLE_JWKS_URL)
            response.raise_for_status()
            return response.json()

    @staticmethod
    def _verify_signature(parts: list[str], key: dict[str, Any]) -> None:
        try:
            modulus = int.from_bytes(_b64url(str(key["n"])), "big")
            exponent = int.from_bytes(_b64url(str(key["e"])), "big")
            public_key = rsa.RSAPublicNumbers(exponent, modulus).public_key()
            public_key.verify(_b64url(parts[2]), f"{parts[0]}.{parts[1]}".encode(), padding.PKCS1v15(), hashes.SHA256())
        except (KeyError, ValueError, InvalidSignature) as exc:
            raise GoogleTokenValidationError("Invalid Google credential") from exc

    def _verify_claims(self, claims: dict[str, Any]) -> None:
        audience = claims.get("aud")
        audiences = audience if isinstance(audience, list) else [audience]
        now = int(time.time())
        if (
            claims.get("iss") not in _GOOGLE_ISSUERS
            or self._settings.google_client_id not in audiences
            or not isinstance(claims.get("exp"), (int, float))
            or int(claims["exp"]) <= now
            or (isinstance(claims.get("nbf"), (int, float)) and int(claims["nbf"]) > now)
            or not str(claims.get("sub") or "")
        ):
            raise GoogleTokenValidationError("Invalid Google credential")

    @staticmethod
    def _email_verified(value: Any) -> bool:
        return value is True or value == "true"


class SessionStore:
    def __init__(self, path: str | Path | None = None) -> None:
        self._path = Path(path) if path is not None else Path(get_settings().auth_sessions_path)

    def _read_unlocked(self) -> dict[str, Any]:
        if not self._path.exists():
            return {"sessions": {}}
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            return {"sessions": {}}
        sessions = data.get("sessions") if isinstance(data, dict) and isinstance(data.get("sessions"), dict) else {}
        return {"sessions": sessions}

    def _write_unlocked(self, payload: dict[str, Any]) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_suffix(f"{self._path.suffix}.tmp")
        temporary.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
        os.replace(temporary, self._path)

    def create(self, user: AuthenticatedUser, expires_at: datetime) -> str:
        token = secrets.token_urlsafe(32)
        with _LOCK:
            payload = self._read_unlocked()
            payload["sessions"][self._hash(token)] = {"user": user.public_dict(), "expires_at": expires_at.isoformat().replace("+00:00", "Z")}
            self._write_unlocked(payload)
        return token

    def get(self, token: str) -> AuthenticatedUser | None:
        if not token:
            return None
        with _LOCK:
            payload = self._read_unlocked()
            record = payload["sessions"].get(self._hash(token))
            if not isinstance(record, dict) or self._is_expired(record.get("expires_at")):
                if self._hash(token) in payload["sessions"]:
                    payload["sessions"].pop(self._hash(token), None)
                    self._write_unlocked(payload)
                return None
            user = record.get("user") if isinstance(record.get("user"), dict) else {}
            if not user.get("id") or not user.get("email"):
                return None
            return AuthenticatedUser(
                id=str(user["id"]), name=str(user.get("name") or user["email"]), email=str(user["email"]), avatar_url=str(user["avatar_url"]) if user.get("avatar_url") else None,
                role=role_for_email(str(user["email"])),
            )

    def delete(self, token: str) -> None:
        if not token:
            return
        with _LOCK:
            payload = self._read_unlocked()
            if payload["sessions"].pop(self._hash(token), None) is not None:
                self._write_unlocked(payload)

    def delete_user(self, email: str) -> None:
        normalized = email.strip().lower()
        with _LOCK:
            payload = self._read_unlocked()
            expired = [key for key, record in payload["sessions"].items() if isinstance(record, dict) and str((record.get("user") or {}).get("email") or "").lower() == normalized]
            for key in expired:
                payload["sessions"].pop(key, None)
            if expired:
                self._write_unlocked(payload)

    @staticmethod
    def _hash(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()

    @staticmethod
    def _is_expired(value: Any) -> bool:
        try:
            return datetime.fromisoformat(str(value).replace("Z", "+00:00")) <= datetime.now(timezone.utc)
        except ValueError:
            return True


class AuthService:
    def __init__(self, settings: Settings | None = None, validator: GoogleIdentityTokenValidator | None = None, store: SessionStore | None = None, users: UserRepository | None = None) -> None:
        self._settings = settings or get_settings()
        self._validator = validator or GoogleIdentityTokenValidator(self._settings)
        self._store = store or SessionStore()
        # Kept optional only for legacy unit tests that construct a tiny settings
        # object. The deployed service always has a persistent account database.
        self._users = users
        if self._users is None and getattr(self._settings, "gateway_users_database_url", ""):
            self._users = get_user_repository()

    @staticmethod
    def _authenticated(user: GatewayUser) -> AuthenticatedUser:
        business_id = META_REVIEW_BUSINESS_ID if user.role == "meta_reviewer" else user.business_id
        return AuthenticatedUser(id=user.id, name=user.name, email=user.email, role=user.role, business_id=business_id)

    async def sign_in(self, credential: str) -> tuple[AuthenticatedUser, str, int]:
        user = await self._validator.verify(credential)
        if self._users is not None:
            account = self._users.by_email(user.email)
            if account is None or not account.active:
                raise GoogleAccessDeniedError("Access denied")
            user = self._authenticated(account)
        elif user.email not in self._settings.allowed_google_users_list:
            raise GoogleAccessDeniedError("Access denied")
        else:
            user = AuthenticatedUser(**{**asdict(user), "role": role_for_email(user.email, self._settings)})
        ttl = max(60, self._settings.auth_session_ttl_seconds)
        token = self._store.create(user, datetime.now(timezone.utc) + timedelta(seconds=ttl))
        return user, token, ttl

    def current_user(self, token: str) -> AuthenticatedUser | None:
        user = self._store.get(token)
        if user is None:
            return None
        if self._users is None:
            return replace(user, role=role_for_email(user.email, self._settings))
        account = self._users.by_email(user.email)
        return self._authenticated(account) if account and account.active else None

    def sign_in_with_password(self, email: str, password: str) -> tuple[AuthenticatedUser, str, int]:
        if self._users is None:
            raise GoogleTokenValidationError("Local login is not configured")
        account = self._users.by_email(email.strip().lower())
        if account is None or not account.active or not password_matches(password, account.password_hash):
            raise GoogleAccessDeniedError("Invalid credentials")
        user = self._authenticated(account)
        ttl = max(60, self._settings.auth_session_ttl_seconds)
        token = self._store.create(user, datetime.now(timezone.utc) + timedelta(seconds=ttl))
        return user, token, ttl

    def sign_out(self, token: str) -> None:
        self._store.delete(token)

    def sign_out_email(self, email: str) -> None:
        self._store.delete_user(email)


def get_auth_service() -> AuthService:
    return AuthService()
