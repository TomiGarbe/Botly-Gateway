"""Inbound WhatsApp Cloud media is fetched from Graph, never through Evolution."""
from __future__ import annotations

import asyncio

import httpx

from app.services import media as media_service


def test_cloud_media_id_comes_from_the_cloud_message_object() -> None:
    cloud = {"messageObject": {"audioMessage": {"id": "1234567890", "mime_type": "audio/ogg; codecs=opus", "voice": True}}}
    baileys = {"messageObject": {"audioMessage": {"url": "https://mmg.whatsapp.net/x", "mediaKey": "abc", "id": "nope"}}}

    assert media_service._cloud_media_id(cloud) == "1234567890"
    assert media_service._cloud_media_id(baileys) is None
    assert media_service._cloud_media_id({}) is None


def test_cloud_media_bytes_are_downloaded_via_graph(tmp_path, monkeypatch) -> None:
    ogg = b"OggS" + b"\x00" * 60
    graph_calls: list[str] = []

    class _Platform:
        async def request(self, method, path, **kwargs):
            graph_calls.append(path)
            assert kwargs["headers"]["Authorization"] == "Bearer token-1"
            return {"url": "https://lookaside.example/media", "mime_type": "audio/ogg"}

    async def fake_get(self, url, **kwargs):
        assert kwargs["headers"]["Authorization"] == "Bearer token-1"
        return httpx.Response(200, content=ogg, request=httpx.Request("GET", url))

    class _Evolution:
        async def get_base64_from_media_message(self, *args, **kwargs):
            raise AssertionError("Cloud media must not use Evolution decrypt")

    import app.platforms.meta as meta

    monkeypatch.setattr(meta, "MetaPlatform", lambda: _Platform())
    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    monkeypatch.setattr(media_service, "_official_credentials", lambda instance: (object(), "token-1"))
    monkeypatch.setattr(media_service, "_decrypted_cache_path", lambda instance, media_id: tmp_path / f"{media_id}.bin")
    monkeypatch.setattr(media_service, "_connection_manager", _Evolution())
    monkeypatch.setattr("app.services.normalization.update_media_download_state", lambda *a, **k: None)

    payload, info = asyncio.run(media_service.get_decrypted_media_bytes({
        "instance": "cloud_runtime", "id": "gw-media-1", "kind": "audio", "mimeType": None,
        "messageObject": {"audioMessage": {"id": "1234567890"}},
    }))

    assert payload == ogg
    assert info["source"] == "meta_graph" and info["mime"] == "audio/ogg"
    assert graph_calls == ["/1234567890"]
