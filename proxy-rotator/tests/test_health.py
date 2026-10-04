from __future__ import annotations

import json

from rotator.health import HealthChecker, HealthConfig
from rotator.models import parse_upstream_line
from rotator.pool import Pool
from rotator.state import UpstreamState

from helpers import http_upstream, next_loopback, origin


def state_for(endpoint, **kwargs) -> UpstreamState:
    spec = parse_upstream_line(f"http://{endpoint.host}:{endpoint.port}")
    return UpstreamState(spec=spec, **kwargs)


def checker_for(states, url: str) -> HealthChecker:
    return HealthChecker(
        Pool(states), HealthConfig(url=url, startup_delay=0, resolve_geo=False, timeout=5)
    )


async def test_probe_learns_exit_ip_and_latency():
    async with origin("probe") as target, http_upstream(next_loopback()) as ep:
        state = state_for(ep)
        checker = checker_for([state], f"http://{target.host}:{target.port}/ip")
        assert await checker.check_one(state) is True
        assert state.exit_ip == ep.host
        assert state.latency is not None and state.latency > 0
        assert state.healthy is True
        assert state.total_success == 1


async def test_probe_failure_marks_the_upstream_unhealthy():
    dead = UpstreamState(spec=parse_upstream_line("http://127.0.0.1:1"))
    checker = checker_for([dead], "http://127.0.0.1:1/")
    assert await checker.check_one(dead) is False
    assert dead.healthy is False
    assert dead.last_error


async def test_check_once_counts_healthy_upstreams():
    async with origin("probe2") as target, http_upstream(next_loopback()) as good_ep, \
            http_upstream(next_loopback(), fail=True) as bad_ep:
        good, bad = state_for(good_ep), state_for(bad_ep)
        checker = checker_for([good, bad], f"http://{target.host}:{target.port}/ip")
        assert await checker.check_once() == 1
        assert good.healthy is True
        assert bad.healthy is False


async def test_recovery_clears_quarantine():
    async with origin("probe3") as target, http_upstream(next_loopback()) as ep:
        state = state_for(ep)
        state.note_failure("temporary glitch", quarantine_secs=0.0)
        assert state.healthy is False
        checker = checker_for([state], f"http://{target.host}:{target.port}/ip")
        assert await checker.check_one(state) is True
        assert state.healthy is True
        assert state.consecutive_failures == 0


async def test_exit_ip_is_learned_from_a_real_endpoint():
    async with origin("probe4") as target, http_upstream(next_loopback()) as ep:
        state = state_for(ep)
        checker = checker_for([state], f"http://{target.host}:{target.port}/ip")
        await checker.check_one(state)
        # the probe egresses from the upstream address, not from the gateway host
        assert state.exit_ip == ep.host


def test_extract_handles_json_and_plain_text():
    payload = json.dumps({"ip": "203.0.113.9", "country_code": "NL"}).encode()
    assert HealthChecker._extract(payload, "") == ("203.0.113.9", "nl")
    assert HealthChecker._extract(b"198.51.100.4", "") == ("198.51.100.4", None)
    assert HealthChecker._extract(b'{"query":"1.1.1.1","countryCode":"AU"}', "") == ("1.1.1.1", "au")
    assert HealthChecker._extract(b'{"ip":"1.2.3.4"}', "US") == ("1.2.3.4", "us")
    assert HealthChecker._extract(b"garbage body", "") == (None, None)


def test_probe_url_scheme_decides_tls():
    assert HealthConfig(url="https://example.com/").use_tls is True
    assert HealthConfig(url="http://example.com/").use_tls is False