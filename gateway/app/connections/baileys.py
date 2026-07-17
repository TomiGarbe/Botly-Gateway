from __future__ import annotations

from app.adapters.evolution.transports import BAILEYS_TRANSPORT_PROFILE
from app.connections.base import Connection
from app.connections.capabilities import BaileysCapabilities
from app.connections.models import ConnectionConfiguration, ConnectionModel
from app.connections.types import ConnectionType


def _evolution_client():
    from app.adapters import evolution

    return evolution.get_evolution_adapter()


class BaileysConnection(Connection):
    connection_type = ConnectionType.BAILEYS
    evolution_integration = BAILEYS_TRANSPORT_PROFILE.integration or ""
    capabilities = BaileysCapabilities()

    def describe(
        self,
        *,
        id: str,
        name: str,
        status: str = "unknown",
        configuration: ConnectionConfiguration | None = None,
    ) -> ConnectionModel:
        return ConnectionModel(
            id=id,
            name=name,
            connection_type=self.connection_type,
            status=status,
            capabilities=self.capabilities,
            configuration=configuration or ConnectionConfiguration(
                public={"integration": self.evolution_integration, "qr": True}
            ),
        )

    async def open(self) -> None:
        evolution = _evolution_client()
        await evolution.open()

    async def close(self) -> None:
        evolution = _evolution_client()
        await evolution.close()

    async def create(
        self,
        instance_name: str,
        *,
        qrcode: bool = True,
        token: str | None = None,
        phone_number_id: str | None = None,
        business_id: str | None = None,
    ) -> dict:
        evolution = _evolution_client()
        return await evolution.create_instance(
            instance_name=instance_name,
            qrcode=qrcode,
            token=token,
            integration=self.evolution_integration,
        )

    async def connect(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.get_qr(instance_name)

    async def reconnect(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.reconnect_instance(instance_name)

    async def disconnect(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.disconnect_instance(instance_name)

    async def delete(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.delete_instance(instance_name)

    async def get_status(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.get_instance_status(instance_name)

    async def list_instances(self) -> list:
        evolution = _evolution_client()
        return await evolution.list_instances()

    async def send_text(self, instance_name: str, number: str, text: str) -> dict:
        evolution = _evolution_client()
        return await evolution.send_text(instance_name, number, text)

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
        evolution = _evolution_client()
        return await evolution.send_media(instance_name, number, media_payload, mediatype, mimetype, file_name, caption)

    async def send_buttons(self, instance_name: str, payload: dict) -> dict:
        evolution = _evolution_client()
        return await evolution.send_buttons(instance_name, payload)

    async def send_list(self, instance_name: str, payload: dict) -> dict:
        evolution = _evolution_client()
        return await evolution.send_list(instance_name, payload)

    async def check_whatsapp_numbers(self, instance_name: str, numbers: list[str]) -> list:
        evolution = _evolution_client()
        return await evolution.check_whatsapp_numbers(instance_name, numbers)

    async def get_base64_from_media_message(
        self,
        instance_name: str,
        *,
        message_key: dict,
        message_object: dict | None = None,
        convert_to_mp4: bool = False,
    ) -> str:
        evolution = _evolution_client()
        return await evolution.get_base64_from_media_message(
            instance_name,
            message_key=message_key,
            message_object=message_object,
            convert_to_mp4=convert_to_mp4,
        )

    async def set_webhook(self, instance_name: str, url: str, events: list[str]) -> dict:
        evolution = _evolution_client()
        return await evolution.configure_webhook(instance_name, url, events)

    async def get_webhook(self, instance_name: str) -> dict:
        evolution = _evolution_client()
        return await evolution.get_webhook(instance_name)
