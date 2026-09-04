from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from app.providers import (
    EvolutionWhatsAppProvider,
    MetaInstagramProvider,
    ProviderRegistryError,
    get_default_provider_registry,
)
from app.services.credential_manager import CredentialManager, ProviderAccountReference


_FIXTURES = Path(__file__).parent / "fixtures" / "instagram"


def _fixture(name: str) -> dict:
    return json.loads((_FIXTURES / name).read_text(encoding="utf-8"))


def test_provider_registry_resolves_provider_and_channel_independently() -> None:
    registry = get_default_provider_registry()

    assert isinstance(registry.require(provider_id="meta", channel_type="instagram"), MetaInstagramProvider)
    assert registry.require(provider_id="meta", channel_type="whatsapp").channel_type == "whatsapp"
    assert isinstance(registry.require(provider_id="evolution", channel_type="whatsapp"), EvolutionWhatsAppProvider)
    with pytest.raises(ProviderRegistryError, match="provider='evolution', channel_type='instagram'"):
        registry.require(provider_id="evolution", channel_type="instagram")


def test_instagram_fixtures_keep_account_and_recipient_ids_as_opaque_strings() -> None:
    provider = MetaInstagramProvider()

    text_event = provider.normalize_webhook(_fixture("text_inbound.json"))[0]
    attachment_event = provider.normalize_webhook(_fixture("attachment_inbound.json"))[0]
    accounts = provider.normalize_webhook(_fixture("multiple_accounts.json"))

    assert text_event["providerAccountId"] == "178400012345678"
    assert text_event["sender"] == "178400001234567"
    assert text_event["recipient"] == "178400012345678"
    assert text_event["message"]["id"] == "ig-mid-text-001"
    assert all(isinstance(event["providerAccountId"], str) for event in accounts)
    assert [event["providerAccountId"] for event in accounts] == ["178400012345678", "178400098765432"]
    assert attachment_event["media"]["id"] == "ig-media-001"
    assert "@s.whatsapp.net" not in json.dumps((text_event, attachment_event, accounts))
    assert "remoteJid" not in json.dumps((text_event, attachment_event, accounts))


def test_instagram_invalid_and_unsupported_fixtures_are_explicit() -> None:
    provider = MetaInstagramProvider()

    assert provider.validate_payload(_fixture("invalid_payload.json")) is False
    assert provider.normalize_webhook(_fixture("invalid_payload.json")) == ()
    unsupported = provider.normalize_webhook(_fixture("unsupported_event.json"))
    assert unsupported[0]["event"] == "INSTAGRAM_UNKNOWN"
    assert unsupported[0]["providerAccountId"] == "178400012345678"


def test_generic_provider_credentials_are_encrypted_and_scoped_to_provider_account(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(
        "app.services.credential_manager.get_settings",
        lambda: SimpleNamespace(
            official_credentials_path=str(tmp_path / "credentials.json"),
            official_credentials_encryption_key="test-encryption-key",
            gateway_api_key="gateway-key",
        ),
    )
    account = ProviderAccountReference(
        provider_id="meta",
        channel_type="instagram",
        provider_account_id="178400012345678",
    )
    record = CredentialManager().upsert_provider_credentials(
        account=account,
        access_token="instagram-secret-token",
        access_token_ref="meta://instagram/178400012345678/token",
        source="g1-test",
        scopes=("instagram_business_basic",),
    )

    raw = (tmp_path / "credentials.json").read_text(encoding="utf-8")
    assert record.account == account
    assert record.public_dict()["providerAccountId"] == "178400012345678"
    assert CredentialManager().get_provider_access_token(account) == "instagram-secret-token"
    assert "instagram-secret-token" not in raw
    assert "phoneNumberId" not in raw
    assert "remoteJid" not in raw
