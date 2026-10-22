import asyncio
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.services.credential_manager import CredentialManager, ProviderAccountReference
from app.services.instagram_token_refresh import refresh_instagram_tokens

NOW = datetime(2026, 10, 22, tzinfo=timezone.utc)


class FakeOAuth:
    def __init__(self, *, refresh_ok=True, rejected=False):
        self.refresh_ok, self.rejected, self.refreshed = refresh_ok, rejected, []

    async def refresh_long_lived(self, token):
        self.refreshed.append(token)
        return SimpleNamespace(access_token=token + "-new", expires_at="2026-12-21T00:00:00Z") if self.refresh_ok else None

    async def token_rejected(self, token):
        return self.rejected


def manager_with(tmp_path, monkeypatch, expiries):
    from app.core.config import get_settings
    monkeypatch.setattr(get_settings(), "official_credentials_path", str(tmp_path / "creds.json"))
    manager = CredentialManager()
    for account_id, expires in expiries.items():
        manager.upsert_provider_credentials(account=ProviderAccountReference("meta", "instagram", account_id),
                                            access_token=f"tok-{account_id}", access_token_ref=f"ref-{account_id}",
                                            source="test", scopes=("instagram_business_manage_messages",), expires_at=expires)
    return manager


def iso(delta):
    return (NOW + delta).isoformat().replace("+00:00", "Z")


def test_refreshes_tokens_near_expiry_or_without_known_expiry(tmp_path, monkeypatch):
    manager = manager_with(tmp_path, monkeypatch, {"soon": iso(timedelta(days=5)), "unknown": None, "healthy": iso(timedelta(days=40)), "gone": iso(-timedelta(days=1))})
    oauth = FakeOAuth()
    outcome = asyncio.run(refresh_instagram_tokens(credentials=manager, oauth=oauth, now=NOW))
    assert outcome == {"refreshed": 2, "expired": 0, "skipped": 2}
    assert sorted(oauth.refreshed) == ["tok-soon", "tok-unknown"]
    refreshed = manager.get_provider_credentials(ProviderAccountReference("meta", "instagram", "soon"))
    assert refreshed.expires_at == "2026-12-21T00:00:00Z"
    assert manager.get_provider_access_token(ProviderAccountReference("meta", "instagram", "soon")) == "tok-soon-new"


def test_rejected_tokens_are_marked_expired_but_transient_refusals_are_not(tmp_path, monkeypatch):
    manager = manager_with(tmp_path, monkeypatch, {"unknown": None})
    asyncio.run(refresh_instagram_tokens(credentials=manager, oauth=FakeOAuth(refresh_ok=False, rejected=False), now=NOW))
    assert manager.get_provider_credentials(ProviderAccountReference("meta", "instagram", "unknown")).expires_at is None
    outcome = asyncio.run(refresh_instagram_tokens(credentials=manager, oauth=FakeOAuth(refresh_ok=False, rejected=True), now=NOW))
    assert outcome["expired"] == 1
    assert manager.get_provider_credentials(ProviderAccountReference("meta", "instagram", "unknown")).expiry_state() == "expired"
