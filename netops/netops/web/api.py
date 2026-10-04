"""Dashboard API: monitoring, rotation control, lookups, scanning, tools, server."""

from __future__ import annotations

import asyncio
import time
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from pydantic import BaseModel, Field

from .. import ipinfo, scanner, sysinfo, tools
from ..config import NetopsConfig, ScannerPolicy
from ..db import Database
from ..rotator_service import PROBE_URL, RotatorService
from .deps import CurrentUser, audit, require_admin, require_user

router = APIRouter(prefix="/api", tags=["api"])


def _db(request: Request) -> Database:
    return request.app.state.db


def _rotator(request: Request) -> RotatorService:
    return request.app.state.rotator


def _policy(request: Request) -> ScannerPolicy:
    return request.app.state.config.scanner


def _fail(request: Request, action: str, target: str | None, exc: Exception, user: CurrentUser):
    audit(request, action, target=target, outcome="denied", detail=str(exc)[:300], user=user)
    status = 400 if isinstance(exc, ValueError) else 500
    raise HTTPException(status_code=status, detail=str(exc)) from exc


# ---------------------------------------------------------------- monitoring
@router.get("/monitor/overview")
def overview(request: Request) -> dict:
    user = require_user(request)
    rotator = _rotator(request)
    config: NetopsConfig = request.app.state.config
    return {
        "ts": time.time(),
        "user": user.as_dict(),
        "host": sysinfo.host_info(),
        "system": sysinfo.snapshot(),
        "rotator": rotator.status(),
        "scanner": {
            "enabled": config.scanner.enabled,
            "nmap_installed": scanner.nmap_available(),
            "allowed_targets": list(config.scanner.allowed_targets),
            "max_ports": config.scanner.max_ports,
        },
    }


@router.get("/monitor/system")
def system(request: Request) -> dict:
    require_user(request)
    return {
        "system": sysinfo.snapshot(),
        "disks": sysinfo.list_disks(),
        "networks": sysinfo.list_networks(),
        "processes": sysinfo.list_processes(limit=25),
    }


@router.get("/monitor/audit")
def audit_log(request: Request, limit: int = Query(60, ge=1, le=500), mine: bool = False) -> dict:
    user = require_user(request)
    db = _db(request)
    rows = db.recent_audit(limit=limit, user_id=user.id if mine else None)
    return {
        "entries": [
            {
                "id": row["id"],
                "ts": row["ts"],
                "username": row["username"],
                "action": row["action"],
                "target": row["target"],
                "outcome": row["outcome"],
                "detail": row["detail"],
            }
            for row in rows
        ]
    }


# ------------------------------------------------------------------ rotation
@router.get("/rotator/status")
def rotator_status(request: Request) -> dict:
    require_user(request)
    rotator = _rotator(request)
    return {**rotator.status(), "configured_strategy": rotator.effective_strategy()}


@router.post("/rotator/start")
def rotator_start(request: Request) -> dict:
    user = require_admin(request)
    rotator = _rotator(request)
    result = rotator.start()
    audit(request, "rotator.start", outcome="ok" if result.get("ok") else "failed",
          detail=str(result.get("error"))[:200], user=user)
    return result


@router.post("/rotator/stop")
def rotator_stop(request: Request) -> dict:
    user = require_admin(request)
    result = _rotator(request).stop()
    audit(request, "rotator.stop", user=user)
    return result


@router.post("/rotator/restart")
def rotator_restart(request: Request) -> dict:
    user = require_admin(request)
    result = _rotator(request).restart()
    audit(request, "rotator.restart", outcome="ok" if result.get("ok") else "failed",
          detail=str(result.get("error"))[:200], user=user)
    return result


@router.post("/rotator/strategy")
def rotator_strategy(request: Request, strategy: str = Query(...)) -> dict:
    user = require_admin(request)
    result = _rotator(request).set_strategy(strategy)
    audit(request, "rotator.strategy", target=strategy,
          outcome="ok" if result.get("ok") else "failed", user=user)
    return result


class UpstreamInput(BaseModel):
    line: str = Field(min_length=3, max_length=400)
    tier: int = Field(default=1, ge=0, le=9)
    max_slots: int = Field(default=0, ge=0, le=10_000)


@router.post("/rotator/upstreams")
def add_upstream(request: Request, payload: UpstreamInput) -> dict:
    user = require_admin(request)
    try:
        result = _rotator(request).add_upstream(payload.line, payload.tier, payload.max_slots)
    except ValueError as exc:
        return _fail(request, "rotator.upstream_add", payload.line, exc, user)
    audit(request, "rotator.upstream_add", target=payload.line,
          outcome="ok" if result.get("ok") else "failed", detail=str(result.get("error")), user=user)
    return result


