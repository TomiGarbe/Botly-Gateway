from __future__ import annotations

import hashlib
from types import SimpleNamespace

from app.services.connection_diagnostics import ConnectionDiagnosticsService
from app.services.credential_manager import CredentialManager


def test_credential_manager_does_not_persist_plaintext_access_token(monkeypatch, tmp_path) -> None:
    store_path = tmp_path / "official_credentials.json"
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(official_credentials_path=str(store_path)),
    )

    record = CredentialManager().upsert_official_credentials(
        instance_name="cloud_instance",
        access_token="secret-access-token",
        phone_number_id="phone_123",
        business_account_id="waba_456",
        source="embedded_signup",
        metadata={"onboarding": "embedded_signup"},
    )

    stored = store_path.read_text(encoding="utf-8")
    public = record.public_dict()
    assert "secret-access-token" not in stored
    assert "secret-access-token" not in str(public)
    assert record.access_token_hash == hashlib.sha256(b"secret-access-token").hexdigest()
    assert public["hasAccessTokenHash"] is True


def test_connection_diagnostics_reports_missing_official_credentials(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(official_credentials_path=str(tmp_path / "empty_credentials.json")),
    )

    diagnostics = ConnectionDiagnosticsService().diagnose(
        {
            "name": "cloud_instance",
            "connectionType": "cloud",
            "integration": "WHATSAPP-BUSINESS",
            "healthChecks": [{"code": "token_configured", "status": "failed"}],
        },
        raw={"lifecycleSignals": {"tokenConfigured": False}},
    )

    codes = {item["code"] for item in diagnostics}
    assert "official_credentials_missing" in codes
    assert "webhook_configuration_unverified" not in codes
