"""Small diagnostic tools: DNS, ping, traceroute, whois, TLS, HTTP headers, hashes.

Every tool runs as an argv list (never a shell string), with a hard timeout and
an output cap, and DNS/IP style targets are validated before use.
"""

from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import math
import re
import socket
import ssl
import time
from collections import Counter

from .config import ScannerPolicy
from .scanner import HOSTNAME_RE, ScanError, validate_target

__all__ = ["ToolError", "TOOLS", "run_tool", "dns_lookup", "tls_check", "http_headers",
           "whois", "ping", "traceroute", "entropy", "hash_text"]

MAX_OUTPUT_BYTES = 200_000


class ToolError(ValueError):
    pass


def _which(binary: str) -> str | None:
    from shutil import which

    return which(binary)


def _valid_host(name: str) -> str:
    name = (name or "").strip()
    if not name or len(name) > 253:
        raise ToolError("invalid host")
    try:
        ipaddress.ip_address(name)
        return name
    except ValueError:
        pass
    if not HOSTNAME_RE.match(name):
        raise ToolError(f"invalid hostname {name!r}")
    return name


async def _run(argv: list[str], timeout: float) -> tuple[int, str, str]:
    try:
        process = await asyncio.create_subprocess_exec(
            *argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE
        )
    except FileNotFoundError as exc:
        raise ToolError(f"{argv[0]} is not installed on this host") from exc
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        raise ToolError(f"{argv[0]} timed out after {timeout:.0f}s") from None
    return (
        process.returncode,
        stdout.decode("utf-8", "replace")[:MAX_OUTPUT_BYTES],
        stderr.decode("utf-8", "replace")[:4_000],
    )


# ------------------------------------------------------------------- tools
async def dns_lookup(host: str, record: str = "A") -> dict:
    host = _valid_host(host)
    record = record.upper()
    if record not in ("A", "AAAA", "MX", "NS", "TXT", "CNAME", "SOA", "PTR", "CAA"):
        raise ToolError(f"unsupported record type {record!r}")
    loop = asyncio.get_running_loop()
    try:
        answers = await loop.getaddrinfo(host, None)
        addresses = sorted({info[4][0] for info in answers})
    except socket.gaierror as exc:
        raise ToolError(f"DNS lookup failed: {exc.strerror or exc}") from exc

    extra: list[str] = []
    if record not in ("A", "AAAA") and _which("dig"):
        code, out, err = await _run(["dig", "+short", record, host], timeout=15)
        if code == 0:
            extra = [line for line in out.splitlines() if line.strip()]
        else:
            extra = [err.strip()] if err.strip() else []
    return {
        "host": host,
        "record": record,
        "addresses": addresses,
        "records": extra,
        "reverse": _reverse(host),
    }


def _reverse(host: str) -> str | None:
    try:
        return socket.gethostbyaddr(host)[0]
    except (socket.herror, OSError):
        return None


async def ping(host: str, count: int = 4) -> dict:
    host = _valid_host(host)
    count = max(1, min(int(count), 20))
    if not _which("ping"):
        raise ToolError("ping is not installed on this host")
    argv = ["ping", "-c", str(count), "-w", str(count * 2 + 5), host]
    started = time.time()
    code, out, err = await _run(argv, timeout=count * 2 + 10)
    loss = _match(out, r"(\d+(?:\.\d+)?)% packet loss") or "?"
    rtt = _match(out, r"(?:rtt|round-trip).*?= ([\d.]+)/([\d.]+)/([\d.]+)")
    return {
        "host": host,
        "ok": code == 0,
        "packet_loss": loss,
        "rtt": {"min": rtt[0], "avg": rtt[1], "max": rtt[2]} if rtt else None,
        "duration": round(time.time() - started, 2),
        "output": out.strip() or err.strip(),
    }


async def traceroute(host: str, max_hops: int = 20) -> dict:
    host = _valid_host(host)
    max_hops = max(1, min(int(max_hops), 40))
    if _which("traceroute"):
        argv = ["traceroute", "-n", "-m", str(max_hops), "-w", "2", "-q", "1", host]
    elif _which("tracepath"):
        argv = ["tracepath", "-n", "-m", str(max_hops), host]
    else:
        raise ToolError("neither traceroute nor tracepath is installed")
    code, out, err = await _run(argv, timeout=max_hops * 4 + 20)
    return {"host": host, "ok": code in (0, 1), "hops": out.strip() or err.strip()}


async def whois(query: str) -> dict:
    query = _valid_host(query)
    if not _which("whois"):
        raise ToolError("whois is not installed on this host")
    code, out, err = await _run(["whois", query], timeout=25)
    text = out.strip() or err.strip()
    keep = [
        line.strip()
        for line in text.splitlines()
        if re.match(
            r"^(netname|descr|country|org-name|orgname|inetnum|netrange|origin|as-name|abuse-mailbox|owner|status|role|person|organization):",
            line.strip(),
            re.I,
        )
    ]
    return {"query": query, "summary": keep[:40], "raw": text[:8000]}


