"""Scanner policy, port parsing and nmap flag sanitising."""

from __future__ import annotations

import pytest

from netops.config import ScannerPolicy
from netops.scanner import (
    ScanError,
    _flags_without_port_selection,
    parse_ports,
    validate_target,
)


@pytest.fixture
def policy() -> ScannerPolicy:
    return ScannerPolicy(
        allowed_targets=("127.0.0.1", "*.example.com"),
        allow_private_targets=True,
        max_ports=50,
    )


def test_parse_ports_ranges_and_lists():
    assert parse_ports("22,80,443", max_ports=50) == [22, 80, 443]
    assert parse_ports("8000-8003", max_ports=50) == [8000, 8001, 8002, 8003]
    assert parse_ports("22,80-82,443", max_ports=50) == [22, 80, 81, 82, 443]


@pytest.mark.parametrize("spec", ["", "0", "65536", "abc", "90-80", "22,,x"])
def test_parse_ports_rejects_bad_input(spec):
    with pytest.raises(ScanError):
        parse_ports(spec, max_ports=50)


def test_parse_ports_respects_policy_cap():
    with pytest.raises(ScanError, match="policy limit"):
        parse_ports("1-100", max_ports=10)


def test_validate_target_allows_listed_targets(policy):
    assert validate_target("127.0.0.1", policy) == "127.0.0.1"
    assert validate_target("api.example.com", policy) == "api.example.com"


def test_validate_target_blocks_unlisted(policy):
    with pytest.raises(ScanError, match="allowed_targets"):
        validate_target("evil.example.net", policy)


def test_empty_allowlist_blocks_everything():
    with pytest.raises(ScanError):
        validate_target("127.0.0.1", ScannerPolicy())


def test_private_targets_can_be_disabled():
    strict = ScannerPolicy(allowed_targets=("127.0.0.1",), allow_private_targets=False)
    with pytest.raises(ScanError, match="private addresses"):
        validate_target("127.0.0.1", strict)


def test_bad_hostname_rejected(policy):
    with pytest.raises(ScanError):
        validate_target("not a host!", policy)


def test_nmap_flags_do_not_conflict_with_explicit_ports():
    flags = ("-sT", "--top-ports", "100", "-T4")
    assert _flags_without_port_selection(flags) == ["-sT", "-T4"]
    assert _flags_without_port_selection(("-sT", "--top-ports=50")) == ["-sT"]


@pytest.mark.asyncio
async def test_builtin_scan_finds_open_listener(policy):
    import asyncio

    from netops.scanner import ScanRequest, tcp_scan

    server = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        result = await tcp_scan(ScanRequest(target="127.0.0.1", ports=str(port)), policy)
    assert port in result.open_ports
    assert result.engine == "builtin"
    assert result.as_dict()["open_count"] == 1


@pytest.mark.asyncio
async def test_builtin_scan_refuses_foreign_target(policy):
    from netops.scanner import ScanRequest, tcp_scan

    with pytest.raises(ScanError):
        await tcp_scan(ScanRequest(target="scanme.invalid.example", ports="22"), policy)


@pytest.mark.asyncio
async def test_scan_endpoint_reports_open_port(admin_client):
    import asyncio

    async def handler(reader, writer):
        writer.close()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    async with server:
        body = admin_client.post(
            "/api/scan/ports", json={"target": "127.0.0.1", "ports": str(port), "engine": "builtin"}
        ).json()
    assert body["open_count"] == 1
    assert body["open_ports"][0]["port"] == port


def test_scan_endpoint_blocks_unlisted_target(admin_client):
    response = admin_client.post(
        "/api/scan/ports", json={"target": "example.com", "ports": "80"}
    )
    assert response.status_code == 400
    assert "allowed_targets" in response.json()["detail"]


def test_scan_endpoint_requires_port_spec(admin_client):
    response = admin_client.post("/api/scan/ports", json={"target": "127.0.0.1", "ports": "70000"})
    assert response.status_code == 400
