"""Prometheus instrumentation."""

from __future__ import annotations

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

__all__ = ["Metrics", "CONTENT_TYPE_LATEST", "render"]

CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"


class Metrics:
    def __init__(self, registry: CollectorRegistry | None = None) -> None:
        self.registry = registry or CollectorRegistry()
        self.requests = Counter(
            "rotator_requests_total",
            "Client requests handled",
            ["mode"],
            registry=self.registry,
        )
        self.rotations = Counter(
            "rotator_rotations_total",
            "Upstream selections",
            ["upstream_id", "tier"],
            registry=self.registry,
        )
        self.failures = Counter(
            "rotator_upstream_failures_total",
            "Upstream connection failures",
            ["upstream_id", "reason"],
            registry=self.registry,
        )
        self.no_upstream = Counter(
            "rotator_no_upstream_total",
            "Requests rejected because no upstream was available",
            registry=self.registry,
        )
        self.duration = Histogram(
            "rotator_upstream_connect_seconds",
            "Time to establish a tunnel through an upstream",
            ["upstream_id"],
            buckets=(0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30),
            registry=self.registry,
        )
        self.bytes = Counter(
            "rotator_relayed_bytes_total",
            "Bytes relayed",
            ["direction"],
            registry=self.registry,
        )
        self.in_use = Gauge(
            "rotator_upstream_in_use",
            "Active tunnels per upstream",
            ["upstream_id"],
            registry=self.registry,
        )
        self.healthy = Gauge(
            "rotator_upstream_healthy",
            "1 when the upstream is considered healthy",
            ["upstream_id"],
            registry=self.registry,
        )
        self.exit_ip_info = Gauge(
            "rotator_upstream_info",
            "Exit IP of an upstream, exposed as a label",
            ["upstream_id", "exit_ip", "country"],
            registry=self.registry,
        )

    def observe_pool(self, pool) -> None:
        for state in pool.states:
            self.in_use.labels(upstream_id=state.id).set(state.in_use)
            self.healthy.labels(upstream_id=state.id).set(1 if state.healthy else 0)
            if state.exit_ip:
                self.exit_ip_info.labels(
                    upstream_id=state.id,
                    exit_ip=state.exit_ip,
                    country=state.effective_country() or "",
                ).set(1)

    def render(self) -> bytes:
        return generate_latest(self.registry)