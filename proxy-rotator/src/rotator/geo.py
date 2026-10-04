"""IP -> country/ASN lookups with caching and polite rate limiting."""

from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import Any

import aiohttp

__all__ = ["GeoInfo", "GeoResolver"]

_IP_KEYS = ("ip", "query", "origin", "address")
_COUNTRY_KEYS = ("country_code", "countryCode", "country_code_iso", "country")


@dataclass(frozen=True, slots=True)
class GeoInfo:
    ip: str
    country: str | None = None
    asn: str | None = None
    org: str | None = None
    city: str | None = None

    @classmethod
    def from_payload(cls, ip: str, payload: dict[str, Any]) -> GeoInfo:
        def pick(*keys: str) -> Any:
            for key in keys:
                value = payload.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
            return None

        return cls(
            ip=pick(*_IP_KEYS) or ip,
            country=(pick(*_COUNTRY_KEYS) or None),
            asn=pick("asn", "as", "asn_org") or None,
            org=pick("org", "isp", "connection", "organization") or None,
            city=pick("city") or None,
        )


class GeoResolver:
    """Resolve exit IPs through a free JSON endpoint, cached in memory."""

    def __init__(
        self,
        template: str = "https://ipwho.is/{ip}",
        *,
        ttl: float = 86_400.0,
        timeout: float = 10.0,
        min_interval: float = 0.25,
        enabled: bool = True,
    ) -> None:
        self.template = template
        self.ttl = ttl
        self.timeout = timeout
        self.min_interval = min_interval
        self.enabled = enabled
        self._cache: dict[str, tuple[float, GeoInfo | None]] = {}
        self._lock = asyncio.Lock()
        self._last_call = 0.0

    def cached(self, ip: str) -> GeoInfo | None:
        entry = self._cache.get(ip)
        if not entry:
            return None
        expires, info = entry
        if expires < time.monotonic():
            self._cache.pop(ip, None)
            return None
        return info

    async def _throttle(self) -> None:
        async with self._lock:
            wait = self._last_call + self.min_interval - time.monotonic()
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_call = time.monotonic()

    async def lookup(self, ip: str) -> GeoInfo | None:
        if not self.enabled:
            return None
        hit = self.cached(ip)
        if hit is not None:
            return hit
        await self._throttle()
        url = self.template.replace("{ip}", ip)
        try:
            timeout = aiohttp.ClientTimeout(total=self.timeout)
            async with aiohttp.ClientSession(timeout=timeout) as session:
                async with session.get(url) as response:
                    if response.status != 200:
                        self._cache[ip] = (time.monotonic() + 300.0, None)
                        return None
                    payload = await response.json(content_type=None)
        except (aiohttp.ClientError, asyncio.TimeoutError, json.JSONDecodeError, ValueError):
            self._cache[ip] = (time.monotonic() + 300.0, None)
            return None

        info = GeoInfo.from_payload(ip, payload if isinstance(payload, dict) else {})
        self._cache[ip] = (time.monotonic() + self.ttl, info)
        return info

    async def resolve_many(self, ips: list[str]) -> dict[str, GeoInfo]:
        if not self.enabled or not ips:
            return {}
        pending = [ip for ip in dict.fromkeys(ips) if self.cached(ip) is None]
        if pending:
            await asyncio.gather(*(self.lookup(ip) for ip in pending), return_exceptions=True)
        return {ip: self.cached(ip) for ip in ips if self.cached(ip) is not None}