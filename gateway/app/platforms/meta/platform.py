from __future__ import annotations

from typing import Any, Callable

import httpx

from app.core.config import get_settings
from app.core.logging import get_logger
from app.platforms.meta.models import MetaCredentials, MetaPlatformConfig, MetaResource, MetaToken

logger = get_logger(__name__)


class MetaPlatformError(Exception):
    def __init__(self, message: str, *, status_code: int = 502, detail: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.detail = detail or {}


class MetaPlatform:
    def __init__(
        self,
        *,
        client: httpx.AsyncClient | None = None,
        settings_factory: Callable[[], Any] = get_settings,
    ) -> None:
        self._client = client
        self._settings_factory = settings_factory

    def public_config(self) -> dict[str, Any]:
        return self.config().public_dict()

    def config(self) -> MetaPlatformConfig:
        settings = self._settings_factory()
        missing = []
        if not settings.meta_app_id:
            missing.append("meta_app_id")
        if not settings.meta_app_secret:
            missing.append("meta_app_secret")
        if not settings.meta_embedded_signup_config_id:
            missing.append("meta_embedded_signup_config_id")
        return MetaPlatformConfig(
            enabled=not missing,
            app_id=settings.meta_app_id or None,
            config_id=settings.meta_embedded_signup_config_id or None,
            graph_version=settings.meta_graph_version,
            supports_coexistence=True,
            coexistence_feature_type="whatsapp_business_app_onboarding",
            missing=tuple(missing),
        )

    def health(self) -> dict[str, Any]:
        config = self.config()
        return {
            "platform": "meta",
            "configured": config.enabled,
            "graphVersion": config.graph_version,
            "missing": list(config.missing),
        }

    async def authenticate(self, *, code: str) -> MetaToken:
        self._ensure_configured()
        token_payload = await self._exchange_code(code)
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise MetaPlatformError("Meta no devolvio access_token para Embedded Signup.", status_code=502)
        expires_in = token_payload.get("expires_in")
        return MetaToken(
            access_token=access_token,
            token_type=token_payload.get("token_type"),
            expires_in=expires_in if isinstance(expires_in, int) else None,
            metadata={
                "source": "oauth_code",
            },
        )

    async def refresh_token(self, *, refresh_token: str) -> MetaToken:
        raise MetaPlatformError(
            "Meta token refresh is not implemented yet.",
            status_code=501,
            detail={"operation": "refresh_token", "platform": "meta"},
        )

    def validate_credentials(self, credentials: MetaCredentials) -> bool:
        return bool(
            str(credentials.access_token or "").strip()
            and str(credentials.phone_number_id or "").strip()
            and str(credentials.business_account_id or "").strip()
        )

    def get_graph_client(self) -> httpx.AsyncClient:
        if self._client is not None:
            return self._client
        settings = self._settings_factory()
        return httpx.AsyncClient(
            base_url=f"https://graph.facebook.com/{settings.meta_graph_version}",
            timeout=httpx.Timeout(float(settings.meta_signup_timeout_seconds)),
        )

    async def discover_resources(self, *, credentials: MetaCredentials) -> tuple[MetaResource, ...]:
        from app.platforms.meta.discovery import MetaDiscoveryService

        return await MetaDiscoveryService(platform=self).discover(credentials=credentials)

    async def request(self, method: str, path: str, **kwargs) -> Any:
        client = self.get_graph_client()
        close_client = self._client is None
        try:
            response = await client.request(method, path, **kwargs)
            if response.status_code >= 400:
                detail = self._extract_error(response)
                logger.warning("meta_graph_error", method=method, path=path, status=response.status_code, detail=detail)
                raise MetaPlatformError(
                    detail.get("message") or f"Meta Graph HTTP {response.status_code}",
                    status_code=response.status_code if response.status_code < 500 else 502,
                    detail=detail,
                )
            if response.content:
                return response.json()
            return {"ok": True}
        except httpx.TimeoutException as exc:
            raise MetaPlatformError("Timeout comunicando con Meta durante Embedded Signup.", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise MetaPlatformError(f"Error de transporte comunicando con Meta: {exc}", status_code=502) from exc
        finally:
            if close_client:
                await client.aclose()

    def credentials_from_embedded_signup(
        self,
        *,
        token: MetaToken,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaCredentials:
        credentials = MetaCredentials(
            access_token=token.access_token,
            phone_number_id=phone_number_id,
            business_account_id=business_account_id,
            token_type=token.token_type,
            metadata={
                "source": "embedded_signup",
                "sessionInfo": dict(session_info or {}),
            },
        )
        if not self.validate_credentials(credentials):
            raise MetaPlatformError("Credenciales de Meta incompletas.", status_code=422)
        return credentials

    def _ensure_configured(self) -> None:
        missing = self.config().missing
        if missing:
            raise MetaPlatformError(
                f"Embedded Signup no esta configurado: faltan {', '.join(missing)}.",
                status_code=503,
                detail={"missing": list(missing)},
            )

    async def _exchange_code(self, code: str) -> dict[str, Any]:
        settings = self._settings_factory()
        result = await self.request(
            "GET",
            "/oauth/access_token",
            params={
                "client_id": settings.meta_app_id,
                "client_secret": settings.meta_app_secret,
                "code": code,
            },
        )
        if not isinstance(result, dict):
            raise MetaPlatformError("Respuesta invalida de Meta al intercambiar el code.", status_code=502)
        return result

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
