"""Active health checks: probe every upstream, learn its exit IP and country."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from urllib.parse import urlsplit

from .geo import GeoResolver
from .http1 import http_get_via
from .link import open_tunnel
from .pool import Pool
from .state import UpstreamState

log = logging.getLogger("rotator.health")

__all__ = ["HealthChecker", "HealthConfig"]


@dataclass(slots=True)
class HealthConfig:
    url: str = "https://api.ipify.org?format=json"
    interval: float = 60.0
    timeout: float = 15.0
    concurrency: int = 20
    quarantine_secs: float = 90.0
    startup_delay: float = 2.0
    resolve_geo: bool = True
    geo_template: str = "https://ipwho.is/{ip}"
    country_header: str = "X-Rotator-Country"

    @property
    def use_tls(self) -> bool:
        return urlsplit(self.url).scheme == "https"


class HealthChecker:
    """Periodically probes each upstream through its own tunnel."""

    def __init__(self, pool: Pool, config: HealthConfig | None = None) -> None:
        self.pool = pool
        self.config = config or HealthConfig()
        self.geo = GeoResolver(
            template=self.config.geo_template, enabled=self.config.resolve_geo
        )
        self._task: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self.last_run: float = 0.0
        self.last_duration: float = 0.0

    async def start(self) -> None:
        if self._task is not None:
            return
        self._stop.clear()
        self._task = asyncio.create_task(self._loop(), name="rotator-health")

    async def stop(self) -> None:
        self._stop.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

    async def _loop(self) -> None:
        if self.config.startup_delay:
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.config.startup_delay)
                return
            except asyncio.TimeoutError:
                pass
        while not self._stop.is_set():
            await self.check_once()
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=self.config.interval)
            except asyncio.TimeoutError:
                continue

    async def check_once(self) -> int:
        started = time.monotonic()
        semaphore = asyncio.Semaphore(self.config.concurrency)

        async def guarded(state: UpstreamState) -> bool:
            async with semaphore:
                return await self.check_one(state)

        results = await asyncio.gather(
            *(guarded(s) for s in self.pool.states), return_exceptions=True
        )
        healthy = 0
        for state, result in zip(self.pool.states, results, strict=True):
            if isinstance(result, BaseException):
                state.note_failure(
                    f"probe crashed: {result}", quarantine_secs=self.config.quarantine_secs
                )
            elif result:
                healthy += 1
        self.last_run = started
        self.last_duration = time.monotonic() - started
        log.info("health check: %d/%d healthy in %.2fs", healthy, len(self.pool.states), self.last_duration)
        return healthy

    async def check_one(self, state: UpstreamState) -> bool:
        async with state.probe_lock:
            parts = urlsplit(self.config.url)
            host = parts.hostname or ""
            port = parts.port or (443 if self.config.use_tls else 80)
            if not host:
                state.note_failure("bad probe url", quarantine_secs=self.config.quarantine_secs)
                return False
            started = time.monotonic()
            try:
                reader, writer = await open_tunnel(state, host, port, timeout=self.config.timeout)
            except Exception as exc:  # noqa: BLE001
                state.note_failure(str(exc), quarantine_secs=self.config.quarantine_secs)
                return False
            try:
                head, body = await http_get_via(
                    reader,
                    writer,
                    self.config.url,
                    timeout=self.config.timeout,
                    use_tls=self.config.use_tls,
                )
            except Exception as exc:  # noqa: BLE001
                state.note_failure(f"probe request: {exc}", quarantine_secs=self.config.quarantine_secs)
                return False
            finally:
                writer.close()

            latency = (time.monotonic() - started) * 1000.0
            if head.status != 200:
                state.note_failure(f"probe status {head.status}", quarantine_secs=self.config.quarantine_secs)
                return False

            exit_ip, country = self._extract(body, head.get(self.config.country_header))
            if exit_ip is None and not self.config.resolve_geo:
                state.note_success(latency=latency, exit_ip=state.exit_ip)
                return True

            if country is None and exit_ip and self.config.resolve_geo:
                info = await self.geo.lookup(exit_ip)
                if info is not None:
                    country = info.country
            state.note_success(latency=latency, exit_ip=exit_ip, country=country)
            return True

    @staticmethod
    def _extract(body: bytes, header_country: str) -> tuple[str | None, str | None]:
        text = body.decode("utf-8", "replace").strip()
        ip: str | None = None
        country = header_country.strip().lower() or None
        if text.startswith("{") or text.startswith("["):
            try:
                payload = json.loads(text)
            except json.JSONDecodeError:
                payload = None
            if isinstance(payload, dict):
                for key in ("ip", "query", "origin", "address"):
                    value = payload.get(key)
                    if isinstance(value, str) and value:
                        ip = value.split(",")[0].strip()
                        break
                if country is None:
                    for key in ("country_code", "countryCode", "country"):
                        value = payload.get(key)
                        if isinstance(value, str) and value:
                            country = value.strip().lower()
                            break
        if ip is None and text and " " not in text and len(text) < 64:
            ip = text
        return ip, country