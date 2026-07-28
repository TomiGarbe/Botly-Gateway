from __future__ import annotations

from app.routers.messages import _persist_local_outbound_event


def test_persist_outbound_accepts_provider_message_as_a_string() -> None:
    # Some provider responses use a human-readable `message` field. It is not
    # a Baileys message object and must never be dereferenced with .get().
    _persist_local_outbound_event(
        instance_name="official_instance",
        number="5491111111111",
        msg_type="text",
        text="Hola",
        evolution_result={"message": "accepted by provider", "messageId": "wamid.abc"},
    )
