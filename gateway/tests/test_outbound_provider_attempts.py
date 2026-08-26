from __future__ import annotations

import asyncio

import pytest

from app.services.outbound_provider_attempts import (
    OutboundAttemptPersistenceError,
    OutboundProviderAttemptStore,
    execute_outbound_attempt,
    provider_delivery_from_attempt,
)


def test_attempt_is_durable_before_sender_and_keeps_evolution_key(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(
        instance="runtime-a", provider="evolution", message_type="text", recipient="5491100000000",
        text="hola", correlation_id="corr-a", request_id="req-a", provider_operation="messages.sendText",
    )
    observed: list[dict] = []

    async def sender():
        observed.extend(store.list(instance="runtime-a"))
        return {"key": {"id": "evo-message-1"}}

    _, completed = asyncio.run(execute_outbound_attempt(attempt=attempt, sender=sender, store=store))

    assert observed and observed[0]["id"] == attempt["id"]
    assert completed["semanticStatus"] == "success"
    assert completed["deliveryState"] == "accepted"
    assert completed["reconciliationState"] == "not_required"
    assert completed["providerMessageId"] == "evo-message-1"
    assert provider_delivery_from_attempt(completed)["attemptId"] == attempt["id"]


def test_timeout_survives_as_unknown_pending_reconciliation(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(instance="runtime-a", provider="meta", message_type="text", recipient="5491100000000", text="hola")

    class TimeoutErrorWithStatus(Exception):
        status_code = 504

    async def sender():
        raise TimeoutErrorWithStatus("provider timeout")

    with pytest.raises(TimeoutErrorWithStatus):
        asyncio.run(execute_outbound_attempt(attempt=attempt, sender=sender, store=store))

    stored = store.list(instance="runtime-a")[0]
    assert stored["semanticStatus"] == "timeout"
    assert stored["deliveryState"] == "unknown"
    assert stored["reconciliationState"] == "pending"
    assert stored["providerMessageId"] is None


def test_network_error_survives_as_unknown_pending_reconciliation(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(instance="runtime-a", provider="evolution", message_type="text", recipient="5491100000000", text="hola")

    class TransportError(Exception):
        status_code = 502

    async def sender():
        raise TransportError("Botly Gateway transport error")

    with pytest.raises(TransportError):
        asyncio.run(execute_outbound_attempt(attempt=attempt, sender=sender, store=store))

    stored = store.list(instance="runtime-a")[0]
    assert stored["semanticStatus"] == "network_error"
    assert stored["deliveryState"] == "unknown"
    assert stored["reconciliationState"] == "pending"


def test_initial_persistence_failure_prevents_sender(tmp_path, monkeypatch) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    monkeypatch.setattr(store, "_write_unlocked", lambda _data: (_ for _ in ()).throw(OSError("disk full")))
    called = False

    with pytest.raises(OutboundAttemptPersistenceError):
        store.create(instance="runtime-a", provider="evolution", message_type="text", recipient="5491100000000")

    assert called is False


def test_attempt_never_persists_credentials_or_media_payload(tmp_path) -> None:
    store = OutboundProviderAttemptStore(tmp_path / "attempts.json")
    attempt = store.create(
        instance="runtime-a", provider="meta", message_type="image", recipient="5491100000000",
        text="hola", media={"kind": "image", "source": "inline", "url": "https://signed/?token=secret", "base64": "binary", "mediaKey": "secret"},
    )
    rendered = str(attempt)
    assert "https://signed" not in rendered
    assert "binary" not in rendered
    assert "secret" not in rendered
    assert attempt["mediaReference"]["status"] == "not_reconstructable"
