"""The rotating proxy gateway: one listener, many interchangeable egress IPs."""

from __future__ import annotations

import asyncio
import base64
import logging
import time
from dataclasses import dataclass, field
from typing import Iterable
from urllib.parse import urlsplit, urlunsplit

from .http1 import HOP_BY_HOP, read_response_head
from .link import LinkError, open_tunnel
from .metrics import Metrics
from .pool import Lease, NoUpstreamAvailable, Pool
from .state import UpstreamState

log = logging.getLogger("rotator.gateway")

__all__ = ["GatewayConfig", "RotatingGateway", "RequestHead", "read_request_head"]


@dataclass(slots=True)
class RequestHead:
    method: str
    target: str
    version: str
    headers: list[tuple[str, str]]

    def get(self, name: str, default: str = "") -> str:
        lowered = name.lower()
        for key, value in self.headers:
            if key.lower() == lowered:
                return value
        return default

    def keep_alive(self) -> bool:
        token = self.get("connection").lower()
        if "close" in token:
            return False
        if self.version == "HTTP/1.0":
            return "keep-alive" in token
        return True


async def read_request_head(reader: asyncio.StreamReader, *, timeout: float = 30.0) -> RequestHead:
    async def run() -> RequestHead:
        request_line = await reader.readline()
        if not request_line:
            raise ConnectionResetError("client closed before sending a request")
        parts = request_line.decode("latin-1").rstrip("\r\n").split(" ")
        if len(parts) != 3:
            raise ValueError(f"malformed request line: {request_line!r}")
        method, target, version = parts
        headers: list[tuple[str, str]] = []
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            key, sep, value = line.decode("latin-1").partition(":")
            if sep:
                headers.append((key.strip(), value.strip()))
            if len(headers) > 200:
                raise ValueError("too many request headers")
        return RequestHead(method=method.upper(), target=target, version=version, headers=headers)

    return await asyncio.wait_for(run(), timeout=timeout)


@dataclass
class GatewayConfig:
    host: str = "127.0.0.1"
    port: int = 8888
    socks_port: int = 0
    metrics_port: int = 0
    username: str | None = None
    password: str | None = None
    connect_timeout: float = 15.0
    head_timeout: float = 30.0
    max_attempts: int = 3
    idle_timeout: float = 300.0
    sticky_ttl: float = 300.0
    sticky_by_peer: bool = False
    sticky_header: str = "X-Rotator-Sticky"
    country_header: str = "X-Rotator-Country"
    tag_header: str = "X-Rotator-Tag"
    agent: str = "proxy-rotator/1.0"
    control_headers: frozenset[str] = field(
        default_factory=lambda: frozenset(
            {"x-rotator-sticky", "x-rotator-country", "x-rotator-tag"}
        )
    )
    expose_headers: bool = True
    default_country: str | None = None


