"""Command line interface: serve, check, list, bench, validate."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

from .config import build_pool, load_config
from .gateway import RotatingGateway
from .health import HealthChecker
from .http1 import http_get_via
from .link import open_tunnel
from .metrics import Metrics
from .models import parse_upstream_line
from .pool import NoUpstreamAvailable, Strategy
from .state import UpstreamState

log = logging.getLogger("rotator")


def _setup_logging(verbosity: int) -> None:
    level = logging.WARNING if verbosity < 0 else logging.INFO if verbosity == 0 else logging.DEBUG
    logging.basicConfig(
        level=level,
        format="%(asctime)s %(levelname)-7s %(name)-16s %(message)s",
        datefmt="%H:%M:%S",
    )


def _load(args) -> tuple:
    config = load_config(args.config)
    if getattr(args, "strategy", None):
        config.strategy = Strategy(args.strategy)
    pool = build_pool(config, strategy=config.strategy)
    return config, pool


async def _probe(state: UpstreamState, url: str, timeout: float) -> dict:
    from urllib.parse import urlsplit

    from .health import HealthChecker

    parts = urlsplit(url)
    use_tls = parts.scheme == "https"
    host = parts.hostname or ""
    port = parts.port or (443 if use_tls else 80)
    started = time.monotonic()
    try:
        reader, writer = await open_tunnel(state, host, port, timeout=timeout)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    try:
        head, body = await http_get_via(reader, writer, url, timeout=timeout, use_tls=use_tls)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc)}
    finally:
        writer.close()
    latency = (time.monotonic() - started) * 1000
    if head.status != 200:
        return {"ok": False, "status": head.status, "error": f"HTTP {head.status}", "latency_ms": round(latency, 1)}
    exit_ip, country = HealthChecker._extract(body, "")
    return {
        "ok": True,
        "status": head.status,
        "exit_ip": exit_ip,
        "country": country,
        "latency_ms": round(latency, 1),
    }


async def cmd_serve(args) -> int:
    config, pool = _load(args)
    metrics = Metrics()
    gateway = RotatingGateway(pool, config.gateway, metrics=metrics)
    await gateway.start()
    http_port, socks_port, status_port = gateway.ports
    log.info(
        "listening: http=%s socks5=%s status=%s | upstreams=%d healthy=%d",
        f"{config.gateway.host}:{http_port}",
        f"{config.gateway.host}:{socks_port}" if socks_port else "-",
        f"{config.gateway.host}:{status_port}" if status_port else "-",
        len(pool),
        sum(1 for s in pool.states if s.healthy),
    )

    health = None
    if config.health is not None:
        health = HealthChecker(pool, config.health)
        await health.start()

    stop = asyncio.Event()
    try:
        await stop.wait()
    except (KeyboardInterrupt, asyncio.CancelledError):
        pass
    finally:
        if health:
            await health.stop()
        await gateway.stop()
    return 0


async def cmd_check(args) -> int:
    config, pool = _load(args)
    url = args.url
    if config.health is not None:
        url = args.url or config.health.url
    url = url or "https://api.ipify.org"

    concurrency = args.concurrency
    semaphore = asyncio.Semaphore(concurrency)

    async def guarded(state: UpstreamState):
        async with semaphore:
            result = await _probe(state, url, timeout=args.timeout)
            return state, result

    started = time.monotonic()
    results = await asyncio.gather(*(guarded(s) for s in pool.states))
    elapsed = time.monotonic() - started

    ok = 0
    rows = []
    for state, result in results:
        if result["ok"]:
            ok += 1
            state.note_success(
                latency=result.get("latency_ms"),
                exit_ip=result.get("exit_ip"),
                country=result.get("country"),
            )
        else:
            state.note_failure(result.get("error", "probe failed"), quarantine_secs=args.quarantine)
        if args.json:
            rows.append({**state.snapshot(), "probe": result})
        else:
            flag = "ok  " if result["ok"] else "FAIL"
            detail = (
                f"{result.get('exit_ip') or '-':<39} {result.get('latency_ms', '-')!s:>7}ms"
                if result["ok"]
                else (result.get("error") or "")[:60]
            )
            print(f"{flag} {state.spec.label:<45} {state.id}  {detail}")

    ips = {r.get("probe", {}).get("exit_ip") for _, r in results if r.get("probe", {}).get("ok")}
    ips.discard(None)
    print(
        f"\n{ok}/{len(pool.states)} upstreams live in {elapsed:.1f}s | "
        f"{len(ips)} distinct exit IPs",
        file=sys.stderr,
    )
    if args.json:
        print(json.dumps(rows, indent=2))
    return 0 if ok or not pool.states else 1


async def cmd_list(args) -> int:
    _, pool = _load(args)
    states = pool.states if args.tier is None else pool.tier_states(args.tier)
    if args.json:
        print(json.dumps([s.snapshot() for s in states], indent=2))
        return 0
    print(f"{'TIER':>4}  {'ID':<12} {'UPSTREAM':<44} {'IP':<16} {'CC':<3} {'MS':>7} {'USE':>5}")
    for s in states:
        latency = f"{s.latency:.0f}" if s.latency is not None else "-"
        print(
            f"{s.tier:>4}  {s.id:<12} {s.spec.label:<44} "
            f"{s.exit_ip or '-':<16} {(s.effective_country() or '-'):<3} {latency:>7} {s.in_use:>5}"
        )
    print("\n" + json.dumps(pool.stats(), indent=2))
    return 0


async def _probe_via_gateway(gateway: "RotatingGateway", url: str, timeout: float) -> dict:
    """Send one request through the gateway's own listener (CONNECT + TLS)."""
    from urllib.parse import urlsplit

    from .health import HealthChecker
    from .http1 import read_response_head

    parts = urlsplit(url)
    use_tls = parts.scheme == "https"
    host = parts.hostname or ""
    port = parts.port or (443 if use_tls else 80)
    started = time.monotonic()
    try:
        reader, writer = await asyncio.open_connection(
            gateway.config.host, gateway.ports[0]
        )
    except OSError as exc:
        return {"ok": False, "error": f"gateway unreachable: {exc}"}
    try:
        writer.write(f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n\r\n".encode())
        await writer.drain()
        head = await asyncio.wait_for(read_response_head(reader), timeout=timeout)
        if head.status != 200:
            return {"ok": False, "status": head.status, "error": f"gateway replied {head.status}"}
        upstream_id = head.get("X-Rotator-Upstream")
        _, body = await http_get_via(reader, writer, url, timeout=timeout, use_tls=use_tls)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    finally:
        writer.close()
    exit_ip, country = HealthChecker._extract(body, "")
    return {
        "ok": True,
        "exit_ip": exit_ip,
        "country": country,
        "upstream_id": upstream_id,
        "latency_ms": round((time.monotonic() - started) * 1000, 1),
    }


async def cmd_bench(args) -> int:
    config, pool = _load(args)
    from .gateway import GatewayConfig

    gateway = RotatingGateway(
        pool, GatewayConfig(host="127.0.0.1", port=0, socks_port=0, metrics_port=0)
    )
    await gateway.start()

    seen: list[str] = []
    latencies: list[float] = []
    try:
        for index in range(args.count):
            result = await _probe_via_gateway(gateway, args.url, timeout=args.timeout)
            if result["ok"]:
                seen.append(result["exit_ip"] or "?")
                latencies.append(result["latency_ms"])
                print(
                    f"[{index + 1:>3}] upstream={result['upstream_id']:<12} "
                    f"exit_ip={result['exit_ip']:<40} cc={result['country'] or '-':<3} "
                    f"{result['latency_ms']:>7.0f}ms"
                )
            else:
                seen.append("error")
                print(f"[{index + 1:>3}] ERROR {result['error']}"[:140])
    finally:
        await gateway.stop()

    unique = {ip for ip in seen if ip and ip != "?" and ip != "error"}
    median = sorted(latencies)[len(latencies) // 2] if latencies else 0.0
    print(
        f"\nrequests={len(seen)} distinct_exit_ips={len(unique)} "
        f"rotation_ratio={(len(unique) / len(seen)) if seen else 0:.0%} median={median:.0f}ms",
        file=sys.stderr,
    )
    return 0 if unique else 1


def cmd_validate(args) -> int:
    errors = 0
    for path in args.pools:
        p = Path(path)
        if not p.is_file():
            print(f"{p}: not a file")
            errors += 1
            continue
        for lineno, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            if not stripped or stripped.startswith("#"):
                continue
            try:
                spec = parse_upstream_line(stripped)
            except ValueError as exc:
                print(f"{p}:{lineno}: {exc}")
                errors += 1
    if args.config:
        try:
            config = load_config(args.config)
            pool = build_pool(config)
            print(
                f"config ok: {len(config.tiers)} tiers, {len(pool)} upstreams, "
                f"strategy={pool.strategy.value}"
            )
        except (ValueError, FileNotFoundError) as exc:
            print(f"config error: {exc}")
            errors += 1
    print("errors: 0" if not errors else f"errors: {errors}")
    return 1 if errors else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="rotator", description="Rotating proxy gateway")
    parser.add_argument("-v", "--verbose", action="count", default=0)
    parser.add_argument("-q", "--quiet", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the gateway")
    serve.add_argument("-c", "--config", default="rotator.toml")
    serve.add_argument("--strategy", choices=[s.value for s in Strategy])
    serve.set_defaults(func=lambda a: asyncio.run(cmd_serve(a)))

    check = sub.add_parser("check", help="probe every upstream once")
    check.add_argument("-c", "--config", default="rotator.toml")
    check.add_argument("--url")
    check.add_argument("--timeout", type=float, default=15.0)
    check.add_argument("--concurrency", type=int, default=20)
    check.add_argument("--quarantine", type=float, default=120.0)
    check.add_argument("--strategy", choices=[s.value for s in Strategy])
    check.add_argument("--json", action="store_true")
    check.set_defaults(func=lambda a: asyncio.run(cmd_check(a)))

    listing = sub.add_parser("list", help="show configured upstreams")
    listing.add_argument("-c", "--config", default="rotator.toml")
    listing.add_argument("--tier", type=int)
    listing.add_argument("--json", action="store_true")
    listing.set_defaults(func=lambda a: asyncio.run(cmd_list(a)))

    bench = sub.add_parser("bench", help="measure real rotation")
    bench.add_argument("-c", "--config", default="rotator.toml")
    bench.add_argument("--url", default="https://api.ipify.org")
    bench.add_argument("--count", type=int, default=10)
    bench.add_argument("--timeout", type=float, default=20.0)
    bench.add_argument("--strategy", choices=[s.value for s in Strategy])
    bench.set_defaults(func=lambda a: asyncio.run(cmd_bench(a)))

    validate = sub.add_parser("validate", help="validate pool files and config")
    validate.add_argument("-c", "--config")
    validate.add_argument("pools", nargs="*")
    validate.set_defaults(func=cmd_validate)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    _setup_logging(-1 if args.quiet else args.verbose)
    try:
        return int(args.func(args) or 0)
    except KeyboardInterrupt:
        return 130
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())