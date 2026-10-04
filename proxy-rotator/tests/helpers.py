"""Test doubles: origin servers, HTTP CONNECT upstreams and a SOCKS5 upstream.

Upstreams bind to distinct 127.0.0.x addresses, so the origin can report the real
peer address it saw. That makes rotation observable end to end without touching
the public internet.
"""

from __future__ import annotations

import asyncio
import base64
import ipaddress
import json
from contextlib import asynccontextmanager
from dataclasses import dataclass

from rotator.http1 import read_response_head
from rotator.socks5 import socks5_connect

LOOPBACK_BASE = ipaddress.ip_address("127.0.0.9")


def next_loopback() -> str:
    global LOOPBACK_BASE
    LOOPBACK_BASE += 1
    return str(LOOPBACK_BASE)


@dataclass(frozen=True)
class Endpoint:
    host: str
    port: int

    def uri(self, scheme: str = "http") -> str:
        return f"{scheme}://{self.host}:{self.port}"


@asynccontextmanager
async def origin(label: str, *, close_delimited: bool = False):
    """Minimal HTTP origin that echoes the peer address it was reached from."""

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            while True:
                request_line = await reader.readline()
                if not request_line:
                    return
                method, target, _version = request_line.decode("latin-1").split()
                headers: list[tuple[str, str]] = []
                length = 0
                chunked_request = False
                while True:
                    line = await reader.readline()
                    if line in (b"\r\n", b"\n", b""):
                        break
                    key, _, value = line.decode("latin-1").partition(":")
                    headers.append((key.strip(), value.strip()))
                    lowered = key.strip().lower()
                    if lowered == "content-length":
                        length = int(value.strip())
                    elif lowered == "transfer-encoding" and "chunked" in value.lower():
                        chunked_request = True
                if length:
                    await reader.readexactly(length)
                elif chunked_request:
                    while True:
                        size_line = await reader.readline()
                        size = int(size_line.split(b";")[0].strip() or b"0", 16)
                        await reader.readexactly(size + 2)
                        if size == 0:
                            break

                peer = writer.get_extra_info("peername")[0]
                payload = json.dumps(
                    {
                        "ip": peer,
                        "origin": label,
                        "peer": peer,
                        "method": method,
                        "path": target,
                    }
                )
                body = payload.encode()
                keep_alive = not any(
                    k.lower() == "connection" and "close" in v.lower() for k, v in headers
                )
                if close_delimited or not keep_alive:
                    head = (
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                        f"X-Origin: {label}\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n"
                    )
                    writer.write(head.encode() + body)
                    await writer.drain()
                    return
                head = (
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n"
                    f"X-Origin: {label}\r\nContent-Length: {len(body)}\r\nConnection: keep-alive\r\n\r\n"
                )
                writer.write(head.encode() + body)
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, ValueError):
            return
        finally:
            writer.close()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    endpoint = Endpoint("127.0.0.1", port)
    try:
        yield endpoint
    finally:
        server.close()
        await server.wait_closed()


