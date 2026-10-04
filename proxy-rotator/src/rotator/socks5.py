"""Minimal async SOCKS5 client (RFC 1928 / 1929)."""

from __future__ import annotations

import asyncio
import ipaddress
import socket

__all__ = ["Socks5Error", "socks5_connect"]

AUTH_NONE = 0x00
AUTH_USERPASS = 0x02
AUTH_NO_ACCEPTABLE = 0xFF

CMD_CONNECT = 0x01

ATYP_IPV4 = 0x01
ATYP_DOMAIN = 0x03
ATYP_IPV6 = 0x04


class Socks5Error(OSError):
    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message if code is None else f"{message} (code=0x{code:02x})")
        self.code = code


_REPLY_TEXT = {
    0x00: "succeeded",
    0x01: "general SOCKS server failure",
    0x02: "connection not allowed by ruleset",
    0x03: "network unreachable",
    0x04: "host unreachable",
    0x05: "connection refused",
    0x06: "TTL expired",
    0x07: "command not supported",
    0x08: "address type not supported",
}


def _encode_address(host: str) -> bytes:
    try:
        return bytes([ATYP_IPV4]) + socket.inet_aton(host)
    except OSError:
        pass
    try:
        return bytes([ATYP_IPV6]) + socket.inet_pton(socket.AF_INET6, host)
    except OSError:
        pass
    encoded = host.encode("idna") if any(ord(c) > 127 for c in host) else host.encode()
    if len(encoded) > 255:
        raise Socks5Error("hostname too long for SOCKS5")
    return bytes([ATYP_DOMAIN, len(encoded)]) + encoded


async def socks5_connect(
    host: str,
    port: int,
    *,
    server: tuple[str, int] = ("127.0.0.1", 9050),
    username: str | None = None,
    password: str | None = None,
    timeout: float = 15.0,
    local_addr: tuple[str, int] | None = None,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Negotiate with a SOCKS5 proxy and open a tunnel to ``host:port``."""

    async def run() -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
        reader, writer = await asyncio.open_connection(
            server[0], server[1], local_addr=local_addr
        )
        try:
            methods = [AUTH_NONE]
            if username is not None:
                methods.append(AUTH_USERPASS)
            writer.write(bytes([0x05, len(methods), *methods]))
            await writer.drain()

            head = await reader.readexactly(2)
            if head[0] != 0x05:
                raise Socks5Error("not a SOCKS5 server")
            method = head[1]
            if method == AUTH_NO_ACCEPTABLE:
                raise Socks5Error("server rejected all offered auth methods")
            if method == AUTH_USERPASS:
                if username is None:
                    raise Socks5Error("server requires username/password auth")
                user = username.encode()
                secret = (password or "").encode()
                writer.write(
                    bytes([0x01, len(user)]) + user + bytes([len(secret)]) + secret
                )
                await writer.drain()
                reply = await reader.readexactly(2)
                if reply[1] != 0x00:
                    raise Socks5Error("username/password authentication rejected")
            elif method != AUTH_NONE:
                raise Socks5Error("unsupported auth method", method)

            writer.write(
                bytes([0x05, CMD_CONNECT, 0x00]) + _encode_address(host) + port.to_bytes(2, "big")
            )
            await writer.drain()

            resp = await reader.readexactly(4)
            if resp[0] != 0x05:
                raise Socks5Error("malformed reply")
            if resp[1] != 0x00:
                raise Socks5Error(_REPLY_TEXT.get(resp[1], "unknown failure"), resp[1])
            atyp = resp[3]
            if atyp == ATYP_IPV4:
                await reader.readexactly(4)
            elif atyp == ATYP_IPV6:
                await reader.readexactly(16)
            elif atyp == ATYP_DOMAIN:
                length = (await reader.readexactly(1))[0]
                await reader.readexactly(length)
            else:
                raise Socks5Error("unsupported address type in reply", atyp)
            await reader.readexactly(2)
            return reader, writer
        except BaseException:
            writer.close()
            raise

    return await asyncio.wait_for(run(), timeout=timeout)