from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class EvolutionTransport(str, Enum):
    BAILEYS = "baileys"
    CLOUD = "cloud"


@dataclass(frozen=True)
class EvolutionTransportProfile:
    transport: EvolutionTransport
    integration: str | None = None


BAILEYS_TRANSPORT_PROFILE = EvolutionTransportProfile(
    transport=EvolutionTransport.BAILEYS,
    integration="WHATSAPP-BAILEYS",
)

CLOUD_TRANSPORT_PROFILE = EvolutionTransportProfile(
    transport=EvolutionTransport.CLOUD,
    integration="WHATSAPP-BUSINESS",
)
