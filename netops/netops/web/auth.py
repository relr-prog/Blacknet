"""Signup, login, logout and session management."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..config import NetopsConfig
from ..db import Database
from ..security import (
    LoginThrottle,
    new_token,
    validate_password,
    validate_username,
    verify_password,
)
from .deps import SESSION_COOKIE, CurrentUser, audit, current_user, get_db, require_admin

router = APIRouter(prefix="/api/auth", tags=["auth"])


class Credentials(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class SignupRequest(Credentials):
    request_admin: bool = False


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=1, max_length=256)


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _set_session_cookie(response: Response, request: Request, token: str, expires: float) -> None:
    config: NetopsConfig = request.app.state.config
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=max(60, int(expires - __import__("time").time())),
        httponly=True,
        samesite="lax",
        secure=config.secure_cookies,
        path="/",
    )


@router.get("/state")
def auth_state(request: Request) -> dict:
    db: Database = get_db(request)
    user = current_user(request)
    return {
        "authenticated": user is not None,
        "user": user.as_dict() if user else None,
        "setup_required": db.user_count() == 0,
        "server_time": __import__("time").time(),
    }


@router.post("/signup")
def signup(request: Request, response: Response, payload: SignupRequest) -> dict:
    db: Database = get_db(request)
    config: NetopsConfig = request.app.state.config
    first_user = db.user_count() == 0
    inviter = None if first_user else require_admin(request)

    try:
        username = validate_username(payload.username)
        validate_password(payload.password)
    except ValueError as exc:
        audit(request, "auth.signup", target=payload.username, outcome="denied", detail=str(exc))
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    if db.get_user(username) is not None:
        audit(request, "auth.signup", target=username, outcome="denied", detail="username taken")
        raise HTTPException(status_code=409, detail="username already exists")

    # the very first account always owns the installation; after that only an
    # administrator can create accounts, and nobody gets promoted by asking
    role = "admin" if first_user else "operator"
    db.create_user(username, payload.password, role, allow_admin=True)
    user = db.get_user(username)
    audit(
        request,
        "auth.signup",
        target=username,
        detail=f"role={user['role']} first_user={first_user}"
        + (f" invited_by={inviter.username}" if inviter else ""),
        user=inviter or CurrentUser(id=int(user["id"]), username=username, role=user["role"]),
    )

    if not first_user:
        # an invitation must not switch the caller's identity
        return {"ok": True, "invited": True, "user": {
            "id": int(user["id"]), "username": username, "role": user["role"]
        }}

    token = new_token()
    expires = db.create_session(
        int(user["id"]), token, config.session_ttl, _client_ip(request),
        request.headers.get("user-agent"),
    )
    db.touch_login(int(user["id"]))
    _set_session_cookie(response, request, token, expires)
    return {"ok": True, "user": {"id": int(user["id"]), "username": username, "role": user["role"]}}


@router.post("/guest")
def guest_login(request: Request, response: Response) -> dict:
    """Optional guest access: creates a lightweight anonymous session."""
    from .deps import ROLE_GUEST

    response.set_cookie(
        "netops_guest",
        "true",
        max_age=3600,
        httponly=True,
        samesite="lax",
        secure=request.app.state.config.secure_cookies,
        path="/",
    )
    return {"ok": True, "user": {"id": -1, "username": "guest", "role": ROLE_GUEST}}


@router.post("/login")
def login(request: Request, response: Response, payload: Credentials) -> dict:
    db: Database = get_db(request)
    config: NetopsConfig = request.app.state.config
    throttle: LoginThrottle = request.app.state.login_throttle
    ip = _client_ip(request)
    throttle_key = f"{ip}:{payload.username.lower()}"

    locked_for = throttle.check(throttle_key)
    if locked_for:
        audit(request, "auth.login", target=payload.username, outcome="locked")
        raise HTTPException(
            status_code=429, detail=f"too many attempts, retry in {int(locked_for) + 1}s"
        )

    user = db.get_user(payload.username.strip())
    if user is None or not verify_password(payload.password, user["password_hash"]):
        blocked = throttle.record_failure(throttle_key)
        if user is not None:
            db.note_failed_login(int(user["id"]))
        audit(request, "auth.login", target=payload.username, outcome="failed")
        detail = "invalid credentials"
        if blocked:
            detail = "account temporarily locked"
        raise HTTPException(status_code=401, detail=detail)

    if int(user["disabled"]):
        audit(request, "auth.login", target=payload.username, outcome="denied", detail="disabled")
        raise HTTPException(status_code=403, detail="this account is disabled")

    throttle.record_success(throttle_key)
    token = new_token()
    expires = db.create_session(
        int(user["id"]), token, config.session_ttl, ip, request.headers.get("user-agent")
    )
    db.touch_login(int(user["id"]))
    _set_session_cookie(response, request, token, expires)
    audit(
        request,
        "auth.login",
        target=user["username"],
        user=CurrentUser(id=int(user["id"]), username=user["username"], role=user["role"]),
    )
    return {"ok": True, "user": {"id": user["id"], "username": user["username"], "role": user["role"]}}


@router.post("/logout")
def logout(request: Request) -> dict:
    db: Database = get_db(request)
    token = request.cookies.get(SESSION_COOKIE)
    user = current_user(request)
    if token:
        db.delete_session(token)
    audit(request, "auth.logout", user=user)
    response = Response(content=b'{"ok":true}', media_type="application/json")
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie("netops_guest", path="/")
    return response


@router.post("/password")
def change_password(request: Request, payload: PasswordChange) -> dict:
    db: Database = get_db(request)
    config: NetopsConfig = request.app.state.config
    user = require_admin_or_self(request)
    if user.is_guest:
        raise HTTPException(status_code=403, detail="guest users cannot change passwords")
    row = db.get_user(user.username)
    if row is None or not verify_password(payload.current_password, row["password_hash"]):
        audit(request, "auth.password_change", outcome="denied", user=user)
        raise HTTPException(status_code=401, detail="current password is incorrect")
    try:
        db.set_password(user.id, validate_password(payload.new_password))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(request, "auth.password_change", target=user.username, user=user)
    return {"ok": True, "detail": "password changed, other sessions revoked"}


def require_admin_or_self(request: Request) -> CurrentUser:
    from .deps import require_user

    user = require_user(request)
    if user.is_guest:
        raise HTTPException(status_code=403, detail="guest access is read-only")
    return user


class UserUpdate(BaseModel):
    disabled: bool | None = None
    role: str | None = None
    password: str | None = None


@router.get("/users")
def list_users(request: Request) -> dict:
    db: Database = get_db(request)
    require_admin(request)
    rows = db.list_users()
    return {
        "users": [
            {
                "id": row["id"],
                "username": row["username"],
                "role": row["role"],
                "disabled": bool(row["disabled"]),
                "created_at": row["created_at"],
                "last_login_at": row["last_login_at"],
                "failed_logins": row["failed_logins"],
                "sessions": len(db.sessions_for_user(int(row["id"]))),
            }
            for row in rows
        ]
    }


@router.post("/users/{user_id}")
def update_user(request: Request, user_id: int, payload: UserUpdate) -> dict:
    db: Database = get_db(request)
    actor = require_admin(request)
    if user_id == actor.id and payload.disabled:
        raise HTTPException(status_code=400, detail="you cannot disable your own account")
    row = db.get_user_by_id(user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="user not found")

    changes = []
    if payload.disabled is not None:
        db.set_disabled(user_id, payload.disabled)
        changes.append(f"disabled={payload.disabled}")
    if payload.role is not None:
        if payload.role not in ("admin", "operator"):
            raise HTTPException(status_code=400, detail="role must be admin or operator")
        db.set_role(user_id, payload.role)
        changes.append(f"role={payload.role}")
    if payload.password:
        try:
            db.set_password(user_id, payload.password)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        changes.append("password reset")

    audit(request, "auth.user_update", target=row["username"], detail=", ".join(changes), user=actor)
    return {"ok": True, "changes": changes}