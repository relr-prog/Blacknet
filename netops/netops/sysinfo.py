"""Host telemetry: CPU, memory, disk, network, uptime, processes, services."""

from __future__ import annotations

import asyncio
import os
import platform
import shutil
import socket
import time
from pathlib import Path
from typing import Sequence

import psutil

from .config import NetopsConfig

__all__ = [
    "snapshot",
    "list_disks",
    "list_networks",
    "list_processes",
    "service_status",
    "ServiceResult",
    "control_service",
    "journal_tail",
    "host_info",
]


def _cpu_percent() -> float:
    # first call always returns 0.0, so prime it
    psutil.cpu_percent(interval=None)
    time.sleep(0.12)
    return psutil.cpu_percent(interval=None)


def snapshot() -> dict:
    virtual = psutil.virtual_memory()
    swap = psutil.swap_memory()
    load1, load5, load15 = os.getloadavg() if hasattr(os, "getloadavg") else (0.0, 0.0, 0.0)
    return {
        "ts": time.time(),
        "cpu_percent": _cpu_percent(),
        "cpu_count": psutil.cpu_count(logical=True),
        "load": {"1m": load1, "5m": load5, "15m": load15},
        "memory": {
            "total": virtual.total,
            "used": virtual.used,
            "available": virtual.available,
            "percent": virtual.percent,
        },
        "swap": {"total": swap.total, "used": swap.used, "percent": swap.percent},
        "uptime_seconds": time.time() - psutil.boot_time(),
        "process_count": len(psutil.pids()),
        "net_connections": len(psutil.net_connections(kind="inet")) if _has_net_conns() else None,
    }


def _has_net_conns() -> bool:
    try:
        psutil.net_connections(kind="inet")
        return True
    except (psutil.AccessDenied, PermissionError, NotImplementedError):
        return False


def list_disks() -> list[dict]:
    disks = []
    for part in psutil.disk_partitions(all=False):
        try:
            usage = psutil.disk_usage(part.mountpoint)
        except (PermissionError, OSError):
            continue
        disks.append(
            {
                "device": part.device,
                "mount": part.mountpoint,
                "fstype": part.fstype,
                "total": usage.total,
                "used": usage.used,
                "free": usage.free,
                "percent": usage.percent,
            }
        )
    return disks


def list_networks() -> list[dict]:
    result = []
    counters = psutil.net_io_counters(pernic=True)
    for name, addresses in psutil.net_if_addrs().items():
        ipv4 = [a.address for a in addresses if a.family == socket.AF_INET]
        ipv6 = [a.address for a in addresses if a.family == socket.AF_INET6]
        stats = counters.get(name)
        result.append(
            {
                "name": name,
                "ipv4": ipv4,
                "ipv6": ipv6,
                "bytes_sent": stats.bytes_sent if stats else 0,
                "bytes_recv": stats.bytes_recv if stats else 0,
                "packets_sent": stats.packets_sent if stats else 0,
                "packets_recv": stats.packets_recv if stats else 0,
            }
        )
    return result


def list_processes(limit: int = 40) -> list[dict]:
    rows = []
    for proc in psutil.process_iter(["pid", "name", "username", "cpu_percent", "memory_info", "status"]):
        try:
            info = proc.info
            memory = info.get("memory_info")
            rows.append(
                {
                    "pid": info["pid"],
                    "name": info.get("name") or "?",
                    "user": info.get("username") or "?",
                    "cpu": info.get("cpu_percent") or 0.0,
                    "rss": memory.rss if memory else 0,
                    "status": info.get("status") or "?",
                }
            )
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue
    rows.sort(key=lambda r: r["rss"], reverse=True)
    return rows[:limit]


def host_info() -> dict:
    return {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "kernel": platform.release(),
        "python": platform.python_version(),
        "cwd": str(Path.cwd()),
    }


# --------------------------------------------------------------- services
class ServiceResult(dict):
    @property
    def ok(self) -> bool:
        return bool(self.get("ok"))


def _systemctl(args: Sequence[str], config: NetopsConfig, timeout: float = 20.0) -> tuple[int, str, str]:
    binary = shutil.which("systemctl") or "/usr/bin/systemctl"
    argv: list[str] = [binary, *args]
    if config.use_sudo_for_services and os.geteuid() != 0:
        argv = ["sudo", "-n", *argv]
    process = subprocess_run(argv, timeout=timeout)
    return process


def subprocess_run(argv: list[str], timeout: float = 20.0, input_text: str | None = None):
    import subprocess

    return subprocess.run(  # noqa: S603 - argv list, never shell=True
        argv,
        capture_output=True,
        text=True,
        timeout=timeout,
        input=input_text,
        check=False,
    )


def _unit_allowed(name: str, config: NetopsConfig) -> bool:
    return name in config.services_allowlist


def service_status(name: str, config: NetopsConfig) -> ServiceResult:
    if not _unit_allowed(name, config):
        return ServiceResult(
            ok=False, unit=name, error=f"unit {name!r} is not in server_control.services_allowlist"
        )
    try:
        result = _systemctl(["show", name, "--property=ActiveState,SubState,MainPID,LoadState"], config)
    except Exception as exc:  # noqa: BLE001
        return ServiceResult(ok=False, unit=name, error=str(exc))
    if result.returncode != 0:
        return ServiceResult(
            ok=False, unit=name, error=result.stderr.strip() or "systemctl failed", needs_sudo="sudo -n" in result.stderr
        )
    fields = dict(
        line.split("=", 1) for line in result.stdout.strip().splitlines() if "=" in line
    )
    active = fields.get("ActiveState", "unknown")
    return ServiceResult(
        ok=True,
        unit=name,
        active_state=active,
        sub_state=fields.get("SubState", "?"),
        main_pid=int(fields.get("MainPID", "0") or 0),
        load_state=fields.get("LoadState", "?"),
        running=active == "active",
    )


def control_service(name: str, action: str, config: NetopsConfig) -> ServiceResult:
    """start / stop / restart a unit that the operator allowlisted."""
    if action not in ("start", "stop", "restart", "reload"):
        return ServiceResult(ok=False, unit=name, error=f"unsupported action {action!r}")
    if not _unit_allowed(name, config):
        return ServiceResult(
            ok=False, unit=name, error=f"unit {name!r} is not in server_control.services_allowlist"
        )
    try:
        result = _systemctl([action, name], config, timeout=30)
    except Exception as exc:  # noqa: BLE001
        return ServiceResult(ok=False, unit=name, error=str(exc))
    if result.returncode != 0:
        error = result.stderr.strip() or result.stdout.strip() or "systemctl failed"
        return ServiceResult(ok=False, unit=name, error=error, needs_sudo="sudo -n" in error)
    return ServiceResult(ok=True, unit=name, action=action, output=result.stdout.strip())


def journal_tail(unit: str | None, config: NetopsConfig, lines: int = 80) -> dict:
    lines = max(1, min(int(lines), 500))
    args = ["journalctl", "--no-pager", "-n", str(lines), "-o", "short-iso"]
    if unit:
        if not _unit_allowed(unit, config):
            return {"ok": False, "error": f"unit {unit!r} is not allowlisted", "lines": []}
        args += ["-u", unit]
    if os.geteuid() != 0:
        args.insert(0, "sudo")
        args.insert(1, "-n")
    try:
        result = subprocess_run(args, timeout=25)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "error": str(exc), "lines": []}
    return {
        "ok": result.returncode == 0,
        "error": None if result.returncode == 0 else result.stderr.strip(),
        "lines": result.stdout.splitlines(),
    }