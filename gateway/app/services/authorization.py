"""Central policy for restricted interactive Gateway accounts."""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException, Request, status


META_REVIEWER_ROLE = "meta_reviewer"


def role_for_email(email: str, settings: Any | None = None) -> str:
    assignments = getattr(settings, "authorization_role_assignments", {}) if settings is not None else {}
    return str(assignments.get(email.strip().lower()) or "operator") if isinstance(assignments, dict) else "operator"


def is_meta_reviewer(user: Any | None) -> bool:
    return bool(user and getattr(user, "role", "operator") == META_REVIEWER_ROLE)


def require_reviewer_client_access(request: Request, client_id: str) -> None:
    if not is_meta_reviewer(getattr(request.state, "user", None)):
        return
    allowed = str(getattr(getattr(request.state, "user", None), "business_id", "") or "").strip()
    if not allowed or client_id != allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="No tenés acceso a este business.")


def require_reviewer_connection_access(request: Request, connection: Any) -> None:
    if is_meta_reviewer(getattr(request.state, "user", None)):
        require_reviewer_client_access(request, str(getattr(connection, "client_id", "")))


def reviewer_endpoint_allowed(request: Request) -> bool:
    """Small global surface; ownership is enforced for each connection."""
    if not is_meta_reviewer(getattr(request.state, "user", None)):
        return True
    method, path = request.method.upper(), request.url.path.rstrip("/") or "/"
    simple = {
        ("GET", "/auth/session"), ("POST", "/auth/logout"), ("GET", "/channels"),
        ("GET", "/clients"), ("GET", "/connections"), ("POST", "/connections"),
        ("GET", "/meta/signup/config"), ("POST", "/meta/signup/complete"),
    }
    if (method, path) in simple:
        return True
    if path.startswith("/clients/"):
        return method == "GET" and path.count("/") == 2
    if path.startswith("/meta/signup/onboarding/"):
        return method == "GET"
    return path.startswith("/connections/")
