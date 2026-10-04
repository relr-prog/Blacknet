"""Dashboard API: monitoring payload, audit trail, rotator pool management."""

from __future__ import annotations

import socket

from netops.config import load_config


def test_health_endpoint(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["users"] == 0


def test_overview_shape(admin_client):
    body = admin_client.get("/api/monitor/overview").json()
    assert body["user"]["username"] == "admin"
    assert set(body["system"]) >= {"cpu_percent", "memory", "uptime_seconds"}
    assert body["host"]["hostname"]
    assert body["scanner"]["allowed_targets"] == ["127.0.0.1", "localhost"]
    assert body["rotator"]["running"] is False


def test_monitor_system_lists_processes_and_disks(admin_client):
    body = admin_client.get("/api/monitor/system").json()
    assert body["processes"], "expected at least one process"
    assert body["disks"], "expected at least one mounted disk"


def test_rotator_lifecycle_and_pool_edits(admin_client, netops_config):
    config = load_config(netops_config)

    started = admin_client.post("/api/rotator/start").json()
    assert started["ok"], started
    assert started["running"] is True
    assert len(started["upstreams"]) == 4  # 3 from the pool file + 1 inline socks5

    listener = started["listeners"]["http"]
    host, port = listener.rsplit(":", 1)
    with socket.socket() as probe:
        probe.settimeout(3)
        assert probe.connect_ex((host, int(port))) == 0

    status = admin_client.get("/api/rotator/status").json()
    assert status["running"] is True

    added = admin_client.post(
        "/api/rotator/upstreams", json={"line": "127.0.0.1:19999:user:pass", "tier": 2}
    ).json()
    assert added["ok"], added
    ids = [u["id"] for u in admin_client.get("/api/rotator/status").json()["upstreams"]]
    assert added["upstream"]["id"] in ids

    target = added["upstream"]["id"]
    assert admin_client.post(
        f"/api/rotator/upstreams/{target}/slots", json={"max_slots": 3}
    ).json()["ok"]
    assert admin_client.post(
        f"/api/rotator/upstreams/{target}/quarantine?seconds=30"
    ).json()["ok"]

    removed = admin_client.delete(f"/api/rotator/upstreams/{target}").json()
    assert removed["ok"] and removed["removed"] is True

    bad = admin_client.post("/api/rotator/upstreams", json={"line": "nonsense"}).json()
    assert bad["ok"] is False

    assert admin_client.post("/api/rotator/stop").json()["ok"]
    stopped = admin_client.get("/api/rotator/status").json()
    assert stopped["running"] is False


def test_strategy_switch_is_persisted(admin_client):
    ok = admin_client.post("/api/rotator/strategy?strategy=fastest").json()
    assert ok["ok"] and ok["strategy"] == "fastest"
    assert admin_client.get("/api/rotator/status").json()["configured_strategy"] == "fastest"

    bad = admin_client.post("/api/rotator/strategy?strategy=nonsense").json()
    assert bad["ok"] is False


def test_burp_export_lists_authenticated_upstreams(admin_client):
    admin_client.post("/api/rotator/start")
    export = admin_client.get("/api/rotator/export/burp").json()
    assert export["count"] >= 1
    assert any("127.0.0.1" in line for line in export["proxy_list_lines"])
    assert export["burp_steps"]
    admin_client.post("/api/rotator/stop")


def test_pool_overrides_survive_restart(admin_client):
    admin_client.post("/api/rotator/start")
    admin_client.post("/api/rotator/upstreams", json={"line": "127.0.0.1:19998", "tier": 3})
    admin_client.post("/api/rotator/restart")
    upstreams = admin_client.get("/api/rotator/status").json()["upstreams"]
    assert any(u["tier"] == 3 for u in upstreams)
    admin_client.post("/api/rotator/upstreams/restore")
    admin_client.post("/api/rotator/stop")


def test_audit_records_actions(admin_client):
    admin_client.post("/api/scan/ports", json={"target": "example.com", "ports": "80"})
    entries = admin_client.get("/api/monitor/audit").json()["entries"]
    assert entries, "audit log should not be empty"
    assert entries[0]["username"] == "admin"
    assert any(entry["outcome"] == "denied" for entry in entries)
    mine = admin_client.get("/api/monitor/audit?mine=true").json()["entries"]
    assert mine and all(entry["username"] == "admin" for entry in mine)


def test_tools_catalogue_lists_availability(admin_client):
    body = admin_client.get("/api/tools").json()
    names = {tool["name"] for tool in body["tools"]}
    assert {"dns", "ping", "traceroute", "whois", "tls", "headers", "hash"} <= names


def test_hash_tool_runs(admin_client):
    body = admin_client.post("/api/tools/hash", json={"data": "hunter2", "algorithm": "sha256"}).json()
    digest = body["result"]
    assert digest["algorithm"] == "sha256"
    assert digest["length"] == 7
    assert digest["hex"] == (
        "f52fbd32b2b3b86ff88ef6c490628285f482af15ddcb29541f94bcf526a3f6c7"
    )
    assert digest["entropy"] > 1.5


def test_unknown_tool_is_rejected(admin_client):
    assert admin_client.post("/api/tools/nope", json={}).status_code == 400


def test_tls_tool_reports_certificate(admin_client):
    response = admin_client.post(
        "/api/tools/tls", json={"host": "example.com", "port": 443}
    )
    if response.status_code == 200:
        result = response.json()["result"]
        assert result.get("issuer") or result.get("error")
    else:
        assert response.status_code == 400


def test_service_list_respects_allowlist(admin_client):
    body = admin_client.get("/api/server/services").json()
    units = {row["unit"] for row in body["services"]}
    assert units == {"tor.service", "ssh.service"}

    denied = admin_client.post(
        "/api/server/services", json={"unit": "cron.service", "action": "restart"}
    ).json()
    assert denied["ok"] is False
    assert "allowlist" in denied["error"]


def test_ip_lookup_validates_input(admin_client):
    assert admin_client.get("/api/ip/lookup?ip=not-an-ip").status_code == 400
    body = admin_client.get("/api/ip/lookup?ip=127.0.0.1").json()
    assert body["ip"] == "127.0.0.1"
    assert body["is_private"] is True
    assert body["version"] == 4


def test_security_headers_present(client):
    response = client.get("/api/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert "default-src 'none'" in response.headers["Content-Security-Policy"]


def test_static_dashboard_is_served(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "netops" in response.text
    assert client.get("/static/app.js").status_code == 200
