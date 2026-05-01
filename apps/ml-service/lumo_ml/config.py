from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    env: str
    public_base_url: str
    service_jwt_secret: str | None
    agent_id: str = "lumo-ml"
    version: str = "0.1.0"
    display_name: str = "Lumo Intelligence Layer"


def get_settings() -> Settings:
    base_url = os.getenv("LUMO_ML_PUBLIC_BASE_URL", "http://localhost:3010").rstrip("/")
    return Settings(
        env=os.getenv("LUMO_ML_ENV", "dev"),
        public_base_url=base_url,
        service_jwt_secret=os.getenv("LUMO_ML_SERVICE_JWT_SECRET"),
    )
