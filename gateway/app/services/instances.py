from __future__ import annotations

from app.connections import ConnectionManager, get_connection_manager


class InstanceService:
    def __init__(self, connection_manager: ConnectionManager | None = None) -> None:
        self._connection_manager = connection_manager or get_connection_manager()

    async def create_instance(
        self,
        instance_name: str,
        *,
        qrcode: bool = True,
        token: str | None = None,
        phone_number_id: str | None = None,
        business_id: str | None = None,
        connection_type: str | None = None,
    ) -> dict:
        return await self._connection_manager.create(
            instance_name,
            qrcode=qrcode,
            token=token,
            phone_number_id=phone_number_id,
            business_id=business_id,
            connection_type=connection_type,
        )

    async def get_qr(self, instance_name: str) -> dict:
        return await self._connection_manager.connect(instance_name)

    async def get_connection_state(self, instance_name: str) -> dict:
        return await self._connection_manager.get_status(instance_name)

    async def fetch_instances(self) -> list:
        return await self._connection_manager.list_instances()

    async def restart_instance(self, instance_name: str) -> dict:
        return await self._connection_manager.reconnect(instance_name)

    async def logout_instance(self, instance_name: str) -> dict:
        return await self._connection_manager.disconnect(instance_name)

    async def delete_instance(self, instance_name: str) -> dict:
        return await self._connection_manager.delete(instance_name)

    async def set_webhook(self, instance_name: str, url: str, events: list[str]) -> dict:
        return await self._connection_manager.set_webhook(instance_name, url, events)

    async def get_webhook(self, instance_name: str) -> dict:
        return await self._connection_manager.get_webhook(instance_name)


def get_instance_service() -> InstanceService:
    return InstanceService()
