"""Tiny HTTP/1.1 helpers used by the health checker and the plain-HTTP path."""

from __future__ import annotations

import asyncio
import ssl
from dataclasses import dataclass
from urllib.parse import urlsplit

__all__ = ["ResponseHead", "read_response_head", "read_body", "http_get_via", "tls_context"]

MAX_HEAD_BYTES = 64 * 1024
MAX_BODY_BYTES = 1024 * 1024

HOP_BY_HOP = frozenset(
    {
        "connection",
        "proxy-connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "trailers",
        "transfer-encoding",
        "upgrade",
    }
)


@dataclass(slots=True)
class ResponseHead:
    version: str
    status: int
    reason: str
    headers: list[tuple[str, str]]

    def get(self, name: str, default: str = "") -> str:
        lowered = name.lower()
        for key, value in self.headers:
            if key.lower() == lowered:
                return value
        return default


def tls_context() -> ssl.SSLContext:
    return ssl.create_default_context()


async def read_response_head(reader: asyncio.StreamReader) -> ResponseHead:
    """Read status line + headers up to CRLFCRLF."""

    async def run() -> ResponseHead:
        buf = bytearray()
        while True:
            chunk = await reader.readuntil(b"\r\n\r\n")
            buf += chunk
            if len(buf) > MAX_HEAD_BYTES:
                raise ValueError("response head too large")
            if buf.endswith(b"\r\n\r\n"):
                break
        text = buf.decode("latin-1")
        lines = text.split("\r\n")
        status_line = lines[0]
        parts = status_line.split(" ", 2)
        version = parts[0]
        status = int(parts[1]) if len(parts) > 1 else 0
        reason = parts[2] if len(parts) > 2 else ""
        headers: list[tuple[str, str]] = []
        for line in lines[1:]:
            if not line:
                continue
            key, sep, value = line.partition(":")
            if not sep:
                continue
            headers.append((key.strip(), value.strip()))
        return ResponseHead(version=version, status=status, reason=reason, headers=headers)

    return await run()


async def read_body(
    reader: asyncio.StreamReader, head: ResponseHead, *, limit: int = MAX_BODY_BYTES
) -> bytes:
    transfer_encoding = head.get("transfer-encoding").lower()
    if "chunked" in transfer_encoding:
        chunks = bytearray()
        while True:
            size_line = (await reader.readline()).strip().split(b";")[0]
            size = int(size_line or b"0", 16)
            if size == 0:
                while True:
                    trailer = await reader.readline()
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            chunks += await reader.readexactly(size)
            await reader.readexactly(2)
            if len(chunks) > limit:
                raise ValueError("response body too large")
        return bytes(chunks)

    raw_length = head.get("content-length")
    if raw_length:
        length = int(raw_length)
        if length > limit:
            raise ValueError("response body too large")
        return await reader.readexactly(length) if length else b""

    if head.status in (204, 304) or head.get("connection").lower() == "close":
        return b""
    try:
        return await asyncio.wait_for(reader.read(limit), timeout=10)
    except asyncio.TimeoutError:
        return b""


async def http_get_via(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    url: str,
    *,
    headers: dict[str, str] | None = None,
    timeout: float = 15.0,
    use_tls: bool = True,
    body_limit: int = MAX_BODY_BYTES,
) -> tuple[ResponseHead, bytes]:
    """Perform one GET over an already-established TCP tunnel.

    With ``use_tls`` the tunnel is upgraded in place to TLS using SNI, which is
    how HTTPS probes run through a plaintext CONNECT tunnel.
    """

    parts = urlsplit(url)
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    host_header = parts.netloc
    request = f"GET {path} HTTP/1.1\r\nHost: {host_header}\r\n"
    merged = {
        "user-agent": "proxy-rotator/1.0",
        "accept": "*/*",
        "connection": "close",
        **(headers or {}),
    }
    for key, value in merged.items():
        request += f"{key}: {value}\r\n"
    request += "\r\n"
    payload = request.encode("latin-1")

    async def run() -> tuple[ResponseHead, bytes]:
        stream_r, stream_w = reader, writer
        if use_tls:
            sock = writer.transport.get_extra_info("socket")
            if sock is None:
                raise OSError("tunnel has no underlying socket for TLS upgrade")
            stream_r, stream_w = await asyncio.open_connection(
                sock=sock, server_hostname=parts.hostname, ssl=tls_context()
            )
        stream_w.write(payload)
        await stream_w.drain()
        head = await read_response_head(stream_r)
        body = await read_body(stream_r, head, limit=body_limit)
        return head, body

    return await asyncio.wait_for(run(), timeout=timeout)