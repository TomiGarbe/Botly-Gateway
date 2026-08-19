"""Persistent local user accounts.  Public registration is intentionally absent."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import NAMESPACE_URL, uuid4, uuid5

from app.core.config import get_settings
from app.services.connection_registry import get_connection_registry


ROLES = {"admin", "operator", "meta_reviewer"}
META_REVIEW_BUSINESS_ID = str(uuid5(NAMESPACE_URL, "botly-gateway:meta-review-business"))
META_REVIEW_BUSINESS_NAME = "Meta Review"


@dataclass(frozen=True)
class GatewayUser:
    id: str
    name: str
    email: str
    password_hash: str
    role: str
    business_id: str | None
    active: bool


def _password_hash(password: str) -> str:
    salt = os.urandom(16)
    # 16 MiB per derivation keeps brute-force resistance without exceeding the
    # conservative OpenSSL memory limit used by the deployment image.
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return "scrypt$" + base64.urlsafe_b64encode(salt).decode() + "$" + base64.urlsafe_b64encode(digest).decode()


def password_matches(password: str, encoded: str) -> bool:
    try:
        scheme, salt64, digest64 = encoded.split("$", 2)
        if scheme != "scrypt":
            return False
        salt, expected = base64.urlsafe_b64decode(salt64), base64.urlsafe_b64decode(digest64)
        actual = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False


class UserRepository:
    def __init__(self, database_url: str | None = None) -> None:
        self._url = str(database_url or get_settings().gateway_users_database_url).strip()
        if not self._url:
            raise RuntimeError("GATEWAY_USERS_DATABASE_URL is required")

    def _connect(self):
        if self._url.startswith("sqlite:///"):
            return sqlite3.connect(self._url.removeprefix("sqlite:///"))
        try:
            import psycopg
        except ImportError as exc:  # pragma: no cover - dependency is installed in the Gateway image
            raise RuntimeError("psycopg is required for PostgreSQL user storage") from exc
        return psycopg.connect(self._url)

    def initialize(self) -> None:
        sql = """CREATE TABLE IF NOT EXISTS botly_gateway_users (
            id VARCHAR(36) PRIMARY KEY, name VARCHAR(160) NOT NULL, email VARCHAR(320) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, role VARCHAR(32) NOT NULL, business_id VARCHAR(128),
            active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)"""
        with self._connect() as connection:
            connection.execute(sql)

    def count(self) -> int:
        with self._connect() as connection:
            return int(connection.execute("SELECT COUNT(*) FROM botly_gateway_users").fetchone()[0])

    def by_email(self, email: str) -> GatewayUser | None:
        with self._connect() as connection:
            row = connection.execute("SELECT id,name,email,password_hash,role,business_id,active FROM botly_gateway_users WHERE email = ?" if self._url.startswith("sqlite:///") else "SELECT id,name,email,password_hash,role,business_id,active FROM botly_gateway_users WHERE email = %s", (email.lower(),)).fetchone()
        return self._row(row)

    def list(self) -> list[GatewayUser]:
        with self._connect() as connection:
            rows = connection.execute("SELECT id,name,email,password_hash,role,business_id,active FROM botly_gateway_users ORDER BY email").fetchall()
        users = [self._row(row) for row in rows]
        return [user for user in users if user is not None]

    def create(self, *, name: str, email: str, password: str, role: str = "operator", business_id: str | None = None) -> GatewayUser:
        role = role.lower()
        if role not in ROLES:
            raise ValueError("Invalid role")
        if len(password) < 12:
            raise ValueError("La contraseña debe tener al menos 12 caracteres.")
        user = GatewayUser(str(uuid4()), name.strip(), email.strip().lower(), _password_hash(password), role, business_id or None, True)
        placeholder = "?" if self._url.startswith("sqlite:///") else "%s"
        sql = f"INSERT INTO botly_gateway_users (id,name,email,password_hash,role,business_id,active) VALUES ({','.join([placeholder] * 7)})"
        try:
            with self._connect() as connection:
                connection.execute(sql, (user.id, user.name, user.email, user.password_hash, user.role, user.business_id, user.active))
        except Exception as exc:
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise ValueError("Ya existe una cuenta con ese email.") from exc
            raise
        return user

    def set_active(self, user_id: str, active: bool) -> None:
        placeholder = "?" if self._url.startswith("sqlite:///") else "%s"
        with self._connect() as connection:
            connection.execute(f"UPDATE botly_gateway_users SET active={placeholder}, updated_at=CURRENT_TIMESTAMP WHERE id={placeholder}", (active, user_id))

    def set_reviewer_scope(self, user_id: str) -> None:
        placeholder = "?" if self._url.startswith("sqlite:///") else "%s"
        with self._connect() as connection:
            connection.execute(
                f"UPDATE botly_gateway_users SET role={placeholder}, business_id={placeholder}, active={placeholder}, updated_at=CURRENT_TIMESTAMP WHERE id={placeholder}",
                ("meta_reviewer", META_REVIEW_BUSINESS_ID, True, user_id),
            )

    def reset_password(self, user_id: str, password: str) -> None:
        if len(password) < 12:
            raise ValueError("La contraseña debe tener al menos 12 caracteres.")
        placeholder = "?" if self._url.startswith("sqlite:///") else "%s"
        with self._connect() as connection:
            connection.execute(f"UPDATE botly_gateway_users SET password_hash={placeholder}, updated_at=CURRENT_TIMESTAMP WHERE id={placeholder}", (_password_hash(password), user_id))

    @staticmethod
    def _row(row: Any) -> GatewayUser | None:
        return GatewayUser(*row) if row else None


def get_user_repository() -> UserRepository:
    return UserRepository()


def bootstrap_initial_admin() -> None:
    settings = get_settings()
    repository = get_user_repository()
    repository.initialize()
    if repository.count():
        return
    if not settings.initial_admin_email or not settings.initial_admin_password:
        raise RuntimeError("Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD before first Gateway startup")
    repository.create(name=settings.initial_admin_name, email=settings.initial_admin_email, password=settings.initial_admin_password, role="admin")


def ensure_meta_review_business() -> str:
    """Create the fixed, isolated client used by every Meta reviewer."""
    registry = get_connection_registry()
    if registry.get_client(META_REVIEW_BUSINESS_ID) is not None:
        return META_REVIEW_BUSINESS_ID
    now = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    registry.save_client({"id": META_REVIEW_BUSINESS_ID, "name": META_REVIEW_BUSINESS_NAME, "description": "Business reserved for Meta review.", "created_at": now, "updated_at": now})
    return META_REVIEW_BUSINESS_ID


def bootstrap_meta_reviewer() -> GatewayUser | None:
    """Provision the review account once, without rotating an existing password."""
    settings = get_settings()
    email = settings.meta_review_email.strip().lower()
    password = settings.meta_review_password
    if not email and not password:
        return None
    if not email or not password:
        raise RuntimeError("Set both META_REVIEW_EMAIL and META_REVIEW_PASSWORD, or neither")
    repository = get_user_repository()
    account = repository.by_email(email)
    if account is None:
        return repository.create(
            name=settings.meta_review_name,
            email=email,
            password=password,
            role="meta_reviewer",
            business_id=META_REVIEW_BUSINESS_ID,
        )
    repository.set_reviewer_scope(account.id)
    return repository.by_email(email)
