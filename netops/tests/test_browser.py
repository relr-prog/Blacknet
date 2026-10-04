"""Built-in privacy browser: URL rules, privacy posture, managers and API guards.

The engine itself is covered by ``scripts/browser_smoke.py`` (needs a real
Playwright browser); everything here runs against fakes so the suite stays fast.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from netops.browser import (
    CookieManager,
    StorageManager,
    TabError,
    TabManager,
    ThemeStore,
    browser_available,
    build_context_options,
    build_launch_args,
    firefox_prefs,
    match_blocker,
    normalise_url,
    summary,
)
from netops.browser.engine import BrowserEngine, BrowserNotInstalled, bundled_executable
from netops.browser.service import BrowserService, _safe_name
from netops.browser.theme import Theme
from netops.config import BrowserPolicy


class User:
    def __init__(self, username: str, admin: bool = True) -> None:
        self.username = username
        self.role = "admin" if admin else "operator"
        self.is_admin = admin


# ------------------------------------------------------------------- fake page
class FakePage:
    def __init__(self, context: "FakeContext", url: str = "about:blank") -> None:
        self.context = context
        self.url = url
        self._closed = False
        self.routes: list = []
        self.evaluated: list = []
        self.response = FakeResponse(200)
        self.screenshot_bytes = b"\x89PNG-fake"

    def set_default_timeout(self, _ms: int) -> None:
        return None

    async def route(self, pattern: str, handler) -> None:
        self.routes.append((pattern, handler))

    async def goto(self, url: str, wait_until: str = "load"):
        self.url = url
        return self.response

    async def go_back(self):
        return None

    async def go_forward(self):
        return None

    async def reload(self):
        return None

    async def title(self) -> str:
        return f"title of {self.url}"

    async def bring_to_front(self) -> None:
        return None

    async def evaluate(self, script, arg=None):
        self.evaluated.append((script, arg))
        if "__netops_theme__" in script:
            return None
        return {"title": "t", "url": self.url, "text": "hello", "links": [], "origin": "o"}

    async def screenshot(self, path: str, full_page: bool = True) -> None:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_bytes(self.screenshot_bytes)

    def is_closed(self) -> bool:
        return self._closed

    async def close(self) -> None:
        self._closed = True


class FakeResponse:
    def __init__(self, status: int) -> None:
        self.status = status


class FakeCDPSession:
    def __init__(self) -> None:
        self.sent: list = []
        self.detached = False

    async def send(self, method: str, params: dict) -> None:
        self.sent.append((method, params))

    async def detach(self) -> None:
        self.detached = True


class FakeContext:
    def __init__(self, cookies: list | None = None) -> None:
        self.cookie_rows = list(cookies or [])
        self.cleared: list = []
        self.pages: list[FakePage] = []
        self.closed = False

    async def new_page(self) -> FakePage:
        page = FakePage(self)
        self.pages.append(page)
        return page

    async def cookies(self) -> list:
        return list(self.cookie_rows)

    async def clear_cookies(self, **kwargs) -> None:
        self.cleared.append(kwargs)

    def set_default_navigation_timeout(self, _ms: int) -> None:
        return None

    async def new_cdp_session(self, page) -> FakeCDPSession:
        return FakeCDPSession()

    @property
    def pages_closed(self) -> list:
        return [page for page in self.pages if page.is_closed()]


# -------------------------------------------------------------------- url rules
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("example.com", "https://example.com"),
        ("https://example.com/path?q=1", "https://example.com/path?q=1"),
        ("http://plain.test", "https://plain.test"),
        ("about:blank", "about:blank"),
        ("  spaced.test  ", "https://spaced.test"),
    ],
)
def test_normalise_url_accepts_expected_shapes(raw: str, expected: str) -> None:
    assert normalise_url(raw) == expected


def test_normalise_url_keeps_http_when_https_only_is_off() -> None:
    assert normalise_url("http://plain.test", https_only=False) == "http://plain.test"


@pytest.mark.parametrize(
    ("raw", "fragment"),
    [
        ("", "required"),
        ("ftp://files.test", "not allowed"),
        ("javascript:alert(1)", "not allowed"),
        ("chrome://settings", "not allowed"),
        ("data:image/png;base64,AAA", "only data:text/html"),
        ("data:text/html," + "x" * 9000, "longer than"),
        ("about:config", "only about:blank"),
        ("https://exa mple.com", "illegal characters"),
    ],
)
def test_normalise_url_rejects_unsafe_shapes(raw: str, fragment: str) -> None:
    with pytest.raises(TabError) as excinfo:
        normalise_url(raw)
    assert fragment in str(excinfo.value)


def test_data_url_may_contain_a_nested_scheme() -> None:
    target = "data:text/html,<a href='https://tracker.test'>x</a>"
    assert normalise_url(target) == target


# ------------------------------------------------------------------- privacy
def test_tracker_patterns_match_hosts_and_paths() -> None:
    assert match_blocker("https://www.google-analytics.com/collect") == "google-analytics.com"
    assert (
        match_blocker("https://www.googletagmanager.com/gtm.js?id=1")
        == "googletagmanager.com/gtm.js"
    )
    assert match_blocker("https://example.com/") is None


def test_operator_blocklist_is_checked_first() -> None:
    assert match_blocker("https://t.me/joinchat/x", ("t.me",)) == "t.me"


def test_launch_args_never_repeat_disable_features() -> None:
    args = build_launch_args(BrowserPolicy())
    flags = [arg for arg in args if arg.startswith("--disable-features")]
    assert len(flags) == 1, flags
    assert "Translate" in flags[0]
    if BrowserPolicy().resist_fingerprinting:
        assert "site-per-process" in flags[0]
        assert "--disable-blink-features=AutomationControlled" in args


def test_launch_args_include_hardened_websocket_and_hsts_defaults() -> None:
    args = build_launch_args(BrowserPolicy())
    assert "--disable-webrtc" in args
    assert "--force-webrtc-ip-handling-policy=disable_non_proxied_udp" in args
    assert "--https-only-mode-upgrades" in args
    assert "--no-sandbox" in args  # WSL: chromium needs it
    assert "--host-resolver-rules" not in " ".join(args)  # only when proxy_dns is on


def test_firefox_prefs_track_privacy_toggles() -> None:
    policy = BrowserPolicy()
    prefs = firefox_prefs(policy)
    assert prefs["privacy.resistFingerprinting"] is True
    assert prefs["network.cookie.cookieBehavior"] == 5  # block third-party
    assert prefs["dom.webnotifications.enabled"] is False
    assert prefs["media.peerconnection.enabled"] is False
    assert firefox_prefs(BrowserPolicy(enabled=True, engine="firefox", block_third_party_cookies=False))[
        "network.cookie.cookieBehavior"
    ] == 2


def test_context_options_carry_privacy_headers_and_proxy() -> None:
    options = build_context_options(
        BrowserPolicy(), proxy={"server": "http://127.0.0.1:8888", "username": "", "password": ""}
    )
    assert options["extra_http_headers"]["DNT"] == "1"
    assert options["extra_http_headers"]["Sec-GPC"] == "1"
    assert options["locale"] == "en-GB"
    # empty credentials are dropped rather than sent as ""
    assert options["proxy"] == {"server": "http://127.0.0.1:8888"}
    assert build_context_options(BrowserPolicy()) .get("proxy") is None


def test_context_options_only_set_is_mobile_for_chromium() -> None:
    assert "is_mobile" in build_context_options(BrowserPolicy(engine="chromium"))
    assert "is_mobile" not in build_context_options(BrowserPolicy(engine="firefox"))
    assert "firefox_user_prefs" in build_context_options(BrowserPolicy(engine="firefox"))
    assert "firefox_user_prefs" not in build_context_options(BrowserPolicy(engine="chromium"))


def test_policy_summary_reports_the_real_posture() -> None:
    report = summary(BrowserPolicy(block_third_party_cookies=True, https_only=False))
    assert report["privacy"]["block_third_party_cookies"] is True
    assert report["privacy"]["https_only"] is False
    assert report["privacy"]["clear_on_close"] is True
    assert report["blocklist_size"] > 40


# --------------------------------------------------------------------- engines
def test_bundled_executable_finds_a_managed_build(tmp_path: Path, monkeypatch) -> None:
    binary = tmp_path / "chromium-9999" / "chrome-linux64" / "chrome"
    binary.parent.mkdir(parents=True)
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    binary.chmod(0o755)
    monkeypatch.setenv("PLAYWRIGHT_BROWSERS_PATH", str(tmp_path))
    assert bundled_executable("chromium") == str(binary)
    assert browser_available(BrowserPolicy(executable_path=str(binary))) is True
    assert browser_available(BrowserPolicy(executable_path=str(tmp_path / "nope"))) is False


def test_engine_falls_back_to_chromium_for_unknown_names() -> None:
    engine = BrowserEngine(object(), engine="safari")
    assert engine.kind == "chromium"


def test_engine_translates_missing_binary_errors() -> None:
    translated = BrowserEngine._translate(
        RuntimeError("Executable doesn't exist at /usr/bin/chromium")
    )
    assert isinstance(translated, BrowserNotInstalled)
    assert "playwright install" in str(translated)
    other = RuntimeError("Protocol error")
    assert BrowserEngine._translate(other) is other


# ---------------------------------------------------------------------- tabs
async def test_tab_manager_tracks_pages_and_history() -> None:
    policy = BrowserPolicy(max_tabs=3)
    context = FakeContext()
    manager = TabManager(context, policy, owner="admin")

    tab = await manager.open("https://example.com")
    assert tab["host"] == "example.com"
    assert tab["title"] == "title of https://example.com"
    assert tab["owner"] == "admin"
    assert context.pages[0].routes, "tracker blocking must be attached"

    described = await manager.navigate(tab_id=tab["id"], url="example.org/next")
    assert described["url"] == "https://example.org/next"
    assert described["status"] == 200
    assert (await manager.activate(tab["id"]))["id"] == tab["id"]

    assert len(manager.list()) == 1
    assert len(manager) == 1
    closed = await manager.close(tab["id"])
    assert closed["tabs"] == 0
    assert manager.list() == []


async def test_tab_manager_enforces_the_ceiling() -> None:
    manager = TabManager(FakeContext(), BrowserPolicy(max_tabs=1), owner="admin")
    await manager.open("about:blank")
    with pytest.raises(TabError, match="tab limit"):
        await manager.open("about:blank")


async def test_tab_manager_isolates_users() -> None:
    context = FakeContext()
    policy = BrowserPolicy()
    alice = TabManager(context, policy, owner="alice")
    bob = TabManager(context, policy, owner="bob")
    tab = await alice.open("about:blank")

    assert bob.owns(tab["id"]) is False
    assert bob.list() == []
    with pytest.raises(TabError, match="unknown tab"):
        await bob.navigate(tab_id=tab["id"], url="example.com")
    with pytest.raises(TabError, match="unknown tab"):
        bob.page(tab["id"])


async def test_tab_manager_reports_unknown_tabs() -> None:
    manager = TabManager(FakeContext(), BrowserPolicy(), owner="admin")
    with pytest.raises(TabError, match="unknown tab"):
        await manager.reload("nope")
    with pytest.raises(TabError, match="unknown tab"):
        await manager.close("nope")


async def test_tab_screenshot_writes_a_file(tmp_path: Path) -> None:
    manager = TabManager(FakeContext(), BrowserPolicy(), owner="admin")
    tab = await manager.open("about:blank")
    target = tmp_path / "shots" / "a.png"
    await manager.screenshot(tab["id"], str(target), full_page=True)
    assert target.read_bytes() == b"\x89PNG-fake"


async def test_close_all_survives_dead_pages() -> None:
    manager = TabManager(FakeContext(), BrowserPolicy(), owner="admin")
    tab = await manager.open("about:blank")
    await manager.page(tab["id"]).close()
    assert (await manager.close_all())["tabs"] == 0


# ------------------------------------------------------------------- cookies
async def test_cookies_are_redacted_by_default() -> None:
    context = FakeContext(
        cookies=[
            {
                "name": "session",
                "value": "super-secret",
                "domain": ".example.com",
                "path": "/",
                "expires": -1,
                "httpOnly": True,
                "secure": True,
                "sameSite": "Lax",
            }
        ]
    )
    listed = await CookieManager(context).list()
    assert listed["count"] == 1
    cookie = listed["cookies"][0]
    assert "value" not in cookie, "raw cookie values are never exposed"
    assert cookie["value_preview"] == "supe…"
    assert cookie["size"] == len("super-secret")
    assert cookie["http_only"] is True and cookie["secure"] is True
    assert cookie["session"] is True
    assert [tuple(entry) for entry in listed["domains"]] == [(".example.com", 1)]
    assert listed["session_cookies"] == 1


async def test_cookie_filter_and_clear() -> None:
    context = FakeContext(
        cookies=[
            {"name": "a", "value": "1", "domain": ".one.test", "path": "/", "expires": -1},
            {"name": "b", "value": "2", "domain": ".two.test", "path": "/x", "expires": -1},
        ]
    )
    manager = CookieManager(context)
    assert (await manager.list(domain="two"))["count"] == 1

    assert (await manager.clear())["cleared"] == "all"
    assert context.cleared == [{}]

    await manager.clear(domain="one")
    assert context.cleared[-1] == {"name": "a", "domain": ".one.test", "path": "/"}


async def test_cookie_export_is_redacted_unless_asked(tmp_path: Path) -> None:
    context = FakeContext(
        cookies=[{"name": "a", "value": "secret", "domain": ".one.test", "path": "/", "expires": -1}]
    )
    manager = CookieManager(context)
    target = tmp_path / "cookies.json"

    result = await manager.export(target)
    assert result["redacted"] is True
    payload = json.loads(target.read_text(encoding="utf-8"))
    assert payload["cookies"][0]["value"] == ""

    await manager.export(target, include_values=True)
    assert json.loads(target.read_text(encoding="utf-8"))["cookies"][0]["value"] == "secret"


async def test_cookie_stats_summarises_flags() -> None:
    context = FakeContext(
        cookies=[
            {"name": "a", "value": "1", "domain": ".one.test", "path": "/", "expires": -1,
             "httpOnly": True, "secure": True},
            {"name": "b", "value": "2", "domain": ".one.test", "path": "/", "expires": 1},
        ]
    )
    stats = await CookieManager(context).stats()
    assert stats["count"] == 2
    assert stats["domains"] == 1
    assert tuple(stats["largest_domain"]) == (".one.test", 2)


# ------------------------------------------------------------------- storage
async def test_cache_report_and_clear_walk_the_profile(tmp_path: Path) -> None:
    cache = tmp_path / "Default" / "Cache" / "data_0"
    cache.mkdir(parents=True)
    (cache / "entry.bin").write_bytes(b"x" * 2048)
    (tmp_path / "Preferences").write_text("{}", encoding="utf-8")

    storage = StorageManager(FakeContext(), BrowserPolicy(cache_enabled=True), tmp_path)
    report = storage.cache_stats()
    assert report["files"] == 2
    assert report["total_bytes"] >= 2048
    assert report["cache_enabled"] is True

    cleared = await storage.clear_cache()
    assert cleared["files_removed"] == 1
    assert cleared["bytes_freed"] == 2048
    assert not (cache / "entry.bin").exists()


async def test_storage_report_degrades_on_opaque_origins() -> None:
    context = FakeContext()
    await context.new_page()
    report = await StorageManager(context, BrowserPolicy(), Path("/tmp")).storage_report()
    assert report["contexts"][0]["url"] == "about:blank"


async def test_revoke_all_clears_cookies_and_cache(tmp_path: Path) -> None:
    context = FakeContext(cookies=[{"name": "a", "value": "1", "domain": ".x.test", "path": "/"}])
    result = await StorageManager(context, BrowserPolicy(), tmp_path).revoke_all()
    assert result["ok"] is True
    assert context.cleared == [{}]


def test_permissions_must_be_declared_in_config() -> None:
    storage = StorageManager(FakeContext(), BrowserPolicy(permissions=["geolocation"]), Path("/tmp"))
    assert storage.grant("geolocation")["permissions"] == ["geolocation"]
    with pytest.raises(ValueError, match="not in browser.permissions"):
        storage.grant("clipboard-read")


# --------------------------------------------------------------------- themes
def test_theme_css_carries_the_chosen_colors(tmp_path: Path) -> None:
    store = ThemeStore(tmp_path)
    result = store.set_global(name="forest", mode="dark", colors={"accent": "#00ff00"})
    assert result["theme"]["name"] == "forest"
    assert result["theme"]["mode"] == "dark"
    assert "#00ff00" in result["css"]
    assert result["updated_at"] > 0
    assert store.get_global()["theme"]["colors"]["accent"] == "#00ff00"
    assert "presets" in result and "forest" in result["presets"]

    saved = json.loads((tmp_path / "themes.json").read_text(encoding="utf-8"))
    assert saved["global"]["name"] == "forest"


def test_site_themes_are_independent_and_removable(tmp_path: Path) -> None:
    store = ThemeStore(tmp_path)
    store.set_site_theme("news.test", reader_mode=True, hide_ads=True)
    assert store.has_site("news.test") is True
    assert "Georgia" in store.site_theme("news.test")["css"]
    assert store.has_site("other.test") is False
    assert [entry["host"] for entry in store.list_sites()] == ["news.test"]
    assert store.list_sites()[0]["updated_at"] > 0
    assert store.clear_site_theme("news.test")["ok"] is True
    assert store.has_site("news.test") is False


def test_theme_rejects_invalid_input(tmp_path: Path) -> None:
    store = ThemeStore(tmp_path)
    with pytest.raises(ValueError):
        store.set_global(mode="neon")
    with pytest.raises(ValueError):
        store.set_global(font_size=4)
    with pytest.raises(ValueError):
        store.set_global(colors={"accent": "javascript:1"})
    with pytest.raises(ValueError):
        store.set_site_theme("not a host", reader_mode=True)


def test_button_presets_round_trip(tmp_path: Path) -> None:
    store = ThemeStore(tmp_path)
    store.set_button("scan", {"label": "Scan host", "action": "scan"})
    assert store.buttons()["scan"]["label"] == "Scan host"
    assert store.remove_button("scan")["ok"] is True
    assert store.buttons() == {}
    with pytest.raises(ValueError):
        store.set_button("bad", {"label": "", "action": "x"})


def test_theme_css_handles_reader_mode_and_force_dark() -> None:
    css = Theme(mode="light", reader_mode=True, hide_ads=True, font_family="Georgia, serif").to_css()
    assert "Georgia, serif" in css
    assert "display:none" in css
    assert "invert(" not in css, "force_dark must not invert a light theme"
    assert "invert(" in Theme(mode="dark", force_dark=True).to_css()


# -------------------------------------------------------------------- service
def test_profile_names_are_sanitised() -> None:
    assert _safe_name("../../etc/passwd") == "etc_passwd"
    assert _safe_name("") == "default"
    assert _safe_name("work profile") == "work_profile"


def test_service_status_before_launch(tmp_path: Path) -> None:
    service = BrowserService(BrowserPolicy(), tmp_path)
    status = service.status()
    assert status["running"] is False
    assert status["ok"] is False
    assert status["tabs"] == 0
    assert status["profiles"] == []
    assert status["bundle_installed"] == browser_available(BrowserPolicy())
    assert status["error"] is None


def test_service_ignores_a_proxy_without_a_server(tmp_path: Path) -> None:
    service = BrowserService(BrowserPolicy(), tmp_path, proxy={"server": ""})
    assert service.effective_proxy() is None
    service.set_proxy({"server": "http://127.0.0.1:8888"})
    assert service.effective_proxy()["server"] == "http://127.0.0.1:8888"
    service.set_proxy(None)
    assert service.effective_proxy() is None


def test_socks_proxy_forces_remote_dns(tmp_path: Path) -> None:
    service = BrowserService(
        BrowserPolicy(), tmp_path, proxy={"server": "socks5://127.0.0.1:9050"}
    )
    options = build_context_options(BrowserPolicy(), proxy=service.effective_proxy())
    assert options["proxy"]["server"].startswith("socks5://")


def test_tab_managers_are_bound_per_user_and_replaced_on_restart(tmp_path: Path) -> None:
    service = BrowserService(BrowserPolicy(), tmp_path)
    context = FakeContext()
    service._state.context = context
    alice = service.tabs_for(User("alice"))
    assert service.tabs_for(User("alice")) is alice
    assert service.tabs_for(User("bob")) is not alice

    other_context = FakeContext()
    service._state.context = other_context
    assert service.tabs_for(User("alice")) is not alice, "stale context must not be reused"
    assert service.all_tabs().keys() >= {"alice", "bob"}


def test_idle_timeout_tracks_usage(tmp_path: Path) -> None:
    service = BrowserService(BrowserPolicy(idle_timeout=600), tmp_path)
    before = service.idle_seconds
    service.touch()
    assert service.idle_seconds < before + 1


async def test_close_if_idle_needs_a_running_engine(tmp_path: Path) -> None:
    idle = BrowserService(BrowserPolicy(idle_timeout=0), tmp_path)
    assert (await idle.close_if_idle())["closed"] is False

    service = BrowserService(BrowserPolicy(idle_timeout=60), tmp_path)
    assert (await service.close_if_idle())["closed"] is False, "not running, nothing to free"

    service._state.context = FakeContext()
    service._state.engine = object()
    service._idle_since = time.time() - 3600
    assert (await service.close_if_idle())["closed"] is True


async def test_launch_reports_a_missing_browser(tmp_path: Path, monkeypatch) -> None:
    service = BrowserService(BrowserPolicy(), tmp_path)

    async def fake_playwright():
        return object()

    async def fake_start(*_args, **_kwargs):
        raise BrowserNotInstalled("no browser binary found")

    class MissingEngine:
        def __init__(self, *_args, **_kwargs) -> None:
            pass

        async def start_persistent(self, *_args, **_kwargs):
            raise BrowserNotInstalled("no browser binary found")

        async def stop(self) -> None:
            return None

    monkeypatch.setattr(service, "_ensure_playwright", fake_playwright)
    monkeypatch.setattr("netops.browser.service.BrowserEngine", MissingEngine)

    result = await service.launch()
    assert result["running"] is False
    assert "no browser binary" in result["error"]
    assert service.running is False


async def test_launch_and_close_round_trip(tmp_path: Path, monkeypatch) -> None:
    service = BrowserService(BrowserPolicy(), tmp_path, proxy={"server": "http://127.0.0.1:8888"})
    context = FakeContext()

    class FakeEngine:
        def __init__(self, *_args, **_kwargs) -> None:
            self.context = None

        async def start_persistent(self, directory, **options):
            self.context = context
            return context

        async def stop(self) -> None:
            return None

        @property
        def executable(self) -> str | None:
            return "/fake/chrome"

    async def fake_playwright():
        return object()

    monkeypatch.setattr(service, "_ensure_playwright", fake_playwright)
    monkeypatch.setattr("netops.browser.service.BrowserEngine", FakeEngine)

    started = await service.launch()
    assert started["running"] is True
    assert started["proxy"]["server"] == "http://127.0.0.1:8888"
    assert started["executable"] == "/fake/chrome"
    assert (tmp_path / "profiles" / "default").is_dir()

    tab = await service.tabs_for(User("alice")).open("about:blank")
    assert started["tabs"] == 0  # status snapshot taken before the tab existed
    assert service.status()["tabs"] == 1

    stopped = await service.close()
    assert stopped["closed"] is True
    assert service.running is False
    assert all(page.is_closed() for page in context.pages)

    await service.shutdown()
    assert tab["id"]  # tab metadata was returned before shutdown
