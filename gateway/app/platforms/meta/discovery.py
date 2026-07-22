from __future__ import annotations

from typing import Any

from app.core.logging import get_logger
from app.platforms.meta.models import MetaCredentials, MetaResource
from app.platforms.meta.models import MetaResourceStatus, MetaResourceType
from app.platforms.meta.platform import MetaPlatform
from app.platforms.meta.resource_store import MetaResourceStore, get_meta_resource_store

logger = get_logger(__name__)


class MetaDiscoveryService:
    def __init__(
        self,
        platform: MetaPlatform | None = None,
        store: MetaResourceStore | None = None,
    ) -> None:
        self._platform = platform or MetaPlatform()
        self._store = store or get_meta_resource_store()

    async def discover(self, *, credentials: MetaCredentials) -> tuple[MetaResource, ...]:
        resources = await self._discover(credentials=credentials)
        return self._store.sync(resources=resources, scope_id=credentials.business_account_id)

    async def _discover(self, *, credentials: MetaCredentials) -> tuple[MetaResource, ...]:
        discovered: dict[str, MetaResource] = {}
        for resource in await self._discover_whatsapp_business(credentials):
            discovered[resource.id] = resource
        for resource in await self._discover_pages_instagram_and_messenger(credentials):
            discovered[resource.id] = resource
        return tuple(discovered.values())

    async def _discover_whatsapp_business(self, credentials: MetaCredentials) -> tuple[MetaResource, ...]:
        metadata: dict[str, Any] = {
            "phoneNumberId": credentials.phone_number_id,
            "businessAccountId": credentials.business_account_id,
            "source": "embedded_signup",
        }
        display_name = credentials.business_account_id
        status = MetaResourceStatus.DISCOVERED

        try:
            account = await self._platform.request(
                "GET",
                f"/{credentials.business_account_id}",
                params={
                    "access_token": credentials.access_token,
                    "fields": "id,name,timezone_id,message_template_namespace,currency",
                },
            )
            if isinstance(account, dict):
                display_name = str(account.get("name") or display_name)
                metadata["waba"] = account
        except Exception as exc:
            metadata["discoveryStatus"] = "partial"
            metadata["wabaDiscoveryError"] = str(exc)
            logger.warning("meta_waba_discovery_failed", business_account_id=credentials.business_account_id, error=str(exc))

        try:
            phones = await self._collect_connection(
                f"/{credentials.business_account_id}/phone_numbers",
                access_token=credentials.access_token,
                fields="id,display_phone_number,verified_name,name_status,code_verification_status,quality_rating,platform_type,throughput",
            )
            metadata["phoneNumbers"] = phones
            selected_phone = self._find_by_id(phones, credentials.phone_number_id)
            if selected_phone:
                metadata["selectedPhoneNumber"] = selected_phone
                display_name = str(
                    selected_phone.get("verified_name")
                    or selected_phone.get("display_phone_number")
                    or display_name
                )
        except Exception as exc:
            metadata["discoveryStatus"] = "partial"
            metadata["phoneNumbersDiscoveryError"] = str(exc)
            logger.warning("meta_waba_phone_discovery_failed", business_account_id=credentials.business_account_id, error=str(exc))

        return (
            MetaResource.build(
                resource_type=MetaResourceType.WHATSAPP_BUSINESS,
                external_id=credentials.business_account_id,
                display_name=display_name,
                status=status,
                metadata=metadata,
            ),
        )

    async def _discover_pages_instagram_and_messenger(self, credentials: MetaCredentials) -> tuple[MetaResource, ...]:
        try:
            pages = await self._collect_connection(
                "/me/accounts",
                access_token=credentials.access_token,
                fields=(
                    "id,name,access_token,tasks,"
                    "instagram_business_account{id,username,name},"
                    "connected_instagram_account{id,username,name}"
                ),
            )
        except Exception as exc:
            logger.info("meta_pages_discovery_unavailable", error=str(exc))
            return ()

        resources: list[MetaResource] = []
        for page in pages:
            page_id = str(page.get("id") or "").strip()
            if not page_id:
                continue
            page_name = str(page.get("name") or page_id)
            page_metadata = self._without_secret(page, blocked_keys={"access_token"})
            resources.append(
                MetaResource.build(
                    resource_type=MetaResourceType.FACEBOOK_PAGE,
                    external_id=page_id,
                    display_name=page_name,
                    status=MetaResourceStatus.DISCOVERED,
                    metadata={
                        **page_metadata,
                        "source": "me/accounts",
                    },
                )
            )

            if page.get("access_token"):
                resources.append(
                    MetaResource.build(
                        resource_type=MetaResourceType.MESSENGER,
                        external_id=page_id,
                        display_name=page_name,
                        status=MetaResourceStatus.DISCOVERED,
                        metadata={
                            "pageId": page_id,
                            "source": "me/accounts",
                            "requiresPermission": "pages_messaging",
                        },
                    )
                )

            for key in ("instagram_business_account", "connected_instagram_account"):
                instagram = page.get(key) if isinstance(page.get(key), dict) else None
                if not instagram:
                    continue
                instagram_id = str(instagram.get("id") or "").strip()
                if not instagram_id:
                    continue
                resources.append(
                    MetaResource.build(
                        resource_type=MetaResourceType.INSTAGRAM,
                        external_id=instagram_id,
                        display_name=str(instagram.get("username") or instagram.get("name") or instagram_id),
                        status=MetaResourceStatus.DISCOVERED,
                        metadata={
                            **dict(instagram),
                            "pageId": page_id,
                            "source": key,
                        },
                    )
                )
        return tuple(resources)

    async def _collect_connection(self, path: str, *, access_token: str, fields: str) -> list[dict[str, Any]]:
        params = {
            "access_token": access_token,
            "fields": fields,
            "limit": 100,
        }
        items: list[dict[str, Any]] = []
        next_path: str | None = path
        next_params: dict[str, Any] | None = params
        while next_path:
            payload = await self._platform.request("GET", next_path, params=next_params)
            if not isinstance(payload, dict):
                break
            data = payload.get("data")
            if isinstance(data, list):
                items.extend(item for item in data if isinstance(item, dict))
            paging = payload.get("paging") if isinstance(payload.get("paging"), dict) else {}
            next_url = paging.get("next")
            next_path = str(next_url) if next_url else None
            next_params = None
        return items

    def _find_by_id(self, items: list[dict[str, Any]], item_id: str) -> dict[str, Any] | None:
        for item in items:
            if str(item.get("id") or "") == item_id:
                return item
        return None

    def _without_secret(self, value: dict[str, Any], *, blocked_keys: set[str]) -> dict[str, Any]:
        return {str(key): item for key, item in value.items() if str(key) not in blocked_keys}
