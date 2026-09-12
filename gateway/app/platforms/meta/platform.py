from __future__ import annotations

import hashlib
import hmac
import time
from typing import Any, Callable, Mapping
from urllib.parse import urlsplit

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
        # The token itself is intentionally never logged.  This fingerprint is
        # only used to correlate the token returned by OAuth with later Graph
        # calls in a single production diagnosis.
        logger.info("meta_oauth_access_token_received", **self._token_observability(access_token))
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
        # Only outbound message sends opt into response logging. OAuth responses
        # can contain access tokens and must never be logged.
        log_response = bool(kwargs.pop("log_response", False))
        client = self.get_graph_client()
        close_client = self._client is None
        request_started_at = time.perf_counter()
        try:
            request_kwargs = self._with_appsecret_proof(kwargs)
            token, token_transport = self._request_access_token(request_kwargs)
            first_started_at = time.perf_counter()
            response = await client.request(method, path, **request_kwargs)
            # Meta validates the Embedded Signup token via /debug_token, but
            # some Graph endpoints reject that same token when it is supplied
            # in the Authorization header (OAuth error 190).  Their documented
            # query-parameter form remains accepted.  Retry only this exact
            # case, and remove the header so credentials are never duplicated.
            should_retry = self._should_retry_with_query_token(response, request_kwargs.get("headers"))
            retry_reason = "oauth_error_190_with_bearer" if should_retry else None
            self._log_graph_attempt(
                method=method,
                path=path,
                attempt=1,
                response=response,
                duration_ms=(time.perf_counter() - first_started_at) * 1000,
                token=token,
                token_transport=token_transport,
                retry_triggered=should_retry,
                retry_reason=retry_reason,
            )
            if should_retry:
                retry_kwargs = self._query_token_retry_kwargs(request_kwargs)
                retry_token = self._bearer_token(request_kwargs.get("headers"))
                logger.info(
                    "meta_graph_retry",
                    method=method.upper(),
                    path=self._safe_log_path(path),
                    attempt=2,
                    retry_reason=retry_reason,
                    token_transport_from=token_transport,
                    token_transport_to="query_access_token",
                    **self._token_observability(retry_token),
                )
                retry_started_at = time.perf_counter()
                response = await client.request(method, path, **retry_kwargs)
                self._log_graph_attempt(
                    method=method,
                    path=path,
                    attempt=2,
                    response=response,
                    duration_ms=(time.perf_counter() - retry_started_at) * 1000,
                    token=retry_token,
                    token_transport="query_access_token",
                    retry_triggered=False,
                    retry_reason=retry_reason,
                )
            if log_response:
                try:
                    logged_body: Any = response.json()
                except Exception:
                    logged_body = response.text
                logger.info(
                    "meta_graph_outbound_response",
                    method=method,
                    path=self._safe_log_path(path),
                    status=response.status_code,
                    response=logged_body,
                )
            if response.status_code >= 400:
                detail = self._extract_error(response)
                logger.warning(
                    "meta_graph_error",
                    method=method,
                    path=self._safe_log_path(path),
                    status=response.status_code,
                    meta_error_code=detail.get("code"),
                    meta_error_type=detail.get("type"),
                    meta_fbtrace_id=detail.get("fbtrace_id"),
                )
                raise MetaPlatformError(
                    detail.get("message") or f"Meta Graph HTTP {response.status_code}",
                    status_code=response.status_code if response.status_code < 500 else 502,
                    detail=detail,
                )
            if response.content:
                return response.json()
            return {"ok": True}
        except httpx.TimeoutException as exc:
            logger.warning(
                "meta_graph_transport_error",
                method=method.upper(),
                path=self._safe_log_path(path),
                status=None,
                duration_ms=round((time.perf_counter() - request_started_at) * 1000, 2),
                error_type="timeout",
            )
            raise MetaPlatformError("Timeout comunicando con Meta durante Embedded Signup.", status_code=504) from exc
        except httpx.HTTPError as exc:
            logger.warning(
                "meta_graph_transport_error",
                method=method.upper(),
                path=self._safe_log_path(path),
                status=None,
                duration_ms=round((time.perf_counter() - request_started_at) * 1000, 2),
                error_type="http_error",
            )
            raise MetaPlatformError(f"Error de transporte comunicando con Meta: {exc}", status_code=502) from exc
        finally:
            if close_client:
                await client.aclose()

    @staticmethod
    def _bearer_token(headers: Any) -> str | None:
        if not isinstance(headers, Mapping):
            return None
        for name, value in headers.items():
            if str(name).lower() != "authorization":
                continue
            candidate = str(value).strip()
            if candidate.lower().startswith("bearer "):
                token = candidate[7:].strip()
                return token or None
        return None

    @staticmethod
    def _token_observability(token: str | None) -> dict[str, Any]:
        """Return irreversible access-token correlation fields for structured logs."""
        if not token:
            return {
                "access_token_present": False,
                "access_token_length": 0,
                "access_token_sha256": None,
            }
        return {
            "access_token_present": True,
            "access_token_length": len(token),
            "access_token_sha256": hashlib.sha256(token.encode("utf-8")).hexdigest(),
        }

    def _request_access_token(self, kwargs: Mapping[str, Any]) -> tuple[str | None, str]:
        """Identify only an Embedded Signup token, without inspecting app-token params."""
        bearer_token = self._bearer_token(kwargs.get("headers"))
        if bearer_token:
            return bearer_token, "authorization_bearer"
        params = kwargs.get("params")
        if isinstance(params, Mapping):
            input_token = str(params.get("input_token") or "").strip()
            if input_token:
                return input_token, "debug_input_token"
        return None, "none"

    @staticmethod
    def _safe_log_path(path: str) -> str:
        """Discard query and fragment components before writing a Graph path to logs."""
        return urlsplit(str(path)).path or "/"

    def _log_graph_attempt(
        self,
        *,
        method: str,
        path: str,
        attempt: int,
        response: httpx.Response,
        duration_ms: float,
        token: str | None,
        token_transport: str,
        retry_triggered: bool,
        retry_reason: str | None,
    ) -> None:
        detail = self._extract_error(response) if response.status_code >= 400 else {}
        logger.info(
            "meta_graph_request",
            method=method.upper(),
            path=self._safe_log_path(path),
            attempt=attempt,
            status=response.status_code,
            duration_ms=round(duration_ms, 2),
            token_transport=token_transport,
            retry_triggered=retry_triggered,
            retry_reason=retry_reason,
            meta_error_code=detail.get("code"),
            meta_error_type=detail.get("type"),
            meta_fbtrace_id=detail.get("fbtrace_id"),
            **self._token_observability(token),
        )

    def _should_retry_with_query_token(self, response: httpx.Response, headers: Any) -> bool:
        if response.status_code != 401 or not self._bearer_token(headers):
            return False
        detail = self._extract_error(response)
        return detail.get("code") == 190

    def _query_token_retry_kwargs(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        token = self._bearer_token(kwargs.get("headers"))
        if not token:
            return kwargs
        headers = {
            str(name): value
            for name, value in (kwargs.get("headers") or {}).items()
            if str(name).lower() != "authorization"
        }
        params = dict(kwargs.get("params") or {})
        params["access_token"] = token
        return {**kwargs, "headers": headers, "params": params}

    def _with_appsecret_proof(self, kwargs: dict[str, Any]) -> dict[str, Any]:
        """Add Meta's optional server-side proof for bearer-token Graph calls."""
        token = self._bearer_token(kwargs.get("headers"))
        secret = str(getattr(self._settings_factory(), "meta_app_secret", "") or "").strip()
        if not token or not secret:
            return kwargs
        params = dict(kwargs.get("params") or {})
        params.setdefault(
            "appsecret_proof",
            hmac.new(secret.encode("utf-8"), token.encode("utf-8"), hashlib.sha256).hexdigest(),
        )
        return {**kwargs, "params": params}

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
