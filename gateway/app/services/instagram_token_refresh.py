"""Keep Instagram long-lived tokens alive; they lapse after 60 days without a refresh."""
import asyncio
from datetime import datetime, timedelta, timezone

from app.core.logging import get_logger
from app.services.credential_manager import get_credential_manager

logger = get_logger(__name__)

REFRESH_WINDOW = timedelta(days=15)
INTERVAL_SECONDS = 6 * 3600


def _expiry(value: str | None) -> datetime | None:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None


async def refresh_instagram_tokens(*, credentials=None, oauth=None, now: datetime | None = None) -> dict[str, int]:
    from app.services.instagram_oauth import InstagramOAuthService

    manager = credentials or get_credential_manager()
    oauth = oauth or InstagramOAuthService()
    now = now or datetime.now(timezone.utc)
    outcome = {"refreshed": 0, "expired": 0, "skipped": 0}
    for record in manager.list_provider_credentials("meta", "instagram"):
        expiry = _expiry(record.expires_at)
        if expiry is not None and (expiry <= now or expiry - now > REFRESH_WINDOW):
            outcome["skipped"] += 1  # healthy, or already expired and waiting for reauthorization
            continue
        token = manager.get_provider_access_token(record.account)
        refreshed = await oauth.refresh_long_lived(token) if token else None
        if refreshed is not None:
            manager.upsert_provider_credentials(
                account=record.account, access_token=refreshed.access_token, access_token_ref=record.access_token_ref,
                source=record.source, scopes=record.scopes, expires_at=refreshed.expires_at, metadata=record.metadata,
            )
            outcome["refreshed"] += 1
        elif not token or await oauth.token_rejected(token):
            manager.mark_provider_credentials_expired(record.account)
            outcome["expired"] += 1
            logger.warning("instagram_token_expired", provider_account_id=record.account.provider_account_id)
        else:
            outcome["skipped"] += 1  # e.g. younger than 24h: Meta refuses to refresh it yet
    return outcome


async def instagram_token_refresh_loop(stop: asyncio.Event) -> None:
    while not stop.is_set():
        try:
            outcome = await refresh_instagram_tokens()
            logger.info("instagram_token_refresh_completed", **outcome)
        except Exception as exc:  # keep the loop alive
            logger.warning("instagram_token_refresh_failed", error=type(exc).__name__)
        try:
            await asyncio.wait_for(stop.wait(), timeout=INTERVAL_SECONDS)
        except asyncio.TimeoutError:
            pass
