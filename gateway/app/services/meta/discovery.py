from __future__ import annotations

from typing import Any

from app.platforms.meta import MetaCredentials, MetaPlatform
from app.services.meta.exceptions import MetaOnboardingError
from app.services.meta.models import DiscoveryResult


class MetaDiscoveryService:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def discover(self, credentials: MetaCredentials) -> DiscoveryResult:
        waba = await self._platform.request(
            "GET",
            f"/{credentials.business_account_id}",
            headers={"Authorization": f"Bearer {credentials.access_token}"},
            params={"fields": "id,name,timezone_id,message_template_namespace,currency"},
        )
        phones_payload = await self._platform.request(
            "GET",
            f"/{credentials.business_account_id}/phone_numbers",
            headers={"Authorization": f"Bearer {credentials.access_token}"},
            params={"fields": "id,display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type,is_on_biz_app", "limit": 100},
        )
        phones = phones_payload.get("data") if isinstance(phones_payload, dict) and isinstance(phones_payload.get("data"), list) else []
        phone = next((item for item in phones if isinstance(item, dict) and str(item.get("id") or "") == credentials.phone_number_id), None)
        if not isinstance(waba, dict) or str(waba.get("id") or "") != credentials.business_account_id:
            raise MetaOnboardingError("discovery_failed", "No se pudo validar la WABA seleccionada.", status_code=502)
        if not isinstance(phone, dict):
            raise MetaOnboardingError("discovery_failed", "El phone_number_id no pertenece a la WABA seleccionada.", status_code=422)
        return DiscoveryResult(
            waba_id=credentials.business_account_id,
            phone_number_id=credentials.phone_number_id,
            display_phone_number=str(phone.get("display_phone_number") or "") or None,
            phone=phone,
            waba=waba,
        )