@router.delete("/rotator/upstreams/{upstream_id}")
def remove_upstream(request: Request, upstream_id: str) -> dict:
    user = require_admin(request)
    result = _rotator(request).remove_upstream(upstream_id)
    audit(request, "rotator.upstream_remove", target=upstream_id, user=user)
    return result


class SlotInput(BaseModel):
    max_slots: int = Field(ge=0, le=10_000)


@router.post("/rotator/upstreams/{upstream_id}/slots")
def set_slots(request: Request, upstream_id: str, payload: SlotInput) -> dict:
    user = require_admin(request)
    result = _rotator(request).set_slots(upstream_id, payload.max_slots)
    audit(request, "rotator.upstream_slots", target=upstream_id, detail=str(payload.max_slots), user=user)
    return result


@router.post("/rotator/upstreams/{upstream_id}/quarantine")
def quarantine(request: Request, upstream_id: str, seconds: float = Query(300, ge=5, le=86_400)) -> dict:
    user = require_admin(request)
    result = _rotator(request).quarantine(upstream_id, seconds)
    audit(request, "rotator.upstream_quarantine", target=upstream_id, detail=str(seconds), user=user)
    return result


@router.post("/rotator/upstreams/restore")
def restore_pool(request: Request) -> dict:
    user = require_admin(request)
    result = _rotator(request).restore_defaults()
    audit(request, "rotator.pool_restore", user=user)
    return result


@router.get("/rotator/probe")
def probe_upstreams(request: Request, url: str = Query(PROBE_URL, max_length=300)) -> dict:
    user = require_user(request)
    results = _rotator(request).probe_all(url)
    audit(request, "rotator.probe", target=url, user=user)
    return {"results": results, "ok_count": sum(1 for r in results if r["ok"])}


@router.get("/rotator/rotation-test")
def rotation_test(request: Request, requests: int = Query(6, ge=1, le=25)) -> dict:
    user = require_user(request)
    result = _rotator(request).rotation_test(requests)
    audit(request, "rotator.rotation_test", target=f"{requests} requests",
          outcome="ok" if result.get("ok") else "failed", user=user)
    return result


@router.get("/rotator/export/burp")
def burp_export(request: Request) -> dict:
    require_user(request)
    return _rotator(request).burp_export()


@router.get("/rotator/metrics")
def rotator_metrics(request: Request) -> str:
    require_user(request)
    from fastapi.responses import PlainTextResponse

    return PlainTextResponse(_rotator(request).metrics_text())


# ------------------------------------------------------------------ lookups
@router.get("/ip/lookup")
async def ip_lookup(request: Request, ip: str = Query(..., max_length=64)) -> dict:
    user = require_user(request)
    try:
        result = await ipinfo.lookup_ip(ip)
    except ipinfo.IPInfoError as exc:
        return _fail(request, "ip.lookup", ip, exc, user)
    audit(request, "ip.lookup", target=ip, user=user)
    return result


@router.get("/ip/rdap")
async def ip_rdap(request: Request, ip: str = Query(..., max_length=64)) -> dict:
    user = require_user(request)
    try:
        result = await ipinfo.whois_free(ip)
    except ipinfo.IPInfoError as exc:
        return _fail(request, "ip.rdap", ip, exc, user)
    audit(request, "ip.rdap", target=ip, user=user)
    return result


@router.get("/ip/egress")
async def ip_egress(request: Request, via: str = Query("direct", pattern="^(direct|gateway|socks5)$")) -> dict:
    user = require_user(request)
    rotator = _rotator(request)
    if via == "direct":
        result = await ipinfo.local_egress()
    else:
        if not rotator.running:
            raise HTTPException(status_code=409, detail="rotator is not running")
        config = rotator._gateway.config if rotator._gateway else None
        if config is None:
            raise HTTPException(status_code=409, detail="rotator has no listener")
        socks_port = rotator._gateway.ports[1] if via == "socks5" else None
        result = await ipinfo.gateway_egress(config, socks_port)
    audit(request, "ip.egress", target=via, outcome="ok" if result.get("ok") else "failed", user=user)
    return result


