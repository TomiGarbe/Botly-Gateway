from app.core.config import Settings


def _settings(**values: str) -> Settings:
    return Settings(
        _env_file=None,
        gateway_api_key="test-gateway-key",
        evolution_api_key="test-evolution-key",
        **values,
    )


def test_public_app_url_is_the_canonical_public_url() -> None:
    settings = _settings(PUBLIC_APP_URL="https://gateway-server.botly.com.ar/")

    assert settings.public_app_url == "https://gateway-server.botly.com.ar/"


def test_legacy_public_base_url_remains_a_read_alias() -> None:
    settings = _settings(PUBLIC_BASE_URL="https://previous-gateway.example")

    assert settings.public_app_url == "https://previous-gateway.example"


def test_cors_uses_the_rebranded_gateway_origin() -> None:
    settings = _settings()

    assert settings.is_cors_origin_allowed("https://gateway.botly.com.ar")
    assert not settings.is_cors_origin_allowed("https://panel-evolution.botly.com.ar")
