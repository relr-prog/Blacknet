"""End-to-end tests: requests go through the gateway, out of distinct exit IPs."""

from __future__ import annotations

import asyncio
import base64
import json

from rotator.gateway import GatewayConfig, RotatingGateway
from rotator.http1 import http_get_via, read_response_head
from rotator.models import parse_upstream_line
from rotator.pool import Pool, Strategy
from rotator.socks5 import socks5_connect
from rotator.state import UpstreamState

from helpers import (
    Endpoint,
    connect_through_proxy,
    http_get_through_proxy,
    http_upstream,
    next_loopback,
    origin,
    socks5_upstream,
)


def state_for(endpoint: Endpoint, *, kind: str = "http", username: str | None = None,
              password: str | None = None, **kwargs) -> UpstreamState:
    auth = f"{username}:{password}@" if username else ""
    scheme = "socks5" if kind == "socks5" else "http"
    spec = parse_upstream_line(f"{scheme}://{auth}{endpoint.host}:{endpoint.port}")
    return UpstreamState(spec=spec, **kwargs)


async def start_gateway(states, **config_kwargs) -> RotatingGateway:
    strategy = config_kwargs.pop("strategy", Strategy.ROUND_ROBIN)
    pool = Pool(states, strategy=strategy)
    config = GatewayConfig(host="127.0.0.1", port=0, socks_port=0, metrics_port=0, **config_kwargs)
    gateway = RotatingGateway(pool, config)
    await gateway.start()
    return gateway


async def get_via_connect(gateway: RotatingGateway, url: str, headers=None) -> tuple[dict, bytes]:
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    port = parts.port or 80
    reader, writer, head = await connect_through_proxy(gateway.ports[0], parts.hostname, port, headers)
    assert head.status == 200, head.status
    exposed = {k.lower(): v for k, v in head.headers}
    _, body = await http_get_via(reader, writer, url, use_tls=False)
    writer.close()
    return exposed, body


async def test_plain_http_rotates_exit_ip_per_request():
    binds = [next_loopback() for _ in range(3)]
    async with origin("rotating") as target, http_upstream(binds[0]) as p1, \
            http_upstream(binds[1]) as p2, http_upstream(binds[2]) as p3:
        gateway = await start_gateway([state_for(p1), state_for(p2), state_for(p3)])
        try:
            peers = []
            for _ in range(6):
                _status, _headers, body = await http_get_through_proxy(
                    gateway.ports[0], f"http://{target.host}:{target.port}/page"
                )
                peers.append(json.loads(body)["peer"])
        finally:
            await gateway.stop()

    assert set(peers) == set(binds)
    assert peers[:3] == binds


async def test_connect_tunnel_reports_the_selected_upstream():
    binds = [next_loopback(), next_loopback()]
    async with origin("connect") as target, http_upstream(binds[0]) as p1, \
            http_upstream(binds[1]) as p2:
        states = [state_for(p1), state_for(p2)]
        gateway = await start_gateway(states)
        try:
            first, body_a = await get_via_connect(gateway, f"http://{target.host}:{target.port}/a")
            second, body_b = await get_via_connect(gateway, f"http://{target.host}:{target.port}/b")
        finally:
            await gateway.stop()

        assert json.loads(body_a)["peer"] == binds[0]
        assert json.loads(body_b)["peer"] == binds[1]
        assert first["x-rotator-upstream"] == states[0].id
        assert second["x-rotator-upstream"] == states[1].id


async def test_sticky_header_pins_one_exit_ip():
    binds = [next_loopback(), next_loopback(), next_loopback()]
    async with origin("sticky") as target, http_upstream(binds[0]) as p1, \
            http_upstream(binds[1]) as p2, http_upstream(binds[2]) as p3:
        gateway = await start_gateway([state_for(p1), state_for(p2), state_for(p3)])
        try:
            peers = []
            for _ in range(6):
                _headers, body = await get_via_connect(
                    gateway, f"http://{target.host}:{target.port}/x", {"X-Rotator-Sticky": "worker-7"}
                )
                peers.append(json.loads(body)["peer"])
        finally:
            await gateway.stop()
    assert len(set(peers)) == 1


async def test_country_header_selects_matching_geo():
    async with origin("geo") as target, http_upstream(next_loopback()) as p1, \
            http_upstream(next_loopback()) as p2:
        us, de = state_for(p1), state_for(p2)
        us.note_success(exit_ip="127.0.0.1", country="us")
        de.note_success(exit_ip="127.0.0.1", country="de")
        gateway = await start_gateway([us, de])
        try:
            header, _body = await get_via_connect(
                gateway, f"http://{target.host}:{target.port}/g", {"X-Rotator-Country": "DE"}
            )
        finally:
            await gateway.stop()
        assert header["x-rotator-upstream"] == de.id
        assert header["x-rotator-country"] == "de"


