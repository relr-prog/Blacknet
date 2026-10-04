"""Network scanning: a built-in asyncio TCP scanner plus an Nmap wrapper.

Both paths are gated by :class:`~netops.config.ScannerPolicy`, so the panel can
only scan hosts the operator listed in ``netops.toml``.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import shutil
import socket
import time
from dataclasses import dataclass, field

from .config import ScannerPolicy

__all__ = [
    "ScanError",
    "ScanRequest",
    "ScanResult",
    "parse_ports",
    "validate_target",
    "tcp_scan",
    "nmap_scan",
    "reverse_dns",
]

HOSTNAME_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$", re.I)

WELL_KNOWN_SERVICES: dict[int, str] = {
    21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "domain", 80: "http",
    110: "pop3", 111: "rpcbind", 135: "msrpc", 139: "netbios-ssn", 143: "imap",
    443: "https", 445: "microsoft-ds", 465: "smtps", 587: "submission",
    631: "ipp", 993: "imaps", 995: "pop3s", 1433: "mssql", 1521: "oracle",
    2049: "nfs", 2375: "docker", 3000: "grafana", 3306: "mysql", 3389: "rdp",
    5000: "upnp", 5432: "postgresql", 5900: "vnc", 6379: "redis", 8000: "http-alt",
    8080: "http-proxy", 8443: "https-alt", 8888: "http-alt", 9000: "sonarqube",
    9090: "prometheus", 9200: "elasticsearch", 27017: "mongodb",
}


class ScanError(ValueError):
    pass


@dataclass
class ScanRequest:
    target: str
    ports: str = "1-1024"
    timeout: float | None = None
    concurrency: int | None = None
    service_probe: bool = True

    def limit(self, policy: ScannerPolicy) -> tuple[float, int]:
        return (
            float(self.timeout or policy.connect_timeout),
            max(1, min(int(self.concurrency or policy.max_concurrency), policy.max_concurrency)),
        )


@dataclass
class ScanResult:
    target: str
    resolved: str
    started_at: float
    finished_at: float = 0.0
    open_ports: list[int] = field(default_factory=list)
    closed_count: int = 0
    errors: list[str] = field(default_factory=list)
    engine: str = "builtin"
    raw: str | None = None

    @property
    def duration(self) -> float:
        return round((self.finished_at or time.time()) - self.started_at, 3)

    def as_dict(self) -> dict:
        return {
            "target": self.target,
            "resolved": self.resolved,
            "engine": self.engine,
            "open_ports": [
                {"port": port, "service": WELL_KNOWN_SERVICES.get(port, "unknown")}
                for port in self.open_ports
            ],
            "open_count": len(self.open_ports),
            "closed_count": self.closed_count,
            "duration": self.duration,
            "errors": self.errors[:20],
            "raw": self.raw,
        }


def parse_ports(spec: str, *, max_ports: int) -> list[int]:
    """Parse ``22,80,443,8000-8100`` into a sorted list, capped by policy."""
    ports: set[int] = set()
    for chunk in (spec or "").replace(" ", "").split(","):
        if not chunk:
            continue
        if "-" in chunk:
            start_text, _, end_text = chunk.partition("-")
            if not start_text.isdigit() or not end_text.isdigit():
                raise ScanError(f"invalid port range {chunk!r}")
            start, end = int(start_text), int(end_text)
            if start > end:
                raise ScanError(f"reversed port range {chunk!r}")
            if not 1 <= start or end > 65535:
                raise ScanError(f"port out of range in {chunk!r}")
            ports.update(range(start, end + 1))
        else:
            if not chunk.isdigit():
                raise ScanError(f"invalid port {chunk!r}")
            port = int(chunk)
            if not 1 <= port <= 65535:
                raise ScanError(f"port out of range: {port}")
            ports.add(port)
        if len(ports) > max_ports:
            raise ScanError(f"port selection exceeds the {max_ports}-port policy limit")
    if not ports:
        raise ScanError("no ports selected")
    return sorted(ports)


def validate_target(target: str, policy: ScannerPolicy) -> str:
    target = (target or "").strip()
    if not target:
        raise ScanError("target is required")
    if not policy.target_allowed(target):
        raise ScanError(
            f"target {target!r} is not in scanner.allowed_targets "
            f"(configured: {', '.join(policy.allowed_targets) or 'none'})"
        )
    try:
        address = ipaddress.ip_address(target)
        is_private = address.is_private or address.is_loopback or address.is_link_local
    except ValueError:
        if not HOSTNAME_RE.match(target):
            raise ScanError(f"invalid hostname or address {target!r}")
        is_private = False
    if is_private and not policy.allow_private_targets:
        raise ScanError("scanning private addresses is disabled by policy")
    return target


async def _resolve(target: str) -> str:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(target, None, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise ScanError(f"cannot resolve {target}: {exc}") from exc
    if not infos:
        raise ScanError(f"cannot resolve {target}")
    return infos[0][4][0]


def reverse_dns(address: str) -> str | None:
    try:
        return socket.gethostbyaddr(address)[0]
    except (socket.herror, OSError):
        return None


async def tcp_scan(request: ScanRequest, policy: ScannerPolicy) -> ScanResult:
    """Connect to every selected port and report which ones accept traffic."""
    target = validate_target(request.target, policy)
    ports = parse_ports(request.ports, max_ports=policy.max_ports)
    timeout, concurrency = request.limit(policy)
    resolved = await _resolve(target)

    result = ScanResult(target=target, resolved=resolved, started_at=time.time())
    deadline = result.started_at + policy.max_runtime_seconds
    semaphore = asyncio.Semaphore(concurrency)
    open_ports: list[int] = []

    async def probe(port: int) -> None:
        if time.time() > deadline:
            result.errors.append("scan deadline reached")
            return
        async with semaphore:
            writer = None
            try:
                _reader, writer = await asyncio.wait_for(
                    asyncio.open_connection(resolved, port), timeout=timeout
                )
                open_ports.append(port)
            except asyncio.TimeoutError:
                result.closed_count += 1
            except OSError as exc:
                result.closed_count += 1
                if exc.errno not in (111, 113, 101, 104, 32, 110):
                    result.errors.append(f"port {port}: {exc}")
            finally:
                if writer is not None:
                    writer.close()

    await asyncio.gather(*(probe(port) for port in ports))
    result.open_ports = sorted(open_ports)
    result.finished_at = time.time()
    return result


def nmap_available() -> bool:
    return shutil.which("nmap") is not None


async def nmap_scan(request: ScanRequest, policy: ScannerPolicy) -> ScanResult:
    """Run nmap -oX and parse the XML result."""
    if not policy.nmap_enabled:
        raise ScanError("nmap is disabled in netops.toml")
    if not nmap_available():
        raise ScanError("nmap is not installed on this host")

    target = validate_target(request.target, policy)
    ports = parse_ports(request.ports, max_ports=policy.max_ports)
    resolved = await _resolve(target)
    started = time.time()
    argv = [
        "nmap",
        *_flags_without_port_selection(policy.nmap_flags),
        "-p",
        ",".join(str(p) for p in ports),
        "-oX",
        "-",
        "--max-retries",
        "1",
        resolved,
    ]
    process = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(), timeout=policy.max_runtime_seconds
        )
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise ScanError("nmap exceeded the maximum runtime") from None

    xml_text = stdout.decode("utf-8", "replace")
    if process.returncode != 0:
        raise ScanError(f"nmap failed: {stderr.decode('utf-8', 'replace').strip()[:300]}")

    open_ports = _parse_nmap_ports(xml_text)
    return ScanResult(
        target=target,
        resolved=resolved,
        started_at=started,
        finished_at=time.time(),
        open_ports=open_ports,
        closed_count=max(0, len(ports) - len(open_ports)),
        engine="nmap",
        raw=xml_text[:20000],
    )


def _flags_without_port_selection(flags: tuple[str, ...]) -> list[str]:
    """Drop --top-ports/-p style flags; this wrapper always supplies -p itself."""
    result: list[str] = []
    skip_next = False
    for flag in flags:
        if skip_next:
            skip_next = False
            continue
        if flag in ("--top-ports", "-p"):
            skip_next = True
            continue
        if flag.startswith("--top-ports="):
            continue
        if flag in ("-iL", "--excludefile"):
            skip_next = True
            continue
        result.append(flag)
    return result


def _parse_nmap_ports(xml_text: str) -> list[int]:
    ports: list[int] = []
    for block in re.findall(r"<port\b.*?</port>", xml_text, flags=re.S):
        state = re.search(r'<state state="([^"]+)"', block)
        number = re.search(r'portid="(\d+)"', block)
        if number and state and state.group(1) == "open":
            ports.append(int(number.group(1)))
    return sorted(set(ports))