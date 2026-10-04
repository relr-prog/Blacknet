"""Built-in privacy browser API: engine, tabs, cookies, cache, themes."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Awaitable

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, Field

from ..browser import (
    CookieManager,
    StorageManager,
    TabError,
    ThemeStore,
    apply_theme,
    browser_available,
    find_system_browser,
    normalise_url,
    summary,
)
from ..browser.engine import BrowserNotInstalled
from .deps import audit, require_admin, require_user

router = APIRouter(prefix="/api/browser", tags=["browser"])

BROWSER_TIMEOUT = 120.0


def _policy(request: Request):
    return request.app.state.config.browser


def _service(request: Request):
    return request.app.state.browser


def _themes(request: Request) -> ThemeStore:
    return request.app.state.browser_themes


def _guard(request: Request) -> None:
    if not _policy(request).enabled:
        raise HTTPException(status_code=403, detail="the built-in browser is disabled in netops.toml")


def _effective_headless(request: Request, headless: bool | None) -> bool:
    """Resolve the requested mode and enforce require_headless."""
    policy = _policy(request)
    if headless is None:
        return policy.headless
    if policy.require_headless and not headless:
        raise HTTPException(
            status_code=400,
            detail="browser.require_headless is set: flip browser.headless in netops.toml first",
        )
    return bool(headless)


async def _run(awaitable: Awaitable[Any], *, timeout: float = BROWSER_TIMEOUT) -> Any:
    """Await engine work with a timeout and map engine errors to HTTP."""
    try:
        return await asyncio.wait_for(awaitable, timeout=timeout)
    except TabError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except BrowserNotInstalled as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="browser call timed out") from None


def _running(request: Request):
    service = _service(request)
    if not service.running:
        raise HTTPException(status_code=409, detail="browser is not running")
    return service


def _tabs(request: Request):
    service = _running(request)
    service.touch()
    return service.tabs_for(require_user(request))


def _storage(request: Request) -> StorageManager:
    service = _running(request)
    return StorageManager(service._state.context, _policy(request), service.profile_dir())


# --------------------------------------------------------------------- status
@router.get("/status")
def status(request: Request) -> dict:
    require_user(request)
    policy = _policy(request)
    service = _service(request)
    return {
        **service.status(),
        "policy": summary(policy),
        "system_browser": find_system_browser(),
        "limits": {
            "max_tabs": policy.max_tabs,
            "max_tabs_per_user": policy.max_tabs_per_user,
            "navigation_timeout": policy.navigation_timeout,
        },
        "available": browser_available(policy),
    }


class StartBody(BaseModel):
    headless: bool | None = None
    profile: str | None = Field(default=None, max_length=64)


@router.post("/start")
async def start(request: Request, payload: StartBody | None = None) -> dict:
    user = require_admin(request)
    _guard(request)
    payload = payload or StartBody()
    _effective_headless(request, payload.headless)
    service = _service(request)
    result = await _run(
        service.launch(headless=payload.headless, profile=payload.profile), timeout=90
    )
    audit(
        request,
        "browser.start",
        target=payload.profile or "default",
        outcome="ok" if result.get("running") else "failed",
        detail=str(result.get("error"))[:200],
        user=user,
    )
    if not result.get("running") and result.get("error"):
        raise HTTPException(status_code=503, detail=result["error"])
    return result


@router.post("/stop")
async def stop(request: Request) -> dict:
    user = require_admin(request)
    result = await _run(_service(request).close(), timeout=60)
    audit(request, "browser.stop", user=user)
    return result


@router.post("/restart")
async def restart(request: Request) -> dict:
    user = require_admin(request)
    _guard(request)
    service = _service(request)
    await _run(service.close(), timeout=60)
    result = await _run(service.launch(), timeout=90)
    audit(
        request,
        "browser.restart",
        outcome="ok" if result.get("running") else "failed",
        detail=str(result.get("error"))[:200],
        user=user,
    )
    return result


@router.put("/proxy")
def set_proxy(request: Request, payload: dict[str, Any]) -> dict:
    user = require_admin(request)
    server = str(payload.get("server") or "").strip() or None
    proxy = {"server": server} if server else None
    result = _service(request).set_proxy(proxy)
    audit(request, "browser.proxy_set", target=server or "none", user=user)
    return result


# ----------------------------------------------------------------------- tabs
class OpenTab(BaseModel):
    url: str = Field(default="about:blank", max_length=2048)


@router.get("/tabs")
def list_tabs(request: Request) -> dict:
    require_user(request)
    return {"tabs": _tabs(request).list()}


@router.post("/tabs")
async def open_tab(request: Request, payload: OpenTab) -> dict:
    user = require_user(request)
    _guard(request)
    tab = await _run(_tabs(request).open(payload.url), timeout=_timeout(request))
    await _apply_theme(request, tab)
    audit(request, "browser.tab_open", target=payload.url[:120], user=user)
    return tab


@router.post("/tabs/{tab_id}/navigate")
async def navigate(request: Request, tab_id: str, payload: OpenTab) -> dict:
    user = require_user(request)
    tabs = _tabs(request)
    tab = await _run(tabs.navigate(tab_id=tab_id, url=payload.url), timeout=_timeout(request))
    await _apply_theme(request, tab)
    audit(request, "browser.tab_navigate", target=payload.url[:120], user=user)
    return tab


@router.post("/tabs/{tab_id}/back")
async def back(request: Request, tab_id: str) -> dict:
    tabs = _tabs(request)
    tab = await _run(tabs.back(tab_id), timeout=_timeout(request))
    await _apply_theme(request, tab)
    return tab


@router.post("/tabs/{tab_id}/forward")
async def forward(request: Request, tab_id: str) -> dict:
    tabs = _tabs(request)
    tab = await _run(tabs.forward(tab_id), timeout=_timeout(request))
    await _apply_theme(request, tab)
    return tab


@router.post("/tabs/{tab_id}/reload")
async def reload(request: Request, tab_id: str) -> dict:
    tabs = _tabs(request)
    tab = await _run(tabs.reload(tab_id), timeout=_timeout(request))
    await _apply_theme(request, tab)
    return tab


@router.post("/tabs/{tab_id}/activate")
async def activate(request: Request, tab_id: str) -> dict:
    tabs = _tabs(request)
    return await _run(tabs.activate(tab_id), timeout=30)


@router.delete("/tabs/{tab_id}")
async def close_tab(request: Request, tab_id: str) -> dict:
    tabs = _tabs(request)
    return await _run(tabs.close(tab_id), timeout=30)


@router.post("/tabs/close-all")
async def close_all_tabs(request: Request) -> dict:
    tabs = _tabs(request)
    return await _run(tabs.close_all(), timeout=60)


@router.post("/tabs/{tab_id}/screenshot")
async def screenshot(request: Request, tab_id: str, full_page: bool = True) -> dict:
    tabs = _tabs(request)
    service = _service(request)
    target = service.data_dir / "shots" / f"{tab_id}-{int(time.time())}.png"
    await _run(tabs.screenshot(tab_id, str(target), full_page=full_page), timeout=60)
    return {
        "ok": True,
        "tab_id": tab_id,
        "path": str(target),
        "relative": str(target.relative_to(service.data_dir)),
    }


@router.get("/tabs/{tab_id}/content")
async def content(
    request: Request, tab_id: str, limit: int = Query(40_000, ge=500, le=400_000)
) -> dict:
    tabs = _tabs(request)
    page = tabs.page(tab_id)
    return await _run(
        page.evaluate(
            """(limit) => ({
                title: document.title,
                url: location.href,
                text: (document.body ? document.body.innerText : '').slice(0, limit),
                links: [...document.querySelectorAll('a[href^="http"]')].slice(0, 60)
                    .map(a => ({ text: a.innerText.trim().slice(0, 80), href: a.href })),
            })""",
            limit,
        ),
        timeout=45,
    )


def _timeout(request: Request) -> float:
    return _policy(request).navigation_timeout + 30


async def _apply_theme(request: Request, tab: dict) -> None:
    """Re-inject the theme after every navigation."""
    store = _themes(request)
    from urllib.parse import urlsplit

    host = (urlsplit(tab.get("url", "")).hostname or "").lower()
    if not host:
        return
    css = store.site_theme(host)["css"] if store.has_site(host) else store.get_global()["css"]
    if not css:
        return
    try:
        tabs = _service(request).tabs_for(require_user(request))
        await apply_theme(tabs.page(tab["id"]), css)
    except (HTTPException, TabError):
        pass


# -------------------------------------------------------------------- cookies
@router.get("/cookies")
async def list_cookies(
    request: Request, domain: str | None = None, include_expired: bool = False
) -> dict:
    require_user(request)
    service = _running(request)
    service.touch()
    cookies = CookieManager(service._state.context)
    return await _run(
        cookies.list(domain=domain, include_expired=include_expired), timeout=60
    )


@router.get("/cookies/stats")
async def cookie_stats(request: Request) -> dict:
    require_user(request)
    service = _running(request)
    return await _run(CookieManager(service._state.context).stats(), timeout=60)


@router.delete("/cookies")
async def clear_cookies(request: Request, domain: str | None = None) -> dict:
    user = require_user(request)
    cookies = CookieManager(_running(request)._state.context)
    result = await _run(cookies.clear(domain=domain), timeout=60)
    audit(request, "browser.cookies_clear", target=domain or "all", user=user)
    return result


@router.post("/cookies/export")
async def export_cookies(request: Request, payload: dict[str, Any]) -> dict:
    user = require_admin(request)
    service = _running(request)
    cookies = CookieManager(service._state.context)
    name = str(payload.get("name") or "cookies.json")[:64]
    if not name.endswith(".json"):
        name += ".json"
    target = service.data_dir / "exports" / name
    result = await _run(
        cookies.export(target, include_values=bool(payload.get("include_values"))), timeout=60
    )
    audit(request, "browser.cookies_export", target=result["path"], user=user)
    return result


# ------------------------------------------------------------ cache & storage
@router.get("/cache")
async def cache_report(request: Request) -> dict:
    require_user(request)
    storage = _storage(request)
    return {
        "cache": storage.cache_stats(),
        "storage": await _run(storage.storage_report(), timeout=90),
    }


@router.post("/cache/clear")
async def clear_cache(request: Request, domain: str | None = None) -> dict:
    user = require_admin(request)
    storage = _storage(request)
    result = await _run(storage.clear_cache(domain=domain), timeout=90)
    audit(request, "browser.cache_clear", target=domain or "all", user=user)
    return result


@router.post("/storage/revoke")
async def revoke(request: Request) -> dict:
    user = require_admin(request)
    storage = _storage(request)
    result = await _run(storage.revoke_all(), timeout=90)
    audit(request, "browser.storage_revoke", user=user)
    return result


# ---------------------------------------------------------------------- theme
@router.get("/theme")
def get_theme(request: Request) -> dict:
    require_user(request)
    return _themes(request).get_global()


class ThemePatch(BaseModel):
    name: str | None = None
    mode: str | None = None
    colors: dict[str, str] | None = None
    font_family: str | None = None
    font_size: int | None = None
    line_height: float | None = None
    max_width: int | None = None
    hide_images: bool | None = None
    hide_ads: bool | None = None
    dim_videos: bool | None = None
    reader_mode: bool | None = None
    force_dark: bool | None = None

    def changes(self) -> dict:
        return {key: value for key, value in self.model_dump().items() if value is not None}


@router.put("/theme")
def set_theme(request: Request, payload: ThemePatch) -> dict:
    user = require_user(request)
    try:
        result = _themes(request).set_global(**payload.changes())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(request, "browser.theme_update", detail=",".join(payload.changes()) or "none", user=user)
    return result


@router.get("/theme/sites")
def list_site_themes(request: Request) -> dict:
    require_user(request)
    return {"sites": _themes(request).list_sites()}


@router.put("/theme/site/{host}")
def set_site_theme(request: Request, host: str, payload: ThemePatch) -> dict:
    user = require_user(request)
    try:
        result = _themes(request).set_site_theme(host, **payload.changes())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(
        request,
        "browser.site_theme_update",
        target=host,
        detail=",".join(payload.changes()) or "none",
        user=user,
    )
    return result


@router.delete("/theme/site/{host}")
def clear_site_theme(request: Request, host: str) -> dict:
    user = require_user(request)
    return _themes(request).clear_site_theme(host)


# -------------------------------------------------------------- button presets
@router.get("/buttons")
def list_buttons(request: Request) -> dict:
    require_user(request)
    return {"buttons": _themes(request).buttons()}


@router.put("/buttons/{key}")
def save_button(request: Request, key: str, payload: dict[str, Any]) -> dict:
    user = require_admin(request)
    try:
        result = _themes(request).set_button(key, payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    audit(request, "browser.button_save", target=key, user=user)
    return result


@router.delete("/buttons/{key}")
def delete_button(request: Request, key: str) -> dict:
    user = require_admin(request)
    return _themes(request).remove_button(key)


# -------------------------------------------------------------- address check
@router.get("/check")
def check_url(request: Request, url: str = Query(..., max_length=2048)) -> dict:
    require_user(request)
    from ..browser.privacy import match_blocker

    normalised = normalise_url(url, https_only=_policy(request).https_only)
    return {
        "url": normalised,
        "blocked_pattern": match_blocker(normalised, tuple(_policy(request).blocklist)),
        "allowed": True,
    }
