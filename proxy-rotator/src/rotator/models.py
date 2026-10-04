"""Upstream definitions plus parsing of pool files."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, replace
from enum import Enum
from urllib.parse import unquote, urlsplit

__all__ = ["UpstreamKind", "UpstreamSpec", "parse_upstream_line", "parse_pool_text"]


class UpstreamKind(str, Enum):
    HTTP = "http"
    SOCKS5 = "socks5"
    DIRECT = "direct"


_SCHEME_KINDS = {
    "http": UpstreamKind.HTTP,
    "https": UpstreamKind.HTTP,
    "socks5": UpstreamKind.SOCKS5,
    "socks5h": UpstreamKind.SOCKS5,
    "direct": UpstreamKind.DIRECT,
    "local": UpstreamKind.DIRECT,
}


@dataclass(frozen=True, slots=True)
class UpstreamSpec:
    host: str
    port: int
    kind: UpstreamKind = UpstreamKind.HTTP
    username: str | None = None
    password: str | None = None
    weight: int = 1
    country: str | None = None
    tags: frozenset[str] = frozenset()
    bind_address: str | None = None
    source: str = "-"

    @property
    def id(self) -> str:
        raw = f"{self.kind.value}|{self.host}:{self.port}|{self.username or ''}|{self.bind_address or ''}"
        return hashlib.sha1(raw.encode()).hexdigest()[:12]

    @property
    def label(self) -> str:
        auth = f"{self.username}:***@" if self.username else ""
        bind = f"[{self.bind_address}]" if self.bind_address else ""
        return f"{self.kind.value}://{bind}{auth}{self.host}:{self.port}"

    @property
    def endpoint(self) -> str:
        bind = f"{self.bind_address}" if self.bind_address else ""
        return f"{bind}{self.host}:{self.port}"

    def redacted(self) -> str:
        return self.label


def _coerce_weight(raw: str) -> int:
    try:
        weight = int(raw)
    except ValueError as exc:
        raise ValueError(f"invalid weight {raw!r}") from exc
    if not 1 <= weight <= 1000:
        raise ValueError(f"weight out of range: {weight}")
    return weight


def _coerce_port(raw: str) -> int:
    if not raw.isdigit():
        raise ValueError(f"invalid port {raw!r}")
    port = int(raw)
    if not 1 <= port <= 65535:
        raise ValueError(f"port out of range: {port}")
    return port


_OPTION_KEYS = ("weight", "country", "cc", "tag", "tags")


def _split_options(fragment: str) -> list[tuple[str | None, str]]:
    """Tokenise ``weight=3,us,fast`` into ``[("weight","3"), (None,"us"), (None,"fast")]``.

    A separator only starts a new option when a known key follows it, so bare
    tags and multi-valued keys survive intact.
    """
    tokens: list[tuple[str | None, str]] = []
    lookahead = r"(?:weight|country|cc|tag|tags)\s*="
    for chunk in re.split(rf"[,;&](?=\s*{lookahead})", fragment):
        chunk = chunk.strip()
        if not chunk:
            continue
        key, sep, value = chunk.partition("=")
        if not sep:
            tokens.append((None, chunk))
            continue
        key = key.strip().lower()
        value = value.strip()
        if key in ("weight", "country", "cc"):
            value, _, rest = value.partition(",")
            tokens.append((key, value.strip()))
            if rest.strip():
                tokens.append((None, rest.strip()))
        else:
            tokens.append((key, value))
    return tokens


def _apply_options(spec: UpstreamSpec, fragment: str) -> UpstreamSpec:
    if not fragment:
        return spec
    overrides: dict[str, object] = {}
    extra_tags: set[str] = set()
    for key, value in _split_options(fragment):
        value = value.lower()
        if key is None:
            extra_tags.update(t for t in value.replace(",", " ").split() if t)
        elif key == "weight":
            overrides["weight"] = _coerce_weight(value)
        elif key in ("country", "cc"):
            overrides["country"] = value or None
        elif key in ("tag", "tags"):
            extra_tags.update(t for t in value.replace(",", " ").split() if t)
        else:
            raise ValueError(f"unknown option {key!r}")
    tags = frozenset(set(spec.tags) | extra_tags)
    if not overrides and tags == spec.tags:
        return spec
    return replace(spec, tags=tags, **overrides)


def _split_comment(line: str) -> tuple[str, str]:
    """Split a line into content and inline comment.

    ``#`` only starts a comment at the beginning of a line or after whitespace,
    so ``host:8080#weight=3`` keeps its options while ``host:8080 # note`` does not.
    """
    for index, char in enumerate(line):
        if char == "#" and (index == 0 or line[index - 1].isspace()):
            return line[:index].strip(), line[index + 1 :].strip()
    return line.strip(), ""


def parse_upstream_line(
    line: str,
    *,
    default_kind: UpstreamKind = UpstreamKind.HTTP,
    source: str = "-",
) -> UpstreamSpec:
    """Parse one upstream line.

    Accepted forms::

        1.2.3.4:8080
        1.2.3.4:8080:user:pass
        http://user:pass@host:8080
        socks5://host:1080
        socks5://user:pass@host:1080#weight=5,us,fast
        direct:203.0.113.7          # egress bound to a local interface address
        direct
    """
    raw, _comment = _split_comment(line)
    if not raw:
        raise ValueError("empty line")
    base, _, fragment = raw.partition("#")

    if "://" in base:
        parts = urlsplit(base)
        kind = _SCHEME_KINDS.get(parts.scheme.lower())
        if kind is None:
            raise ValueError(f"unsupported scheme {parts.scheme!r} in {raw!r}")
        host = parts.hostname or ""
        port = parts.port
        username = unquote(parts.username) if parts.username else None
        password = unquote(parts.password) if parts.password else None
        if kind is UpstreamKind.DIRECT:
            # direct://203.0.113.7 or direct://203.0.113.7:0
            bind = host or None
            return _apply_options(
                UpstreamSpec(
                    host="direct",
                    port=0,
                    kind=kind,
                    bind_address=bind,
                    source=source,
                ),
                fragment,
            )
        if not host:
            raise ValueError(f"missing host in {raw!r}")
        if port is None:
            port = 8080 if kind is UpstreamKind.HTTP else 1080
        spec = UpstreamSpec(
            host=host,
            port=_coerce_port(str(port)),
            kind=kind,
            username=username,
            password=password,
            source=source,
        )
        return _apply_options(spec, fragment)

    # scheme-less forms
    if base.lower().startswith("direct"):
        _, _, tail = base.partition(":")
        return _apply_options(
            UpstreamSpec(
                host="direct",
                port=0,
                kind=UpstreamKind.DIRECT,
                bind_address=tail.strip() or None,
                source=source,
            ),
            fragment,
        )

    parts = base.split(":")
    if len(parts) == 4:
        host, port, username, password = parts
        spec = UpstreamSpec(
            host=host.strip(),
            port=_coerce_port(port.strip()),
            kind=default_kind,
            username=username or None,
            password=password or None,
            source=source,
        )
        return _apply_options(spec, fragment)
    if len(parts) == 2:
        host, port = parts
        return _apply_options(
            UpstreamSpec(
                host=host.strip(),
                port=_coerce_port(port.strip()),
                kind=default_kind,
                source=source,
            ),
            fragment,
        )
    if len(parts) == 3:
        host, port, username = parts
        return _apply_options(
            UpstreamSpec(
                host=host.strip(),
                port=_coerce_port(port.strip()),
                kind=default_kind,
                username=username or None,
                source=source,
            ),
            fragment,
        )
    raise ValueError(f"cannot parse upstream line: {raw!r}")


def parse_pool_text(
    text: str,
    *,
    default_kind: UpstreamKind = UpstreamKind.HTTP,
    source: str = "-",
) -> list[UpstreamSpec]:
    specs: list[UpstreamSpec] = []
    seen: set[str] = set()
    errors: list[str] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        if not _split_comment(line)[0]:
            continue
        try:
            spec = parse_upstream_line(line, default_kind=default_kind, source=source)
        except ValueError as exc:
            errors.append(f"{source}:{lineno}: {exc}")
            continue
        if spec.id in seen:
            continue
        seen.add(spec.id)
        specs.append(spec)
    if errors:
        raise ValueError("invalid pool entries:\n  " + "\n  ".join(errors))
    return specs