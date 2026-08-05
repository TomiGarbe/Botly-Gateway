from __future__ import annotations

import asyncio
import base64
import json
import time
from types import SimpleNamespace

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware import auth as auth_middleware
from app.middleware.auth import AuthMiddleware
from app.routers import auth as auth_router
from app.services.google_auth import (
    AuthService,
    GoogleAccessDeniedError,
    GoogleIdentityTokenValidator,
    SessionStore,
)


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def _credential(private_key, *, email: str = "tomigarbe2003@gmail.com") -> tuple[str, dict]:
    numbers = private_key.public_key().public_numbers()
    key = {"kty": "RSA", "kid": "test-key", "n": _b64(numbers.n.to_bytes((numbers.n.bit_length() + 7) // 8, "big")), "e": _b64(numbers.e.to_bytes((numbers.e.bit_length() + 7) // 8, "big"))}
    header = _b64(json.dumps({"alg": "RS256", "kid": "test-key"}, separators=(",", ":")).encode())
    claims = _b64(json.dumps({"iss": "https://accounts.google.com", "aud": "google-client", "sub": "google-user", "email": email, "email_verified": True, "name": "Tomi", "exp": int(time.time()) + 3600}, separators=(",", ":")).encode())
    signature = _b64(private_key.sign(f"{header}.{claims}".encode(), padding.PKCS1v15(), hashes.SHA256()))
    return f"{header}.{claims}.{signature}", {"keys": [key]}


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        google_client_id="google-client",
        allowed_google_users_list={"tomigarbe2003@gmail.com"},
        auth_session_ttl_seconds=3600,
    )


def _service(tmp_path) -> tuple[AuthService, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    credential, jwks = _credential(private_key)

    async def fetch_jwks() -> dict:
        return jwks

    settings = _settings()
    validator = GoogleIdentityTokenValidator(settings, fetch_jwks)  # type: ignore[arg-type]
    return AuthService(settings, validator, SessionStore(tmp_path / "sessions.json")), credential  # type: ignore[arg-type]


def test_google_token_whitelist_and_persisted_session(tmp_path) -> None:
    service, credential = _service(tmp_path)
    user, token, _ttl = asyncio.run(service.sign_in(credential))

    assert user.email == "tomigarbe2003@gmail.com"
    assert service.current_user(token) == user

    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    denied_credential, jwks = _credential(private_key, email="outside@example.com")

    async def fetch_jwks() -> dict:
        return jwks

    denied = AuthService(_settings(), GoogleIdentityTokenValidator(_settings(), fetch_jwks), SessionStore(tmp_path / "denied.json"))  # type: ignore[arg-type]
    try:
        asyncio.run(denied.sign_in(denied_credential))
        assert False, "expected denied user"
    except GoogleAccessDeniedError:
        pass


def test_auth_routes_protect_gateway_and_support_logout(monkeypatch, tmp_path) -> None:
    service, credential = _service(tmp_path)
    monkeypatch.setattr(auth_router, "_service", service)
    monkeypatch.setattr(auth_router, "get_settings", lambda: SimpleNamespace(debug=True, google_client_id="google-client"))
    monkeypatch.setattr(auth_middleware, "get_auth_service", lambda: service)

    api = FastAPI()
    api.add_middleware(AuthMiddleware)
    api.include_router(auth_router.router)

    @api.get("/protected")
    async def protected():
        return {"ok": True}

    http = TestClient(api)
    assert http.get("/auth/config").json() == {"google_client_id": "google-client"}
    assert http.get("/protected").status_code == 401
    login = http.post("/auth/google", json={"credential": credential})
    assert login.status_code == 200
    assert login.json()["user"]["email"] == "tomigarbe2003@gmail.com"
    assert http.get("/protected").status_code == 200
    assert http.post("/auth/logout").status_code == 204
    assert http.get("/protected").status_code == 401
