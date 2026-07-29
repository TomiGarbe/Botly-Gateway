from __future__ import annotations

from typing import Any

from app.platforms.meta import MetaPlatform
from app.services.meta.exceptions import MetaOnboardingError
from app.services.meta.models import OnboardingType


class MetaPhoneRegistrationService:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def ensure_registered(self, phone_number_id: str, onboarding_type: OnboardingType, access_token: str) -> dict[str, Any]:
        if onboarding_type == OnboardingType.COEXISTENCE:
            return {"skipped": True, "reason": "coexistence_number_already_registered"}
        try:
            response = await self._platform.request(
                "POST",
                f"/{phone_number_id}/register",
                headers={"Authorization": f"Bearer {access_token}"},
                json={"messaging_product": "whatsapp"},
            )
        except Exception as exc:
            raise MetaOnboardingError("phone_registration_failed", "Meta no pudo registrar el numero para Cloud API.", detail={"error": str(exc)}) from exc
        if isinstance(response, dict) and response.get("success") is False:
            raise MetaOnboardingError(
                "phone_registration_failed",
                "Meta rechazo el registro del numero para Cloud API.",
                detail={"response": response},
            )
        return {"skipped": False, "response": response if isinstance(response, dict) else {}}
