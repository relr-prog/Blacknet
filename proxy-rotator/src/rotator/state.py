"""Runtime state for a single upstream (health, latency, slots, geo)."""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .models import UpstreamSpec

if TYPE_CHECKING:  # pragma: no cover
    pass


@dataclass
class UpstreamState:
    spec: UpstreamSpec
    tier: int = 0
    max_slots: int = 0
    in_use: int = 0
    alive: bool = True
    latency: float | None = None
    exit_ip: str | None = None
    country: str | None = None
    consecutive_failures: int = 0
    total_success: int = 0
    total_failure: int = 0
    bytes_up: int = 0
    bytes_down: int = 0
    last_check: float = 0.0
    last_error: str | None = None
    quarantined_until: float = 0.0
    probe_lock: asyncio.Lock = field(default_factory=lambda: asyncio.Lock(), repr=False)

    @property
    def id(self) -> str:
        return self.spec.id

    @property
    def healthy(self) -> bool:
        return self.alive and time.monotonic() >= self.quarantined_until

    @property
    def has_slot(self) -> bool:
        return self.max_slots == 0 or self.in_use < self.max_slots

    @property
    def available(self) -> bool:
        return self.healthy and self.has_slot

    def effective_country(self) -> str | None:
        return self.country or self.spec.country

    def note_success(
        self,
        *,
        latency: float | None = None,
        exit_ip: str | None = None,
        country: str | None = None,
        now: float | None = None,
    ) -> None:
        now = time.monotonic() if now is None else now
        self.alive = True
        self.consecutive_failures = 0
        self.quarantined_until = 0.0
        self.total_success += 1
        self.last_check = now
        self.last_error = None
        if latency is not None:
            # EWMA keeps selection stable across noisy probes
            self.latency = latency if self.latency is None else 0.7 * self.latency + 0.3 * latency
        if exit_ip:
            self.exit_ip = exit_ip
        if country:
            self.country = country.lower()

    def note_failure(self, error: str, *, now: float | None = None, quarantine_secs: float = 60.0) -> None:
        now = time.monotonic() if now is None else now
        self.consecutive_failures += 1
        self.total_failure += 1
        self.last_error = error[:200]
        self.last_check = now
        self.alive = False
        # a first failure gets a short timeout, repeated ones a full window
        delay = quarantine_secs if self.consecutive_failures >= 2 else max(5.0, quarantine_secs / 3)
        self.quarantined_until = now + delay

    def acquire_slot(self) -> None:
        self.in_use += 1

    def release_slot(self) -> None:
        if self.in_use > 0:
            self.in_use -= 1

    def snapshot(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.spec.label,
            "kind": self.spec.kind.value,
            "tier": self.tier,
            "weight": self.spec.weight,
            "in_use": self.in_use,
            "max_slots": self.max_slots or "unlimited",
            "healthy": self.healthy,
            "latency_ms": round(self.latency, 1) if self.latency is not None else None,
            "exit_ip": self.exit_ip,
            "country": self.effective_country(),
            "ok": self.total_success,
            "fail": self.total_failure,
            "tags": sorted(self.spec.tags),
            "last_error": self.last_error,
        }