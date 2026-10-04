"""Password hashing, session tokens and login rate limiting."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time

__all__ = [
    "hash_password",
    "verify_password",
    "new_token",
    "token_fingerprint",
    "constant_time_equals",
    "LoginThrottle",
    "validate_username",
    "validate_password",
    "validate_hostname",
]

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
DKLEN = 32


def hash_password(password: str, *, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
        dklen=DKLEN,
        maxmem=64 * 1024 * 1024,
    )
    return "$".join(
        [
            "scrypt",
            str(SCRYPT_N),
            str(SCRYPT_R),
            str(SCRYPT_P),
            base64.b64encode(salt).decode(),
            base64.b64encode(digest).decode(),
        ]
    )


def verify_password(password: str, encoded: str) -> bool:
    try:
        algorithm, n, r, p, salt_b64, digest_b64 = encoded.split("$")
        if algorithm != "scrypt":
            return False
        expected = base64.b64decode(digest_b64)
        actual = hashlib.scrypt(
            password.encode("utf-8"),
            salt=base64.b64decode(salt_b64),
            n=int(n),
            r=int(r),
            p=int(p),
            dklen=len(expected),
            maxmem=64 * 1024 * 1024,
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_fingerprint(token: str) -> str:
    """Only the fingerprint is stored, so a database copy cannot be replayed."""
    return hashlib.sha256(token.encode()).hexdigest()


def constant_time_equals(left: str, right: str) -> bool:
    return hmac.compare_digest(left.encode(), right.encode())


class LoginThrottle:
    """Per-IP and per-account lockout to slow credential stuffing."""

    def __init__(self, *, max_attempts: int = 5, window: float = 300.0, block: float = 900.0) -> None:
        self.max_attempts = max_attempts
        self.window = window
        self.block = block
        self._entries: dict[str, list[float]] = {}
        self._blocked: dict[str, float] = {}

    def check(self, key: str) -> float:
        """Return seconds remaining on a lockout, or 0.0 when allowed."""
        now = time.monotonic()
        until = self._blocked.get(key, 0.0)
        return max(0.0, until - now) if until > now else 0.0

    def record_failure(self, key: str) -> float:
        now = time.monotonic()
        attempts = [t for t in self._entries.get(key, []) if now - t < self.window]
        attempts.append(now)
        self._entries[key] = attempts
        if len(attempts) >= self.max_attempts:
            self._blocked[key] = now + self.block
            self._entries.pop(key, None)
            return self.block
        return 0.0

    def record_success(self, key: str) -> None:
        self._entries.pop(key, None)
        self._blocked.pop(key, None)

    def reset(self, key: str) -> None:
        self.record_success(key)


def validate_username(username: str) -> str:
    username = (username or "").strip()
    if not 3 <= len(username) <= 32:
        raise ValueError("username must be 3-32 characters")
    if not all(c.isalnum() or c in "._-" for c in username):
        raise ValueError("username may only contain letters, digits, dot, underscore, hyphen")
    return username


def validate_password(password: str) -> str:
    password = password or ""
    if len(password) < 10:
        raise ValueError("password must be at least 10 characters")
    if not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        raise ValueError("password must mix letters and digits")
    if len(password) > 512:
        raise ValueError("password is too long")
    return password


def validate_hostname(host: str) -> str:
    """Accept only plain DNS names or IP literals — never URLs or shell junk."""
    import ipaddress
    import re

    host = (host or "").strip().rstrip(".")
    if not host:
        raise ValueError("host is required")
    if len(host) > 253:
        raise ValueError("host is too long")
    try:
        return str(ipaddress.ip_address(host))
    except ValueError:
        pass
    if not re.match(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$", host, re.I):
        raise ValueError(f"{host!r} is not a valid hostname or IP address")
    return host