async def test_impossible_country_yields_503():
    async with http_upstream(next_loopback()) as p1:
        state = state_for(p1)
        state.note_success(exit_ip="127.0.0.1", country="us")
        gateway = await start_gateway([state])
        try:
            _reader, writer, head = await connect_through_proxy(
                gateway.ports[0], "127.0.0.1", 80, {"X-Rotator-Country": "fr"}
            )
            writer.close()
        finally:
            await gateway.stop()
        assert head.status == 503


async def test_dead_upstream_is_skipped_for_the_next_request():
    async with origin("failover") as target, http_upstream("127.0.0.1", fail=True) as dead, \
            http_upstream(next_loopback()) as good:
        gateway = await start_gateway([state_for(dead), state_for(good)], max_attempts=2)
        try:
            status, _headers, body = await http_get_through_proxy(
                gateway.ports[0], f"http://{target.host}:{target.port}/after-failure"
            )
        finally:
            await gateway.stop()
        assert status == 200
        assert json.loads(body)["origin"] == "failover"


async def test_upstream_credentials_are_forwarded():
    async with origin("auth") as target, http_upstream(next_loopback(), username="u", password="p") as ep:
        gateway = await start_gateway([state_for(ep, username="u", password="p")])
        try:
            _status, _headers, body = await http_get_through_proxy(
                gateway.ports[0], f"http://{target.host}:{target.port}/authed"
            )
        finally:
            await gateway.stop()
        assert json.loads(body)["path"] == "/authed"


async def test_wrong_upstream_credentials_surface_as_502():
    async with http_upstream(next_loopback(), username="u", password="p") as ep:
        gateway = await start_gateway([state_for(ep, username="u", password="nope")], max_attempts=1)
        try:
            _reader, writer, head = await connect_through_proxy(gateway.ports[0], "127.0.0.1", 9)
            writer.close()
        finally:
            await gateway.stop()
        assert head.status == 502


async def test_socks5_upstream_kind_is_supported():
    bind = next_loopback()
    async with origin("socks") as target, socks5_upstream(bind) as ep:
        gateway = await start_gateway([state_for(ep, kind="socks5")])
        try:
            _status, _headers, body = await http_get_through_proxy(
                gateway.ports[0], f"http://{target.host}:{target.port}/via-socks"
            )
        finally:
            await gateway.stop()
        assert json.loads(body)["peer"] == bind


async def test_direct_upstream_uses_the_local_egress():
    async with origin("direct") as target:
        gateway = await start_gateway([UpstreamState(spec=parse_upstream_line("direct"))])
        try:
            _status, _headers, body = await http_get_through_proxy(
                gateway.ports[0], f"http://{target.host}:{target.port}/direct"
            )
        finally:
            await gateway.stop()
        assert json.loads(body)["peer"] == "127.0.0.1"


async def test_client_authentication_is_enforced():
    async with origin("clientauth") as target, http_upstream(next_loopback()) as ep:
        gateway = await start_gateway([state_for(ep)], username="local", password="token")
        try:
            _reader, writer, unauth = await connect_through_proxy(
                gateway.ports[0], target.host, target.port
            )
            writer.close()
            assert unauth.status == 407

            token = base64.b64encode(b"local:token").decode()
            status, _headers, body = await http_get_through_proxy(
                gateway.ports[0],
                f"http://{target.host}:{target.port}/ok",
                {"Proxy-Authorization": f"Basic {token}"},
            )
        finally:
            await gateway.stop()
        assert status == 200
        assert json.loads(body)["origin"] == "clientauth"


async def test_keepalive_reuses_one_client_connection():
    async with origin("keepalive") as target, http_upstream(next_loopback()) as p1, \
            http_upstream(next_loopback()) as p2:
        gateway = await start_gateway([state_for(p1), state_for(p2)])
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", gateway.ports[0])
            paths = []
            for index in range(2):
                writer.write(
                    f"GET http://{target.host}:{target.port}/k{index} HTTP/1.1\r\n"
                    f"Host: {target.host}:{target.port}\r\nConnection: keep-alive\r\n\r\n".encode()
                )
                await writer.drain()
                head = await read_response_head(reader)
                assert head.status == 200
                length = int(head.get("content-length"))
                paths.append(json.loads(await reader.readexactly(length))["path"])
            writer.close()
        finally:
            await gateway.stop()
    assert paths == ["/k0", "/k1"]


