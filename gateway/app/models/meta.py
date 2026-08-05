from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator


class MetaSignupCompleteRequest(BaseModel):
    instance_name: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,64}$")
    connection_id: str | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(..., min_length=8)
    phone_number_id: str = Field(..., min_length=2)
    business_account_id: str = Field(..., min_length=2)
    session_info: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def require_connection_target(self) -> "MetaSignupCompleteRequest":
        if not self.instance_name and not self.connection_id:
            raise ValueError("instance_name or connection_id is required")
        return self


class MetaSignupConfigResponse(BaseModel):
    enabled: bool
    app_id: str | None = None
    config_id: str | None = None
    graph_version: str
    supports_coexistence: bool = True
    coexistence_feature_type: str = "whatsapp_business_app_onboarding"
    missing: list[str] = Field(default_factory=list)
