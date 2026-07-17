from __future__ import annotations

from typing import Any

from app.adapters.evolution import EvolutionError, get_evolution_adapter, get_evolution_client


async def get_client():
    return await get_evolution_client().open()


async def close_client() -> None:
    await get_evolution_client().close()


async def create_instance(
    instance_name: str,
    qrcode: bool = True,
    token: str | None = None,
    *,
    integration: str,
    number: str | None = None,
    business_id: str | None = None,
) -> dict:
    return await get_evolution_adapter().create_instance(
        instance_name=instance_name,
        qrcode=qrcode,
        token=token,
        integration=integration,
        number=number,
        business_id=business_id,
    )


async def get_qr(instance_name: str) -> dict:
    return await get_evolution_adapter().get_qr(instance_name)


async def get_connection_state(instance_name: str) -> dict:
    return await get_evolution_adapter().get_instance_status(instance_name)


async def fetch_instances() -> list:
    return await get_evolution_adapter().list_instances()


async def restart_instance(instance_name: str) -> dict:
    return await get_evolution_adapter().reconnect_instance(instance_name)


async def logout_instance(instance_name: str) -> dict:
    return await get_evolution_adapter().disconnect_instance(instance_name)


async def delete_instance(instance_name: str) -> dict:
    return await get_evolution_adapter().delete_instance(instance_name)


async def send_text(instance_name: str, number: str, text: str) -> dict:
    return await get_evolution_adapter().send_text(instance_name, number, text)


async def send_media(
    instance_name: str,
    number: str,
    media_payload: str,
    mediatype: str,
    mimetype: str,
    file_name: str,
    caption: str = "",
) -> dict:
    return await get_evolution_adapter().send_media(
        instance_name,
        number,
        media_payload,
        mediatype,
        mimetype,
        file_name,
        caption,
    )


async def send_buttons(instance_name: str, payload: dict) -> dict:
    return await get_evolution_adapter().send_buttons(instance_name, payload)


async def send_list(instance_name: str, payload: dict) -> dict:
    return await get_evolution_adapter().send_list(instance_name, payload)


async def set_webhook(instance_name: str, url: str, events: list[str]) -> dict:
    return await get_evolution_adapter().configure_webhook(instance_name, url, events)


async def get_webhook(instance_name: str) -> dict:
    return await get_evolution_adapter().get_webhook(instance_name)


async def check_whatsapp_numbers(instance_name: str, numbers: list[str]) -> list:
    return await get_evolution_adapter().check_whatsapp_numbers(instance_name, numbers)


async def get_base64_from_media_message(
    instance_name: str,
    *,
    message_key: dict[str, Any],
    message_object: dict[str, Any] | None = None,
    convert_to_mp4: bool = False,
) -> str:
    return await get_evolution_adapter().get_base64_from_media_message(
        instance_name,
        message_key=message_key,
        message_object=message_object,
        convert_to_mp4=convert_to_mp4,
    )
