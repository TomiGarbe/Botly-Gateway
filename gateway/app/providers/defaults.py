from __future__ import annotations

from functools import lru_cache

from app.providers.instagram import MetaInstagramProvider
from app.providers.registry import ProviderRegistry
from app.providers.whatsapp_official import OfficialWhatsAppProvider


class EvolutionWhatsAppProvider:
    """Registry identity for the existing Evolution WhatsApp transport.

    Evolution continues to be invoked through its established services.  This
    marker makes its provider/channel support explicit without routing a new
    production path through the G1 registry.
    """

    provider_id = "evolution"
    channel_type = "whatsapp"


def build_default_provider_registry() -> ProviderRegistry:
    registry = ProviderRegistry()
    registry.register(provider_id="meta", channel_type="instagram", adapter=MetaInstagramProvider())
    registry.register(provider_id="meta", channel_type="whatsapp", adapter=OfficialWhatsAppProvider())
    registry.register(provider_id="evolution", channel_type="whatsapp", adapter=EvolutionWhatsAppProvider())
    return registry


@lru_cache
def get_default_provider_registry() -> ProviderRegistry:
    return build_default_provider_registry()
