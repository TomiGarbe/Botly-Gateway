from __future__ import annotations

from typing import Any, Protocol


class ChannelProvider(Protocol):
    def validate_payload(self, payload: dict[str, Any]) -> bool:
        ...

    def normalize_webhook(self, payload: dict[str, Any]) -> tuple[dict[str, Any], ...]:
        ...
