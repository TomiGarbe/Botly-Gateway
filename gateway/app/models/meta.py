from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class MetaSignupCompleteRequest(BaseModel):
    instance_name: str = Field(..., pattern=r"^[a-z0-9_]{1,64}$")
    code: str = Field(..., min_length=8)
    phone_number_id: str = Field(..., min_length=2)
    business_account_id: str = Field(..., min_length=2)
    session_info: dict[str, Any] = Field(default_factory=dict)


class MetaSignupConfigResponse(BaseModel):
    enabled: bool
    app_id: str | None = None
    config_id: str | None = None
    graph_version: str
    supports_coexistence: bool = True
    coexistence_feature_type: str = "whatsapp_business_app_onboarding"
    missing: list[str] = Field(default_factory=list)
