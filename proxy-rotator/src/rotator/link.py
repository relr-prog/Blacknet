"""Open a byte tunnel to ``host:port`` through any upstream kind."""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass

from .http1 import read_response_head
from .models import UpstreamKind
from .socks5 import socks5_connect
from .state import UpstreamState

__all__ = ["LinkError", "open_tunnel"]


class LinkError(OSError):
    """Raised when a tunnel through an upstream cannot be established."""

    def __init__(self, message: str, upstream_id: str | None = None) -> None:
        super().__init__(message)
        self.upstream_id = upstream_id


def _basic_auth(username: str, password: str) -> str:
    token = base64.b64encode(f"{username}:{password}".encode()).decode()
    return f"Basic {token}"


async def _open_direct(host: str, port: int, bind: str | None, timeout: float):
    local_addr = (bind, 0) if bind else None
    return await asyncio.open_connection(host, port, local_addr=local_addr)


async def _open_socks(spec, host: str, port: int, timeout: float):
    return await socks5_connect(
        host,
        port,
        server=(spec.host, spec.port),
        username=spec.username,
        password=spec.password,
        timeout=timeout,
        local_addr=(spec.bind_address, 0) if spec.bind_address else None,
    )


async def _open_http(spec, host: str, port: int, timeout: float):
    reader, writer = await _open_direct(spec.host, spec.port, spec.bind_address, timeout)
    try:
        request = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n"
        if spec.username is not None:
            request += f"Proxy-Authorization: {_basic_auth(spec.username, spec.password or '')}\r\n"
        request += "Proxy-Connection: keep-alive\r\n\r\n"
        writer.write(request.encode("latin-1"))
        await writer.drain()
        head = await read_response_head(reader)
    except BaseException:
        writer.close()
        raise
    if not 200 <= head.status < 300:
        writer.close()
        reason = f"{head.status} {head.reason}".strip()
        raise LinkError(f"CONNECT rejected by {spec.label}: {reason}", spec.id)
    return reader, writer


async def open_tunnel(
    state: UpstreamState, host: str, port: int, *, timeout: float = 15.0
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Return a connected (reader, writer) reaching ``host:port`` via ``state``."""
    spec = state.spec
    try:
        if spec.kind is UpstreamKind.DIRECT:
            return await asyncio.wait_for(_open_direct(host, port, spec.bind_address, timeout), timeout)
        if spec.kind is UpstreamKind.SOCKS5:
            return await _open_socks(spec, host, port, timeout)
        return await _open_http(spec, host, port, timeout)
    except LinkError:
        raise
    except asyncio.TimeoutError as exc:
        raise LinkError(f"timeout connecting to {spec.label} -> {host}:{port}", spec.id) from exc
    except (OSError, ValueError) as exc:
        raise LinkError(f"{spec.label} -> {host}:{port}: {exc}", spec.id) from exc