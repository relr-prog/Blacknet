"""IP intelligence lookups: geo, ASN and this host's real egress address."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urlsplit

from rotator.geo import GeoResolver
from rotator.http1 import http_get_via, read_response_head
from rotator.socks5 import socks5_connect

__all__ = ["IPInfoError", "normalise_ip", "lookup_ip", "local_egress", "whois_free"]

ECHO_URLS = (
    "https://api.ipify.org?format=json",
    "https://ipinfo.io/json",
    "https://ifconfig.me/all.json",
)


class IPInfoError(ValueError):
    pass


def normalise_ip(value: str) -> str:
    value = (value or "").strip()
    if not value:
        raise IPInfoError("IP address is required")
    if value.startswith("http://") or value.startswith("https://"):
        parts = urlsplit(value)
        value = parts.hostname or ""
    try:
        return str(ipaddress.ip_address(value))
    except ValueError as exc:
        raise IPInfoError(f"{value!r} is not a valid IP address") from exc


async def lookup_ip(value: str, resolver: GeoResolver | None = None) -> dict:
    address = normalise_ip(value)
    resolver = resolver or GeoResolver()
    info = await resolver.lookup(address)
    parsed = ipaddress.ip_address(address)
    reverse = None
    try:
        reverse = await asyncio.to_thread(socket.gethostbyaddr, address)
    except (socket.herror, OSError):
        reverse = None

    return {
        "ip": address,
        "version": parsed.version,
        "is_private": parsed.is_private,
        "is_global": parsed.is_global,
        "reverse_dns": reverse[0] if reverse else None,
        "country": info.country if info else None,
        "city": info.city if info else None,
        "asn": info.asn if info else None,
        "org": info.org if info else None,
        "resolved": info is not None,
    }


async def _echo(url: str, connect, timeout: float = 20.0) -> dict:
    parts = urlsplit(url)
    use_tls = parts.scheme == "https"
    host = parts.hostname or ""
    port = parts.port or (443 if use_tls else 80)
    reader, writer = await connect(host, port, timeout)
    try:
        head, body = await http_get_via(reader, writer, url, timeout=timeout, use_tls=use_tls)
        if head.status != 200:
            raise IPInfoError(f"echo service replied {head.status}")
        import json

        text = body.decode("utf-8", "replace").strip()
        try:
            payload = json.loads(text)
        except json.JSONDecodeError:
            payload = {}
        return {"url": url, "payload": payload, "raw": text[:500]}
    finally:
        writer.close()


async def local_egress() -> dict:
    """What the internet sees when traffic leaves this machine directly."""

    async def direct(host: str, port: int, timeout: float):
        return await asyncio.wait_for(asyncio.open_connection(host, port), timeout=timeout)

    errors = []
    for url in ECHO_URLS:
        try:
            result = await _echo(url, direct)
        except (OSError, asyncio.TimeoutError, IPInfoError) as exc:
            errors.append(f"{url}: {exc}")
            continue
        payload = result["payload"]
        address = payload.get("ip") or payload.get("origin") or result["raw"]
        return {"ok": True, "ip": str(address).split(",")[0].strip(), "source": url,
                "payload": payload}
    return {"ok": False, "error": "; ".join(errors)[:400]}


async def gateway_egress(gateway_config, socks_port: int | None = None) -> dict:
    """What the internet sees when traffic goes through our rotating listener."""
    host, port = gateway_config.host, gateway_config.port

    async def via_proxy(target_host: str, target_port: int, timeout: float):
        reader, writer = await asyncio.open_connection(host, port)
        writer.write(
            f"CONNECT {target_host}:{target_port} HTTP/1.1\r\nHost: {target_host}:{target_port}\r\n\r\n".encode()
        )
        await writer.drain()
        head = await asyncio.wait_for(read_response_head(reader), timeout=timeout)
        if head.status != 200:
            writer.close()
            raise IPInfoError(f"gateway replied {head.status} {head.reason}")
        return reader, writer

    async def via_socks(target_host: str, target_port: int, timeout: float):
        if not socks_port:
            raise IPInfoError("SOCKS5 listener is disabled")
        return await socks5_connect(
            target_host, target_port, server=(host, socks_port), timeout=timeout
        )

    errors = []
    for url in ECHO_URLS:
        for name, connect in (("http", via_proxy), ("socks5", via_socks)):
            try:
                result = await _echo(url, connect)
            except (OSError, asyncio.TimeoutError, IPInfoError) as exc:
                errors.append(f"{name} {url}: {exc}")
                continue
            payload = result["payload"]
            address = payload.get("ip") or payload.get("origin") or result["raw"]
            return {
                "ok": True,
                "ip": str(address).split(",")[0].strip(),
                "via": name,
                "payload": payload,
            }
    return {"ok": False, "error": "; ".join(errors)[:400]}


async def whois_free(address: str) -> dict:
    """Minimal whois via RDAP (the structured successor of the whois protocol)."""
    address = normalise_ip(address)
    parsed = ipaddress.ip_address(address)
    url = (
        "https://rdap.arin.net/registry/ip/"
        if parsed.version == 4
        else "https://rdap.arin.net/registry/ip/"
    )
    try:
        import aiohttp

        timeout = aiohttp.ClientTimeout(total=20)
        async with aiohttp.ClientSession(timeout=timeout) as session:
            async with session.get(url) as response:
                if response.status != 200:
                    return {"ip": address, "error": f"RDAP replied {response.status}"}
                payload = await response.json(content_type=None)
    except Exception as exc:  # noqa: BLE001
        return {"ip": address, "error": str(exc)[:200]}

    entities = [
        {
            "handle": entity.get("handle"),
            "name": _vcard_name(entity),
            "roles": entity.get("roles", []),
        }
        for entity in payload.get("entities", [])
    ]
    return {
        "ip": address,
        "name": payload.get("name"),
        "handle": payload.get("handle"),
        "start": payload.get("startAddress"),
        "end": payload.get("endAddress"),
        "country": payload.get("country"),
        "type": payload.get("type"),
        "entities": entities[:12],
        "events": payload.get("events", []),
    }


def _vcard_name(entity: dict) -> str | None:
    for item in entity.get("vcardArray", [[], []])[1:]:
        for entry in item:
            if entry and entry[0] == "fn":
                return entry[3]
    return None