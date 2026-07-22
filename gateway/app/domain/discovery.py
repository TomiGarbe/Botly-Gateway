from __future__ import annotations

from enum import Enum
from typing import Protocol


class DiscoveryType(str, Enum):
    EMBEDDED_SIGNUP = "embedded_signup"
    QR = "qr"
    MANUAL = "manual"
    NONE = "none"


class DiscoveryService(Protocol):
    discovery_type: DiscoveryType

    async def start(self, *, channel_id: str, method_id: str, context: dict | None = None) -> dict:
        ...

    async def complete(self, *, session_id: str, payload: dict) -> dict:
        ...
