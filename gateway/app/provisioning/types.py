from __future__ import annotations

from enum import Enum


class ProvisioningState(str, Enum):
    CREATED = "CREATED"
    WAITING_CONFIGURATION = "WAITING_CONFIGURATION"
    PROVISIONING = "PROVISIONING"
    CONFIGURING = "CONFIGURING"
    READY = "READY"
    FAILED = "FAILED"
