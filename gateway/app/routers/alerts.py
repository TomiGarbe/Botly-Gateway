from fastapi import APIRouter, HTTPException

from app.services.alerts import get_alert_service


router = APIRouter(prefix="/alerts", tags=["alerts"])
_service = get_alert_service()


@router.get("")
async def get_alerts():
    return {"items": [alert.public_dict() for alert in await _service.list_alerts()]}


@router.post("/{alert_id}/acknowledge")
async def acknowledge_alert(alert_id: str):
    alert = await _service.acknowledge(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert.public_dict()


@router.post("/{alert_id}/resolve")
async def resolve_alert(alert_id: str):
    alert = await _service.resolve(alert_id)
    if alert is None:
        raise HTTPException(status_code=404, detail="Alert not found")
    return alert.public_dict()
