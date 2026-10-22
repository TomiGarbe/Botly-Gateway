from app.core.config import Settings, ephemeral_state_paths


def test_state_paths_under_tmp_are_reported_but_caches_are_not():
    settings = Settings(gateway_api_key="k", evolution_api_key="k",
                        auth_sessions_path="/tmp/sessions.json",
                        official_credentials_path="/var/lib/botly/official_credentials.json",
                        media_cache_dir="/tmp/media")
    found = ephemeral_state_paths(settings)
    assert "auth_sessions_path" in found
    assert "official_credentials_path" not in found
    assert "media_cache_dir" not in found
