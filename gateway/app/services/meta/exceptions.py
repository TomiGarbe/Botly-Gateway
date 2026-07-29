from __future__ import annotations

from typing import Any

from app.platforms.meta import MetaPlatformError


class MetaOnboardingError(MetaPlatformError):
    def __init__(self, code: str, message: str, *, status_code: int = 422, detail: dict[str, Any] | None = None) -> None:
        self.code = code
        super().__init__(message, status_code=status_code, detail={"code": code, **(detail or {})})
