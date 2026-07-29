from __future__ import annotations

from typing import Any

from app.core.config import get_settings
from app.platforms.meta import MetaPlatform, MetaToken
from app.services.meta.exceptions import MetaOnboardingError
from app.services.meta.models import TokenVerification


_EXPECTED_SCOPES = {"whatsapp_business_management", "whatsapp_business_messaging"}


class MetaVerificationService:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def verify_token(self, token: MetaToken) -> TokenVerification:
        settings = get_settings()
        app_token = f"{settings.meta_app_id}|{settings.meta_app_secret}"
        try:
            response = await self._platform.request(
                "GET",
                "/debug_token",
                params={"input_token": token.access_token, "access_token": app_token},
            )
        except Exception as exc:
            raise MetaOnboardingError("token_invalid", "No se pudo validar el access token con Meta.", status_code=401, detail={"error": str(exc)}) from exc
        data = response.get("data") if isinstance(response, dict) and isinstance(response.get("data"), dict) else {}
        if not data.get("is_valid"):
            raise MetaOnboardingError("token_invalid", "Meta informo que el access token no es valido.", status_code=401)
        app_id = str(data.get("app_id") or "") or None
        if app_id and settings.meta_app_id and app_id != settings.meta_app_id:
            raise MetaOnboardingError("token_invalid", "El token pertenece a una aplicacion Meta diferente.", status_code=401)
        scopes = tuple(str(scope) for scope in data.get("scopes") or [] if isinstance(scope, str))
        missing = sorted(_EXPECTED_SCOPES.difference(scopes))
        # Both permissions are required by the following discovery, subscription
        # and send operations.  Reporting them only as warnings allowed a record
        # to reach READY even though it could never complete the first message.
        if missing:
            raise MetaOnboardingError(
                "token_scopes_missing",
                f"El token de Meta no tiene los permisos requeridos: {', '.join(missing)}.",
                status_code=401,
                detail={"missingScopes": missing},
            )
        return TokenVerification(
            app_id=app_id,
            business_id=str(data.get("business_id") or "") or None,
            expires_at=data.get("expires_at") if isinstance(data.get("expires_at"), int) else None,
            scopes=scopes,
            warnings=(),
        )

    async def verify_phone(self, phone_number_id: str, access_token: str) -> dict[str, Any]:
        fields = "id,display_phone_number,verified_name,name_status,quality_rating,messaging_limit_tier,certificate,code_verification_status,platform_type,is_on_biz_app"
        try:
            response = await self._platform.request("GET", f"/{phone_number_id}", headers={"Authorization": f"Bearer {access_token}"}, params={"fields": fields})
        except Exception as exc:
            raise MetaOnboardingError("phone_verification_failed", "No se pudo consultar el estado del numero en Meta.", detail={"error": str(exc)}) from exc
        if not isinstance(response, dict) or not str(response.get("id") or "").strip():
            raise MetaOnboardingError("phone_verification_failed", "Meta no devolvio el estado del numero de telefono.", status_code=502)
        return response
