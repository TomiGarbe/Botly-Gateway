from fastapi import APIRouter

from app.services.dashboard import get_dashboard_service


router = APIRouter(prefix="/dashboard", tags=["dashboard"])
_service = get_dashboard_service()


@router.get("")
async def get_dashboard():
    return (await _service.snapshot()).public_dict()
