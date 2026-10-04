"""TOML configuration loading and pool construction."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

from .gateway import GatewayConfig
from .health import HealthConfig
from .models import UpstreamKind, UpstreamSpec, parse_pool_text
from .pool import Pool, Strategy
from .state import UpstreamState

__all__ = ["TierConfig", "AppConfig", "load_config", "build_pool"]

DEFAULT_POOL_DIR = "pools"


@dataclass
class TierConfig:
    name: str
    strategy: Strategy = Strategy.ROUND_ROBIN
    max_slots: int = 0
    tags: tuple[str, ...] = ()
    files: tuple[str, ...] = ()
    inline: tuple[str, ...] = ()
    kind: UpstreamKind = UpstreamKind.HTTP
    country: str | None = None


@dataclass
class AppConfig:
    gateway: GatewayConfig = field(default_factory=GatewayConfig)
    health: HealthConfig | None = None
    tiers: list[TierConfig] = field(default_factory=list)
    strategy: Strategy = Strategy.ROUND_ROBIN
    root: Path = field(default_factory=Path.cwd)

    @property
    def total_upstreams(self) -> int:
        return sum(len(t.files) + len(t.inline) for t in self.tiers)


def _tier_from_table(raw: dict, index: int) -> TierConfig:
    strategy_raw = str(raw.get("strategy", "round_robin"))
    try:
        strategy = Strategy(strategy_raw)
    except ValueError as exc:
        raise ValueError(f"tier #{index}: unknown strategy {strategy_raw!r}") from exc
    kind_raw = str(raw.get("kind", "http"))
    try:
        kind = UpstreamKind(kind_raw)
    except ValueError as exc:
        raise ValueError(f"tier #{index}: unknown kind {kind_raw!r}") from exc
    files = raw.get("files") or []
    inline = raw.get("inline") or []
    if isinstance(files, str):
        files = [files]
    if isinstance(inline, str):
        inline = [inline]
    if not files and not inline:
        raise ValueError(f"tier #{index}: needs at least one of 'files' or 'inline'")
    return TierConfig(
        name=str(raw.get("name", f"tier{index}")),
        strategy=strategy,
        max_slots=int(raw.get("max_slots", 0)),
        tags=tuple(str(t).lower() for t in raw.get("tags", ())),
        files=tuple(str(f) for f in files),
        inline=tuple(str(s) for s in inline),
        kind=kind,
        country=(str(raw["country"]).lower() if raw.get("country") else None),
    )


def load_config(path: str | Path) -> AppConfig:
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise FileNotFoundError(path)
    data = tomllib.loads(path.read_text(encoding="utf-8"))

    gateway_raw = data.get("gateway", {})
    gateway = GatewayConfig(
        host=str(gateway_raw.get("host", "127.0.0.1")),
        port=int(gateway_raw.get("port", 8888)),
        socks_port=int(gateway_raw.get("socks_port", 0)),
        metrics_port=int(gateway_raw.get("metrics_port", 0)),
        username=gateway_raw.get("username"),
        password=gateway_raw.get("password"),
        connect_timeout=float(gateway_raw.get("connect_timeout", 15.0)),
        head_timeout=float(gateway_raw.get("head_timeout", 30.0)),
        max_attempts=int(gateway_raw.get("max_attempts", 3)),
        idle_timeout=float(gateway_raw.get("idle_timeout", 300.0)),
        sticky_ttl=float(gateway_raw.get("sticky_ttl", 300.0)),
        sticky_by_peer=bool(gateway_raw.get("sticky_by_peer", False)),
        default_country=(
            str(gateway_raw["default_country"]).lower()
            if gateway_raw.get("default_country")
            else None
        ),
    )
    try:
        strategy = Strategy(str(gateway_raw.get("strategy", Strategy.ROUND_ROBIN.value)))
    except ValueError as exc:
        raise ValueError(f"gateway.strategy: {exc}") from exc

    health_raw = data.get("health")
    health = None
    if health_raw is not None:
        health = HealthConfig(
            url=str(health_raw.get("url", "https://api.ipify.org?format=json")),
            interval=float(health_raw.get("interval", 60.0)),
            timeout=float(health_raw.get("timeout", 15.0)),
            concurrency=int(health_raw.get("concurrency", 20)),
            quarantine_secs=float(health_raw.get("quarantine_secs", 90.0)),
            startup_delay=float(health_raw.get("startup_delay", 2.0)),
            resolve_geo=bool(health_raw.get("resolve_geo", True)),
            geo_template=str(health_raw.get("geo_template", "https://ipwho.is/{ip}")),
        )

    tiers = [_tier_from_table(t, i) for i, t in enumerate(data.get("tier", []))]
    if not tiers:
        raise ValueError("config has no [[tier]] sections")

    return AppConfig(
        gateway=gateway, health=health, tiers=tiers, strategy=strategy, root=path.parent
    )


def _with_defaults(spec: UpstreamSpec, tier: TierConfig) -> UpstreamSpec:
    from dataclasses import replace

    changes: dict[str, object] = {}
    if tier.country and not spec.country:
        changes["country"] = tier.country
    if tier.tags:
        changes["tags"] = frozenset(set(spec.tags) | set(tier.tags))
    return replace(spec, **changes) if changes else spec


def build_pool(config: AppConfig, *, strategy: Strategy | None = None) -> Pool:
    states: list[UpstreamState] = []
    warnings: list[str] = []
    seen: set[str] = set()

    for tier_index, tier in enumerate(config.tiers):
        specs: list[UpstreamSpec] = []
        for rel in tier.files:
            candidate = Path(rel)
            if not candidate.is_absolute():
                candidate = config.root / rel
            if not candidate.is_file():
                warnings.append(f"tier {tier.name}: missing pool file {candidate}")
                continue
            try:
                specs.extend(
                    parse_pool_text(
                        candidate.read_text(encoding="utf-8"),
                        default_kind=tier.kind,
                        source=str(candidate),
                    )
                )
            except ValueError as exc:
                warnings.append(str(exc))
        for line in tier.inline:
            try:
                specs.extend(_parse_inline(line, tier, config.root))
            except ValueError as exc:
                warnings.append(f"tier {tier.name}: {exc}")

        for spec in specs:
            spec = _with_defaults(spec, tier)
            if spec.id in seen:
                continue
            seen.add(spec.id)
            states.append(
                UpstreamState(spec=spec, tier=tier_index, max_slots=tier.max_slots)
            )

    for message in warnings:
        print(f"warning: {message}")
    if not states:
        raise ValueError("no usable upstreams configured")
    return Pool(
        states,
        strategy=strategy or config.strategy,
        sticky_ttl=config.gateway.sticky_ttl,
    )


def _parse_inline(line: str, tier: TierConfig, root: Path) -> list[UpstreamSpec]:
    from .models import parse_upstream_line

    candidate = line.strip()
    path = Path(candidate)
    if not path.is_absolute():
        path = root / path
    if not candidate.startswith(("http://", "https://", "socks5://", "socks5h://", "direct:")) and path.is_file():
        return parse_pool_text(
            path.read_text(encoding="utf-8"), default_kind=tier.kind, source=str(path)
        )
    return [parse_upstream_line(candidate, default_kind=tier.kind, source="inline")]