async def tls_check(host: str, port: int = 443) -> dict:
    host = _valid_host(host)
    port = int(port)
    if not 1 <= port <= 65535:
        raise ToolError("invalid port")
    ctx = ssl.create_default_context()
    started = time.time()

    def connect() -> dict:
        with socket.create_connection((host, port), timeout=8) as sock:
            with ctx.wrap_socket(sock, server_hostname=host) as tls:
                cert = tls.getpeercert()
                cipher = tls.cipher()
                version = tls.version()
        return {
            "host": host,
            "port": port,
            "tls_version": version,
            "cipher": cipher[0] if cipher else None,
            "cipher_bits": cipher[2] if cipher else None,
            "issuer": _flatten(cert.get("issuer")),
            "subject": _flatten(cert.get("subject")),
            "not_before": cert.get("notBefore"),
            "not_after": cert.get("notAfter"),
            "san": [value for key, value in cert.get("subjectAltName", ()) if key == "DNS"],
            "expired": _expired(cert.get("notAfter")),
            "handshake_ms": round((time.time() - started) * 1000, 1),
        }

    try:
        return await asyncio.to_thread(connect)
    except ssl.SSLCertVerificationError as exc:
        return {"host": host, "port": port, "error": f"certificate verification failed: {exc.verify_message}"}
    except (OSError, ssl.SSLError) as exc:
        raise ToolError(f"TLS handshake failed: {exc}") from exc


async def http_headers(url: str) -> dict:
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        url = f"https://{url}"
    parts = url.split("/", 3)
    host = parts[2].split("@")[-1]
    host_only = host.split(":")[0]
    _valid_host(host_only)
    code, out, err = await _run(
        ["curl", "-sS", "-o", "/dev/null", "-D", "-", "-L", "--max-time", "20",
         "-A", "netops/1.0", "-w", "\\n[time_total=%{time_total}s http=%{http_code}]", url],
        timeout=25,
    )
    if code != 0:
        raise ToolError(err.strip() or "curl failed")
    return {"url": url, "headers": out.strip()}


def _flatten(name_tuples) -> str:
    if not name_tuples:
        return ""
    return ", ".join(f"{key}={value}" for group in name_tuples for key, value in group)


def _expired(not_after: str | None) -> bool | None:
    if not not_after:
        return None
    try:
        from datetime import datetime

        return datetime.strptime(not_after, "%b %d %H:%M:%S %Y %Z").timestamp() < time.time()
    except ValueError:
        return None


def _match(text: str, pattern: str) -> tuple[str, ...] | None:
    found = re.search(pattern, text)
    return found.groups() if found else None


def entropy(data: str) -> float:
    """Shannon entropy per character — a quick password/secret strength hint."""
    if not data:
        return 0.0
    counts = Counter(data)
    total = len(data)
    return round(-sum((n / total) * math.log2(n / total) for n in counts.values()), 3)


def hash_text(data: str, algorithm: str = "sha256") -> dict:
    data = (data or "").encode()
    algorithm = algorithm.lower()
    available = {"md5": hashlib.md5, "sha1": hashlib.sha1, "sha256": hashlib.sha256,
                 "sha512": hashlib.sha512}
    if algorithm not in available:
        raise ToolError(f"unsupported algorithm {algorithm!r}")
    return {
        "algorithm": algorithm,
        "length": len(data),
        "hex": available[algorithm](data).hexdigest(),
        "base64": __import__("base64").b64encode(available[algorithm](data).digest()).decode(),
        "entropy": entropy(data.decode("utf-8", "replace")),
    }


TOOLS = {
    "dns": {"fn": dns_lookup, "args": ["host", "record"], "needs_target": True},
    "ping": {"fn": ping, "args": ["host", "count"], "needs_target": True},
    "traceroute": {"fn": traceroute, "args": ["host", "max_hops"], "needs_target": True},
    "whois": {"fn": whois, "args": ["query"], "needs_target": True},
    "tls": {"fn": tls_check, "args": ["host", "port"], "needs_target": True},
    "headers": {"fn": http_headers, "args": ["url"], "needs_target": False},
    "hash": {"fn": lambda **kw: _sync_tool(hash_text, **kw), "args": ["data", "algorithm"], "needs_target": False},
}


def _sync_tool(fn, **kwargs):
    return fn(**kwargs)


async def run_tool(name: str, params: dict, policy: ScannerPolicy) -> dict:
    tool = TOOLS.get(name)
    if tool is None:
        raise ToolError(f"unknown tool {name!r}")
    if not policy.tools_enabled:
        raise ToolError("tools are disabled in netops.toml")

    kwargs = {key: value for key, value in params.items() if key in tool["args"] and value not in (None, "")}
    if tool["needs_target"]:
        target = kwargs.get("host") or kwargs.get("query") or kwargs.get("url")
        if not target:
            raise ToolError("this tool requires a target")
        for key in ("host", "query", "url"):
            if key in kwargs:
                try:
                    validate_target(_host_of(kwargs[key]), policy)
                except ScanError:
                    # DNS/WHOIS against a public resolver target is still useful,
                    # so only hard-block when the operator has set an allowlist.
                    if policy.allowed_targets != ("*",):
                        raise
    result = tool["fn"](**kwargs)
    if asyncio.iscoroutine(result):
        result = await asyncio.wait_for(result, timeout=policy.tool_timeout)
    return result


def _host_of(value: str) -> str:
    text = value.strip()
    if "://" in text:
        text = text.split("://", 1)[1]
    return text.split("/", 1)[0].split(":", 1)[0]