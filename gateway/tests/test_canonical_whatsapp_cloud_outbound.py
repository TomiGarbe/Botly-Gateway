"""Canonical outbound over WhatsApp Cloud (Meta official) connections."""
from __future__ import annotations

import asyncio
import base64
from uuid import uuid4

import httpx
import pytest

from app.models.canonical_outbound import CanonicalOutboundMessage
from app.providers.registry import ProviderRegistry
from app.services import canonical_outbound as service_module
from app.services.canonical_outbound import CanonicalOutboundError, CanonicalOutboundService
from app.services.outbound_provider_attempts import OutboundProviderAttemptStore


class _Registry:
    def __init__(self, *, provider: str = "meta", channel_type: str = "whatsapp") -> None:
        self.record = {"id": "connection-cloud-1", "legacy_name": "cloud_runtime", "provider_id": provider, "channel_id": channel_type, "core_channel": {}}

    def connection_record(self, name: str):
        return self.record if name == "cloud_runtime" else None

    def connection_records(self):
        return [self.record]


class _OfficialProvider:
    def __init__(self) -> None:
        self.texts: list[dict] = []
        self.media: list[dict] = []

    async def send_text(self, **kwargs):
        self.texts.append(kwargs)
        return {"ok": True, "messageId": "wamid.text-1"}

    async def send_media(self, **kwargs):
        self.media.append(kwargs)
        return {"ok": True, "messageId": "wamid.media-1"}


class _EvolutionTrap:
    async def send_text(self, *args, **kwargs):
        raise AssertionError("WhatsApp Cloud must not be delivered through Evolution")

    send_media = send_text


def _message(*, core_provider: str = "evolution", kind: str = "text", attachments: list | None = None) -> CanonicalOutboundMessage:
    return CanonicalOutboundMessage.model_validate({
        "channel": {"id": str(uuid4()), "type": "whatsapp", "provider": core_provider},
        "recipient": {"externalId": "5493516509296@s.whatsapp.net"},
        "message": {"kind": kind, "content": "Hola desde Botly", "attachments": attachments or []},
        "idempotencyKey": f"core:cloud:{uuid4()}",
        "metadata": {},
        "trace": {"requestId": "req-cloud", "correlationId": "corr-cloud"},
    })


@pytest.fixture
def official(monkeypatch):
    provider = _OfficialProvider()
    import app.providers.whatsapp_official as official_module

    monkeypatch.setattr(official_module, "get_official_whatsapp_provider", lambda: provider)
    return provider


def _service(tmp_path, registry=None) -> CanonicalOutboundService:
    return CanonicalOutboundService(
        registry=registry or _Registry(),
        connection_manager=_EvolutionTrap(),
        connection_service=object(),
        provider_registry=ProviderRegistry(),
        attempt_store=OutboundProviderAttemptStore(tmp_path / "attempts.json"),
    )


@pytest.mark.parametrize("core_provider", ["evolution", "meta"])
def test_core_whatsapp_channel_is_delivered_through_cloud_api(tmp_path, official, core_provider) -> None:
    result = asyncio.run(_service(tmp_path).deliver(message=_message(core_provider=core_provider), authenticated_instance="cloud_runtime"))

    assert result["status"] == "accepted"
    assert result["providerMessageId"] == "wamid.text-1"
    assert official.texts == [{"instance_name": "cloud_runtime", "number": "5493516509296", "text": "Hola desde Botly"}]


def test_cloud_media_is_downloaded_from_core_and_uploaded_to_graph(tmp_path, official, monkeypatch) -> None:
    audio = b"OggS" + b"\x00" * 32

    async def fake_get(self, url, **kwargs):
        return httpx.Response(200, content=audio, request=httpx.Request("GET", url))

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    message = _message(kind="audio", attachments=[{"kind": "audio", "url": "https://api.example/files/1?token=t", "mimeType": "audio/ogg", "filename": "nota.ogg"}])

    result = asyncio.run(_service(tmp_path).deliver(message=message, authenticated_instance="cloud_runtime"))

    assert result["providerMessageId"] == "wamid.media-1"
    sent = official.media[0]
    assert base64.b64decode(sent["media_base64"]) == audio
    assert (sent["media_type"], sent["mime_type"], sent["file_name"]) == ("audio", "audio/ogg", "nota.ogg")


def test_evolution_core_provider_still_rejected_for_instagram_connections(tmp_path, official) -> None:
    registry = _Registry(provider="meta", channel_type="instagram")
    message = CanonicalOutboundMessage.model_validate({
        **_message().model_dump(by_alias=True),
        "channel": {"id": str(uuid4()), "type": "instagram", "provider": "evolution"},
    })

    with pytest.raises(CanonicalOutboundError) as raised:
        asyncio.run(_service(tmp_path, registry).deliver(message=message, authenticated_instance="cloud_runtime"))

    assert raised.value.code == "transport_mismatch"
    assert official.texts == []


def test_provider_match_rule() -> None:
    match = service_module._provider_matches
    assert match(connection_provider="meta", channel_type="whatsapp", core_provider="evolution")
    assert match(connection_provider="evolution", channel_type="whatsapp", core_provider="evolution")
    assert not match(connection_provider="evolution", channel_type="whatsapp", core_provider="meta")
    assert not match(connection_provider="meta", channel_type="instagram", core_provider="evolution")
