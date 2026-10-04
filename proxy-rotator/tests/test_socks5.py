from __future__ import annotations

import pytest

from rotator.socks5 import Socks5Error, socks5_connect

from helpers import next_loopback, origin, socks5_upstream


async def test_connect_through_socks5_upstream():
    bind = next_loopback()
    async with origin("o1") as target, socks5_upstream(bind) as proxy:
        reader, writer = await socks5_connect(target.host, target.port, server=(proxy.host, proxy.port))
        try:
            writer.write(b"GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n")
            await writer.drain()
            payload = await reader.read()
        finally:
            writer.close()
    assert b"200 OK" in payload
    assert bind.encode() in payload


async def test_username_password_auth_succeeds():
    bind = next_loopback()
    async with origin("o2") as target, socks5_upstream(bind, username="u", password="p") as proxy:
        reader, writer = await socks5_connect(
            target.host, target.port, server=(proxy.host, proxy.port), username="u", password="p"
        )
        writer.close()
        assert reader is not None


async def test_username_password_auth_rejected():
    bind = next_loopback()
    async with origin("o3") as target, socks5_upstream(bind, username="u", password="p") as proxy:
        with pytest.raises(Socks5Error, match="authentication rejected"):
            await socks5_connect(
                target.host, target.port, server=(proxy.host, proxy.port), username="u", password="wrong"
            )


async def test_server_requires_auth_but_client_offers_none():
    bind = next_loopback()
    async with origin("o4") as target, socks5_upstream(bind, username="u", password="p") as proxy:
        with pytest.raises(Socks5Error):
            await socks5_connect(target.host, target.port, server=(proxy.host, proxy.port))


async def test_upstream_failure_is_reported():
    bind = next_loopback()
    async with origin("o5") as target, socks5_upstream(bind, fail=True) as proxy:
        with pytest.raises(Socks5Error, match="connection refused"):
            await socks5_connect(target.host, target.port, server=(proxy.host, proxy.port))


async def test_hostname_address_type_is_supported():
    bind = next_loopback()
    async with origin("o6") as target, socks5_upstream(bind) as proxy:
        reader, writer = await socks5_connect("localhost", target.port, server=(proxy.host, proxy.port))
        writer.close()
        assert reader is not None


async def test_garbage_server_is_rejected():
    import asyncio

    async def handler(reader, writer):
        writer.write(b"not socks at all\r\n")
        await writer.drain()
        writer.close()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        with pytest.raises(Socks5Error, match="not a SOCKS5 server"):
            await socks5_connect("127.0.0.1", 80, server=("127.0.0.1", port))
    finally:
        server.close()
        await server.wait_closed()