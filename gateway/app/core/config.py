from functools import lru_cache
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Gateway
    gateway_api_key: str
    gateway_port: int = 9000
    log_level: str = "info"

    # Evolution API
    evolution_url: str = "http://evolution:8080"
    evolution_api_key: str

    # Bot (destino de los webhooks procesados)
    bot_webhook_url: str = ""
    bot_webhook_timeout: int = 5  # segundos

    # Rate limiting (slowapi usa strings "X/minute")
    rate_limit_default: str = "1000/minute"
    rate_limit_send_message: str = "20/second"

    model_config = SettingsConfigDict(
        # En Docker las variables llegan por environment: en el compose.
        # env_file solo aplica si corrés el gateway localmente fuera de Docker.
        env_file="../config/.env",
        env_file_encoding="utf-8",
        extra="ignore",
    )


@lru_cache
def get_settings() -> Settings:
    return Settings()
