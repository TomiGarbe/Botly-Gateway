from __future__ import annotations

from typing import Any, Protocol

from app.connections.capabilities import ConnectionCapabilities
from app.connections.models import ConnectionConfiguration, ConnectionModel
from app.connections.types import ConnectionType


class Connection(Protocol):
    @property
    def connection_type(self) -> ConnectionType:
        ...

    @property
    def evolution_integration(self) -> str:
        ...

    @property
    def capabilities(self) -> ConnectionCapabilities:
        ...

    def describe(
        self,
        *,
        id: str,
        name: str,
        status: str = "unknown",
        configuration: ConnectionConfiguration | None = None,
    ) -> ConnectionModel:
        ...

    async def open(self) -> None:
        ...

    async def close(self) -> None:
        ...

    async def create(
        self,
        instance_name: str,
        *,
        qrcode: bool = True,
        token: str | None = None,
        phone_number_id: str | None = None,
        business_id: str | None = None,
    ) -> dict:
        ...

    async def connect(self, instance_name: str) -> dict:
        ...

    async def reconnect(self, instance_name: str) -> dict:
        ...

    async def disconnect(self, instance_name: str) -> dict:
        ...

    async def delete(self, instance_name: str) -> dict:
        ...

    async def get_status(self, instance_name: str) -> dict:
        ...

    async def list_instances(self) -> list:
        ...

    async def send_text(self, instance_name: str, number: str, text: str) -> dict:
        ...

    async def send_media(
        self,
        instance_name: str,
        number: str,
        media_payload: str,
        mediatype: str,
        mimetype: str,
        file_name: str,
        caption: str = "",
    ) -> dict:
        ...

    async def send_buttons(self, instance_name: str, payload: dict) -> dict:
        ...

    async def send_list(self, instance_name: str, payload: dict) -> dict:
        ...

    async def check_whatsapp_numbers(self, instance_name: str, numbers: list[str]) -> list:
        ...

    async def get_base64_from_media_message(
        self,
        instance_name: str,
        *,
        message_key: dict[str, Any],
        message_object: dict[str, Any] | None = None,
        convert_to_mp4: bool = False,
    ) -> str:
        ...

    async def set_webhook(self, instance_name: str, url: str, events: list[str]) -> dict:
        ...

    async def get_webhook(self, instance_name: str) -> dict:
        ...