@asynccontextmanager
async def http_upstream(bind: str, *, fail: bool = False, username: str | None = None,
                        password: str | None = None):
    """A CONNECT-capable HTTP proxy; CONNECT traffic egresses from ``bind``."""

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            request_line = await reader.readline()
            if not request_line:
                return
            method, target, _version = request_line.decode("latin-1").split()
            headers: dict[str, str] = {}
            while True:
                line = await reader.readline()
                if line in (b"\r\n", b"\n", b""):
                    break
                key, _, value = line.decode("latin-1").partition(":")
                headers[key.strip().lower()] = value.strip()

            if username is not None:
                expected = base64.b64encode(
                    f"{username}:{password or ''}".encode()
                ).decode()
                if headers.get("proxy-authorization") != f"Basic {expected}":
                    writer.write(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\n"
                        b"Content-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    await writer.drain()
                    return

            if method == "CONNECT":
                if fail:
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                    await writer.drain()
                    return
                host, _, port = target.rpartition(":")
                try:
                    up_reader, up_writer = await asyncio.open_connection(
                        host, int(port), local_addr=(bind, 0)
                    )
                except OSError:
                    writer.write(b"HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n")
                    await writer.drain()
                    return
                writer.write(b"HTTP/1.1 200 Connection established\r\n\r\n")
                await writer.drain()
                await _pump(reader, writer, up_reader, up_writer)
            else:
                writer.write(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionResetError, ValueError, OSError):
            pass
        finally:
            writer.close()

    server = await asyncio.start_server(handler, bind, 0)
    port = server.sockets[0].getsockname()[1]
    endpoint = Endpoint(bind, port)
    try:
        yield endpoint
    finally:
        server.close()
        await server.wait_closed()


@asynccontextmanager
async def socks5_upstream(bind: str, *, fail: bool = False,
                         username: str | None = None, password: str | None = None):
    """A SOCKS5 server that dials out from ``bind``."""

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        up_writer = None
        try:
            greeting = await reader.readexactly(2)
            methods = set(await reader.readexactly(greeting[1]))
            if username is not None:
                if 0x02 not in methods:
                    writer.write(bytes([0x05, 0xFF]))
                    await writer.drain()
                    return
                writer.write(bytes([0x05, 0x02]))
                await writer.drain()
                version = (await reader.readexactly(1))[0]
                assert version == 0x01
                ulen = (await reader.readexactly(1))[0]
                user = (await reader.readexactly(ulen)).decode()
                plen = (await reader.readexactly(1))[0]
                secret = (await reader.readexactly(plen)).decode()
                ok = user == username and secret == (password or "")
                writer.write(bytes([0x01, 0x00 if ok else 0x01]))
                await writer.drain()
                if not ok:
                    return
            else:
                writer.write(bytes([0x05, 0x00]))
                await writer.drain()

            request = await reader.readexactly(4)
            atyp = request[3]
            if atyp == 0x01:
                host = str(ipaddress.IPv4Address(await reader.readexactly(4)))
            elif atyp == 0x03:
                host = (await reader.readexactly((await reader.readexactly(1))[0])).decode()
            else:
                host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
            port = int.from_bytes(await reader.readexactly(2), "big")

            if fail or request[1] != 0x01:
                writer.write(bytes([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                await writer.drain()
                return
            try:
                up_reader, up_writer = await asyncio.open_connection(host, port, local_addr=(bind, 0))
            except OSError:
                writer.write(bytes([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
                await writer.drain()
                return
            writer.write(bytes([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
            await writer.drain()
            await _pump(reader, writer, up_reader, up_writer)
        except (asyncio.IncompleteReadError, ConnectionResetError, ValueError, OSError):
            pass
        finally:
            if up_writer is not None:
                up_writer.close()
            writer.close()

    server = await asyncio.start_server(handler, bind, 0)
    port = server.sockets[0].getsockname()[1]
    endpoint = Endpoint(bind, port)
    try:
        yield endpoint
    finally:
        server.close()
        await server.wait_closed()


@asynccontextmanager
async def connect_via_socks5(endpoint: Endpoint, host: str, target_port: int, **kwargs):
    reader, writer = await socks5_connect(
        host, target_port, server=(endpoint.host, endpoint.port), **kwargs
    )
    try:
        yield reader, writer
    finally:
        writer.close()


async def _pump(
    a_reader: asyncio.StreamReader,
    a_writer: asyncio.StreamWriter,
    b_reader: asyncio.StreamReader,
    b_writer: asyncio.StreamWriter,
) -> None:
    async def one(src: asyncio.StreamReader, dst: asyncio.StreamWriter) -> None:
        try:
            while True:
                data = await src.read(65536)
                if not data:
                    break
                dst.write(data)
                await dst.drain()
        except (ConnectionResetError, OSError):
            return

    tasks = [asyncio.create_task(one(a_reader, b_writer)), asyncio.create_task(one(b_reader, a_writer))]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def http_get_through_proxy(proxy_port: int, url: str, headers: dict[str, str] | None = None):
    """One GET through a plain-HTTP proxy, returning (status, headers, body)."""
    from urllib.parse import urlsplit

    parts = urlsplit(url)
    port = parts.port or 80
    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    try:
        path = parts.path or "/"
        if parts.query:
            path = f"{path}?{parts.query}"
        request = f"GET {url} HTTP/1.1\r\nHost: {parts.netloc}\r\nConnection: close\r\n"
        for key, value in (headers or {}).items():
            request += f"{key}: {value}\r\n"
        writer.write(request.encode() + b"\r\n")
        await writer.drain()
        head = await read_response_head(reader)
        body = b""
        while True:
            chunk = await reader.read(65536)
            if not chunk:
                break
            body += chunk
        return head.status, head.headers, body
    finally:
        writer.close()


async def connect_through_proxy(proxy_port: int, host: str, port: int, headers: dict[str, str] | None = None):
    reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
    request = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n"
    for key, value in (headers or {}).items():
        request += f"{key}: {value}\r\n"
    writer.write(request.encode() + b"\r\n")
    await writer.drain()
    head = await read_response_head(reader)
    return reader, writer, head