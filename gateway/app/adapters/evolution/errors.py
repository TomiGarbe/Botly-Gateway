from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class EvolutionError(Exception):
    message: str
    status_code: int = 502
    detail: Any | None = None
    retryable: bool = False

    def __str__(self) -> str:
        return self.message
