"""Manual smoke test for the built-in privacy browser (run outside pytest).

    ./.venv/bin/python scripts/browser_smoke.py
"""

from __future__ import annotations

import asyncio
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from netops.browser import (  # noqa: E402
    BrowserService,
    CookieManager,
    StorageManager,
    ThemeStore,
    apply_theme,
    browser_available,
    find_system_browser,
    normalise_url,
    summary,
)
from netops.browser.privacy import build_launch_args, firefox_prefs, match_blocker  # noqa: E402
from netops.config import BrowserPolicy  # noqa: E402


class FakeUser:
    username = "admin"
    role = "admin"
    is_admin = True


class OtherUser:
    username = "operator"
    role = "operator"
    is_admin = False


async def run() -> int:
    policy = BrowserPolicy()
    print("bundled engine available:", browser_available(policy))
    print("system browser:", find_system_browser())
    print("launch flags:", len(build_launch_args(policy)), "firefox prefs:", len(firefox_prefs(policy)))
    print("tracker match:", match_blocker("https://www.google-analytics.com/collect"))

    service = BrowserService(policy, pathlib.Path(tempfile.mkdtemp()))
    status = await service.launch()
    print("launch:", {key: status.get(key) for key in ("ok", "running", "engine", "error")})
    if not status.get("running"):
        return 1
    print("executable:", status["executable"])

    tabs = service.tabs_for(FakeUser())
    tab = await tabs.open("data:text/html,<h1>hello privacy</h1><a href='https://example.com'>link</a>")
    print("tab:", {key: tab.get(key) for key in ("id", "url", "title", "owner")})
    print("tabs listed:", len(tabs.list()))

    other = service.tabs_for(OtherUser())
    print("other user sees tabs:", len(other.list()), "| owns tab:", other.owns(tab["id"]))
    try:
        await other.navigate(tab_id=tab["id"], url="https://example.org")
    except Exception as exc:  # noqa: BLE001
        print("cross-user navigate blocked:", type(exc).__name__, exc)

    cookies = CookieManager(service._state.context)
    print("cookies:", await cookies.stats())

    storage = StorageManager(service._state.context, policy, service.profile_dir())
    report = storage.cache_stats()
    print("cache files:", report["files"], "bytes:", report["total_bytes"])
    print("storage report:", await storage.storage_report())

    store = ThemeStore(service.data_dir)
    global_theme = store.set_global(name="forest", mode="dark")
    print("global css lines:", len(global_theme["css"].splitlines()))
    site = store.set_site_theme("example.com", reader_mode=True)
    print("site css has reader font:", "Georgia" in site["css"])
    await apply_theme(tabs.page(tab["id"]), global_theme["css"])
    themed = await tabs.page(tab["id"]).evaluate("() => !!document.getElementById('__netops_theme__')")
    print("theme injected into page:", themed)
    print("button:", store.set_button("scan-self", {"label": "Scan self", "action": "scan"})["scan-self"])

    shot = service.data_dir / "shots" / "smoke.png"
    await tabs.screenshot(tab["id"], str(shot))
    print("screenshot bytes:", shot.stat().st_size)

    print("url normalisation:", normalise_url("example.com"), normalise_url("http://a.test/x"))
    print("policy summary engine:", summary(policy)["engine"])

    await service.close()
    await service.shutdown()
    print("closed, running:", service.running)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(run()))
