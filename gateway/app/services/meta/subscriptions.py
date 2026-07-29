from __future__ import annotations

from typing import Any

from app.core.config import get_settings
from app.platforms.meta import MetaPlatform
from app.services.meta.exceptions import MetaOnboardingError


class MetaSubscriptionManager:
    def __init__(self, platform: MetaPlatform) -> None:
        self._platform = platform

    async def ensure_subscribed(self, waba_id: str, access_token: str) -> dict[str, Any]:
        settings = get_settings()
        headers = {"Authorization": f"Bearer {access_token}"}
        callback_url = f"{str(getattr(settings, 'public_app_url', '') or '').strip().rstrip('/')}/webhooks/meta"
        verify_token = str(getattr(settings, "meta_webhook_verify_token", "") or "").strip()
        try:
            existing = await self._platform.request("GET", f"/{waba_id}/subscribed_apps", headers=headers, params={"fields": "id"})
        except Exception as exc:
            raise MetaOnboardingError("subscription_failed", "No se pudo consultar la suscripcion de la app a la WABA.", detail={"error": str(exc)}) from exc
        apps = existing.get("data") if isinstance(existing, dict) and isinstance(existing.get("data"), list) else []
        already_subscribed = any(isinstance(app, dict) and str(app.get("id") or "") == settings.meta_app_id for app in apps)
        try:
            # Meta supports overriding the callback per WABA.  Doing it here
            # makes a new Embedded Signup connection self-contained instead of
            # relying on a manual dashboard operation for each customer.
            response = await self._platform.request(
                "POST",
                f"/{waba_id}/subscribed_apps",
                headers=headers,
                json={"override_callback_uri": callback_url, "verify_token": verify_token},
            )
        except Exception as exc:
            raise MetaOnboardingError("subscription_failed", "No se pudo suscribir la app y configurar su webhook para la WABA.", detail={"error": str(exc), "wabaId": waba_id}) from exc
        if isinstance(response, dict) and response.get("success") is False:
            raise MetaOnboardingError("subscription_failed", "Meta rechazo la suscripcion de la app a la WABA.", detail={"response": response, "wabaId": waba_id})
        try:
            confirmed = await self._platform.request("GET", f"/{waba_id}/subscribed_apps", headers=headers, params={"fields": "id,override_callback_uri"})
        except Exception as exc:
            raise MetaOnboardingError("subscription_failed", "No se pudo confirmar la suscripcion y el webhook de la WABA.", detail={"error": str(exc), "wabaId": waba_id}) from exc
        confirmed_apps = confirmed.get("data") if isinstance(confirmed, dict) and isinstance(confirmed.get("data"), list) else []
        callback_confirmed = any(
            isinstance(app, dict) and str(app.get("override_callback_uri") or "").rstrip("/") == callback_url
            for app in confirmed_apps
        )
        if not callback_confirmed:
            raise MetaOnboardingError(
                "subscription_failed",
                "Meta no confirmo el callback de webhook para la WABA.",
                detail={"wabaId": waba_id, "expectedCallbackUrl": callback_url},
            )
        return {
            "alreadySubscribed": already_subscribed,
            "callbackUrl": callback_url,
            "response": response if isinstance(response, dict) else {},
        }
