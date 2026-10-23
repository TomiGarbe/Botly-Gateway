"""Live provider facts for alerts: what the stored connection status cannot tell."""
from __future__ import annotations

import time
from typing import Any

from app.core.logging import get_logger

logger = get_logger(__name__)

DAY_MS = 86_400_000


class LiveAlertSignals:
    async def evolution_states(self) -> dict[str, str]:
        """Session state per runtime name; instances owned by another Gateway are absent."""
        from app.adapters.evolution import get_evolution_adapter

        try:
            records = await get_evolution_adapter().list_instances()
        except Exception as exc:
            logger.warning("alert_signals_evolution_unavailable", error=type(exc).__name__)
            return {}
        states = {}
        for item in records if isinstance(records, list) else []:
            instance = item.get("instance") if isinstance(item.get("instance"), dict) else item
            name = instance.get("name") or instance.get("instanceName")
            if name:
                states[str(name)] = str(instance.get("connectionStatus") or instance.get("status") or "").lower()
        return states

    def instagram_token_state(self, connection_id: str) -> str | None:
        from app.services.connection_registry import get_connection_registry
        from app.services.credential_manager import ProviderAccountReference, get_credential_manager

        record = get_connection_registry().connection_record_by_id(connection_id) or {}
        account_id = str((record.get("provider_account") or {}).get("providerAccountId") or "")
        if not account_id:
            return None
        credential = get_credential_manager().get_provider_credentials(ProviderAccountReference("meta", "instagram", account_id))
        return credential.expiry_state() if credential else "missing"

    def core_delivery_stats(self, connection_id: str) -> dict[str, Any]:
        from app.services.core_inbound_dispatcher import get_core_inbound_dispatcher

        now = int(time.time() * 1000)
        oldest_pending, dead = None, 0
        for item in get_core_inbound_dispatcher().deliveries_for_connection(connection_id, limit=500):
            status = item.get("status")
            created = int(item.get("createdAt") or 0)
            if status in {"pending", "retry", "delivering"}:
                oldest_pending = created if oldest_pending is None else min(oldest_pending, created)
            elif status in {"dead_letter", "failed"} and now - int(item.get("updatedAt") or created) <= DAY_MS:
                dead += 1
        return {"pending_age_seconds": (now - oldest_pending) / 1000 if oldest_pending else 0, "failed_24h": dead}
