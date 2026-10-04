"""Upstream selection: strategies, sticky sessions, geo filtering, tier failover."""

from __future__ import annotations

import itertools
import random
import time
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import Enum

from .state import UpstreamState

__all__ = ["Strategy", "Lease", "Pool", "NoUpstreamAvailable"]


class Strategy(str, Enum):
    ROUND_ROBIN = "round_robin"
    RANDOM = "random"
    WEIGHTED_RANDOM = "weighted_random"
    LEAST_USED = "least_used"
    FASTEST = "fastest"


class NoUpstreamAvailable(RuntimeError):
    pass


@dataclass
class Lease:
    """A reserved slot on an upstream. Release it exactly once."""

    state: UpstreamState
    strategy: Strategy
    acquired_at: float
    sticky_key: str | None = None
    _released: bool = False

    @property
    def upstream_id(self) -> str:
        return self.state.id

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self.state.release_slot()


class Pool:
    """Holds every upstream grouped into priority tiers."""

    def __init__(
        self,
        states: Iterable[UpstreamState],
        *,
        strategy: Strategy = Strategy.ROUND_ROBIN,
        sticky_ttl: float = 300.0,
        seed: int | None = None,
    ) -> None:
        self.states: list[UpstreamState] = list(states)
        self.by_id: dict[str, UpstreamState] = {s.id: s for s in self.states}
        self.strategy = strategy
        self.sticky_ttl = sticky_ttl
        self._rng = random.Random(seed)
        self._cursor = itertools.count()
        self._sticky: dict[str, tuple[str, float]] = {}
        self.tiers_cache: set[int] = {s.tier for s in self.states}

    def __len__(self) -> int:
        return len(self.states)

    # ---------------------------------------------------------------- tiers
    @property
    def tiers(self) -> list[int]:
        return sorted(self.tiers_cache)

    def tier_states(self, tier: int) -> list[UpstreamState]:
        return [s for s in self.states if s.tier == tier]

    def available(self) -> list[UpstreamState]:
        return [s for s in self.states if s.available]

    # ------------------------------------------------------------ selection
    def _matches(
        self,
        state: UpstreamState,
        *,
        country: str | None,
        tags: Sequence[str],
        exclude: frozenset[str],
    ) -> bool:
        if state.id in exclude or not state.available:
            return False
        if country:
            cc = state.effective_country()
            if not cc or cc != country.lower():
                return False
        if tags:
            have = {t.lower() for t in state.spec.tags}
            if not all(t.lower() in have for t in tags):
                return False
        return True

    def _pick(self, candidates: list[UpstreamState]) -> UpstreamState:
        strategy = self.strategy
        if strategy is Strategy.RANDOM:
            return self._rng.choice(candidates)
        if strategy is Strategy.WEIGHTED_RANDOM:
            weights = [max(1, c.spec.weight) for c in candidates]
            return self._rng.choices(candidates, weights=weights, k=1)[0]
        if strategy is Strategy.LEAST_USED:
            return min(candidates, key=lambda c: (c.in_use, -c.spec.weight))
        if strategy is Strategy.FASTEST:
            return min(
                candidates,
                key=lambda c: (c.latency if c.latency is not None else 1e9, -c.spec.weight),
            )
        # round robin: cursor walks the candidate list
        offset = next(self._cursor)
        return candidates[offset % len(candidates)]

    def _sticky_get(self, key: str) -> UpstreamState | None:
        entry = self._sticky.get(key)
        if not entry:
            return None
        upstream_id, expires = entry
        if expires < time.monotonic():
            self._sticky.pop(key, None)
            return None
        return self.by_id.get(upstream_id)

    def _sticky_put(self, key: str, state: UpstreamState) -> None:
        self._sticky[key] = (state.id, time.monotonic() + self.sticky_ttl)

    def acquire(
        self,
        *,
        country: str | None = None,
        tags: Sequence[str] = (),
        sticky_key: str | None = None,
        exclude: Iterable[str] = (),
    ) -> Lease:
        """Reserve an upstream, walking tiers from the most to least preferred."""
        excluded = frozenset(exclude)
        if sticky_key:
            state = self._sticky_get(sticky_key)
            if state is not None and self._matches(
                state, country=country, tags=tags, exclude=excluded
            ):
                state.acquire_slot()
                return Lease(
                    state=state,
                    strategy=self.strategy,
                    acquired_at=time.monotonic(),
                    sticky_key=sticky_key,
                )

        for tier in self.tiers:
            candidates = [
                s
                for s in self.tier_states(tier)
                if self._matches(s, country=country, tags=tags, exclude=excluded)
            ]
            if not candidates:
                continue
            state = self._pick(candidates)
            state.acquire_slot()
            if sticky_key:
                self._sticky_put(sticky_key, state)
            return Lease(
                state=state,
                strategy=self.strategy,
                acquired_at=time.monotonic(),
                sticky_key=sticky_key,
            )

        raise NoUpstreamAvailable(
            "no healthy upstream with a free slot "
            f"(country={country!r} tags={tuple(tags)} exclude={tuple(excluded)})"
        )

    def release(self, lease: Lease) -> None:
        lease.release()

    # ------------------------------------------------------- live mutation
    def add_state(self, state: UpstreamState) -> bool:
        """Insert an upstream at runtime (dashboard edits). Returns False on duplicates."""
        if state.id in self.by_id:
            return False
        self.states.append(state)
        self.by_id[state.id] = state
        if state.tier not in self.tiers_cache:
            self.tiers_cache.add(state.tier)
        self._invalidate()
        return True

    def remove_state(self, upstream_id: str) -> bool:
        state = self.by_id.get(upstream_id)
        if state is None:
            return False
        self.states.remove(state)
        del self.by_id[upstream_id]
        self._sticky = {
            key: entry for key, entry in self._sticky.items() if entry[0] != upstream_id
        }
        self._invalidate()
        return True

    def get_state(self, upstream_id: str) -> UpstreamState | None:
        return self.by_id.get(upstream_id)

    def set_strategy(self, strategy: Strategy) -> None:
        self.strategy = strategy

    def set_slots(self, upstream_id: str, max_slots: int) -> bool:
        state = self.by_id.get(upstream_id)
        if state is None:
            return False
        state.max_slots = max(0, int(max_slots))
        return True

    def reset_counters(self) -> None:
        for state in self.states:
            state.consecutive_failures = 0
            state.alive = True
            state.quarantined_until = 0.0
            state.last_error = None

    def _invalidate(self) -> None:
        self.tiers_cache = {s.tier for s in self.states}

    def stats(self) -> dict[str, object]:
        healthy = sum(1 for s in self.states if s.healthy)
        exit_ips = {s.exit_ip for s in self.states if s.exit_ip}
        countries = sorted({s.effective_country() for s in self.states if s.effective_country()})
        return {
            "upstreams": len(self.states),
            "healthy": healthy,
            "in_use": sum(s.in_use for s in self.states),
            "distinct_exit_ips": len(exit_ips),
            "countries": countries,
            "strategy": self.strategy.value,
        }