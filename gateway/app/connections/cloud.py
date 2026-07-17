from __future__ import annotations

from typing import Any

from app.adapters.evolution.transports import CLOUD_TRANSPORT_PROFILE
from app.connections.base import Connection
from app.connections.capabilities import CloudCapabilities
from app.connections.cloud_domain import CloudConnectionRecord, CloudConnectionStatus, CloudCredentials
from app.connections.errors import ConnectionNotImplementedError
from app.connections.models import ConnectionConfiguration, ConnectionModel
from app.connections.types import ConnectionType


def _evolution_client():
    from app.adapters import evolution

    return evolution.get_evolution_adapter()


class CloudConnection(Connection):
    connection_type = ConnectionType.CLOUD
    evolution_integration = CLOUD_TRANSPORT_PROFILE.integration or "WHATSAPP-BUSINESS"
    capabilities = CloudCapabilities()

    def __init__(self) -> None:
        self._records: dict[str, CloudConnectionRecord] = {}

    def _unsupported(self, operation: str) -> ConnectionNotImplementedError:
        return ConnectionNotImplementedError(connection_type=self.connection_type, operation=operation)

    def describe(
        self,
        *,
        id: str,
        name: str,
        status: str = "created",
        configuration: ConnectionConfiguration | None = None,
    ) -> ConnectionModel:
        record = self._records.get(name)
        return ConnectionModel(
            id=id,
            name=name,
            connection_type=self.connection_type,
            status=record.status.value if record else status,
            capabilities=self.capabilities,
            configuration=configuration or ConnectionConfiguration(
                public={
                    "implemented": True,
                    "qr": False,
                    "meta": False,
                    "integration": self.evolution_integration,
                }
            ),
        )

    def configure(self, instance_name: str, credentials: CloudCredentials) -> dict:
        record = self._records.get(instance_name)
        if record is None or record.status == CloudConnectionStatus.DELETED:
            record = CloudConnectionRecord(
                id=instance_name,
                name=instance_name,
                status=CloudConnectionStatus.CREATED,
            )
            self._records[instance_name] = record

        record.credentials = credentials
        record.status = CloudConnectionStatus.CONFIGURED if credentials.is_configured else CloudConnectionStatus.CREATED
        return record.public_instance()

    def _record(self, instance_name: str) -> CloudConnectionRecord:
        record = self._records.get(instance_name)
        if record is None:
            record = CloudConnectionRecord(
                id=instance_name,
                name=instance_name,
                status=CloudConnectionStatus.CREATED,
            )
            self._records[instance_name] = record
        return record

    async def open(self) -> None:
        return None

    async def close(self) -> None:
        return None

    async def create(
        self,
        instance_name: str,
        *,
        qrcode: bool = True,
        token: str | None = None,
        phone_number_id: str | None = None,
        business_id: str | None = None,
    ) -> dict:
        if token and phone_number_id and business_id:
            evolution = _evolution_client()
            result = await evolution.create_instance(
                instance_name=instance_name,
                qrcode=False,
                token=token,
                integration=self.evolution_integration,
                number=phone_number_id,
                business_id=business_id,
            )
            self.configure(
                instance_name,
                CloudCredentials(
                    phone_number_id=phone_number_id,
                    business_account_id=business_id,
                    access_token_ref=f"evolution://instances/{instance_name}/token",
                    connection_metadata={"integration": self.evolution_integration},
                ),
            )
            if isinstance(result, dict):
                result.setdefault("integration", self.evolution_integration)
                result.setdefault("connectionType", self.connection_type.value)
                instance_payload = result.get("instance") if isinstance(result.get("instance"), dict) else {}
                if not any(key in result for key in ("connectionStatus", "status")) and not instance_payload.get("state"):
                    result["status"] = "open"
            return result

        record = CloudConnectionRecord(
            id=instance_name,
            name=instance_name,
            status=CloudConnectionStatus.CREATED,
        )
        self._records[instance_name] = record
        return record.public_instance()

    async def connect(self, instance_name: str) -> dict:
        raise self._unsupported("connect")

    async def reconnect(self, instance_name: str) -> dict:
        raise self._unsupported("reconnect")

    async def disconnect(self, instance_name: str) -> dict:
        record = self._record(instance_name)
        if record.status != CloudConnectionStatus.DELETED:
            record.status = CloudConnectionStatus.DISCONNECTED
        return record.public_instance()

    async def delete(self, instance_name: str) -> dict:
        record = self._record(instance_name)
        record.status = CloudConnectionStatus.DELETED
        return record.public_instance()

    async def get_status(self, instance_name: str) -> dict:
        return self._record(instance_name).public_instance()

    async def list_instances(self) -> list:
        return [record.public_instance() for record in self._records.values()]

    async def send_text(self, instance_name: str, number: str, text: str) -> dict:
        raise self._unsupported("send_text")

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
        raise self._unsupported("send_media")

    async def send_buttons(self, instance_name: str, payload: dict) -> dict:
        raise self._unsupported("send_buttons")

    async def send_list(self, instance_name: str, payload: dict) -> dict:
        raise self._unsupported("send_list")

    async def check_whatsapp_numbers(self, instance_name: str, numbers: list[str]) -> list:
        raise self._unsupported("check_whatsapp_numbers")

    async def get_base64_from_media_message(
        self,
        instance_name: str,
        *,
        message_key: dict[str, Any],
        message_object: dict[str, Any] | None = None,
        convert_to_mp4: bool = False,
    ) -> str:
        raise self._unsupported("get_base64_from_media_message")

    async def set_webhook(self, instance_name: str, url: str, events: list[str]) -> dict:
        raise self._unsupported("set_webhook")

    async def get_webhook(self, instance_name: str) -> dict:
        raise self._unsupported("get_webhook")
