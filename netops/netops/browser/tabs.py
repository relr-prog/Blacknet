"""Tab manager: many tabs, one rotating context, per-tab identity and titles."""

from __future__ import annotations

import re
import time
import uuid
from typing import Any
from urllib.parse import urlsplit

from ..config import BrowserPolicy
from ..security import validate_hostname

__all__ = ["TabManager", "TabError", "normalise_url"]

_SCHEME = re.compile(r"^([a-z][a-z0-9+.\-]*):", re.IGNORECASE)
_SAFE_SCHEMES = ("http", "https", "about")
_DATA_PREFIXES = ("data:text/html,", "data:text/plain,")
_MAX_DATA_URL = 8192


class TabError(ValueError):
    pass


def normalise_url(raw: str, *, https_only: bool = True) -> str:
    """Accept a hostname, a URL or about:blank and return something navigable."""
    url = (raw or "").strip()
    if not url:
        raise TabError("URL is required")
    match = _SCHEME.match(url)
    scheme = (match.group(1).lower() if match else None) or "https"
    if scheme == "data":
        if not url.lower().startswith(_DATA_PREFIXES):
            raise TabError("only data:text/html and data:text/plain are allowed")
        if len(url) > _MAX_DATA_URL:
            raise TabError(f"data URL is longer than {_MAX_DATA_URL} characters")
        return url
    if scheme not in _SAFE_SCHEMES:
        raise TabError(f"scheme {scheme!r} is not allowed")
    if not match:
        url = f"https://{url}"
    if scheme == "about":
        if url.lower() not in ("about:blank",):
            raise TabError("only about:blank is allowed")
        return url
    if scheme == "http" and https_only:
        url = f"https://{url[len('http://'):]}"
    if any(char in url for char in " \t\r\n<>\"'"):
        raise TabError("URL contains illegal characters")
    return url


def host_of(url: str) -> str:
    if "://" not in url:
        return ""
    try:
        return (urlsplit(url).hostname or "").lower()
    except ValueError:
        return ""


