from __future__ import annotations

from enum import Enum


class ConnectionType(str, Enum):
    BAILEYS = "baileys"
    CLOUD = "cloud"
