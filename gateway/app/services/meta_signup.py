from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import httpx

from app.connections import get_connection_manager
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class MetaSignupError(Exception):
    def __init__(self, message: str, *, status_code: int = 502, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail or {}


@dataclass(frozen=True)
class MetaCredentials:
    access_token: str
    phone_number_id: str
    business_account_id: str
    token_type: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @property
    def access_token_ref(self) -> str:
        return f"meta://waba/{self.business_account_id}/phones/{self.phone_number_id}/token"

    def public_dict(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "phoneNumberId": self.phone_number_id,
            "businessAccountId": self.business_account_id,
            "hasAccessToken": bool(self.access_token),
            "accessTokenRef": self.access_token_ref,
            "metadata": dict(self.metadata),
        }
        if self.token_type:
            payload["tokenType"] = self.token_type
        return payload


@dataclass(frozen=True)
class MetaSignupCompletion:
    credentials: MetaCredentials
    instance: dict[str, Any]


class MetaSignupService:
    def __init__(self, client: httpx.AsyncClient | None = None, connection_manager: Any | None = None) -> None:
        self._client = client
        self._connection_manager = connection_manager

    def public_config(self) -> dict[str, Any]:
        settings = get_settings()
        missing = []
        if not settings.meta_app_id:
            missing.append("meta_app_id")
        if not settings.meta_app_secret:
            missing.append("meta_app_secret")
        if not settings.meta_embedded_signup_config_id:
            missing.append("meta_embedded_signup_config_id")
        return {
            "enabled": not missing,
            "app_id": settings.meta_app_id or None,
            "config_id": settings.meta_embedded_signup_config_id or None,
            "graph_version": settings.meta_graph_version,
            "supports_coexistence": True,
            "coexistence_feature_type": "whatsapp_business_app_onboarding",
            "missing": missing,
        }

    async def complete_onboarding(
        self,
        *,
        instance_name: str,
        code: str,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaSignupCompletion:
        credentials = await self.complete_embedded_signup(
            code=code,
            phone_number_id=phone_number_id,
            business_account_id=business_account_id,
            session_info=session_info,
        )
        manager = self._connection_manager or get_connection_manager()
        instance = await manager.create(
            instance_name=instance_name,
            qrcode=False,
            token=credentials.access_token,
            phone_number_id=credentials.phone_number_id,
            business_id=credentials.business_account_id,
            connection_type="cloud",
        )
        return MetaSignupCompletion(credentials=credentials, instance=instance if isinstance(instance, dict) else {})

    async def complete_embedded_signup(
        self,
        *,
        code: str,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaCredentials:
        settings = get_settings()
        self._ensure_configured(settings)
        token_payload = await self._exchange_code(code)
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise MetaSignupError("Meta no devolvio access_token para Embedded Signup.", status_code=502)

        metadata: dict[str, Any] = {
            "source": "embedded_signup",
            "sessionInfo": dict(session_info or {}),
        }

        return MetaCredentials(
            access_token=access_token,
            phone_number_id=phone_number_id,
            business_account_id=business_account_id,
            token_type=token_payload.get("token_type"),
            metadata=metadata,
        )

    def _ensure_configured(self, settings) -> None:
        missing = self.public_config()["missing"]
        if missing:
            raise MetaSignupError(
                f"Embedded Signup no esta configurado: faltan {', '.join(missing)}.",
                status_code=503,
                detail={"missing": missing},
            )

    async def _exchange_code(self, code: str) -> dict[str, Any]:
        settings = get_settings()
        result = await self._request(
            "GET",
            "/oauth/access_token",
            params={
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "code": code,
            },
        )
        if not isinstance(result, dict):
            raise MetaSignupError("Respuesta invalida de Meta al intercambiar el code.", status_code=502)
        return result

    async def _request(self, method: str, path: str, **kwargs) -> Any:
        settings = get_settings()
        client = self._client or httpx.AsyncClient(
            base_url=f"https://graph.facebook.com/{settings.meta_graph_version}",
            timeout=httpx.Timeout(float(settings.meta_signup_timeout_seconds)),
        )
        close_client = self._client is None
        try:
            response = await client.request(method, path, **kwargs)
            if response.status_code >= 400:
                detail = self._extract_error(response)
                logger.warning("meta_graph_error", method=method, path=path, status=response.status_code, detail=detail)
                raise MetaSignupError(
                    detail.get("message") or f"Meta Graph HTTP {response.status_code}",
                    status_code=response.status_code if response.status_code < 500 else 502,
                    detail=detail,
                )
            if response.content:
                return response.json()
            return {"ok": True}
        except httpx.TimeoutException as exc:
            raise MetaSignupError("Timeout comunicando con Meta durante Embedded Signup.", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise MetaSignupError(f"Error de transporte comunicando con Meta: {exc}", status_code=502) from exc
        finally:
            if close_client:
                await client.aclose()

    def _extract_error(self, response: httpx.Response) -> dict[str, Any]:
        try:
            payload = response.json()
        except Exception:
            payload = {}
        error = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(error, dict):
            return {
                "message": str(error.get("message") or ""),
                "type": error.get("type"),
                "code": error.get("code"),
                "fbtrace_id": error.get("fbtrace_id"),
            }
        return {"message": response.text[:300] or f"HTTP {response.status_code}"}


def get_meta_signup_service() -> MetaSignupService:
    return MetaSignupService()
