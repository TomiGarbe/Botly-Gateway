from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class MethodInfo(BaseModel):
    id: str
    display_name: str
    icon: str = ""
    authentication: str
    discovery: str
    capabilities: list[str] = Field(default_factory=list)
    enabled: bool = True


class CatalogItem(BaseModel):
    channel: str
    display_name: str
    icon: str = ""
    capabilities: list[str] = Field(default_factory=list)
    methods: list[MethodInfo] = Field(default_factory=list)
    enabled: bool = True


class ProvisioningResource(BaseModel):
    id: str
    type: str
    display_name: str
    status: str


class ProvisionedChannel(BaseModel):
    id: str
    channel: str
    method: str
    display_name: str
    status: str


class ConnectionRequest(BaseModel):
    channel: str = Field(..., min_length=1)
    method: str = Field(..., min_length=1)
    context: dict[str, Any] = Field(default_factory=dict)


class ProvisionRequest(BaseModel):
    resource_id: str = Field(..., min_length=1)


class ConnectionStart(BaseModel):
    channel: str
    method: str
    status: str
    authentication: str
    discovery: str
    platform: dict[str, Any] | None = None
    capabilities: list[str] = Field(default_factory=list)
    next_action: dict[str, Any]
