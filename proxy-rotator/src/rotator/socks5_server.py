"""SOCKS5 front end: same rotation pool, SOCKS5 wire protocol."""

from __future__ import annotations

import asyncio
import ipaddress
import logging

from .pool import NoUpstreamAvailable

log = logging.getLogger("rotator.socks5")

__all__ = ["handle_socks_client"]

AUTH_NONE = 0x00
AUTH_USERPASS = 0x02
AUTH_NO_ACCEPTABLE = 0xFF

CMD_CONNECT = 0x01
CMD_UDP_ASSOCIATE = 0x03

ATYP_IPV4 = 0x01
ATYP_DOMAIN = 0x03
ATYP_IPV6 = 0x04

_REPLY_FAILURE = 0x01
_REPLY_SUCCESS = 0x00


async def _read_address(
    reader: asyncio.StreamReader, atyp: int | None = None
) -> tuple[str, int]:
    if atyp is None:
        atyp = (await reader.readexactly(1))[0]
    if atyp == ATYP_IPV4:
        host = str(ipaddress.IPv4Address(await reader.readexactly(4)))
    elif atyp == ATYP_IPV6:
        host = str(ipaddress.IPv6Address(await reader.readexactly(16)))
    elif atyp == ATYP_DOMAIN:
        length = (await reader.readexactly(1))[0]
        host = (await reader.readexactly(length)).decode("idna", "replace")
    else:
        raise ValueError(f"unsupported address type 0x{atyp:02x}")
    port = int.from_bytes(await reader.readexactly(2), "big")
    return host, port


def _encode_address(host: str, port: int) -> bytes:
    try:
        return bytes([ATYP_IPV4]) + ipaddress.IPv4Address(host).packed + port.to_bytes(2, "big")
    except ipaddress.AddressValueError:
        pass
    try:
        return bytes([ATYP_IPV6]) + ipaddress.IPv6Address(host).packed + port.to_bytes(2, "big")
    except ipaddress.AddressValueError:
        pass
    encoded = host.encode()[:255]
    return bytes([ATYP_DOMAIN, len(encoded)]) + encoded + port.to_bytes(2, "big")


async def handle_socks_client(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    gateway,
) -> None:
    config = gateway.config
    lease = None
    up_writer = None
    try:
        version, nmethods = await asyncio.wait_for(reader.readexactly(2), timeout=15)
        if version != 0x05:
            writer.close()
            return
        methods = set(await reader.readexactly(nmethods))
        if config.username:
            if AUTH_USERPASS not in methods:
                writer.write(bytes([0x05, AUTH_NO_ACCEPTABLE]))
                await writer.drain()
                return
            writer.write(bytes([0x05, AUTH_USERPASS]))
            await writer.drain()
            head = await reader.readexactly(2)
            ulen = (await reader.readexactly(1))[0]
            user = (await reader.readexactly(ulen)).decode("utf-8", "replace")
            plen = (await reader.readexactly(1))[0]
            secret = (await reader.readexactly(plen)).decode("utf-8", "replace")
            if user != config.username or secret != (config.password or ""):
                writer.write(bytes([0x01, 0x01]))
                await writer.drain()
                return
            writer.write(bytes([0x01, 0x00]))
            await writer.drain()
        elif AUTH_NONE not in methods:
            writer.write(bytes([0x05, AUTH_NO_ACCEPTABLE]))
            await writer.drain()
            return
        else:
            writer.write(bytes([0x05, AUTH_NONE]))
            await writer.drain()

        request = await reader.readexactly(4)
        command = request[1]
        host, port = await _read_address(reader, request[3])
        if command != CMD_CONNECT:
            writer.write(bytes([0x05, 0x07, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]))
            await writer.drain()
            return

        selection = gateway._selection_for_peer(reader, writer)
        exclude: set[str] = set()
        last_error: Exception | None = None
        for _ in range(max(1, config.max_attempts)):
            try:
                up_reader, up_writer, lease = await gateway.open_for(
                    host, port, exclude=exclude, **selection
                )
                last_error = None
                break
            except Exception as exc:  # noqa: BLE001
                last_error = exc
                if isinstance(exc, NoUpstreamAvailable):
                    break
                upstream_id = getattr(exc, "upstream_id", None)
                if upstream_id:
                    exclude.add(upstream_id)
                log.warning("socks5 connect failed via %s: %s", host, exc)

        if lease is None or up_writer is None:
            code = 0x01 if last_error is not None else 0x04
            writer.write(bytes([0x05, code, 0x00, ATYP_IPV4, 0, 0, 0, 0, 0, 0]))
            await writer.drain()
            return

        writer.write(bytes([0x05, _REPLY_SUCCESS, 0x00]) + _encode_address("0.0.0.0", 0))
        await writer.drain()
        await gateway._pump_pair(reader, writer, up_reader, up_writer, lease)
    except (asyncio.IncompleteReadError, ConnectionResetError, asyncio.TimeoutError, BrokenPipeError):
        pass
    except asyncio.CancelledError:
        raise
    except Exception:  # noqa: BLE001
        log.exception("socks5 client failed")
    finally:
        if up_writer is not None:
            try:
                up_writer.close()
            except Exception:  # noqa: BLE001
                pass
        if lease is not None:
            lease.release()
        try:
            writer.close()
        except Exception:  # noqa: BLE001
            pass