class TabManager:
    """Wraps Playwright pages for one signed-in user."""

    def __init__(self, context: Any, policy: BrowserPolicy, owner: str = "anonymous") -> None:
        self.context = context
        self.policy = policy
        self.owner = owner
        self._tabs: dict[str, dict[str, Any]] = {}

    # ---------------------------------------------------------------- helpers
    def _limit(self) -> None:
        if len(self._tabs) >= self.policy.max_tabs:
            raise TabError(f"browser tab limit reached ({self.policy.max_tabs})")

    def _record(self, page: Any, url: str) -> dict[str, Any]:
        entry = {
            "id": uuid.uuid4().hex[:12],
            "owner": self.owner,
            "page": page,
            "url": url,
            "title": "",
            "opened_at": time.time(),
            "last_active": time.time(),
            "blocked": [],
        }
        self._tabs[entry["id"]] = entry
        return entry

    def _entry(self, tab_id: str) -> dict[str, Any]:
        entry = self._tabs.get(tab_id)
        if entry is None:
            raise TabError(f"unknown tab {tab_id!r}")
        entry["last_active"] = time.time()
        return entry

    def page(self, tab_id: str) -> Any:
        """Public accessor for API handlers that need the raw Playwright page."""
        return self._entry(tab_id)["page"]

    def owns(self, tab_id: str) -> bool:
        entry = self._tabs.get(tab_id)
        return bool(entry and entry["owner"] == self.owner)

    # ------------------------------------------------------------------- api
    async def open(self, url: str = "about:blank") -> dict:
        self._limit()
        target = normalise_url(url, https_only=self.policy.https_only)
        if target.startswith(("http://", "https://")):
            validate_hostname(host_of(target))
        page = await self.context.new_page()
        page.set_default_timeout(self.policy.navigation_timeout * 1000)
        entry = self._record(page, target)
        await self._attach_blockers(page, entry)
        if target.startswith("data:"):
            await page.goto(target, wait_until="domcontentloaded")
            await self.refresh(entry)
        else:
            await self.navigate(tab_id=entry["id"], url=target)
        return await self.describe(entry["id"])

    async def navigate(self, *, tab_id: str, url: str) -> dict:
        entry = self._entry(tab_id)
        target = normalise_url(url, https_only=self.policy.https_only)
        if target.startswith(("http://", "https://")):
            validate_hostname(host_of(target))
        response = await entry["page"].goto(target, wait_until="domcontentloaded")
        await self.refresh(entry)
        status = response.status if response is not None else None
        described = await self.describe(tab_id)
        described["status"] = status
        return described

    async def activate(self, tab_id: str) -> dict:
        await self._entry(tab_id)["page"].bring_to_front()
        return await self.describe(tab_id)

    async def close(self, tab_id: str) -> dict:
        entry = self._tabs.get(tab_id)
        if entry is None:
            raise TabError(f"unknown tab {tab_id!r}")
        try:
            await entry["page"].close()
        finally:
            self._tabs.pop(tab_id, None)
        return {"ok": True, "closed": tab_id, "tabs": len(self._tabs)}

    async def close_all(self) -> dict:
        for entry in list(self._tabs.values()):
            try:
                await entry["page"].close()
            except Exception:  # noqa: BLE001
                pass
        self._tabs.clear()
        return {"ok": True, "tabs": 0}

    async def back(self, tab_id: str) -> dict:
        await self._entry(tab_id)["page"].go_back()
        await self.refresh(self._entry(tab_id))
        return await self.describe(tab_id)

    async def forward(self, tab_id: str) -> dict:
        await self._entry(tab_id)["page"].go_forward()
        await self.refresh(self._entry(tab_id))
        return await self.describe(tab_id)

    async def reload(self, tab_id: str) -> dict:
        await self._entry(tab_id)["page"].reload()
        await self.refresh(self._entry(tab_id))
        return await self.describe(tab_id)

    async def screenshot(self, tab_id: str, target: str, *, full_page: bool = True) -> str:
        await self._entry(tab_id)["page"].screenshot(path=target, full_page=full_page)
        return target

    # ------------------------------------------------------------- blocking
    async def _attach_blockers(self, page: Any, entry: dict[str, Any]) -> None:
        """Abort tracker requests per tab."""
        from .privacy import match_blocker

        blocked: list[str] = entry["blocked"]
        extra = tuple(self.policy.blocklist)

        async def route_handler(route, request) -> None:
            if match_blocker(request.url, extra):
                if len(blocked) < 200:
                    blocked.append(request.url)
                await route.abort()
            else:
                await route.continue_()

        try:
            await page.route("**/*", route_handler)
        except Exception:  # noqa: BLE001 - routing unsupported on this engine
            pass

    # ---------------------------------------------------------------- output
    async def refresh(self, entry: dict[str, Any]) -> None:
        page = entry["page"]
        if page.is_closed():
            entry["title"] = "(closed)"
            return
        entry["url"] = page.url
        try:
            entry["title"] = await page.title()
        except Exception:  # noqa: BLE001 - still loading or navigating
            entry["title"] = "(loading)"

    async def describe(self, tab_id: str) -> dict:
        entry = self._entry(tab_id)
        page = entry["page"]
        if not page.is_closed():
            await self.refresh(entry)
        return {
            "id": tab_id,
            "owner": entry["owner"],
            "url": entry["url"],
            "host": host_of(entry["url"]),
            "title": entry["title"],
            "opened_at": entry["opened_at"],
            "last_active": entry["last_active"],
            "blocked": entry["blocked"][:50],
            "blocked_count": len(entry["blocked"]),
            "closed": page.is_closed(),
        }

    def list(self) -> list[dict]:
        out = []
        for tab_id, entry in sorted(
            self._tabs.items(), key=lambda kv: kv[1]["last_active"], reverse=True
        ):
            page = entry["page"]
            out.append(
                {
                    "id": tab_id,
                    "owner": entry["owner"],
                    "url": entry["url"],
                    "host": host_of(entry["url"]),
                    "title": entry["title"] or ("(closed)" if page.is_closed() else "(loading)"),
                    "opened_at": entry["opened_at"],
                    "last_active": entry["last_active"],
                    "blocked": entry["blocked"][:50],
                    "blocked_count": len(entry["blocked"]),
                    "closed": page.is_closed(),
                }
            )
        return out

    def __len__(self) -> int:
        return len(self._tabs)
