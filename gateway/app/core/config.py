from functools import lru_cache
import re

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Gateway
    gateway_api_key: str
    google_client_id: str = ""
    allowed_google_users: str = ""
    auth_sessions_path: str = "/tmp/botly_gateway_sessions.json"
    auth_session_ttl_seconds: int = 28800
    gateway_port: int = 9000
    # PUBLIC_BASE_URL se conserva como alias de lectura para no interrumpir
    # despliegues existentes durante la migracion del dominio.
    public_app_url: str = Field(
        default="",
        validation_alias=AliasChoices("PUBLIC_APP_URL", "PUBLIC_BASE_URL"),
    )
    log_level: str = "info"
    debug: bool = False
    cors_allowed_origins: str = (
        "https://gateway.botly.com.ar,"
        "http://localhost:5174,"
        "http://127.0.0.1:5174"
    )
    cors_allow_origin_regex: str = r"https?://(localhost|127\.0\.0\.1)(:\d+)?"
    cors_debug: bool = False
    feature_provider_evolution: bool = False
    feature_provider_baileys: bool = False
    feature_whatsapp_web: bool = False
    feature_qr_login: bool = False
    feature_instagram: bool = True
    feature_whatsapp_cloud: bool = True

    # Evolution API
    evolution_url: str = "http://evolution:8080"
    evolution_api_key: str

    # Bot (destino de los webhooks procesados)
    bot_webhook_url: str = ""
    bot_webhook_timeout: int = 5  # segundos
    bot_webhook_retries: int = 3
    bot_webhook_backoff_base_ms: int = 400
    bot_webhook_max_parallel: int = 20
    bot_webhook_max_queue: int = 200
    enable_group_messages: bool = False

    dedupe_ttl_seconds: int = 180
    dedupe_max_items: int = 20000
    outbound_echo_ttl_seconds: int = 45
    max_event_age_seconds: int = 600
    flood_window_seconds: int = 3
    flood_max_messages: int = 12
    webhook_event_retention: int = 2000

    # Rate limiting (slowapi usa strings "X/minute")
    rate_limit_default: str = "1000/minute"
    rate_limit_send_message: str = "20/second"
    media_max_upload_mb: int = 25
    media_allowed_mime_prefixes: str = "image/,video/,audio/,application/pdf,application/msword,application/vnd.openxmlformats-officedocument"
    media_cache_dir: str = "/tmp/botly_media_cache"
    media_cache_ttl_seconds: int = 3600
    media_cache_max_files: int = 500
    media_download_timeout: int = 30
    instance_api_keys_path: str = "/tmp/botly_instance_api_keys.json"
    instance_webhooks_path: str = "/tmp/botly_instance_webhooks.json"
    connection_metadata_path: str = "/tmp/botly_connection_metadata.json"
    # Product-domain ownership registry. It is additive and intentionally
    # separate from provider/runtime persistence during the Instance migration.
    connection_registry_path: str = "/tmp/botly_connection_registry.json"
    official_credentials_path: str = "/tmp/botly_official_credentials.json"
    # Timeline business events shown by /webhooks/events.  It must survive a
    # Gateway restart so a received first message is not lost before the UI
    # reads it.
    webhook_events_path: str = "/tmp/botly_webhook_events.json"
    # Alertas operativas persistentes. Se mantiene separado del timeline para
    # que reconocer o resolver una alerta no modifique la evidencia original.
    alerts_path: str = "/tmp/botly_alerts.json"
    # Definiciones y ejecuciones del motor operativo. El historial se conserva
    # separado de la configuración para que pueda auditarse sin reconstruirlo.
    automations_path: str = "/tmp/botly_automations.json"
    automation_scheduler_enabled: bool = True
    operations_path: str = "/tmp/botly_operations.json"
    operations_worker_enabled: bool = True
    operations_target_concurrency: int = 8
    # Key used to encrypt the long-lived WhatsApp Cloud token at rest.  When it
    # is not explicitly configured, the gateway API key is used as key material
    # so existing installations remain operable; production deployments should
    # provide a distinct, high-entropy value.
    official_credentials_encryption_key: str = ""
    meta_onboarding_path: str = "/tmp/botly_meta_onboarding.json"
    meta_resources_path: str = "/tmp/botly_meta_resources.json"
    channel_records_path: str = "/tmp/botly_channel_records.json"
    instance_webhook_timeout: int = 8
    webhook_debug: bool = False
    webhook_dispatch_history_limit: int = 30
    allow_insecure_evolution_webhooks: bool = False
    evolution_auth_cache_ttl_seconds: int = 45

    # Meta Embedded Signup
    meta_app_id: str = ""
    meta_app_secret: str = ""
    meta_embedded_signup_config_id: str = ""
    meta_graph_version: str = "v23.0"
    meta_signup_timeout_seconds: int = 30
    # Webhook oficial de WhatsApp Cloud API. No reutilizar la clave de Evolution:
    # Meta llama al Gateway directamente y firma cada POST con META_APP_SECRET.
    meta_webhook_verify_token: str = ""
    meta_webhook_require_signature: bool = True

    model_config = SettingsConfigDict(
        # En Docker las variables llegan por environment: en el compose.
        # env_file solo aplica si corrés el gateway localmente fuera de Docker.
        env_file="../config/.env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    @property
    def cors_allowed_origins_list(self) -> list[str]:
        origins: list[str] = []
        for item in self.cors_allowed_origins.split(","):
            origin = item.strip().rstrip("/")
            if origin and origin not in origins:
                origins.append(origin)
        return origins

    @property
    def allowed_google_users_list(self) -> set[str]:
        return {item.strip().lower() for item in self.allowed_google_users.split(",") if item.strip()}

    def is_cors_origin_allowed(self, origin: str | None) -> bool:
        value = str(origin or "").strip().rstrip("/")
        if not value:
            return False
        if "*" in self.cors_allowed_origins_list:
            return True
        if value in self.cors_allowed_origins_list:
            return True
        if self.cors_allow_origin_regex:
            try:
                return re.fullmatch(self.cors_allow_origin_regex, value) is not None
            except re.error:
                return False
        return False


@lru_cache
def get_settings() -> Settings:
    return Settings()
