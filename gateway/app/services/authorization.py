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


def require_webhook_delivery_manual_action_access(request: Request, connection: Any) -> None:
    """Explicit write capability for an operator-triggered webhook action.

    It intentionally requires a signed-in actor in addition to the existing
    connection ownership policy; an API key or a read-only lookup cannot cause
    an external test dispatch.
    """
    user = getattr(request.state, "user", None)
    if user is None or not str(getattr(user, "id", "") or "").strip():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Manual webhook actions require an authenticated operator")
    require_reviewer_connection_access(request, connection)


def require_webhook_delivery_repeat_test_access(request: Request, connection: Any) -> None:
    """Backward-compatible name for the repeat-test capability."""
    require_webhook_delivery_manual_action_access(request, connection)


def require_provider_delivery_resend_access(request: Request, connection: Any) -> None:
    """Explicit actor-bound capability for an outbound provider side effect."""
    require_webhook_delivery_manual_action_access(request, connection)


def reviewer_endpoint_allowed(request: Request) -> bool:
    """Small global surface; ownership is enforced for each connection."""
    if not is_meta_reviewer(getattr(request.state, "user", None)):
        return True
    method, path = request.method.upper(), request.url.path.rstrip("/") or "/"
    simple = {
        ("GET", "/auth/session"), ("POST", "/auth/logout"), ("GET", "/channels"),
        ("GET", "/clients"), ("GET", "/connections"), ("POST", "/connections"),
        ("POST", "/connection-setups"),
        ("GET", "/meta/signup/config"), ("POST", "/meta/signup/complete"), ("GET", "/analytics"),
    }
    if (method, path) in simple:
        return True
    if path.startswith("/clients/"):
        return method == "GET" and path.count("/") == 2
    if path.startswith("/meta/signup/onboarding/"):
        return method == "GET"
    if path.startswith("/connection-setups/"):
        return method in {"GET", "POST"}
    if path == "/webhooks" or path.startswith("/webhooks/"):
        # The Webhooks Center router resolves each stable webhook ID back to
        # its connection before exposing or mutating it.
        return True
    if path == "/provider-deliveries" or path.startswith("/provider-deliveries/"):
        # The router resolves both list and detail records back to a connection
        # before exposing any delivery evidence.
        return method == "GET" or (method == "POST" and path.endswith("/resend"))
    return path.startswith("/connections/")
