from __future__ import annotations

import asyncio
import random
from typing import Any

import httpx

from app.adapters.evolution.errors import EvolutionError
from app.core.config import get_settings
from app.core.logging import get_logger

logger = get_logger(__name__)


class EvolutionClient:
    def __init__(self) -> None:
        self._client: httpx.AsyncClient | None = None
        self._lock = asyncio.Lock()

    def _build_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(connect=5.0, read=25.0, write=15.0, pool=5.0)

    async def open(self) -> httpx.AsyncClient:
        if self._client is not None:
            return self._client

        async with self._lock:
            if self._client is None:
                settings = get_settings()
                self._client = httpx.AsyncClient(
                    base_url=settings.evolution_url,
                    headers={"apikey": settings.evolution_api_key, "Content-Type": "application/json"},
                    timeout=self._build_timeout(),
                )
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def request(self, method: str, path: str, *, retries: int = 1, **kwargs) -> Any:
        client = await self.open()

        for attempt in range(retries + 1):
            try:
                response = await client.request(method, path, **kwargs)

                if response.status_code >= 500 and attempt < retries:
                    backoff = 0.25 * (2**attempt) + random.uniform(0, 0.2)
                    logger.warning(
                        "evolution_request_retry_server_error",
                        method=method,
                        path=path,
                        status=response.status_code,
                        attempt=attempt + 1,
                        backoff=round(backoff, 3),
                    )
                    await asyncio.sleep(backoff)
                    continue

                response.raise_for_status()
                if response.content:
                    try:
                        return response.json()
                    except Exception:
                        return {"ok": True, "raw": response.text}
                return {"ok": True}

            except httpx.TimeoutException as exc:
                retryable = attempt < retries
                logger.warning(
                    "evolution_request_timeout",
                    method=method,
                    path=path,
                    attempt=attempt + 1,
                    retryable=retryable,
                )
                if retryable:
                    await asyncio.sleep(0.25 * (2**attempt))
                    continue
                raise EvolutionError(
                    message=f"Botly Gateway timeout on {method} {path}",
                    status_code=504,
                    retryable=True,
                ) from exc

            except httpx.HTTPStatusError as exc:
                response = exc.response
                message = self._extract_error_message(response)
                retryable = response.status_code >= 500
                logger.info(
                    "evolution_response",
                    method=method,
                    path=path,
                    status=response.status_code,
                    body=response.text,
                )
                logger.warning(
                    "evolution_request_http_error",
                    method=method,
                    path=path,
                    status=response.status_code,
                    message=message,
                    attempt=attempt + 1,
                )
                raise EvolutionError(
                    message=f"Botly Gateway HTTP {response.status_code}: {message}",
                    status_code=response.status_code,
                    detail={"method": method, "path": path, "response": message},
                    retryable=retryable,
                ) from exc

            except httpx.HTTPError as exc:
                retryable = attempt < retries
                logger.warning(
                    "evolution_request_transport_error",
                    method=method,
                    path=path,
                    attempt=attempt + 1,
                    retryable=retryable,
                    error=str(exc),
                )
                if retryable:
                    await asyncio.sleep(0.25 * (2**attempt))
                    continue
                raise EvolutionError(
                    message=f"Botly Gateway transport error on {method} {path}: {exc}",
                    status_code=502,
                    retryable=True,
                ) from exc

    def _extract_error_message(self, response: httpx.Response) -> str:
        try:
            payload = response.json()
        except Exception:
            payload = None

        if isinstance(payload, dict):
            for key in ("message", "detail", "error"):
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value
        return response.text[:300] or f"HTTP {response.status_code}"


_client = EvolutionClient()


def get_evolution_client() -> EvolutionClient:
    return _client
