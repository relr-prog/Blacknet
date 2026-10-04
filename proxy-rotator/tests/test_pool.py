from __future__ import annotations

import time

import pytest

from rotator.models import parse_upstream_line
from rotator.pool import NoUpstreamAvailable, Pool, Strategy
from rotator.state import UpstreamState


def state(host: str, *, tier: int = 0, country: str | None = None, weight: int = 1,
         tags: tuple[str, ...] = (), max_slots: int = 0, latency: float | None = None,
         healthy: bool = True, spec_id: str | None = None) -> UpstreamState:
    fragment = ""
    parts = []
    if weight != 1:
        parts.append(f"weight={weight}")
    if country:
        parts.append(f"country={country}")
    if tags:
        parts.append(f"tags={','.join(tags)}")
    if parts:
        fragment = "#" + ";".join(parts)
    spec = parse_upstream_line(f"http://{host}:8080{fragment}")
    st = UpstreamState(spec=spec, tier=tier, max_slots=max_slots)
    if latency is not None:
        st.latency = latency
    if not healthy:
        st.alive = False
    return st


def test_round_robin_cycles_through_every_upstream():
    pool = Pool([state("1.1.1.1"), state("2.2.2.2"), state("3.3.3.3")])
    picked = [pool.acquire().state.spec.host for _ in range(6)]
    assert picked == ["1.1.1.1", "2.2.2.2", "3.3.3.3"] * 2


def test_random_strategy_uses_all_upstreams():
    pool = Pool([state("1.1.1.1"), state("2.2.2.2"), state("3.3.3.3")], strategy=Strategy.RANDOM, seed=7)
    picked = {pool.acquire().state.spec.host for _ in range(60)}
    assert len(picked) == 3


def test_weighted_random_respects_weights():
    pool = Pool(
        [state("1.1.1.1", weight=1), state("2.2.2.2", weight=20)],
        strategy=Strategy.WEIGHTED_RANDOM,
        seed=11,
    )
    counts: dict[str, int] = {}
    for _ in range(400):
        host = pool.acquire().state.spec.host
        counts[host] = counts.get(host, 0) + 1
    assert counts["2.2.2.2"] > counts["1.1.1.1"] * 5


def test_least_used_and_fastest():
    pool = Pool(
        [state("1.1.1.1", latency=90.0), state("2.2.2.2", latency=10.0)],
        strategy=Strategy.FASTEST,
    )
    assert pool.acquire().state.spec.host == "2.2.2.2"

    busy, idle = state("1.1.1.1"), state("2.2.2.2")
    busy.in_use = 1
    pool = Pool([busy, idle], strategy=Strategy.LEAST_USED)
    assert pool.acquire().state is idle


def test_lease_releases_slot_and_is_idempotent():
    one = state("1.1.1.1", max_slots=1)
    pool = Pool([one])
    lease = pool.acquire()
    assert one.in_use == 1
    with pytest.raises(NoUpstreamAvailable):
        pool.acquire()
    lease.release()
    lease.release()
    assert one.in_use == 0
    assert pool.acquire().state is one


def test_unhealthy_and_quarantined_upstreams_are_skipped():
    broken = state("1.1.1.1")
    broken.note_failure("boom", now=time.monotonic(), quarantine_secs=300)
    good = state("2.2.2.2")
    pool = Pool([broken, good])
    assert pool.acquire().state is good
    assert broken.healthy is False


def test_sticky_sessions_reuse_the_same_upstream():
    pool = Pool([state("1.1.1.1"), state("2.2.2.2")], sticky_ttl=60)
    first = pool.acquire(sticky_key="session-a")
    for _ in range(5):
        assert pool.acquire(sticky_key="session-a").state is first.state
    assert pool.acquire(sticky_key="session-b").state is not first.state


def test_sticky_expires():
    pool = Pool([state("1.1.1.1"), state("2.2.2.2")], sticky_ttl=0.01)
    first = pool.acquire(sticky_key="session-a").state
    time.sleep(0.03)
    assert pool.acquire(sticky_key="session-a").state is not first