async def test_post_body_is_forwarded_through_the_plain_path():
    async with origin("post") as target, http_upstream(next_loopback()) as ep:
        gateway = await start_gateway([state_for(ep)])
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", gateway.ports[0])
            body = b'{"hello":"world"}'
            writer.write(
                (
                    f"POST http://{target.host}:{target.port}/submit HTTP/1.1\r\n"
                    f"Host: {target.host}:{target.port}\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    "Connection: close\r\n\r\n"
                ).encode()
                + body
            )
            await writer.drain()
            head = await read_response_head(reader)
            assert head.status == 200
            payload = json.loads(await reader.readexactly(int(head.get("content-length"))))
            writer.close()
        finally:
            await gateway.stop()
    assert payload["method"] == "POST"


async def test_socks5_front_end_rotates():
    async with origin("front") as target, http_upstream(next_loopback()) as p1, \
            http_upstream(next_loopback()) as p2:
        gateway = await start_gateway([state_for(p1), state_for(p2)])
        socks_server = await asyncio.start_server(gateway._handle_socks, "127.0.0.1", 0)
        socks_port = socks_server.sockets[0].getsockname()[1]
        peers = []
        try:
            for _ in range(4):
                reader, writer = await socks5_connect(
                    target.host, target.port, server=("127.0.0.1", socks_port)
                )
                writer.write(b"GET /f HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
                await writer.drain()
                payload = await reader.read()
                peers.append(json.loads(payload.split(b"\r\n\r\n", 1)[1])["peer"])
                writer.close()
        finally:
            socks_server.close()
            await socks_server.wait_closed()
            await gateway.stop()
    assert len(set(peers)) == 2


async def test_status_and_metrics_endpoints():
    async with origin("metrics") as target, http_upstream(next_loopback()) as ep:
        gateway = await start_gateway([state_for(ep)])
        status_server = await asyncio.start_server(gateway._handle_status, "127.0.0.1", 0)
        status_port = status_server.sockets[0].getsockname()[1]
        try:
            await http_get_through_proxy(gateway.ports[0], f"http://{target.host}:{target.port}/m")

            reader, writer = await asyncio.open_connection("127.0.0.1", status_port)
            writer.write(b"GET /metrics HTTP/1.1\r\nHost: x\r\n\r\n")
            await writer.drain()
            await read_response_head(reader)
            metrics_body = await reader.read()
            writer.close()

            reader, writer = await asyncio.open_connection("127.0.0.1", status_port)
            writer.write(b"GET /status HTTP/1.1\r\nHost: x\r\n\r\n")
            await writer.drain()
            await read_response_head(reader)
            status = json.loads(await reader.read())
            writer.close()
        finally:
            status_server.close()
            await status_server.wait_closed()
            await gateway.stop()

    assert b"rotator_requests_total" in metrics_body
    assert status["pool"]["upstreams"] == 1
    assert status["upstreams"][0]["ok"] >= 1


async def test_concurrency_hits_the_slots_limit():
    async with origin("slots") as target, http_upstream(next_loopback()) as ep:
        gateway = await start_gateway([state_for(ep, max_slots=1)])
        try:
            _first_reader, first_writer, first_head = await connect_through_proxy(
                gateway.ports[0], target.host, target.port
            )
            assert first_head.status == 200
            _r2, w2, second_head = await connect_through_proxy(
                gateway.ports[0], target.host, target.port
            )
            w2.close()
            assert second_head.status == 503
            first_writer.close()
        finally:
            await gateway.stop()


async def test_origin_form_request_is_rejected():
    async with http_upstream(next_loopback()) as ep:
        gateway = await start_gateway([state_for(ep)])
        try:
            reader, writer = await asyncio.open_connection("127.0.0.1", gateway.ports[0])
            writer.write(b"GET /relative HTTP/1.1\r\nHost: x\r\n\r\n")
            await writer.drain()
            head = await read_response_head(reader)
            writer.close()
        finally:
            await gateway.stop()
    assert head.status == 400


async def test_random_strategy_cycles_all_upstreams():
    async with origin("random") as target, http_upstream(next_loopback()) as p1, \
            http_upstream(next_loopback()) as p2, http_upstream(next_loopback()) as p3:
        gateway = await start_gateway(
            [state_for(p1), state_for(p2), state_for(p3)], strategy=Strategy.RANDOM
        )
        try:
            peers = set()
            for _ in range(30):
                _status, _headers, body = await http_get_through_proxy(
                    gateway.ports[0], f"http://{target.host}:{target.port}/r"
                )
                peers.add(json.loads(body)["peer"])
        finally:
            await gateway.stop()
    assert len(peers) == 3