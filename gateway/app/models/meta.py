from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field, model_validator


class MetaSignupCompleteRequest(BaseModel):
    instance_name: str | None = Field(default=None, pattern=r"^[a-z0-9_]{1,64}$")
    connection_id: str | None = Field(default=None, min_length=1, max_length=128)
    setup_id: str | None = Field(default=None, min_length=1, max_length=128)
    code: str = Field(..., min_length=8)
    # The coexistence completion event can identify only the WABA.  The
    # Gateway resolves a single eligible phone after exchanging the OAuth code.
    phone_number_id: str | None = Field(default=None, min_length=2)
    business_account_id: str = Field(..., min_length=2)
    session_info: dict[str, Any] = Field(default_factory=dict)
    # PIN de verificacion en dos pasos del numero de WhatsApp. Si el numero ya
    # tiene uno configurado, el usuario debe ingresarlo; si no tiene, elige uno
    # nuevo (que Meta setea como su 2FA). Vacio = el backend genera uno (solo
    # sirve para numeros sin 2FA previo).
    registration_pin: str | None = Field(default=None, pattern=r"^\d{6}$")

    @model_validator(mode="after")
    def require_connection_target(self) -> "MetaSignupCompleteRequest":
        if not self.instance_name and not self.connection_id and not self.setup_id:
            raise ValueError("instance_name, connection_id or setup_id is required")
        return self


class MetaSignupConfigResponse(BaseModel):
    enabled: bool
    app_id: str | None = None
    config_id: str | None = None
    graph_version: str
    supports_coexistence: bool = True
    coexistence_feature_type: str = "whatsapp_business_app_onboarding"
    missing: list[str] = Field(default_factory=list)
