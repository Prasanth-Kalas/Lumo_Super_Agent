from __future__ import annotations

from typing import Annotated

import jwt
from fastapi import Header, HTTPException, status
from pydantic import BaseModel

from .config import get_settings


class AuthContext(BaseModel):
    user_id: str
    request_id: str
    scope: str


def require_lumo_jwt(
    authorization: Annotated[str | None, Header(alias="Authorization")] = None,
) -> AuthContext:
    settings = get_settings()
    if not settings.service_jwt_secret:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": "service_auth_not_configured",
                "message": "LUMO_ML_SERVICE_JWT_SECRET is required for tool calls.",
            },
        )
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "missing_bearer", "message": "Authorization bearer is required."},
        )

    token = authorization.removeprefix("Bearer ").strip()
    try:
        payload = jwt.decode(
            token,
            settings.service_jwt_secret,
            algorithms=["HS256"],
            audience=settings.agent_id,
            issuer="lumo-core",
        )
    except jwt.PyJWTError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"error": "invalid_bearer", "message": str(exc)},
        ) from exc

    user_id = payload.get("sub")
    request_id = payload.get("jti")
    scope = payload.get("scope")
    if not isinstance(user_id, str) or not user_id or user_id == "anon":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "authenticated_user_required"},
        )
    if not isinstance(request_id, str) or not request_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail={"error": "jti_required"})
    if not isinstance(scope, str) or not scope:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"error": "scope_required"},
        )

    return AuthContext(user_id=user_id, request_id=request_id, scope=scope)
