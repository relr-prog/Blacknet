"""Privacy browser engine management.

A real Chromium/Firefox instance driven by Playwright, hardened for privacy and
launched through the rotating proxy so every tab leaves from a different exit
IP. This module owns engine processes and profiles; tab, cookie, cache and
theme control live in the sibling modules.

Everything is async and runs on the caller's event loop, which is why the panel
can talk to the engine without a second process or a worker thread.
"""

from __future__ import annotations

import asyncio
import logging
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..config import BrowserPolicy
from .engine import BrowserEngine, BrowserNotInstalled, bundled_executable
from .privacy import build_context_options, build_launch_args
from .tabs import TabManager

log = logging.getLogger("netops.browser")

__all__ = ["BrowserService", "BrowserPolicy", "browser_available", "find_system_browser"]


@dataclass
class _EngineState:
    engine: BrowserEngine | None = None
    context: Any = None
    profile: str = "default"
    started_at: float = 0.0
    error: str | None = None


class BrowserService:
    """One engine at a time, plus one persistent context (the current profile)."""

    def __init__(self, policy: BrowserPolicy, data_dir: Path, proxy: dict | None = None) -> None:
        self.policy = policy
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.proxy = proxy
        self._state = _EngineState()
        self._lock = asyncio.Lock()
        self._playwright: Any = None
        self._tabs: dict[str, TabManager] = {}
        self._idle_since = time.time()

    # ------------------------------------------------------------- lifecycle
    @property
    def running(self) -> bool:
        return self._state.engine is not None and self._state.context is not None

    @property
    def profile(self) -> str:
        return self._state.profile

    def profile_dir(self, profile: str | None = None) -> Path:
        name = _safe_name(profile or self._state.profile)
        path = self.data_dir / "profiles" / name
        path.mkdir(parents=True, exist_ok=True)
        return path

    def profiles(self) -> list[str]:
        base = self.data_dir / "profiles"
        return sorted(p.name for p in base.glob("*") if p.is_dir()) if base.is_dir() else []

    async def _ensure_playwright(self) -> Any:
        if self._playwright is not None:
            return self._playwright
        from playwright.async_api import async_playwright

        self._playwright = await async_playwright().start()
        return self._playwright

    async def launch(
        self, *, headless: bool | None = None, profile: str | None = None
    ) -> dict:
        async with self._lock:
            if self.running and (profile is None or profile == self._state.profile):
                return self.status()

            await self._close_locked()
            try:
                playwright = await self._ensure_playwright()
            except Exception as exc:  # noqa: BLE001
                self._state.error = f"playwright unavailable: {exc}"
                return {"ok": False, "running": False, "error": self._state.error}

            headless = self.policy.headless if headless is None else bool(headless)
            engine = BrowserEngine(
                playwright,
                engine=self.policy.engine,
                headless=headless,
                executable_path=self.policy.executable_path,
                args=build_launch_args(self.policy),
                env=self.policy.env_dict,
            )
            profile_name = _safe_name(profile or "default")
            directory = self.profile_dir(profile_name)
            try:
                context = await engine.start_persistent(
                    directory,
                    **build_context_options(self.policy, proxy=self.effective_proxy()),
                )
            except BrowserNotInstalled as exc:
                self._state.error = str(exc)
                return {"ok": False, "running": False, "error": self._state.error}
            except Exception as exc:  # noqa: BLE001
                self._state.error = f"{type(exc).__name__}: {exc}"
                await engine.stop()
                return {"ok": False, "running": False, "error": self._state.error}

            context.set_default_navigation_timeout(self.policy.navigation_timeout * 1000)
            self._state = _EngineState(
                engine=engine, context=context, profile=profile_name, started_at=time.time()
            )
            log.info(
                "browser %s launched (headless=%s, profile=%s, proxy=%s)",
                self.policy.engine, headless, profile_name, self.effective_proxy(),
            )
            return self.status()

    def effective_proxy(self) -> dict | None:
        proxy = dict(self.proxy or {})
        if not proxy.get("server"):
            return None
        if str(proxy["server"]).startswith("socks5"):
            # remote DNS for SOCKS: never leak hostnames to the local resolver
            proxy["bypass"] = ""
        return proxy

    def set_proxy(self, proxy: dict | None) -> dict:
        """Changing the proxy needs a fresh context; restart to apply."""
        self.proxy = proxy
        return {"ok": True, "proxy": self.effective_proxy(), "restart_required": self.running}

    async def close(self) -> dict:
        async with self._lock:
            closed = await self._close_locked()
            return {"ok": True, "closed": closed, "running": False}

    async def _close_locked(self) -> bool:
        had = self.running
        for manager in list(self._tabs.values()):
            try:
                await manager.close_all()
            except Exception:  # noqa: BLE001
                pass
        self._tabs.clear()
        # engine.stop() owns the persistent context, which is also the browser
        if self._state.engine is not None:
            try:
                await self._state.engine.stop()
            except Exception as exc:  # noqa: BLE001
                log.debug("engine stop reported: %s", exc)
        if self.policy.clear_on_close and had:
            self._wipe_profile(self._state.profile)
        self._state = _EngineState()
        return had

    def _wipe_profile(self, profile: str) -> None:
        """clear_on_close: forget cookies and caches, keep nothing identifying."""
        directory = self.data_dir / "profiles" / _safe_name(profile)
        for name in ("Default", "Cookies", "Cookies-journal", "Local Storage", "Session Storage",
                     "IndexedDB", "Service Worker", "Cache", "Code Cache", "GPUCache",
                     "DawnCache", "Network"):
            target = directory / name
            if target.is_dir():
                shutil.rmtree(target, ignore_errors=True)
            elif target.is_file():
                try:
                    target.unlink()
                except OSError:
                    pass

    async def shutdown(self) -> None:
        async with self._lock:
            await self._close_locked()
            playwright = self._playwright
            self._playwright = None
        if playwright is not None:
            try:
                await playwright.stop()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------ tabs
    def tabs_for(self, user: Any) -> TabManager:
        """One TabManager per signed-in user, bound to the live context."""
        key = getattr(user, "username", None) or str(user)
        manager = self._tabs.get(key)
        if manager is None or manager.context is not self._state.context:
            manager = TabManager(self._state.context, self.policy, owner=key)
            self._tabs[key] = manager
        return manager

    def all_tabs(self) -> dict[str, TabManager]:
        return dict(self._tabs)

    def touch(self) -> None:
        self._idle_since = time.time()

    @property
    def idle_seconds(self) -> float:
        return time.time() - self._idle_since

    async def close_if_idle(self) -> dict:
        """Free RAM when nobody has used the browser for a while."""
        if not self.running or self.policy.idle_timeout <= 0:
            return {"ok": True, "closed": False}
        if self.idle_seconds < self.policy.idle_timeout:
            return {"ok": True, "closed": False}
        log.info("closing idle browser after %.0fs", self.idle_seconds)
        return await self.close()

    # ---------------------------------------------------------------- status
    def status(self) -> dict:
        state = self._state
        return {
            "ok": state.engine is not None,
            "running": self.running,
            "engine": self.policy.engine,
            "headless": self.policy.headless,
            "profile": state.profile if self.running else None,
            "started_at": state.started_at or None,
            "uptime_seconds": round(time.time() - state.started_at, 1) if state.started_at else None,
            "tabs": sum(len(manager) for manager in self._tabs.values()),
            "executable": state.engine.executable if state.engine else None,
            "bundle_installed": browser_available(self.policy),
            "profiles": self.profiles(),
            "proxy": self.effective_proxy(),
            "error": state.error,
        }


def browser_available(policy: BrowserPolicy) -> bool:
    """Is the requested engine actually present on this host?"""
    if policy.executable_path:
        return Path(policy.executable_path).is_file()
    return bundled_executable(policy.engine) is not None


def _safe_name(name: str) -> str:
    cleaned = "".join(
        char if char.isalnum() or char in "._-" else "_" for char in (name or "default")
    )
    return cleaned.strip("._-") or "default"


def find_system_browser() -> str | None:
    for name in ("chromium", "chromium-browser", "google-chrome", "firefox", "firefox-esr"):
        found = shutil.which(name)
        if found:
            return found
    return None
