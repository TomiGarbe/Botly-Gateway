from __future__ import annotations

from typing import Any

from app.platforms.meta import MetaPlatform, MetaPlatformError
from app.services.meta.exceptions import MetaOnboardingError
from app.services.meta.models import OnboardingType

# (#133005) "Two step verification PIN Mismatch" solo puede ocurrir cuando el
# numero YA tiene un PIN de dos pasos configurado, es decir ya esta registrado
# en Cloud API. Re-registrarlo con un PIN nuevo es innecesario y ademas
# imposible sin el PIN original; el numero ya esta operativo.
_ALREADY_REGISTERED_CODE = 133005


class MetaPhoneRegistrationService:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def ensure_registered(
        self,
        phone_number_id: str,
        onboarding_type: OnboardingType,
        access_token: str,
        registration_pin: str | None = None,
    ) -> dict[str, Any]:
        if onboarding_type == OnboardingType.COEXISTENCE:
            return {"skipped": True, "reason": "coexistence_number_already_registered"}
        if not isinstance(registration_pin, str) or len(registration_pin) != 6 or not registration_pin.isascii() or not registration_pin.isdigit():
            raise MetaOnboardingError("phone_registration_failed", "El PIN de registro debe contener exactamente seis digitos.")
        try:
            response = await self._platform.request(
                "POST",
                f"/{phone_number_id}/register",
                headers={"Authorization": f"Bearer {access_token}"},
                # WhatsApp Business Phone Number > Register requires these
                # exact fields.  Do not add optional migration fields here:
                # standard and test Cloud numbers need only this payload.
                json={"messaging_product": "whatsapp", "pin": registration_pin},
            )
        except MetaPlatformError as exc:
            code = exc.detail.get("code") if isinstance(exc.detail, dict) else None
            if code == _ALREADY_REGISTERED_CODE:
                return {"skipped": True, "reason": "already_registered", "detail": {"code": code}}
            raise MetaOnboardingError("phone_registration_failed", "Meta no pudo registrar el numero para Cloud API.", detail={"error": str(exc), "code": code}) from exc
        except Exception as exc:
            raise MetaOnboardingError("phone_registration_failed", "Meta no pudo registrar el numero para Cloud API.", detail={"error": str(exc)}) from exc
        if isinstance(response, dict) and response.get("success") is False:
            raise MetaOnboardingError(
                "phone_registration_failed",
                "Meta rechazo el registro del numero para Cloud API.",
                detail={"response": response},
            )
        return {"skipped": False, "response": response if isinstance(response, dict) else {}}
