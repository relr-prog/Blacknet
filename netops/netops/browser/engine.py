"""Engine wrapper: one place that knows Chromium vs Firefox differences.

Uses the Playwright *async* API so everything runs on the app's event loop — the
sync API pins a greenlet to its creating thread and cannot be used from a
FastAPI worker.

The panel always wants a *persistent* context (so cookies, cache and logins
survive between sessions), which means the browser is owned by
``launch_persistent_context`` rather than ``launch``. ``start_persistent`` is
therefore the primary path and ``start`` exists only for throwaway contexts.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

log = logging.getLogger("netops.browser")

__all__ = ["BrowserEngine", "BrowserNotInstalled", "bundled_executable"]


class BrowserNotInstalled(RuntimeError):
    pass


_INSTALL_HINT = (
    "no browser binary found. Run './.venv/bin/python -m playwright install chromium' "
    "or set [browser] executable_path in netops.toml"
)


class BrowserEngine:
    """Thin wrapper over Playwright browser types."""

    def __init__(
        self,
        playwright: Any,
        *,
        engine: str = "chromium",
        headless: bool = True,
        executable_path: str | None = None,
        args: list[str] | None = None,
        env: dict[str, str] | None = None,
        slow_mo: int = 0,
    ) -> None:
        self.playwright = playwright
        self.kind = engine if engine in ("chromium", "firefox", "webkit") else "chromium"
        self.headless = headless
        self.args = args or []
        self.env = env or None
        self.executable_path = executable_path or None
        self.slow_mo = slow_mo
        self._browser: Any = None
        self._context: Any = None

    @property
    def launcher(self) -> Any:
        return getattr(self.playwright, self.kind)

    @property
    def executable(self) -> str | None:
        """Best-effort binary path; persistent contexts hide it behind .browser."""
        target: Any = self._browser
        if target is None and self._context is not None:
            try:
                target = self._context.browser
            except Exception:  # noqa: BLE001
                target = None
        try:
            if target is not None:
                return target.executable_path
        except Exception:  # noqa: BLE001
            pass
        return bundled_executable(self.kind)
    def _launch_kwargs(self) -> dict[str, Any]:
        kwargs: dict[str, Any] = {"headless": self.headless}
        if self.kind == "chromium":
            if self.args:
                kwargs["args"] = self.args
            if self.env:
                kwargs["env"] = self.env
        if self.slow_mo:
            kwargs["slow_mo"] = self.slow_mo
        if self.executable_path:
            kwargs["executable_path"] = self.executable_path
        return kwargs

    @staticmethod
    def _translate(exc: Exception) -> Exception:
        message = str(exc)
        if "Executable doesn't exist" in message or "playwright install" in message:
            return BrowserNotInstalled(_INSTALL_HINT)
        return exc
    async def start_persistent(self, user_data_dir: str | Path, **options: Any) -> Any:
        """Launch the engine and its persistent context in one call."""
        directory = Path(user_data_dir)
        directory.mkdir(parents=True, exist_ok=True)
        try:
            self._context = await self.launcher.launch_persistent_context(
                str(directory), **self._launch_kwargs(), **options
            )
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc) from exc
        return self._context

    async def start(self) -> None:
        if self._browser is not None:
            return
        try:
            self._browser = await self.launcher.launch(**self._launch_kwargs())
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc) from exc

    async def new_context(self, **options: Any):
        if self._browser is None:
            raise RuntimeError("engine is not running")
        try:
            return await self._browser.new_context(**options)
        except Exception as exc:  # noqa: BLE001
            raise self._translate(exc) from exc

    async def stop(self) -> None:
        for target in (self._context, self._browser):
            if target is None:
                continue
            try:
                await target.close()
            except Exception as exc:  # noqa: BLE001
                log.debug("browser close reported: %s", exc)
        self._context = None
        self._browser = None


def bundled_executable(engine: str) -> str | None:
    """Find a Playwright-managed binary without importing the driver."""
    import os

    kind = engine if engine in ("chromium", "firefox") else "chromium"
    roots = []
    custom = os.environ.get("PLAYWRIGHT_BROWSERS_PATH")
    if custom and custom != "0":
        roots.append(Path(custom))
    roots.append(Path.home() / ".cache" / "ms-playwright")

    markers = {
        "chromium": (
            "chrome-linux64/chrome",
            "chrome-linux/chrome",
            "chrome-linux/headless_shell",
            "chrome-headless-shell-linux64/chrome-headless-shell",
            "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
        ),
        "firefox": ("firefox/firefox", "firefox/firefox-bin", "firefox/Nightly.app/Contents/MacOS/firefox"),
    }[kind]

    for root in roots:
        if not root.is_dir():
            continue
        for entry in sorted(root.iterdir(), reverse=True):
            if not entry.is_dir() or not entry.name.lower().startswith(kind[:4]):
                continue
            for marker in markers:
                candidate = entry / marker
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    return str(candidate)
    return None
