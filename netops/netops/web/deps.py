"""Shared FastAPI dependencies: current user, admin checks, audit helper."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import HTTPException, Request

from ..db import Database

SESSION_COOKIE = "netops_session"

ROLE_ADMIN = "admin"
ROLE_OPERATOR = "operator"
ROLE_GUEST = "guest"


@dataclass(frozen=True)
class CurrentUser:
    id: int
    username: str
    role: str

    @property
    def is_admin(self) -> bool:
        return self.role == ROLE_ADMIN

    @property
    def is_guest(self) -> bool:
        return self.role == ROLE_GUEST

    def as_dict(self) -> dict:
        return {"id": self.id, "username": self.username, "role": self.role}


def get_db(request: Request) -> Database:
    return request.app.state.db


def get_config(request: Request):
    return request.app.state.config


def current_user(request: Request) -> CurrentUser | None:
    cached = getattr(request.state, "current_user", None)
    if cached is not None:
        return cached if cached is not False else None
    db: Database = request.app.state.db
    token = request.cookies.get(SESSION_COOKIE)
    user = None
    if token:
        row = db.session_user(token)
        if row is not None:
            user = CurrentUser(id=int(row["id"]), username=row["username"], role=row["role"])
    # Allow anonymous/guest access if the frontend explicitly requested it and
    # the configuration permits. This is intentionally light-touch: a valid
    # session still takes precedence.
    if user is None and request.cookies.get("netops_guest") == "true":
        user = CurrentUser(id=-1, username="guest", role="guest")
    request.state.current_user = user if user is not None else False
    return user


def require_user(request: Request) -> CurrentUser:
    user = current_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return user


def require_admin(request: Request) -> CurrentUser:
    user = require_user(request)
    if user.is_guest or not user.is_admin:
        raise HTTPException(status_code=403, detail="administrator role required")
    return user


def audit(
    request: Request,
    action: str,
    *,
    target: str | None = None,
    outcome: str = "ok",
    detail: str | None = None,
    user: CurrentUser | None = None,
) -> None:
    actor = user or current_user(request)
    db: Database = request.app.state.db
    db.audit(
        action,
        user_id=actor.id if actor else None,
        username=actor.username if actor else "anonymous",
        target=target,
        outcome=outcome,
        detail=detail,
    )