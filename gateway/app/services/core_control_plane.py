"""Narrow server-side client for Botly Core's Gateway control-plane."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote

import httpx

from app.core.config import get_settings


class CoreControlPlaneError(RuntimeError):
    def __init__(self, message: str, *, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class CoreChannel:
    id: str
    name: str
    channel_type: str
    status: str

    @classmethod
    def from_payload(cls, value: Any) -> "CoreChannel":
        if not isinstance(value, dict):
            raise CoreControlPlaneError("Core returned an invalid channel response", status_code=502)
        fields = {key: str(value.get(key) or "").strip() for key in ("id", "name", "channel_type", "status")}
        if not all(fields.values()):
            raise CoreControlPlaneError("Core returned incomplete channel metadata", status_code=502)
        return cls(**fields)

    def public_dict(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "channel_type": self.channel_type, "status": self.status}


@dataclass(frozen=True)
class CoreBinding:
    id: str
    channel: CoreChannel
    dispatch_credential: str


class CoreControlPlaneClient:
    """Core control-plane calls only; no provider, OAuth or dispatcher logic."""

    def __init__(self, *, settings_factory: Callable[[], Any] = get_settings, client: httpx.AsyncClient | None = None) -> None:
        self._settings_factory = settings_factory
        self._client = client

    def _settings(self) -> tuple[str, str, float]:
        settings = self._settings_factory()
        base_url = str(getattr(settings, "core_control_plane_url", "") or "").strip().rstrip("/")
        api_key = str(getattr(settings, "gateway_control_plane_api_key", "") or "").strip()
        if not base_url or not api_key:
            raise CoreControlPlaneError("Core Channel integration is not configured", status_code=503)
        return base_url, api_key, float(getattr(settings, "core_control_plane_timeout_seconds", 10) or 10)

    async def discover_channels(self, *, gateway_client_id: str, channel_type: str) -> list[CoreChannel]:
        payload = await self._request("GET", "/channels", gateway_client_id=gateway_client_id, params={"channel_type": channel_type})
        raw_items = payload.get("items") if isinstance(payload, dict) else None
        if not isinstance(raw_items, list):
            raise CoreControlPlaneError("Core returned an invalid channel list", status_code=502)
        return [CoreChannel.from_payload(item) for item in raw_items]

    async def bind(self, *, gateway_client_id: str, gateway_connection_id: str, core_channel_id: str, channel_type: str) -> CoreBinding:
        payload = await self._request(
            "POST", "/bindings", gateway_client_id=gateway_client_id,
            json={"gateway_connection_id": gateway_connection_id, "core_channel_id": core_channel_id, "channel_type": channel_type},
        )
        if not isinstance(payload, dict) or not isinstance(payload.get("binding"), dict):
            raise CoreControlPlaneError("Core returned an invalid binding response", status_code=502)
        binding_id = str(payload["binding"].get("id") or "").strip()
        credential = str(payload.get("dispatch_credential") or "").strip()
        if not binding_id or not credential:
            raise CoreControlPlaneError("Core returned an incomplete binding response", status_code=502)
        return CoreBinding(id=binding_id, channel=CoreChannel.from_payload(payload.get("channel")), dispatch_credential=credential)

    async def revoke_binding(self, *, gateway_client_id: str, binding_id: str) -> None:
        await self._request("DELETE", f"/bindings/{quote(binding_id, safe='')}", gateway_client_id=gateway_client_id, expect_empty=True)

    async def _request(self, method: str, path: str, *, gateway_client_id: str, params: dict[str, str] | None = None, json: dict[str, str] | None = None, expect_empty: bool = False) -> dict[str, Any]:
        base_url, api_key, timeout = self._settings()
        # Keep the configured `/api/v1/control-plane/gateway` prefix. A leading
        # slash in an httpx request path would otherwise discard it.
        client = self._client or httpx.AsyncClient(base_url=f"{base_url}/", timeout=httpx.Timeout(timeout))
        close = self._client is None
        try:
            response = await client.request(
                method, path.lstrip("/"), params=params, json=json,
                headers={"Authorization": f"Bearer {api_key}", "X-Botly-Gateway-Client-Id": gateway_client_id},
            )
        except httpx.TimeoutException as exc:
            raise CoreControlPlaneError("Core Channel integration timed out", status_code=504) from exc
        except httpx.HTTPError as exc:
            raise CoreControlPlaneError("Core Channel integration is unavailable", status_code=502) from exc
        finally:
            if close:
                await client.aclose()
        if response.status_code >= 400:
            messages = {401: "Core rejected Gateway service authentication", 403: "The selected channel is not available for this client", 404: "The selected Core channel was not found", 409: "The selected Core channel cannot be linked", 503: "Core Channel integration is not configured"}
            safe_statuses = {401, 403, 404, 409, 503}
            raise CoreControlPlaneError(
                messages.get(response.status_code, "Core Channel integration failed"),
                status_code=response.status_code if response.status_code in safe_statuses else 502,
            )
        if expect_empty:
            return {}
        try:
            payload = response.json()
        except ValueError as exc:
            raise CoreControlPlaneError("Core returned an invalid response", status_code=502) from exc
        if not isinstance(payload, dict):
            raise CoreControlPlaneError("Core returned an invalid response", status_code=502)
        return payload


def get_core_control_plane_client() -> CoreControlPlaneClient:
    return CoreControlPlaneClient()