class RotatingGateway:
    """HTTP proxy (CONNECT + absolute-form) in front of a :class:`Pool`.

    Each new client connection picks a different upstream, so consecutive
    requests leave from different egress IPs. ``X-Rotator-Sticky`` pins a client
    to one upstream, ``X-Rotator-Country`` demands a geo.
    """

    def __init__(
        self,
        pool: Pool,
        config: GatewayConfig | None = None,
        *,
        metrics: Metrics | None = None,
    ) -> None:
        self.pool = pool
        self.config = config or GatewayConfig()
        self.metrics = metrics or Metrics()
        self._server: asyncio.AbstractServer | None = None
        self._socks: asyncio.AbstractServer | None = None
        self._status: asyncio.AbstractServer | None = None
        self._tasks: set[asyncio.Task] = set()
        self.started_at = 0.0
        self.connections = 0

    # ------------------------------------------------------------- lifecycle
    async def start(self) -> None:
        self._server = await asyncio.start_server(
            self._handle_client, self.config.host, self.config.port, limit=128 * 1024
        )
        if self.config.socks_port:
            self._socks = await asyncio.start_server(
                self._handle_socks, self.config.host, self.config.socks_port, limit=128 * 1024
            )
        if self.config.metrics_port:
            self._status = await asyncio.start_server(
                self._handle_status, self.config.host, self.config.metrics_port, limit=64 * 1024
            )
        self.started_at = time.time()

    async def stop(self) -> None:
        for server in (self._server, self._socks, self._status):
            if server is not None:
                server.close()
        for server in (self._server, self._socks, self._status):
            if server is not None:
                try:
                    await server.wait_closed()
                except Exception:  # noqa: BLE001
                    pass
        for task in list(self._tasks):
            task.cancel()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        self._tasks = set()

    @property
    def ports(self) -> tuple[int, int, int]:
        http = self._server.sockets[0].getsockname()[1] if self._server and self._server.sockets else 0
        socks = self._socks.sockets[0].getsockname()[1] if self._socks and self._socks.sockets else 0
        status = (
            self._status.sockets[0].getsockname()[1]
            if self._status and self._status.sockets
            else 0
        )
        return http, socks, status

    # ------------------------------------------------------------ HTTP proxy
    async def _handle_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        if task is not None:
            self._tasks.add(task)
        self.connections += 1
        peer = writer.get_extra_info("peername")
        peer_ip = peer[0] if peer else "-"
        try:
            while True:
                try:
                    head = await read_request_head(reader, timeout=self.config.head_timeout)
                except (asyncio.TimeoutError, asyncio.IncompleteReadError):
                    return
                except (ValueError, ConnectionResetError) as exc:
                    await self._send_simple(writer, 400, f"bad request: {exc}")
                    return

                if not self._authorised(head):
                    await self._send_simple(
                        writer,
                        407,
                        "Proxy Authentication Required",
                        extra=b'Proxy-Authenticate: Basic realm="proxy-rotator"\r\n',
                    )
                    return

                if head.method == "CONNECT":
                    await self._handle_connect(reader, writer, head, peer_ip)
                    return

                keep_alive = await self._handle_plain(reader, writer, head, peer_ip)
                if not keep_alive:
                    return
        except (ConnectionResetError, BrokenPipeError, asyncio.CancelledError):
            raise
        except Exception:  # noqa: BLE001
            log.exception("client connection from %s failed", peer_ip)
        finally:
            if task is not None:
                self._tasks.discard(task)
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    def _authorised(self, head: RequestHead) -> bool:
        if not self.config.username:
            return True
        value = head.get("proxy-authorization")
        if not value.lower().startswith("basic "):
            return False
        try:
            decoded = base64.b64decode(value.split(None, 1)[1]).decode("utf-8", "replace")
        except (ValueError, IndexError):
            return False
        user, _, secret = decoded.partition(":")
        return user == self.config.username and secret == (self.config.password or "")

    def _selection(self, head: RequestHead, peer_ip: str) -> tuple[str | None, tuple[str, ...], str | None]:
        sticky = head.get(self.config.sticky_header).strip() or None
        country = head.get(self.config.country_header).strip().lower() or self.config.default_country
        tags = tuple(t.strip().lower() for t in head.get(self.config.tag_header).split(",") if t.strip())
        if sticky is None and self.config.sticky_by_peer:
            sticky = f"peer:{peer_ip}"
        return country, tags, sticky

    def _selection_for_peer(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> dict:
        """SOCKS5 has no request headers, so select using peer identity only."""
        peer = writer.get_extra_info("peername")
        peer_ip = peer[0] if peer else "-"
        country, tags, sticky = self._selection(RequestHead("", "", "", []), peer_ip)
        return {"country": country, "tags": tags, "sticky": sticky}

    async def _handle_connect(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        head: RequestHead,
        peer_ip: str,
    ) -> None:
        host, _, port_text = head.target.rpartition(":")
        if not host or not port_text.isdigit():
            await self._send_simple(writer, 400, "CONNECT requires host:port")
            return
        port = int(port_text)
        country, tags, sticky = self._selection(head, peer_ip)

        exclude: set[str] = set()
        for attempt in range(1, max(1, self.config.max_attempts) + 1):
            lease = self._try_acquire(country, tags, sticky, exclude)
            if lease is None:
                await self._send_simple(writer, 503, "no upstream available")
                return
            started = time.monotonic()
            try:
                tunnel_reader, tunnel_writer = await open_tunnel(
                    lease.state, host, port, timeout=self.config.connect_timeout
                )
            except LinkError as exc:
                lease.state.note_failure(str(exc))
                self.metrics.failures.labels(upstream_id=lease.state.id, reason="connect").inc()
                log.warning("attempt %d via %s failed: %s", attempt, lease.state.spec.label, exc)
                lease.release()
                exclude.add(lease.state.id)
                continue

            self.metrics.duration.labels(upstream_id=lease.state.id).observe(
                time.monotonic() - started
            )
            self.metrics.rotations.labels(
                upstream_id=lease.state.id, tier=str(lease.state.tier)
            ).inc()
            self.metrics.requests.labels(mode="connect").inc()
            self.metrics.observe_pool(self.pool)
            lease.state.note_success()
            extra = self._expose(lease.state)
            writer.write(
                b"HTTP/1.1 200 Connection established\r\n"
                + self.config.agent.encode()
                + b"\r\n"
                + extra
                + b"\r\n"
            )
            try:
                await writer.drain()
            except (ConnectionResetError, BrokenPipeError):
                tunnel_writer.close()
                lease.release()
                return

            try:
                await self._pump_pair(reader, writer, tunnel_reader, tunnel_writer, lease)
            finally:
                tunnel_writer.close()
                lease.release()
            return

        await self._send_simple(writer, 502, "all upstreams failed")

    async def _handle_plain(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
        head: RequestHead,
        peer_ip: str,
    ) -> bool:
        parts = urlsplit(head.target)
        if parts.scheme not in ("http", ""):
            await self._send_simple(writer, 400, "only http:// and CONNECT are supported")
            return False
        if not parts.hostname:
            await self._send_simple(writer, 400, "request target must be an absolute URI")
            return False
        host = parts.hostname
        port = parts.port or 80
        path = urlunsplit(("", "", parts.path or "/", parts.query, ""))
        country, tags, sticky = self._selection(head, peer_ip)

        forwarded = [
            (k, v)
            for k, v in head.headers
            if k.lower() not in HOP_BY_HOP and k.lower() not in self.config.control_headers
        ]

        exclude: set[str] = set()
        for attempt in range(1, max(1, self.config.max_attempts) + 1):
            lease = self._try_acquire(country, tags, sticky, exclude)
            if lease is None:
                await self._send_simple(writer, 503, "no upstream available")
                return False
            started = time.monotonic()
            try:
                up_reader, up_writer = await open_tunnel(
                    lease.state, host, port, timeout=self.config.connect_timeout
                )
                keep_alive = head.keep_alive()
                request = f"{head.method} {path} HTTP/1.1\r\nHost: {head.get('host') or f'{host}:{port}'}\r\n"
                for key, value in forwarded:
                    request += f"{key}: {value}\r\n"
                if keep_alive:
                    request += "Connection: keep-alive\r\n"
                else:
                    request += "Connection: close\r\n"
                request += "\r\n"
                up_writer.write(request.encode("latin-1"))
                await up_writer.drain()
                await self._forward_request_body(reader, up_writer, head)
            except (LinkError, OSError, ValueError) as exc:
                lease.state.note_failure(str(exc))
                self.metrics.failures.labels(upstream_id=lease.state.id, reason="connect").inc()
                exclude.add(lease.state.id)
                log.warning("plain attempt %d via %s failed: %s", attempt, lease.state.spec.label, exc)
                lease.release()
                continue

            self.metrics.duration.labels(upstream_id=lease.state.id).observe(
                time.monotonic() - started
            )
            self.metrics.rotations.labels(upstream_id=lease.state.id, tier=str(lease.state.tier)).inc()
            self.metrics.requests.labels(mode="http").inc()
            self.metrics.observe_pool(self.pool)
            lease.state.note_success()
            try:
                return await self._relay_http_response(reader, writer, up_reader, up_writer, head, lease)
            except (asyncio.TimeoutError, ConnectionResetError, BrokenPipeError, ValueError, OSError) as exc:
                lease.state.note_failure(f"relay: {exc}")
                self.metrics.failures.labels(upstream_id=lease.state.id, reason="relay").inc()
                log.warning("relay failed via %s: %s", lease.state.spec.label, exc)
                return False
            finally:
                up_writer.close()
                lease.release()

        await self._send_simple(writer, 502, "all upstreams failed")
        return False

    def _try_acquire(
        self,
        country: str | None,
        tags: Iterable[str],
        sticky: str | None,
        exclude: set[str],
    ) -> Lease | None:
        try:
            return self.pool.acquire(
                country=country, tags=tuple(tags), sticky_key=sticky, exclude=exclude
            )
        except NoUpstreamAvailable as exc:
            log.warning("no upstream available: %s", exc)
            self.metrics.no_upstream.inc()
            return None

    def _expose(self, state: UpstreamState) -> bytes:
        if not self.config.expose_headers:
            return b""
        lines = [f"X-Rotator-Upstream: {state.id}\r\n"]
        if state.exit_ip:
            lines.append(f"X-Rotator-Exit-IP: {state.exit_ip}\r\n")
        country = state.effective_country()
        if country:
            lines.append(f"X-Rotator-Country: {country}\r\n")
        return "".join(lines).encode("latin-1")

    async def _relay_http_response(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        up_reader: asyncio.StreamReader,
        up_writer: asyncio.StreamWriter,
        request_head: RequestHead,
        lease: Lease,
    ) -> bool:
        head = await asyncio.wait_for(read_response_head(up_reader), timeout=self.config.head_timeout)
        extra = self._expose(lease.state)
        status_line = f"HTTP/1.1 {head.status} {head.reason}\r\n"
        out = bytearray(status_line.encode("latin-1"))
        for key, value in head.headers:
            if key.lower() in ("connection", "keep-alive", "proxy-authenticate", "proxy-connection"):
                continue
            out += f"{key}: {value}\r\n".encode("latin-1")
        if extra:
            out += extra
        if request_head.keep_alive() and head.version != "HTTP/1.0":
            out += b"Connection: keep-alive\r\n"
        else:
            out += b"Connection: close\r\n"
        out += b"\r\n"
        client_writer.write(bytes(out))
        await client_writer.drain()

        chunked = "chunked" in head.get("transfer-encoding").lower()
        raw_length = head.get("content-length")
        if chunked:
            await self._relay_chunked(up_reader, client_writer)
            return request_head.keep_alive()
        if raw_length:
            length = int(raw_length)
            if length:
                await self._relay_exact(up_reader, client_writer, length)
            return request_head.keep_alive()
        # close-delimited body: stream until the upstream hangs up
        await self._relay_until_eof(up_reader, client_writer)
        return False

    # --------------------------------------------------------------- relaying
    async def _pump_pair(
        self,
        client_reader: asyncio.StreamReader,
        client_writer: asyncio.StreamWriter,
        up_reader: asyncio.StreamReader,
        up_writer: asyncio.StreamWriter,
        lease: Lease,
    ) -> None:
        async def client_to_up() -> None:
            while True:
                data = await asyncio.wait_for(
                    client_reader.read(65536), timeout=self.config.idle_timeout
                )
                if not data:
                    break
                up_writer.write(data)
                await up_writer.drain()
                lease.state.bytes_up += len(data)

        async def up_to_client() -> None:
            while True:
                data = await asyncio.wait_for(up_reader.read(65536), timeout=self.config.idle_timeout)
                if not data:
                    break
                client_writer.write(data)
                await client_writer.drain()
                lease.state.bytes_down += len(data)

        tasks = [asyncio.create_task(client_to_up()), asyncio.create_task(up_to_client())]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            await asyncio.gather(*pending, return_exceptions=True)
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, asyncio.CancelledError):
                    log.debug("tunnel via %s ended: %r", lease.state.id, exc)
        finally:
            for task in tasks:
                task.cancel()

    async def _forward_request_body(
        self,
        client_reader: asyncio.StreamReader,
        up_writer: asyncio.StreamWriter,
        head: RequestHead,
    ) -> None:
        """Stream a plain-HTTP request body through to the origin."""
        if "chunked" in head.get("transfer-encoding").lower():
            await self._relay_chunked(client_reader, up_writer)
            return
        raw_length = head.get("content-length")
        if not raw_length:
            return
        length = int(raw_length)
        if length:
            await self._relay_exact(client_reader, up_writer, length)

    async def _relay_exact(
        self, source: asyncio.StreamReader, sink: asyncio.StreamWriter, length: int
    ) -> None:
        remaining = length
        while remaining > 0:
            chunk = await source.read(min(65536, remaining))
            if not chunk:
                break
            sink.write(chunk)
            await sink.drain()
            remaining -= len(chunk)

    async def _relay_chunked(self, source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> None:
        while True:
            line = await source.readline()
            if not line:
                break
            sink.write(line)
            await sink.drain()
            size_text = line.split(b";")[0].strip()
            try:
                size = int(size_text, 16)
            except ValueError:
                break
            if size == 0:
                while True:
                    trailer = await source.readline()
                    sink.write(trailer)
                    await sink.drain()
                    if trailer in (b"\r\n", b"\n", b""):
                        break
                break
            await self._relay_exact(source, sink, size + 2)

    async def _relay_until_eof(self, source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> None:
        while True:
            chunk = await source.read(65536)
            if not chunk:
                break
            sink.write(chunk)
            await sink.drain()

    async def _send_simple(
        self, writer: asyncio.StreamWriter, status: int, reason: str, *, extra: bytes = b""
    ) -> None:
        body = f"{status} {reason}\n".encode()
        payload = (
            f"HTTP/1.1 {status} {reason}\r\n"
            "Content-Type: text/plain; charset=utf-8\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n"
        ).encode("latin-1") + extra + b"\r\n" + body
        try:
            writer.write(payload)
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass

    # ------------------------------------------------------------ SOCKS5 in
    async def _handle_socks(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        from .socks5_server import handle_socks_client

        await handle_socks_client(reader, writer, self)

    async def open_for(
        self, host: str, port: int, **selection
    ) -> tuple[asyncio.StreamReader, asyncio.StreamWriter, Lease]:
        """Used by the SOCKS5 front end: pick an upstream and tunnel to host:port."""
        country = selection.get("country")
        tags = tuple(selection.get("tags") or ())
        sticky = selection.get("sticky")
        exclude = selection.get("exclude") or ()
        lease = self.pool.acquire(country=country, tags=tags, sticky_key=sticky, exclude=exclude)
        started = time.monotonic()
        try:
            tunnel_reader, tunnel_writer = await open_tunnel(
                lease.state, host, port, timeout=self.config.connect_timeout
            )
        except BaseException:
            lease.release()
            raise
        self.metrics.duration.labels(upstream_id=lease.state.id).observe(time.monotonic() - started)
        self.metrics.rotations.labels(upstream_id=lease.state.id, tier=str(lease.state.tier)).inc()
        self.metrics.requests.labels(mode="socks5").inc()
        self.metrics.observe_pool(self.pool)
        lease.state.note_success()
        return tunnel_reader, tunnel_writer, lease

    # --------------------------------------------------------------- status
    async def _handle_status(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        import json

        try:
            request_line = await asyncio.wait_for(reader.readline(), timeout=5)
            parts = request_line.decode("latin-1").split()
            path = parts[1] if len(parts) > 1 else "/"
        except (asyncio.TimeoutError, ValueError):
            path = "/"
        while True:  # consume headers
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break

        if path.startswith("/metrics"):
            body = self.metrics.render()
            content_type = b"text/plain; version=0.0.4; charset=utf-8"
            status = b"200 OK"
        elif path.startswith("/status"):
            payload = {
                "uptime_seconds": round(time.time() - self.started_at, 1),
                "connections": self.connections,
                "pool": self.pool.stats(),
                "upstreams": [s.snapshot() for s in self.pool.states],
            }
            body = json.dumps(payload, indent=2).encode()
            content_type = b"application/json"
            status = b"200 OK"
        else:
            body = b"proxy-rotator\n/metrics\n/status\n"
            content_type = b"text/plain; charset=utf-8"
            status = b"200 OK"

        head = (
            f"HTTP/1.1 {status.decode()}\r\n"
            f"Content-Type: {content_type.decode()}\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode("latin-1")
        try:
            writer.write(head + body)
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass
        finally:
            writer.close()