"""Runs the rotating proxy gateway in-process and exposes it to the dashboard."""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from rotator.config import build_pool, load_config
from rotator.gateway import GatewayConfig, RotatingGateway
from rotator.health import HealthChecker, HealthConfig
from rotator.http1 import http_get_via, read_response_head
from rotator.link import open_tunnel
from rotator.metrics import Metrics
from rotator.models import UpstreamSpec, parse_upstream_line
from rotator.pool import Pool, Strategy
from rotator.state import UpstreamState

log = logging.getLogger("netops.rotator")

__all__ = ["RotatorService", "ProbeOutcome"]

OVERRIDES_KEY = "rotator_pool_overrides"
PROBE_URL = "https://api.ipify.org?format=json"


@dataclass
class ProbeOutcome:
    upstream_id: str
    label: str
    ok: bool
    exit_ip: str | None = None
    country: str | None = None
    latency_ms: float | None = None
    error: str | None = None


class RotatorService:
    """Owns the event loop, gateway and health checker behind thread-safe calls."""

    def __init__(self, config_path: Path, database=None) -> None:
        self.config_path = Path(config_path)
        self.db = database
        self._loop: asyncio.AbstractEventLoop | None = None
        self._thread: threading.Thread | None = None
        self._gateway: RotatingGateway | None = None
        self._health: HealthChecker | None = None
        self._pool: Pool | None = None
        self._lock = threading.RLock()
        self._started_at: float | None = None
        self._error: str | None = None
        self.metrics = Metrics()

    # ------------------------------------------------------------- helpers
    @property
    def running(self) -> bool:
        return self._gateway is not None and self._loop is not None and self._loop.is_running()

    def _overrides(self) -> dict:
        if self.db is None:
            return {"added": [], "removed": [], "slots": {}}
        value = self.db.get_setting(OVERRIDES_KEY, None)
        if not isinstance(value, dict):
            return {"added": [], "removed": [], "slots": {}}
        value.setdefault("added", [])
        value.setdefault("removed", [])
        value.setdefault("slots", {})
        return value

    def _save_overrides(self, overrides: dict) -> None:
        if self.db is not None:
            self.db.set_setting(OVERRIDES_KEY, overrides)

    def build_pool(self) -> Pool:
        """Config files first, then dashboard additions, minus dashboard removals."""
        config = load_config(self.config_path)
        pool = build_pool(config)
        overrides = self._overrides()
        removed = set(overrides.get("removed", []))

        for index, state in enumerate(list(pool.states)):
            if state.id in removed:
                pool.remove_state(state.id)

        for entry in overrides.get("added", []):
            if not isinstance(entry, dict) or not entry.get("line"):
                continue
            try:
                spec = parse_upstream_line(entry["line"], source="dashboard")
            except ValueError:
                continue
            tier = int(entry.get("tier", 1))
            state = UpstreamState(spec=spec, tier=tier, max_slots=_as_int(entry.get("max_slots"), 0))
            pool.add_state(state)

        slots = overrides.get("slots", {})
        if isinstance(slots, dict):
            for upstream_id, value in slots.items():
                pool.set_slots(upstream_id, _as_int(value, 0))
        return pool

    # ------------------------------------------------------------ lifecycle
    def start(self) -> dict:
        with self._lock:
            if self.running:
                return self.status()
            try:
                pool = self.build_pool()
                config = load_config(self.config_path)
            except (ValueError, FileNotFoundError) as exc:
                self._error = str(exc)
                return {"ok": False, "error": str(exc)}

            ready = threading.Event()
            error: list[BaseException] = []

            def run() -> None:
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                self._loop = loop
                try:
                    loop.run_until_complete(self._boot(pool, config))
                    ready.set()
                    # stay alive until stop() asks the loop to finish
                    loop.run_forever()
                except BaseException as exc:  # noqa: BLE001
                    ready.set()
                    error.append(exc)
                    self._error = f"{type(exc).__name__}: {exc}"
                finally:
                    ready.set()
                    try:
                        if not loop.is_closed() and not loop.is_running():
                            loop.run_until_complete(self._teardown())
                    except Exception:  # noqa: BLE001
                        pass
                    try:
                        loop.close()
                    except Exception:  # noqa: BLE001
                        pass
                    self._loop = None
                    self._gateway = None
                    self._health = None
                    self._pool = None

            self._thread = threading.Thread(target=run, name="rotator-loop", daemon=True)
            self._thread.start()
            ready.wait(timeout=20)

            if error:
                return {"ok": False, "error": self._error or "gateway failed to start"}
            self._started_at = time.time()
            self._error = None
            return self.status()

    async def _boot(self, pool: Pool, config) -> None:
        gateway_config = GatewayConfig(
            host=config.gateway.host,
            port=config.gateway.port,
            socks_port=config.gateway.socks_port,
            metrics_port=config.gateway.metrics_port,
            username=config.gateway.username,
            password=config.gateway.password,
            connect_timeout=config.gateway.connect_timeout,
            max_attempts=config.gateway.max_attempts,
            idle_timeout=config.gateway.idle_timeout,
            sticky_ttl=config.gateway.sticky_ttl,
            sticky_by_peer=config.gateway.sticky_by_peer,
            default_country=config.gateway.default_country,
        )
        self._pool = pool
        self._gateway = RotatingGateway(pool, gateway_config, metrics=self.metrics)
        await self._gateway.start()
        health_config = config.health or HealthConfig(url=PROBE_URL)
        self._health = HealthChecker(pool, health_config)
        await self._health.start()
        log.info(
            "rotator started on %s:%s with %d upstreams",
            gateway_config.host,
            self._gateway.ports[0],
            len(pool),
        )

    async def _teardown(self) -> None:
        if self._health is not None:
            await self._health.stop()
            self._health = None
        if self._gateway is not None:
            await self._gateway.stop()
            self._gateway = None

    def stop(self, timeout: float = 15.0) -> dict:
        """Shut the listeners down inside the loop, then stop the loop itself.

        Stopping the loop first would leave the sockets bound, so the next
        start would fail with EADDRINUSE.
        """
        with self._lock:
            loop, thread = self._loop, self._thread
            if loop is None or thread is None:
                return {"ok": True, "already_stopped": True}
            if not loop.is_running():
                thread.join(timeout=timeout)
            else:
                future = asyncio.run_coroutine_threadsafe(self._teardown(), loop)
                try:
                    future.result(timeout=timeout)
                except Exception as exc:  # noqa: BLE001
                    log.warning("rotator teardown reported: %s", exc)
                try:
                    loop.call_soon_threadsafe(loop.stop)
                except RuntimeError as exc:  # loop already closed
                    log.debug("rotator loop already stopped: %s", exc)
                thread.join(timeout=timeout)
            self._thread = None
            self._pool = None
            self._started_at = None
            return {"ok": True, "stopped": True}

    def restart(self) -> dict:
        self.stop()
        time.sleep(0.2)
        return self.start()

    # ------------------------------------------------------------- queries
    def _run(self, coro, timeout: float = 90.0):
        loop = self._loop
        if loop is None or not loop.is_running():
            raise RuntimeError("rotator is not running")
        future = asyncio.run_coroutine_threadsafe(coro, loop)
        return future.result(timeout=timeout)

    def status(self) -> dict:
        with self._lock:
            pool = self._pool
            if not self.running or pool is None:
                return {
                    "ok": False,
                    "running": False,
                    "error": self._error,
                    "config_path": str(self.config_path),
                }
            http_port, socks_port, status_port = self._gateway.ports  # type: ignore[union-attr]
            return {
                "ok": True,
                "running": True,
                "uptime_seconds": round(time.time() - (self._started_at or time.time()), 1),
                "listeners": {
                    "http": f"{self._gateway.config.host}:{http_port}",  # type: ignore[union-attr]
                    "socks5": f"{self._gateway.config.host}:{socks_port}" if socks_port else None,
                    "status": f"{self._gateway.config.host}:{status_port}" if status_port else None,
                },
                "strategy": pool.strategy.value,
                "pool": pool.stats(),
                "upstreams": [state.snapshot() for state in pool.states],
            }

    def pool_snapshot(self) -> list[dict]:
        pool = self._pool
        return [state.snapshot() for state in pool.states] if pool else []

    def set_strategy(self, strategy: str) -> dict:
        try:
            value = Strategy(strategy)
        except ValueError as exc:
            return {"ok": False, "error": f"unknown strategy {strategy!r}"}
        if self._pool is not None:
            self._pool.set_strategy(value)
        self._persist_strategy(value.value)
        return {"ok": True, "strategy": value.value}

    def _persist_strategy(self, value: str) -> None:
        if self.db is None:
            return
        overrides = self._overrides()
        overrides["strategy"] = value
        self._save_overrides(overrides)

    def effective_strategy(self) -> str:
        overrides = self._overrides()
        return overrides.get("strategy") or "round_robin"

    def add_upstream(self, line: str, tier: int = 1, max_slots: int = 0) -> dict:
        try:
            spec = parse_upstream_line(line, source="dashboard")
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        overrides = self._overrides()
        removed = set(overrides.get("removed", []))
        overrides["removed"] = sorted(removed - {spec.id})

        pool = self._pool
        state = UpstreamState(spec=spec, tier=int(tier), max_slots=int(max_slots))
        if pool is not None and pool.get_state(spec.id) is not None:
            return {"ok": False, "error": f"{spec.label} is already in the pool"}
        overrides.setdefault("added", []).append(
            {"line": line.strip(), "tier": int(tier), "max_slots": int(max_slots)}
        )
        self._save_overrides(overrides)
        if pool is not None:
            pool.add_state(state)
        return {"ok": True, "upstream": state.snapshot()}

    def remove_upstream(self, upstream_id: str) -> dict:
        overrides = self._overrides()
        overrides["added"] = [
            entry for entry in overrides.get("added", [])
            if not _entry_matches(entry, upstream_id)
        ]
        overrides["removed"] = sorted(set(overrides.get("removed", [])) | {upstream_id})
        self._save_overrides(overrides)
        removed = bool(self._pool.remove_state(upstream_id)) if self._pool else False
        return {"ok": True, "removed": removed, "upstream_id": upstream_id}

    def restore_defaults(self) -> dict:
        self._save_overrides({"added": [], "removed": [], "slots": {}})
        return self.restart()

    def set_slots(self, upstream_id: str, max_slots: int) -> dict:
        if self._pool is None or not self._pool.set_slots(upstream_id, max_slots):
            return {"ok": False, "error": f"unknown upstream {upstream_id}"}
        overrides = self._overrides()
        overrides.setdefault("slots", {})[upstream_id] = int(max_slots)
        self._save_overrides(overrides)
        return {"ok": True, "upstream_id": upstream_id, "max_slots": int(max_slots)}

    def quarantine(self, upstream_id: str, seconds: float = 300.0) -> dict:
        if self._pool is None:
            return {"ok": False, "error": "rotator is not running"}
        state = self._pool.get_state(upstream_id)
        if state is None:
            return {"ok": False, "error": f"unknown upstream {upstream_id}"}
        state.note_failure("quarantined from dashboard", quarantine_secs=float(seconds))
        return {"ok": True, "upstream_id": upstream_id, "quarantine_seconds": seconds}

    # -------------------------------------------------------------- actions
    def check_all(self) -> dict:
        if not self.running or self._health is None:
            return {"ok": False, "error": "rotator is not running"}
        healthy = self._run(self._health.check_once())
        return {"ok": True, "healthy": healthy, "total": len(self._pool.states)}  # type: ignore[union-attr]

    async def _probe_state(self, state: UpstreamState, url: str) -> ProbeOutcome:
        parts = urlsplit(url)
        use_tls = parts.scheme == "https"
        host = parts.hostname or ""
        port = parts.port or (443 if use_tls else 80)
        started = time.monotonic()
        try:
            reader, writer = await open_tunnel(state, host, port, timeout=20)
        except Exception as exc:  # noqa: BLE001
            state.note_failure(str(exc))
            return ProbeOutcome(
                upstream_id=state.id, label=state.spec.label, ok=False, error=str(exc)[:200]
            )
        try:
            head, body = await http_get_via(reader, writer, url, timeout=20, use_tls=use_tls)
        except Exception as exc:  # noqa: BLE001
            state.note_failure(str(exc))
            return ProbeOutcome(
                upstream_id=state.id, label=state.spec.label, ok=False, error=str(exc)[:200]
            )
        finally:
            writer.close()

        latency = round((time.monotonic() - started) * 1000, 1)
        if head.status != 200:
            state.note_failure(f"probe status {head.status}")
            return ProbeOutcome(
                upstream_id=state.id, label=state.spec.label, ok=False,
                error=f"HTTP {head.status}", latency_ms=latency,
            )
        from rotator.health import HealthChecker as _HC

        exit_ip, country = _HC._extract(body, "")
        if not country and exit_ip and self._health is not None:
            info = await self._health.geo.lookup(exit_ip)
            country = info.country if info else None
        state.note_success(latency=latency, exit_ip=exit_ip, country=country)
        return ProbeOutcome(
            upstream_id=state.id, label=state.spec.label, ok=True, exit_ip=exit_ip,
            country=country, latency_ms=latency,
        )

    def probe_all(self, url: str = PROBE_URL) -> list[dict]:
        """Check every upstream by fetching its real exit IP."""
        if not self.running or self._pool is None:
            return []
        states = list(self._pool.states)

        async def run_all() -> list[ProbeOutcome]:
            semaphore = asyncio.Semaphore(10)

            async def guarded(state: UpstreamState) -> ProbeOutcome:
                async with semaphore:
                    return await self._probe_state(state, url)

            return list(await asyncio.gather(*(guarded(s) for s in states)))

        return [outcome.__dict__ for outcome in self._run(run_all(), timeout=180)]

    def rotation_test(self, requests: int = 6, url: str = PROBE_URL) -> dict:
        """Send N requests through the gateway's own listener and compare exit IPs."""
        if not self.running or self._gateway is None:
            return {"ok": False, "error": "rotator is not running"}
        requests = max(1, min(int(requests), 25))
        gateway = self._gateway

        async def one() -> dict:
            parts = urlsplit(url)
            use_tls = parts.scheme == "https"
            port = parts.port or (443 if use_tls else 80)
            host = parts.hostname or ""
            started = time.monotonic()
            reader, writer = await asyncio.open_connection(
                gateway.config.host, gateway.ports[0]
            )
            try:
                writer.write(
                    f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode()
                )
                await writer.drain()
                head = await asyncio.wait_for(read_response_head(reader), timeout=25)
                if head.status != 200:
                    return {"ok": False, "status": head.status,
                            "error": f"gateway replied {head.status} {head.reason}"}
                _, body = await http_get_via(reader, writer, url, timeout=25, use_tls=use_tls)
            finally:
                writer.close()
            from rotator.health import HealthChecker as _HC

            exit_ip, country = _HC._extract(body, "")
            return {
                "ok": True,
                "exit_ip": exit_ip,
                "country": country,
                "upstream_id": head.get("X-Rotator-Upstream"),
                "ms": round((time.monotonic() - started) * 1000, 1),
            }

        async def run_all() -> list[dict]:
            return list(await asyncio.gather(*(one() for _ in range(requests))))

        results = self._run(run_all(), timeout=120)
        exits = {r.get("exit_ip") for r in results if r.get("ok") and r.get("exit_ip")}
        return {
            "ok": bool(results),
            "requests": results,
            "distinct_exit_ips": len(exits),
            "rotation_ratio": round(len(exits) / len(results), 3) if results else 0.0,
        }

    def burp_export(self) -> dict:
        """Formats Burp needs to push traffic through this pool."""
        pool = self._pool
        rows = []
        for state in pool.states if pool else []:
            spec: UpstreamSpec = state.spec
            if not spec.username:
                continue
            rows.append(
                {
                    "upstream": f"{spec.host}:{spec.port}",
                    "username": spec.username,
                    "password": spec.password or "",
                    "scheme": "SOCKS5" if spec.kind.value == "socks5" else "HTTP",
                    "our_upstream_id": state.id,
                }
            )
        lines = [f"{r['upstream']}:{r['username']}:{r['password']}" for r in rows]
        return {
            "count": len(rows),
            "entries": rows,
            "proxy_list_lines": lines,
            "burp_steps": [
                "Burp Proxy > Proxy settings > Upstream proxies > add one entry per line above",
                "Set the upstream scheme to HTTP or SOCKS5 as shown",
                "Alternatively point Burp at the rotating listener for automatic rotation: "
                f"{self.status().get('listeners', {}).get('http') if self.running else '127.0.0.1:8888'}",
            ],
        }

    def metrics_text(self) -> str:
        return self.metrics.render().decode("utf-8", "replace")


def _as_int(value, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _entry_matches(entry: dict, upstream_id: str) -> bool:
    if not isinstance(entry, dict) or not entry.get("line"):
        return False
    try:
        return parse_upstream_line(entry["line"]).id == upstream_id
    except ValueError:
        return False