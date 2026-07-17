from __future__ import annotations

from functools import lru_cache
from typing import Any

from app.connections.baileys import BaileysConnection
from app.connections.base import Connection
from app.connections.cloud import CloudConnection
from app.connections.types import ConnectionType
from app.provisioning import ConnectionInstanceProvisioner, ProvisioningRequest, ProvisioningService


class ConnectionManager:
    def __init__(self) -> None:
        self._connections: dict[ConnectionType, Connection] = {
            ConnectionType.BAILEYS: BaileysConnection(),
            ConnectionType.CLOUD: CloudConnection(),
        }
        self._default_connection_type = ConnectionType.BAILEYS
        self._provisioning = ProvisioningService(
            instance_provisioners=[
                ConnectionInstanceProvisioner(connection) for connection in self._connections.values()
            ],
        )

    def get(self, connection_type: ConnectionType | str | None = None) -> Connection:
        resolved_type = ConnectionType(connection_type) if isinstance(connection_type, str) else connection_type
        resolved_type = resolved_type or self._default_connection_type
        connection = self._connections.get(resolved_type)
        if connection is None:
            raise NotImplementedError(f"Connection type {resolved_type.value} is not supported yet.")
        return connection

    def default(self) -> Connection:
        return self.get(self._default_connection_type)

    @property
    def provisioning(self) -> ProvisioningService:
        return self._provisioning

    async def open_default(self) -> None:
        await self.default().open()

    async def close_default(self) -> None:
        await self.default().close()

    async def create(
        self,
        instance_name: str,
        *,
        qrcode: bool = True,
        token: str | None = None,
        phone_number_id: str | None = None,
        business_id: str | None = None,
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        resolved_type = ConnectionType(connection_type) if isinstance(connection_type, str) else connection_type
        resolved_type = resolved_type or self._default_connection_type
        result = await self._provisioning.provision_connection(
            ProvisioningRequest(
                instance_name=instance_name,
                connection_type=resolved_type,
                qrcode=qrcode,
                token=token,
                phone_number_id=phone_number_id,
                business_id=business_id,
            )
        )
        if result.instance is None:
            return result.public_dict()
        return result.instance

    async def connect(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).connect(instance_name)

    async def reconnect(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).reconnect(instance_name)

    async def disconnect(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).disconnect(instance_name)

    async def delete(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).delete(instance_name)

    async def get_status(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).get_status(instance_name)

    async def list_instances(self, *, connection_type: ConnectionType | str | None = None) -> list:
        return await self.get(connection_type).list_instances()

    async def send_text(
        self,
        instance_name: str,
        number: str,
        text: str,
        *,
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        return await self.get(connection_type).send_text(instance_name, number, text)

    async def send_media(
        self,
        instance_name: str,
        number: str,
        media_payload: str,
        mediatype: str,
        mimetype: str,
        file_name: str,
        caption: str = "",
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        return await self.get(connection_type).send_media(
            instance_name,
            number,
            media_payload,
            mediatype,
            mimetype,
            file_name,
            caption,
        )

    async def send_buttons(
        self,
        instance_name: str,
        payload: dict,
        *,
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        return await self.get(connection_type).send_buttons(instance_name, payload)

    async def send_list(
        self,
        instance_name: str,
        payload: dict,
        *,
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        return await self.get(connection_type).send_list(instance_name, payload)

    async def check_whatsapp_numbers(
        self,
        instance_name: str,
        numbers: list[str],
        *,
        connection_type: ConnectionType | str | None = None,
    ) -> list:
        return await self.get(connection_type).check_whatsapp_numbers(instance_name, numbers)

    async def get_base64_from_media_message(
        self,
        instance_name: str,
        *,
        message_key: dict[str, Any],
        message_object: dict[str, Any] | None = None,
        convert_to_mp4: bool = False,
        connection_type: ConnectionType | str | None = None,
    ) -> str:
        return await self.get(connection_type).get_base64_from_media_message(
            instance_name,
            message_key=message_key,
            message_object=message_object,
            convert_to_mp4=convert_to_mp4,
        )

    async def set_webhook(
        self,
        instance_name: str,
        url: str,
        events: list[str],
        *,
        connection_type: ConnectionType | str | None = None,
    ) -> dict:
        return await self.get(connection_type).set_webhook(instance_name, url, events)

    async def get_webhook(self, instance_name: str, *, connection_type: ConnectionType | str | None = None) -> dict:
        return await self.get(connection_type).get_webhook(instance_name)


@lru_cache
def get_connection_manager() -> ConnectionManager:
    return ConnectionManager()
