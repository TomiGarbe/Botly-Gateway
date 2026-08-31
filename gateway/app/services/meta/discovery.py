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

    async def resolve_phone_number_id(
        self,
        *,
        business_account_id: str,
        access_token: str,
        requested_phone_number_id: str | None,
    ) -> str:
        """Resolve a phone only after OAuth has authorized the selected WABA.

        Coexistence's final Embedded Signup message can contain only a WABA id.
        Never invent a phone in that case: a supplied id must belong to that
        WABA, and an omitted id is accepted only when Graph identifies exactly
        one eligible phone.
        """
        phones_payload = await self._platform.request(
            "GET",
            f"/{business_account_id}/phone_numbers",
            headers={"Authorization": f"Bearer {access_token}"},
            params={
                "fields": "id,display_phone_number,platform_type,is_on_biz_app",
                "limit": 100,
            },
        )
        phones = (
            phones_payload.get("data")
            if isinstance(phones_payload, dict) and isinstance(phones_payload.get("data"), list)
            else []
        )
        candidates = [
            item
            for item in phones
            if isinstance(item, dict) and str(item.get("id") or "").strip()
        ]

        if requested_phone_number_id:
            if any(str(item.get("id")) == requested_phone_number_id for item in candidates):
                return requested_phone_number_id
            raise MetaOnboardingError(
                "discovery_failed",
                "El phone_number_id no pertenece a la WABA seleccionada.",
                detail={"businessAccountId": business_account_id},
            )

        business_app_phones = [item for item in candidates if item.get("is_on_biz_app") is True]
        eligible = business_app_phones if len(business_app_phones) == 1 else candidates
        if len(eligible) == 1:
            return str(eligible[0]["id"])

        raise MetaOnboardingError(
            "phone_selection_required",
            "Meta no devolvio un unico telefono para la WABA seleccionada. Vuelve a elegir el numero en Meta.",
            detail={"businessAccountId": business_account_id, "phoneCount": len(candidates)},
        )
