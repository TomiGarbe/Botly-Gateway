from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status

from app.core.logging import get_logger
from app.models.meta import MetaSignupCompleteRequest, MetaSignupConfigResponse
from app.services import instance_auth
from app.services.audit import audit_event
from app.services.connection_metadata import set_connection_metadata
from app.services.connections import ConnectionNotFoundError, get_connection_service
from app.services.connection_setups import ConnectionSetupConflictError, ConnectionSetupNotFoundError, get_connection_setup_service
from app.services.instances_contract import normalize_instance
from app.services.meta import get_meta_onboarding_orchestrator
from app.platforms.meta import MetaPlatformError
from app.services.authorization import require_reviewer_connection_access
from app.services.authorization import require_reviewer_client_access

logger = get_logger(__name__)
router = APIRouter(prefix="/meta/signup", tags=["meta-signup"])


@router.get("/config", response_model=MetaSignupConfigResponse)
async def get_signup_config(request: Request):
    return get_meta_onboarding_orchestrator().public_config()


@router.post("/complete", status_code=status.HTTP_201_CREATED)
async def complete_signup(body: MetaSignupCompleteRequest, request: Request):
    orchestrator = get_meta_onboarding_orchestrator()
    connection_service = get_connection_service()
    setup_service = get_connection_setup_service()
    setup = None
    if body.setup_id:
        try:
            setup = setup_service.raw(body.setup_id)
            require_reviewer_client_access(request, str(setup["client_id"]))
            if setup.get("provider_id") != "meta":
                raise HTTPException(status_code=422, detail="Connection setup does not use Meta")
            if setup.get("state") == "ready" and setup.get("connection_id"):
                return (await connection_service.get_connection(str(setup["connection_id"]))).public_dict()
            if setup.get("state") not in {"onboarding", "provisioning"}:
                raise HTTPException(status_code=409, detail="Connection setup is not active")
            instance_name = str(setup["runtime_name"])
            setup_service.begin_meta_provisioning(
                str(setup["id"]),
                phone_number_id=body.phone_number_id,
                business_account_id=body.business_account_id,
            )
        except ConnectionSetupNotFoundError:
            raise HTTPException(status_code=404, detail="Connection setup not found")
    elif body.connection_id:
        try:
            instance_name = connection_service.connection_runtime_name(body.connection_id)
            require_reviewer_connection_access(request, await connection_service.get_connection(body.connection_id))
        except ConnectionNotFoundError:
            raise HTTPException(status_code=404, detail="Connection not found")
    else:
        instance_name = body.instance_name
    if not instance_name:
        raise HTTPException(status_code=422, detail="Connection target is required")
    try:
        completion = await orchestrator.run(
            instance_name=instance_name,
            code=body.code,
            phone_number_id=body.phone_number_id,
            business_account_id=body.business_account_id,
            session_info=body.session_info,
            registration_pin=body.registration_pin,
        )
    except MetaPlatformError as exc:
        if setup is not None:
            setup_service.mark_meta_failed(str(setup["id"]))
        logger.warning(
            "meta_signup_complete_failed",
            instance=instance_name,
            phone_number_id=body.phone_number_id,
            business_account_id=body.business_account_id,
            error=str(exc),
            detail=exc.detail,
        )
        raise HTTPException(status_code=exc.status_code, detail=str(exc))
    except Exception as exc:
        if setup is not None:
            setup_service.mark_meta_failed(str(setup["id"]))
        logger.error("meta_signup_evolution_create_failed", instance=instance_name, error=str(exc))
        status_code = getattr(exc, "status_code", 502)
        raise HTTPException(status_code=status_code if isinstance(status_code, int) else 502, detail=str(exc))

    result = completion.instance
    instance_auth.ensure_instance_key(instance_name, instance_id=instance_name)
    audit_event(
        "embedded_signup_completed",
        instance=instance_name,
        phoneNumberId=completion.credentials.phone_number_id,
        businessAccountId=completion.credentials.business_account_id,
    )

    if isinstance(result, dict):
        result.setdefault("metadata", {})
        if isinstance(result["metadata"], dict):
            result["metadata"]["embeddedSignup"] = completion.credentials.public_dict()
        set_connection_metadata(
            instance_name,
            {
                "metadata": {
                    "embeddedSignup": completion.credentials.public_dict(),
                },
            },
        )
        normalized = normalize_instance(result)
        if setup is not None:
            try:
                completed_setup = setup_service.complete_meta(
                    str(setup["id"]), phone_number_id=body.phone_number_id, business_account_id=body.business_account_id
                )
                return (await connection_service.get_connection(str(completed_setup["connection_id"]))).public_dict()
            except ConnectionSetupConflictError as exc:
                raise HTTPException(status_code=409, detail=str(exc))
        if body.connection_id:
            return connection_service.mark_meta_signup_completed(body.connection_id).public_dict()
        if normalized:
            return normalized

    if setup is not None:
        completed_setup = setup_service.complete_meta(
            str(setup["id"]), phone_number_id=body.phone_number_id, business_account_id=body.business_account_id
        )
        return (await connection_service.get_connection(str(completed_setup["connection_id"]))).public_dict()
    if body.connection_id:
        return connection_service.mark_meta_signup_completed(body.connection_id).public_dict()

    return {
        "id": instance_name,
        "name": instance_name,
        "status": "open",
        "connectionType": "cloud",
        "integration": "WHATSAPP-BUSINESS",
    }


@router.get("/onboarding/{instance_name}")
async def onboarding_status(instance_name: str, request: Request):
    try:
        require_reviewer_connection_access(request, await get_connection_service().get_connection_by_runtime_name(instance_name))
    except ConnectionNotFoundError:
        raise HTTPException(status_code=404, detail="No existe conexión para este onboarding")
    result = get_meta_onboarding_orchestrator().status(instance_name)
    if result is None:
        raise HTTPException(status_code=404, detail="No existe estado de onboarding para esta instancia")
    return result
