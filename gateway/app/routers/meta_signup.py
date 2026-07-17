from __future__ import annotations

from fastapi import APIRouter, HTTPException, status

from app.core.logging import get_logger
from app.models.meta import MetaSignupCompleteRequest, MetaSignupConfigResponse
from app.services import instance_auth
from app.services.audit import audit_event
from app.services.connection_metadata import set_connection_metadata
from app.services.credential_manager import get_credential_manager
from app.services.instances_contract import normalize_instance
from app.services.meta_signup import MetaSignupError, get_meta_signup_service

logger = get_logger(__name__)
router = APIRouter(prefix="/meta/signup", tags=["meta-signup"])


@router.get("/config", response_model=MetaSignupConfigResponse)
async def get_signup_config():
    return get_meta_signup_service().public_config()


@router.post("/complete", status_code=status.HTTP_201_CREATED)
async def complete_signup(body: MetaSignupCompleteRequest):
    service = get_meta_signup_service()
    try:
        completion = await service.complete_onboarding(
            instance_name=body.instance_name,
            code=body.code,
            phone_number_id=body.phone_number_id,
            business_account_id=body.business_account_id,
            session_info=body.session_info,
        )
    except MetaSignupError as exc:
        logger.warning(
            "meta_signup_complete_failed",
            instance=body.instance_name,
            phone_number_id=body.phone_number_id,
            business_account_id=body.business_account_id,
            error=str(exc),
            detail=exc.detail,
        )
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    except Exception as exc:
        logger.error("meta_signup_evolution_create_failed", instance=body.instance_name, error=str(exc))
        status_code = getattr(exc, "status_code", 502)
        raise HTTPException(status_code=status_code if isinstance(status_code, int) else 502, detail=str(exc))

    credentials = completion.credentials
    result = completion.instance
    instance_auth.ensure_instance_key(body.instance_name, instance_id=body.instance_name)
    get_credential_manager().upsert_official_credentials(
        instance_name=body.instance_name,
        access_token=credentials.access_token,
        phone_number_id=credentials.phone_number_id,
        business_account_id=credentials.business_account_id,
        source="embedded_signup",
        metadata={
            "onboarding": "embedded_signup",
        },
    )
    audit_event(
        "embedded_signup_completed",
        instance=body.instance_name,
        phoneNumberId=credentials.phone_number_id,
        businessAccountId=credentials.business_account_id,
    )

    if isinstance(result, dict):
        result.setdefault("metadata", {})
        if isinstance(result["metadata"], dict):
            result["metadata"]["embeddedSignup"] = credentials.public_dict()
        set_connection_metadata(
            body.instance_name,
            {
                "metadata": {
                    "embeddedSignup": credentials.public_dict(),
                },
            },
        )
        normalized = normalize_instance(result)
        if normalized:
            return normalized

    return {
        "id": body.instance_name,
        "name": body.instance_name,
        "status": "open",
        "connectionType": "cloud",
        "integration": "WHATSAPP-BUSINESS",
    }
