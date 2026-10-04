"""Built-in privacy browser: engine, profiles, tabs, cookies, cache, themes."""

from __future__ import annotations

from .cookies import CookieManager, StorageManager
from .engine import BrowserEngine, BrowserNotInstalled
from .privacy import (
    TRACKER_PATTERNS,
    build_context_options,
    build_launch_args,
    firefox_prefs,
    match_blocker,
    summary,
)
from .service import BrowserService, browser_available, find_system_browser
from .tabs import TabError, TabManager, normalise_url
from .theme import PRESETS, Theme, ThemeStore, apply_theme

__all__ = [
    "BrowserEngine",
    "BrowserNotInstalled",
    "BrowserService",
    "CookieManager",
    "PRESETS",
    "StorageManager",
    "TRACKER_PATTERNS",
    "TabError",
    "TabManager",
    "Theme",
    "ThemeStore",
    "apply_theme",
    "browser_available",
    "build_context_options",
    "build_launch_args",
    "firefox_prefs",
    "find_system_browser",
    "match_blocker",
    "normalise_url",
    "summary",
]
