from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.middleware import auth as auth_middleware
from app.middleware.auth import AuthMiddleware
from app.services.google_auth import AuthService, AuthenticatedUser, SessionStore
from app.services.users import UserRepository
from app.services import users as users_service


def test_local_accounts_are_persistent_and_passwords_are_verified(tmp_path) -> None:
    repository = UserRepository(f"sqlite:///{tmp_path / 'users.sqlite3'}")
    repository.initialize()
    account = repository.create(name="Owner", email="owner@example.com", password="a-long-test-password", role="admin")
    settings = SimpleNamespace(gateway_users_database_url="configured", auth_session_ttl_seconds=3600, google_client_id="", allowed_google_users_list=set())
    service = AuthService(settings=settings, store=SessionStore(tmp_path / "sessions.json"), users=repository)  # type: ignore[arg-type]

    user, token, _ = service.sign_in_with_password("OWNER@example.com", "a-long-test-password")
    assert user.id == account.id
    assert user.role == "admin"
    assert service.current_user(token) == user
    service.sign_out_email("owner@example.com")
    assert service.current_user(token) is None

    try:
        service.sign_in_with_password("owner@example.com", "not-the-password")
        assert False, "invalid password must be rejected"
    except Exception:
        pass


def test_meta_reviewer_is_server_side_blocked_from_non_meta_routes(monkeypatch) -> None:
    reviewer = AuthenticatedUser(id="reviewer", name="Review", email="review@example.com", role="meta_reviewer", business_id="review-business")
    monkeypatch.setattr(auth_middleware, "get_auth_service", lambda: SimpleNamespace(current_user=lambda _token: reviewer))
    monkeypatch.setattr(auth_middleware, "get_settings", lambda: SimpleNamespace(gateway_api_key=""))

    api = FastAPI()
    api.add_middleware(AuthMiddleware)

    @api.get("/settings/providers")
    async def settings():
        return {"leak": True}

    @api.post("/connections")
    async def create_connection():
        return {"ok": True}

    @api.get("/connections/abc/api-key")
    async def api_key():
        return {"secret": True}

    http = TestClient(api)
    assert http.get("/settings/providers", cookies={"botly_gateway_session": "token"}).status_code == 403
    assert http.get("/connections/abc/api-key", cookies={"botly_gateway_session": "token"}).status_code == 200
    # The connections router applies the additional business ownership check.
    assert http.post("/connections", cookies={"botly_gateway_session": "token"}).status_code == 200


def test_meta_reviewer_is_bootstrapped_once_without_password_rotation(monkeypatch, tmp_path) -> None:
    repository = UserRepository(f"sqlite:///{tmp_path / 'users.sqlite3'}")
    repository.initialize()
    settings = SimpleNamespace(meta_review_email="meta-review@example.com", meta_review_password="a-long-review-password", meta_review_name="Meta Review")
    monkeypatch.setattr(users_service, "get_settings", lambda: settings)
    monkeypatch.setattr(users_service, "get_user_repository", lambda: repository)

    created = users_service.bootstrap_meta_reviewer()
    repeated = users_service.bootstrap_meta_reviewer()

    assert created is not None and repeated is not None
    assert created.id == repeated.id
    assert repeated.role == "meta_reviewer"
    assert users_service.password_matches("a-long-review-password", repeated.password_hash)
