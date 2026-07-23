from types import SimpleNamespace

from app.domain import get_default_domain_registry
from app.services.features import FeatureService


def _features(**values):
    defaults = {
        "feature_provider_evolution": False,
        "feature_provider_baileys": False,
        "feature_whatsapp_web": False,
        "feature_qr_login": False,
        "feature_instagram": True,
        "feature_whatsapp_cloud": True,
    }
    defaults.update(values)
    return FeatureService(SimpleNamespace(**defaults))


def test_default_flags_hide_legacy_method_and_qr_capability() -> None:
    channels = _features().public_channels(get_default_domain_registry())

    whatsapp = next(channel for channel in channels if channel["id"] == "whatsapp")
    assert [method["id"] for method in whatsapp["methods"]] == ["official"]
    assert "supports_qr" not in whatsapp["capabilities"]


def test_legacy_method_requires_all_compatibility_flags() -> None:
    features = _features(feature_provider_evolution=True, feature_provider_baileys=True, feature_whatsapp_web=True, feature_qr_login=True)

    assert features.method_enabled("whatsapp", "web") is True
