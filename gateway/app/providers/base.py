from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal, Protocol


CapabilityState = Literal["not_implemented", "foundation", "implemented"]


@dataclass(frozen=True)
class ProviderCapabilities:
    """Provider-adapter capability state, independent from product feature flags.

    ``foundation`` means the adapter contract or parser exists, but its public
    production flow has intentionally not been enabled.  It must never be
    interpreted as ``implemented`` or ``ready``.
    """

    inbound_text: CapabilityState = "not_implemented"
    inbound_media: CapabilityState = "not_implemented"
    outbound_text: CapabilityState = "not_implemented"
    outbound_media: CapabilityState = "not_implemented"
    webhook: CapabilityState = "not_implemented"
    business_login: CapabilityState = "not_implemented"
    reactions: CapabilityState = "not_implemented"
    templates: CapabilityState = "not_implemented"
    enabled: bool = False
    ready: bool = False

    def public_dict(self) -> dict[str, Any]:
        return {
            "inboundText": self.inbound_text,
            "inboundMedia": self.inbound_media,
            "outboundText": self.outbound_text,
            "outboundMedia": self.outbound_media,
            "webhook": self.webhook,
            "businessLogin": self.business_login,
            "reactions": self.reactions,
            "templates": self.templates,
            "enabled": self.enabled,
            "ready": self.ready,
        }


class ChannelProvider(Protocol):
    """Provider-specific parser contract; output is not Botly Core's contract."""

    provider_id: str
    channel_type: str

    @property
    def capabilities(self) -> ProviderCapabilities:
        ...

    def validate_payload(self, payload: dict[str, Any]) -> bool:
        ...

    def normalize_webhook(self, payload: dict[str, Any]) -> tuple[dict[str, Any], ...]:
        ...