# ------------------------------------------------------------------ scanning
class ScanRequestBody(BaseModel):
    target: str = Field(min_length=1, max_length=255)
    ports: str = Field(default="1-1024", max_length=120)
    engine: str = Field(default="builtin", pattern="^(builtin|nmap)$")
    timeout: float | None = Field(default=None, ge=0.1, le=10)
    concurrency: int | None = Field(default=None, ge=1, le=512)


@router.post("/scan/ports")
async def scan_ports(request: Request, payload: ScanRequestBody) -> dict:
    user = require_admin(request)
    policy = _policy(request)
    if not policy.enabled:
        audit(request, "scan.ports", target=payload.target, outcome="denied", detail="disabled", user=user)
        raise HTTPException(status_code=403, detail="scanning is disabled in netops.toml")
    if payload.engine == "nmap" and not policy.nmap_enabled:
        raise HTTPException(status_code=403, detail="nmap is disabled in netops.toml")

    scan_request = scanner.ScanRequest(
        target=payload.target,
        ports=payload.ports,
        timeout=payload.timeout,
        concurrency=payload.concurrency,
    )
    started = time.time()
    try:
        scan_request.target = scanner.validate_target(payload.target, policy)
        result = (
            await scanner.nmap_scan(scan_request, policy)
            if payload.engine == "nmap"
            else await scanner.tcp_scan(scan_request, policy)
        )
    except (scanner.ScanError, ValueError) as exc:
        audit(request, "scan.ports", target=payload.target, outcome="denied",
              detail=str(exc)[:300], user=user)
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload_out = result.as_dict()
    payload_out["reverse_dns"] = scanner.reverse_dns(result.resolved)
    payload_out["requested_at"] = started
    audit(request, "scan.ports", target=payload.target,
          detail=f"engine={result.engine} open={len(result.open_ports)} ports={payload.ports}",
          user=user)
    return payload_out


# -------------------------------------------------------------------- tools
@router.get("/tools")
def list_tools(request: Request) -> dict:
    require_user(request)
    policy = _policy(request)
    return {
        "enabled": policy.tools_enabled,
        "tools": [
            {
                "name": name,
                "args": spec["args"],
                "needs_target": spec["needs_target"],
                "available": _tool_available(name),
            }
            for name, spec in tools.TOOLS.items()
        ],
    }


def _tool_available(name: str) -> bool:
    from shutil import which

    required = {
        "dns": ("dig",),
        "ping": ("ping",),
        "traceroute": ("traceroute", "tracepath"),
        "whois": ("whois",),
        "tls": (),
        "headers": ("curl",),
        "hash": (),
    }[name]
    if not required:
        return True
    return any(which(binary) for binary in required)


@router.post("/tools/{name}")
async def run_tool(request: Request, name: str, payload: dict[str, Any]) -> dict:
    user = require_user(request)
    policy = _policy(request)
    try:
        result = await tools.run_tool(name, payload or {}, policy)
    except tools.ToolError as exc:
        audit(request, f"tool.{name}", target=str(payload.get("host") or payload.get("data", ""))[:60],
              outcome="denied", detail=str(exc)[:200], user=user)
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except asyncio.TimeoutError:
        raise HTTPException(status_code=504, detail="tool timed out") from None
    audit(request, f"tool.{name}", target=str(payload.get("host") or payload.get("query", ""))[:80], user=user)
    return {"tool": name, "result": result}


# ------------------------------------------------------------ server control
@router.get("/server/services")
def services(request: Request) -> dict:
    require_admin(request)
    config: NetopsConfig = request.app.state.config
    rows = [sysinfo.service_status(unit, config) for unit in config.services_allowlist]
    return {"services": rows}


class ServiceAction(BaseModel):
    unit: str
    action: str = Field(pattern="^(start|stop|restart|reload)$")


@router.post("/server/services")
def service_action(request: Request, payload: ServiceAction) -> dict:
    user = require_admin(request)
    config: NetopsConfig = request.app.state.config
    result = sysinfo.control_service(payload.unit, payload.action, config)
    audit(request, "server.service", target=f"{payload.unit}:{payload.action}",
          outcome="ok" if result.ok else "failed", detail=str(result.get("error"))[:200], user=user)
    return dict(result)


@router.get("/server/journal")
def journal(request: Request, unit: str | None = None, lines: int = Query(80, ge=1, le=500)) -> dict:
    require_admin(request)
    config: NetopsConfig = request.app.state.config
    return sysinfo.journal_tail(unit, config, lines)


@router.get("/server/network")
def network(request: Request) -> dict:
    require_admin(request)
    return {"interfaces": sysinfo.list_networks(), "host": sysinfo.host_info()}