def test_country_filter():
    us = state("1.1.1.1", country="us")
    de = state("2.2.2.2", country="de")
    pool = Pool([us, de])
    assert pool.acquire(country="DE").state is de
    with pytest.raises(NoUpstreamAvailable):
        pool.acquire(country="fr")


def test_country_can_come_from_a_health_probe():
    probed = state("1.1.1.1")
    assert probed.effective_country() is None
    probed.note_success(exit_ip="9.9.9.9", country="GB")
    pool = Pool([probed])
    assert pool.acquire(country="gb").state is probed


def test_tag_filter_requires_all_tags():
    fast = state("1.1.1.1", tags=("fast", "eu"))
    slow = state("2.2.2.2", tags=("fast",))
    pool = Pool([fast, slow])
    assert pool.acquire(tags=("eu",)).state is fast
    with pytest.raises(NoUpstreamAvailable):
        pool.acquire(tags=("eu", "residential"))


def test_tier_failover_prefers_the_first_healthy_tier():
    premium = state("1.1.1.1", tier=0)
    backup = state("2.2.2.2", tier=1)
    pool = Pool([premium, backup])
    assert pool.acquire().state is premium

    premium.note_failure("down", quarantine_secs=300)
    assert pool.acquire().state is backup


def test_exclusion_forces_the_next_candidate():
    first, second = state("1.1.1.1"), state("2.2.2.2")
    pool = Pool([first, second])
    lease = pool.acquire(exclude=[first.id])
    assert lease.state is second


def test_stats_summarises_the_pool():
    a = state("1.1.1.1", country="us")
    a.note_success(exit_ip="5.5.5.5")
    b = state("2.2.2.2", country="de")
    b.note_success(exit_ip="6.6.6.6")
    stats = Pool([a, b]).stats()
    assert stats["upstreams"] == 2
    assert stats["healthy"] == 2
    assert stats["distinct_exit_ips"] == 2
    assert stats["countries"] == ["de", "us"]


def test_tiers_are_tracked_on_construction():
    pool = Pool([state("1.1.1.1", tier=0), state("2.2.2.2", tier=1), state("3.3.3.3")])
    assert pool.tiers == [0, 1]


def test_add_state_registers_the_new_tier():
    pool = Pool([state("1.1.1.1", tier=0)])
    assert pool.tiers == [0]
    assert pool.add_state(state("2.2.2.2", tier=3)) is True
    assert pool.tiers == [0, 3]
    assert pool.get_state(pool.states[1].id) is pool.states[1]
    # a duplicate id is refused
    assert pool.add_state(state("1.1.1.1")) is False
    assert len(pool) == 2


def test_remove_state_drops_the_tier_when_empty():
    pool = Pool([state("1.1.1.1", tier=0), state("2.2.2.2", tier=1)])
    only = pool.states[0]
    assert pool.remove_state(only.id) is True
    assert pool.tiers == [1]
    assert pool.remove_state("does-not-exist") is False
    assert pool.get_state(only.id) is None


def test_strategy_and_slot_limits_apply_to_added_states():
    pool = Pool([state("1.1.1.1")], strategy=Strategy.FASTEST)
    pool.set_strategy(Strategy.ROUND_ROBIN)
    assert pool.strategy is Strategy.ROUND_ROBIN

    pool.add_state(state("2.2.2.2", tier=1))
    target = pool.states[1]
    assert pool.set_slots(target.id, 1) is True
    lease = pool.acquire()
    lease.release()
    # slot limits survive the mutation API
    assert pool.set_slots(target.id, 0) is True
    assert pool.set_slots("nope", 2) is False


def test_reset_counters_clears_health_history():
    broken = state("1.1.1.1")
    broken.note_failure("boom", quarantine_secs=600)
    pool = Pool([broken])
    assert broken.healthy is False
    pool.reset_counters()
    assert broken.healthy is True