from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

from app.core.config import get_settings
from app.core.logging import get_logger
from app.domain import ChannelProvisioningService
from app.platforms.meta import MetaCredentials, MetaDiscoveryService as LegacyMetaDiscoveryService, MetaPlatform, MetaPlatformError
from app.services.credential_manager import CredentialManager, get_credential_manager
from app.services.meta.discovery import MetaDiscoveryService
from app.services.meta.evolution import MetaEvolutionProvisioner
from app.services.meta.exceptions import MetaOnboardingError
from app.services.meta.models import MetaOnboardingResult, MetaOnboardingState, OnboardingType
from app.services.meta.oauth import MetaOAuthService
from app.services.meta.registration import MetaPhoneRegistrationService
from app.services.meta.state_store import MetaOnboardingStore
from app.services.meta.subscriptions import MetaSubscriptionManager
from app.services.meta.verification import MetaVerificationService
from app.services.normalization import save_pipeline_event

logger = get_logger(__name__)


class MetaOnboardingOrchestrator:
    """Run and durably checkpoint all Graph API work required after signup."""

    def __init__(
        self,
        *,
        platform: MetaPlatform | None = None,
        store: MetaOnboardingStore | None = None,
        credentials: CredentialManager | None = None,
        evolution: MetaEvolutionProvisioner | None = None,
        channel_provisioning: ChannelProvisioningService | None = None,
    ) -> None:
        self._platform = platform or MetaPlatform(settings_factory=get_settings)
        self._store = store or MetaOnboardingStore()
        self._credentials_store = credentials or get_credential_manager()
        self._oauth = MetaOAuthService(self._platform)
        self._verification = MetaVerificationService(self._platform)
        self._discovery = MetaDiscoveryService(self._platform)
        self._subscriptions = MetaSubscriptionManager(self._platform)
        self._registration = MetaPhoneRegistrationService(self._platform)
        self._evolution = evolution or MetaEvolutionProvisioner()
        self._channel_provisioning = channel_provisioning or ChannelProvisioningService()

    def status(self, instance_name: str) -> dict[str, Any] | None:
        record = self._store.get(instance_name)
        return record.public_dict() if record else None

    def public_config(self) -> dict[str, Any]:
        return self._platform.public_config()

    async def run(
        self,
        *,
        instance_name: str,
        code: str,
        phone_number_id: str,
        business_account_id: str,
        session_info: dict[str, Any] | None = None,
    ) -> MetaOnboardingResult:
        onboarding_type = self._onboarding_type(session_info)
        record = self._store.start(instance_name, onboarding_type)
        logger.info("meta_onboarding_started", instance=instance_name, onboarding_type=onboarding_type.value)
        save_pipeline_event(stage="embedded_signup", status="started", instance=instance_name, event="EMBEDDED_SIGNUP", component="Meta", details={"onboardingType": onboarding_type.value})
        try:
            token = await self._oauth.exchange(code)
            self._store.advance(record, MetaOnboardingState.OAUTH_OK)
            logger.info("oauth_completed", instance=instance_name)
            save_pipeline_event(stage="oauth", status="completed", instance=instance_name, event="OAUTH_COMPLETED", component="Meta")

            verification = await self._verification.verify_token(token)
            self._store.advance(
                record,
                MetaOnboardingState.TOKEN_VALID,
                details={
                    "token": {
                        "appId": verification.app_id,
                        "businessId": verification.business_id,
                        "expiresAt": verification.expires_at,
                        "scopes": list(verification.scopes),
                    }
                },
            )
            for warning in verification.warnings:
                self._store.warn(record, warning)
            logger.info("token_verified", instance=instance_name, warnings=len(verification.warnings))
            save_pipeline_event(stage="token_verification", status="completed", instance=instance_name, event="TOKEN_VERIFIED", component="Meta", details={"warnings": len(verification.warnings)})

            credentials = self._platform.credentials_from_embedded_signup(
                token=token,
                phone_number_id=phone_number_id,
                business_account_id=business_account_id,
                session_info=session_info,
            )
            discovery = await self._discovery.discover(credentials)
            self._store.advance(
                record,
                MetaOnboardingState.DISCOVERY_OK,
                details={
                    "discovery": {
                        "wabaId": discovery.waba_id,
                        "phoneNumberId": discovery.phone_number_id,
                        "displayPhoneNumber": discovery.display_phone_number,
                        "waba": discovery.waba,
                        "phone": discovery.phone,
                    }
                },
            )
            logger.info("discovery_completed", instance=instance_name, waba_id=discovery.waba_id, phone_number_id=discovery.phone_number_id)
            save_pipeline_event(stage="discovery", status="completed", instance=instance_name, event="DISCOVERY_COMPLETED", component="Meta", details={"wabaId": discovery.waba_id, "phoneNumberId": discovery.phone_number_id})

            self._verify_webhook_configuration(record)

            # Reconfirm the override when recovering an interrupted run: an
            # earlier subscription checkpoint alone does not prove the callback
            # was successfully applied.
            if not record.completed(MetaOnboardingState.APP_SUBSCRIBED) or not record.completed(MetaOnboardingState.WEBHOOK_VERIFIED):
                subscription = await self._subscriptions.ensure_subscribed(discovery.waba_id, credentials.access_token)
                self._store.advance(record, MetaOnboardingState.APP_SUBSCRIBED, details={"subscription": subscription})
                logger.info("subscription_completed", instance=instance_name, already_subscribed=subscription.get("alreadySubscribed", False))
                save_pipeline_event(stage="subscription", status="completed", instance=instance_name, event="SUBSCRIPTION_COMPLETED", component="Meta", details={"alreadySubscribed": subscription.get("alreadySubscribed", False)})

            self._store.advance(
                record,
                MetaOnboardingState.WEBHOOK_VERIFIED,
                details={"webhook": {"callbackUrl": f"{str(get_settings().public_app_url).rstrip('/')}/webhooks/meta", "signatureRequired": True}},
            )
            logger.info("webhook_verified", instance=instance_name)
            save_pipeline_event(stage="webhook", status="verified", instance=instance_name, event="WEBHOOK_VERIFIED", component="Meta")

            if not record.completed(MetaOnboardingState.PHONE_REGISTERED):
                registration = await self._registration.ensure_registered(discovery.phone_number_id, onboarding_type, credentials.access_token)
                self._store.advance(record, MetaOnboardingState.PHONE_REGISTERED, details={"registration": registration})
                logger.info("phone_registered", instance=instance_name, skipped=registration.get("skipped", False))
                save_pipeline_event(stage="phone_registration", status="completed", instance=instance_name, event="PHONE_REGISTERED", component="Meta", details={"skipped": registration.get("skipped", False)})

            phone = await self._verification.verify_phone(discovery.phone_number_id, credentials.access_token)
            self._validate_phone_state(phone, onboarding_type)
            self._store.advance(record, MetaOnboardingState.PHONE_VERIFIED, details={"phoneVerification": phone})
            logger.info("phone_verified", instance=instance_name, quality_rating=phone.get("quality_rating"), name_status=phone.get("name_status"))
            save_pipeline_event(stage="phone_verification", status="completed", instance=instance_name, event="PHONE_VERIFIED", component="Meta")

            resources, channels = await self._sync_legacy_resources(credentials, instance_name)
            if record.completed(MetaOnboardingState.EVOLUTION_READY):
                instance = self._resumed_instance(instance_name)
            else:
                instance = await self._evolution.provision(instance_name, credentials)
                self._store.advance(record, MetaOnboardingState.EVOLUTION_READY)
                logger.info("evolution_created", instance=instance_name)
                save_pipeline_event(stage="evolution_provisioning", status="completed", instance=instance_name, event="EVOLUTION_PROVISIONED", component="Evolution")

            if not record.completed(MetaOnboardingState.CREDENTIALS_PERSISTED):
                self._credentials_store.upsert_official_credentials(
                    instance_name=instance_name,
                    access_token=credentials.access_token,
                    phone_number_id=credentials.phone_number_id,
                    business_account_id=credentials.business_account_id,
                    source="embedded_signup",
                    metadata={
                        "onboarding": "embedded_signup",
                        "onboardingType": onboarding_type.value,
                        "onboardingState": MetaOnboardingState.READY.value,
                        "onboardedAt": record.updated_at,
                    },
                )
                self._store.advance(record, MetaOnboardingState.CREDENTIALS_PERSISTED)
                logger.info("credentials_saved", instance=instance_name)
                save_pipeline_event(stage="credentials", status="completed", instance=instance_name, event="CREDENTIALS_UPDATED", component="Gateway")

            self._store.advance(record, MetaOnboardingState.READY)
            logger.info("meta_onboarding_completed", instance=instance_name, onboarding_type=onboarding_type.value)
            save_pipeline_event(stage="onboarding", status="ready", instance=instance_name, event="ONBOARDING_READY", component="Meta")
            return MetaOnboardingResult(
                token=token,
                credentials=credentials,
                discovery=discovery,
                instance=instance,
                record=record,
                resources=resources,
                channels=channels,
            )
        except MetaPlatformError as exc:
            code_value = str(exc.detail.get("code") if isinstance(exc.detail, dict) else "meta_onboarding_failed")
            self._store.fail(record, code=code_value, message=str(exc), detail=exc.detail)
            logger.error(code_value, instance=instance_name, error=str(exc))
            logger.warning("meta_onboarding_failed", instance=instance_name, code=code_value, error=str(exc))
            save_pipeline_event(stage="onboarding", status="failed", instance=instance_name, event="ONBOARDING_ERROR", component="Meta", details={"error": str(exc), "code": code_value, "action": "Revisa la etapa indicada y vuelve a intentar."})
            raise
        except Exception as exc:
            self._store.fail(record, code="meta_onboarding_failed", message=str(exc))
            logger.exception("meta_onboarding_failed", instance=instance_name, code="meta_onboarding_failed")
            save_pipeline_event(stage="onboarding", status="failed", instance=instance_name, event="ONBOARDING_ERROR", component="Meta", details={"error": str(exc), "action": "Revisa la configuración de Meta y vuelve a intentar."})
            raise MetaOnboardingError("meta_onboarding_failed", "No se pudo completar el onboarding de Meta.", status_code=502) from exc

    def _verify_webhook_configuration(self, record) -> None:
        settings = get_settings()
        missing = [
            name
            for name, value in {
                "meta_app_secret": settings.meta_app_secret,
                "meta_webhook_verify_token": settings.meta_webhook_verify_token,
            }.items()
            if not str(value or "").strip()
        ]
        if missing:
            raise MetaOnboardingError(
                "webhook_invalid",
                f"El webhook oficial de Meta no esta configurado: faltan {', '.join(missing)}.",
                status_code=503,
                detail={"missing": missing, "resource": "/webhooks/meta"},
            )
        public_url = str(getattr(settings, "public_app_url", "") or "").strip().rstrip("/")
        parsed = urlparse(public_url)
        if parsed.scheme != "https" or not parsed.netloc:
            raise MetaOnboardingError(
                "webhook_invalid",
                "El webhook oficial de Meta requiere una PUBLIC_APP_URL HTTPS publica.",
                status_code=503,
                detail={"field": "public_app_url", "resource": "/webhooks/meta"},
            )

    async def _sync_legacy_resources(self, credentials: MetaCredentials, instance_name: str) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
        """Keep the existing channel/resource catalog available to current callers."""
        try:
            resources = await LegacyMetaDiscoveryService(platform=self._platform).discover(credentials=credentials)
        except Exception as exc:
            logger.warning("legacy_resource_sync_failed", instance=instance_name, error=str(exc))
            return (), ()
        channels = []
        for resource in resources:
            try:
                channel = self._channel_provisioning.provision_from_meta_resource(resource)
                if channel is not None:
                    channels.append(channel)
            except Exception as exc:
                logger.warning("channel_provisioning_from_meta_resource_failed", instance=instance_name, resource_id=resource.id, error=str(exc))
        return tuple(resources), tuple(channels)

    @staticmethod
    def _onboarding_type(session_info: dict[str, Any] | None) -> OnboardingType:
        event = str((session_info or {}).get("event") or "").upper()
        return OnboardingType.COEXISTENCE if event == "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" else OnboardingType.STANDARD

    @staticmethod
    def _resumed_instance(instance_name: str) -> dict[str, Any]:
        return {
            "id": instance_name,
            "instanceName": instance_name,
            "name": instance_name,
            "status": "open",
            "connectionType": "cloud",
            "integration": "WHATSAPP-BUSINESS",
        }

    @staticmethod
    def _validate_phone_state(phone: dict[str, Any], onboarding_type: OnboardingType) -> None:
        if str(phone.get("code_verification_status") or "").upper() in {"FAILED", "REJECTED"}:
            raise MetaOnboardingError("phone_verification_failed", "Meta informa que la verificacion del numero fue rechazada.")
        if onboarding_type == OnboardingType.COEXISTENCE:
            platform_type = str(phone.get("platform_type") or "").upper()
            if platform_type and platform_type != "CLOUD_API":
                raise MetaOnboardingError("phone_verification_failed", "El numero de coexistencia aun no esta activo en Cloud API.")


def get_meta_onboarding_orchestrator() -> MetaOnboardingOrchestrator:
    return MetaOnboardingOrchestrator()
