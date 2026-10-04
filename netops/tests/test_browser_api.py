"""Browser API guards: auth, roles, and the "not running" contract.

No real engine is started here; the routes must refuse cleanly instead.
"""

from __future__ import annotations

import dataclasses

from fastapi.testclient import TestClient

BROWSER = "/api/browser"


def _operator_client(admin_client) -> TestClient:
    admin_client.post("/api/auth/signup", json={"username": "newbie", "password": "sup3rsecret2"})
    operator = TestClient(admin_client.app)
    assert operator.post(
        "/api/auth/login", json={"username": "newbie", "password": "sup3rsecret2"}
    ).status_code == 200
    return operator


def test_anonymous_cannot_touch_the_browser(client):
    for path in (f"{BROWSER}/status", f"{BROWSER}/tabs", f"{BROWSER}/cookies", f"{BROWSER}/theme"):
        assert client.get(path).status_code == 401


def test_status_reports_policy_and_limits_before_launch(admin_client):
    payload = admin_client.get(f"{BROWSER}/status").json()
    assert payload["running"] is False
    assert payload["policy"]["privacy"]["https_only"] is True
    assert payload["limits"]["max_tabs"] >= 1
    assert "available" in payload


def test_every_tab_route_requires_a_running_browser(admin_client):
    assert admin_client.get(f"{BROWSER}/tabs").status_code == 409
    assert admin_client.post(f"{BROWSER}/tabs", json={"url": "example.com"}).status_code == 409
    assert admin_client.post(f"{BROWSER}/tabs/abc/back").status_code == 409
    assert admin_client.delete(f"{BROWSER}/tabs/abc").status_code == 409
    assert admin_client.get(f"{BROWSER}/cookies").status_code == 409
    assert admin_client.get(f"{BROWSER}/cache").status_code == 409


def test_start_requires_an_admin(admin_client):
    operator = _operator_client(admin_client)
    assert operator.post(f"{BROWSER}/start", json={}).status_code == 403
    assert operator.post(f"{BROWSER}/stop").status_code == 403
    assert operator.post(f"{BROWSER}/cookies/export", json={}).status_code == 403
    assert operator.put(f"{BROWSER}/buttons/x", json={"label": "x", "action": "scan"}).status_code == 403


def _browser_policy(client, monkeypatch, **changes):
    """Swap in a different BrowserPolicy.

    BrowserPolicy is a frozen dataclass, so a field cannot be monkeypatched - the
    whole policy object is replaced, which is also how netops.toml would apply it.
    """
    config = client.app.state.config
    updated = dataclasses.replace(config, browser=dataclasses.replace(config.browser, **changes))
    monkeypatch.setattr(client.app.state, "config", updated)
    return updated


def _never_reachable_launch(client, monkeypatch):
    """Make any launch attempt fail, without depending on a module-level class."""
    monkeypatch.setattr(client.app.state.browser, "launch", _never_started, raising=False)


def test_require_headless_blocks_a_visible_window(client, monkeypatch):
    client.post("/api/auth/signup", json={"username": "admin", "password": "sup3rsecret1"})
    _browser_policy(client, monkeypatch, require_headless=True)
    _never_reachable_launch(client, monkeypatch)

    response = client.post(f"{BROWSER}/start", json={"headless": False})
    assert response.status_code == 400
    assert "require_headless" in response.json()["detail"]


async def _never_started(*_args, **_kwargs):
    # Bound onto the service *instance*, so there is no `self` to accept.
    return {"ok": False, "running": False, "error": "stubbed"}


def test_start_reports_engine_failures_as_service_unavailable(client, monkeypatch):
    client.post("/api/auth/signup", json={"username": "admin", "password": "sup3rsecret1"})
    _never_reachable_launch(client, monkeypatch)
    response = client.post(f"{BROWSER}/start", json={})
    assert response.status_code == 503
    assert response.json()["detail"] == "stubbed"


def test_disabled_browser_is_refused(client, monkeypatch):
    client.post("/api/auth/signup", json={"username": "admin", "password": "sup3rsecret1"})
    _browser_policy(client, monkeypatch, enabled=False)
    # A disabled browser answers 403 ("disabled in netops.toml") on every route
    # rather than 409 ("not running"), which would blame the wrong thing.
    assert client.post(f"{BROWSER}/start", json={}).status_code == 403
    assert client.post(f"{BROWSER}/tabs", json={"url": "example.com"}).status_code == 403
    assert client.get(f"{BROWSER}/status").status_code == 200


def test_themes_and_buttons_work_without_an_engine(admin_client):
    theme = admin_client.put(f"{BROWSER}/theme", json={"name": "forest", "mode": "dark"}).json()
    assert theme["theme"]["name"] == "forest"
    assert "#34d399" in theme["css"]

    bad = admin_client.put(f"{BROWSER}/theme", json={"font_size": 99})
    assert bad.status_code == 400

    site = admin_client.put(f"{BROWSER}/theme/site/news.test", json={"reader_mode": True})
    assert site.status_code == 200
    assert admin_client.get(f"{BROWSER}/theme/sites").json()["sites"][0]["host"] == "news.test"
    assert admin_client.delete(f"{BROWSER}/theme/site/news.test").status_code == 200

    saved = admin_client.put(
        f"{BROWSER}/buttons/scan", json={"label": "Scan", "action": "scan"}
    ).json()
    assert saved["buttons"]["scan"]["action"] == "scan"
    assert admin_client.delete(f"{BROWSER}/buttons/scan").json()["buttons"] == {}


def test_url_check_normalises_and_reports_blocking(admin_client):
    payload = admin_client.get(f"{BROWSER}/check", params={"url": "example.com"}).json()
    assert payload["url"] == "https://example.com"
    assert payload["allowed"] is True

    blocked = admin_client.get(
        f"{BROWSER}/check", params={"url": "https://www.google-analytics.com/collect"}
    ).json()
    assert blocked["blocked_pattern"] == "google-analytics.com"

    assert admin_client.get(f"{BROWSER}/check", params={"url": "file:///etc/passwd"}).status_code == 400


def test_health_includes_the_browser_state(client):
    client.post("/api/auth/signup", json={"username": "admin", "password": "sup3rsecret1"})
    health = client.get("/api/health").json()
    assert health["browser_running"] is False
    assert health["ok"] is True
