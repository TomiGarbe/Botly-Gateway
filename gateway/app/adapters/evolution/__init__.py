from __future__ import annotations

from app.adapters.evolution.errors import EvolutionError
from app.adapters.evolution.transports import (
    BAILEYS_TRANSPORT_PROFILE,
    CLOUD_TRANSPORT_PROFILE,
    EvolutionTransport,
    EvolutionTransportProfile,
)


def get_evolution_adapter():
    from app.adapters.evolution.adapter import get_evolution_adapter as factory

    return factory()


def get_evolution_client():
    from app.adapters.evolution.client import get_evolution_client as factory

    return factory()


def __getattr__(name: str):
    if name == "CloudEvolutionAdapter":
        from app.adapters.evolution.cloud import CloudEvolutionAdapter

        return CloudEvolutionAdapter
    if name == "EvolutionAdapter":
        from app.adapters.evolution.adapter import EvolutionAdapter

        return EvolutionAdapter
    if name == "EvolutionClient":
        from app.adapters.evolution.client import EvolutionClient

        return EvolutionClient
    raise AttributeError(name)


__all__ = [
    "BAILEYS_TRANSPORT_PROFILE",
    "CLOUD_TRANSPORT_PROFILE",
    "CloudEvolutionAdapter",
    "EvolutionAdapter",
    "EvolutionClient",
    "EvolutionError",
    "EvolutionTransport",
    "EvolutionTransportProfile",
    "get_evolution_adapter",
    "get_evolution_client",
]
