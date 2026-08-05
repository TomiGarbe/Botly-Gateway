from __future__ import annotations

import hashlib
import asyncio
from types import SimpleNamespace

from app.services.connection_diagnostics import ConnectionDiagnosticsService
from app.services.credential_manager import CredentialManager


class _DiagnosticsRegistry:
    def __init__(self) -> None:
        self.record = {"id": "connection-01", "legacy_name": "cloud_instance", "updated_at": "2026-08-01T00:00:00Z"}

    def connection_record_by_id(self, connection_id: str):
        return self.record if connection_id == "connection-01" else None

    def update_connection_record(self, _connection_id: str, changes: dict):
        self.record.update(changes)
        return self.record


class _DiagnosticsRuntime:
    def __init__(self, state: str) -> None:
        self.state = state

    async def list_instances(self):
        return [{"name": "cloud_instance", "status": self.state, "connectionType": "cloud", "integration": "WHATSAPP-BUSINESS"}]


class _DiagnosticsCredentials:
    def __init__(self, present: bool) -> None:
        self.present = present

    def get_official_credentials_info(self, _instance: str):
        if not self.present:
            return None
        return SimpleNamespace(phone_number_id="phone_123", business_account_id="waba_456", access_token_hash="hash", updated_at="2026-08-02T09:00:00Z")


def test_credential_manager_does_not_persist_plaintext_access_token(monkeypatch, tmp_path) -> None:
    store_path = tmp_path / "official_credentials.json"
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(
            official_credentials_path=str(store_path),
            official_credentials_encryption_key="test-encryption-key",
        ),
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
    assert CredentialManager().get_official_access_token("cloud_instance") == "secret-access-token"


def test_registration_pin_is_encrypted_and_reused_when_credentials_are_updated(monkeypatch, tmp_path) -> None:
    store_path = tmp_path / "official_credentials.json"
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(
            official_credentials_path=str(store_path),
            official_credentials_encryption_key="test-encryption-key",
        ),
    )
    credentials = CredentialManager()
    credentials.upsert_official_credentials(
        instance_name="cloud_instance",
        access_token="first-token",
        phone_number_id="phone_123",
        business_account_id="waba_456",
        source="embedded_signup",
    )
    pin = credentials.get_or_create_registration_pin("cloud_instance")
    credentials.upsert_official_credentials(
        instance_name="cloud_instance",
        access_token="refreshed-token",
        phone_number_id="phone_123",
        business_account_id="waba_456",
        source="embedded_signup",
    )

    stored = store_path.read_text(encoding="utf-8")
    public = credentials.get_official_credentials_info("cloud_instance").public_dict()
    assert len(pin) == 6 and pin.isdigit()
    assert credentials.get_or_create_registration_pin("cloud_instance") == pin
    assert pin not in stored
    assert public["hasRegistrationPin"] is True
    assert "registrationPinCiphertext" not in str(public)


def test_connection_diagnostics_reports_missing_official_credentials(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(
            official_credentials_path=str(tmp_path / "empty_credentials.json"),
            official_credentials_encryption_key="test-encryption-key",
        ),
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


def test_connection_diagnostics_snapshot_for_healthy_connection(monkeypatch) -> None:
    monkeypatch.setattr("app.services.connection_diagnostics.get_settings", lambda: SimpleNamespace(meta_graph_version="v23.0"))
    monkeypatch.setattr("app.services.connection_diagnostics.list_instance_webhooks", lambda *_args, **_kwargs: [{"enabled": True, "lastSuccessAt": "2026-08-02T10:00:00Z"}])
    service = ConnectionDiagnosticsService(
        connection_manager=_DiagnosticsRuntime("open"),
        registry=_DiagnosticsRegistry(),
        credentials=_DiagnosticsCredentials(True),
        events_reader=lambda **_kwargs: [{"timestamp": 100, "type": "message", "direction": "outbound"}, {"timestamp": 200, "type": "message", "direction": "inbound"}],
    )

    snapshot = asyncio.run(service.snapshot("connection-01"))

    assert snapshot["summary"]["status"] == "healthy"
    assert snapshot["summary"]["last_message_sent_at"] == 100
    assert snapshot["summary"]["last_message_received_at"] == 200
    assert snapshot["technical"]["phone_number_id"] == "phone_123"
    assert all(item["status"] == "healthy" for item in snapshot["checks"])


def test_connection_diagnostics_snapshot_explains_degraded_connection(monkeypatch) -> None:
    monkeypatch.setattr("app.services.connection_diagnostics.get_settings", lambda: SimpleNamespace(meta_graph_version="v23.0"))
    monkeypatch.setattr("app.services.connection_diagnostics.list_instance_webhooks", lambda *_args, **_kwargs: [])
    service = ConnectionDiagnosticsService(
        connection_manager=_DiagnosticsRuntime("close"),
        registry=_DiagnosticsRegistry(),
        credentials=_DiagnosticsCredentials(False),
        events_reader=lambda **_kwargs: [],
    )

    snapshot = asyncio.run(service.snapshot("connection-01"))

    assert snapshot["summary"]["status"] == "unhealthy"
    token = next(item for item in snapshot["checks"] if item["code"] == "token")
    assert token["action"]
