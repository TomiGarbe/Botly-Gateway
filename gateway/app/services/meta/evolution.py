from __future__ import annotations

from typing import Any

from app.connections import get_connection_manager
from app.platforms.meta import MetaCredentials
from app.services.meta.exceptions import MetaOnboardingError


class MetaEvolutionProvisioner:
    def __init__(self, connection_manager: Any | None = None) -> None:
        self._manager = connection_manager or get_connection_manager()

    async def provision(self, instance_name: str, credentials: MetaCredentials) -> dict[str, Any]:
        result = await self._manager.create(
            instance_name=instance_name,
            qrcode=False,
            token=credentials.access_token,
            phone_number_id=credentials.phone_number_id,
            business_id=credentials.business_account_id,
            connection_type="cloud",
        )
        if not isinstance(result, dict):
            raise MetaOnboardingError("evolution_failed", "Evolution no devolvio una instancia valida.", status_code=502)
        integration = str(result.get("integration") or (result.get("instance") or {}).get("integration") or "").upper()
        if integration and integration != "WHATSAPP-BUSINESS":
            raise MetaOnboardingError("evolution_failed", "Evolution creo una instancia con una integracion distinta a WhatsApp Oficial.", status_code=502)
        return result
