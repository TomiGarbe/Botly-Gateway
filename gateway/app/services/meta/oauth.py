from __future__ import annotations

from app.platforms.meta import MetaPlatform, MetaToken


class MetaOAuthService:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def exchange(self, code: str) -> MetaToken:
        return await self._platform.authenticate(code=code)
