from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ConnectionCapabilities:
    supports_qr: bool = False
    supports_embedded_signup: bool = False
    supports_instance_lifecycle: bool = False
    supports_reconnect: bool = False
    supports_logout: bool = False
    supports_delete: bool = False
    supports_text_messages: bool = False
    supports_media_messages: bool = False
    supports_buttons: bool = False
    supports_lists: bool = False
    supports_webhooks: bool = False
    supports_number_check: bool = False
    supports_media_decryption: bool = False
    future: tuple[str, ...] = field(default_factory=tuple)


@dataclass
class BaileysCapabilities(ConnectionCapabilities):
    supports_qr: bool = True
    supports_instance_lifecycle: bool = True
    supports_reconnect: bool = True
    supports_logout: bool = True
    supports_delete: bool = True
    supports_text_messages: bool = True
    supports_media_messages: bool = True
    supports_buttons: bool = True
    supports_lists: bool = True
    supports_webhooks: bool = True
    supports_number_check: bool = True
    supports_media_decryption: bool = True


@dataclass
class CloudCapabilities(ConnectionCapabilities):
    supports_embedded_signup: bool = True
    supports_instance_lifecycle: bool = True
    supports_logout: bool = True
    supports_delete: bool = True
    supports_text_messages: bool = True
    supports_media_messages: bool = True
    supports_webhooks: bool = True
    future: tuple[str, ...] = (
        "embedded_signup",
        "oauth",
        "facebook_login",
        "meta_graph_api",
        "phone_number_id",
        "waba",
        "evolution_webhooks",
    )
