"""Application configuration (netops.toml) with safe defaults."""

from __future__ import annotations

import os
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

__all__ = ["ScannerPolicy", "BrowserPolicy", "NetopsConfig", "load_config", "ROOT"]

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class BrowserPolicy:
    """How the built-in privacy browser is allowed to behave."""

    enabled: bool = True
    engine: str = "chromium"          # chromium | firefox
    executable_path: str | None = None  # point at /usr/bin/chromium if you prefer
    headless: bool = True
    require_headless: bool = False    # true forbids a visible window

    # privacy posture
    block_third_party_cookies: bool = True
    resist_fingerprinting: bool = True
    https_only: bool = True
    disable_webrtc: bool = True
    disable_javascript: bool = False
    block_service_workers: bool = False
    block_notifications: bool = True
    disable_pdf_viewer: bool = True
    ignore_https_errors: bool = False
    no_sandbox: bool = True           # required for Chromium inside WSL containers
    proxy_dns: bool = False           # socks5 remote DNS (breaks http proxies)
    cache_enabled: bool = False
    clear_on_close: bool = True
    blocklist: tuple[str, ...] = ()

    # identity / fingerprint surface
    locale: str = "en-GB"
    timezone: str = "Europe/London"
    user_agent: str | None = None
    viewport_width: int = 1440
    viewport_height: int = 900
    device_scale_factor: float = 1.0
    has_touch: bool = False
    prefers_dark: bool = True
    permissions: tuple[str, ...] = ()

    # limits
    max_tabs: int = 12
    max_tabs_per_user: int = 4
    idle_timeout: int = 1800
    navigation_timeout: float = 30.0
    storage_state: str | None = None
    downloads_path: str | None = None
    extra_args: tuple[str, ...] = ()
    env: tuple[tuple[str, str], ...] = ()

    @property
    def env_dict(self) -> dict[str, str]:
        return dict(self.env)


@dataclass(frozen=True)
class ScannerPolicy:
    """Hard limits for anything that touches the network or spawns processes."""

    enabled: bool = True
    allow_private_targets: bool = True
    allowed_targets: tuple[str, ...] = ()
    max_ports: int = 200
    max_concurrency: int = 64
    connect_timeout: float = 1.5
    max_runtime_seconds: int = 600
    nmap_enabled: bool = True
    nmap_flags: tuple[str, ...] = ("-sT", "--top-ports", "100")
    tools_enabled: bool = True
    tool_timeout: int = 30

    def target_allowed(self, target: str) -> bool:
        """Only scan what the operator declared in netops.toml."""
        if not self.allowed_targets:
            return False
        target = target.strip().lower()
        for entry in self.allowed_targets:
            entry = entry.strip().lower()
            if entry == "*":
                return True
            if target == entry:
                return True
            if entry.startswith("*.") and target.endswith(entry[1:]):
                return True
        return False


@dataclass
class NetopsConfig:
    host: str = "127.0.0.1"
    port: int = 8443
    session_ttl: int = 60 * 60 * 12
    secure_cookies: bool = False
    db_path: Path = field(default_factory=lambda: ROOT / "data" / "netops.db")
    rotator_config: Path = field(default_factory=lambda: ROOT / "rotator.toml")
    initial_admin: str = "admin"
    initial_password: str | None = None
    services_allowlist: tuple[str, ...] = (
        "netops.service",
        "rotator.service",
        "tor.service",
        "haproxy.service",
        "ssh.service",
        "nginx.service",
        "docker.service",
    )
    use_sudo_for_services: bool = True
    scanner: ScannerPolicy = field(default_factory=ScannerPolicy)
    browser: BrowserPolicy = field(default_factory=BrowserPolicy)
    root: Path = field(default_factory=lambda: ROOT)

    @property
    def scanner_enabled(self) -> bool:
        return self.scanner.enabled


def _policy(raw: dict) -> ScannerPolicy:
    defaults = ScannerPolicy()
    return ScannerPolicy(
        enabled=bool(raw.get("enabled", defaults.enabled)),
        allow_private_targets=bool(raw.get("allow_private_targets", defaults.allow_private_targets)),
        allowed_targets=tuple(str(t) for t in raw.get("allowed_targets", ())),
        max_ports=int(raw.get("max_ports", defaults.max_ports)),
        max_concurrency=int(raw.get("max_concurrency", defaults.max_concurrency)),
        connect_timeout=float(raw.get("connect_timeout", defaults.connect_timeout)),
        max_runtime_seconds=int(raw.get("max_runtime_seconds", defaults.max_runtime_seconds)),
        nmap_enabled=bool(raw.get("nmap_enabled", defaults.nmap_enabled)),
        nmap_flags=tuple(str(f) for f in raw.get("nmap_flags", defaults.nmap_flags)),
        tools_enabled=bool(raw.get("tools_enabled", defaults.tools_enabled)),
        tool_timeout=int(raw.get("tool_timeout", defaults.tool_timeout)),
    )


def load_config(path: str | Path | None = None) -> NetopsConfig:
    config_path = Path(path or os.environ.get("NETOPS_CONFIG", ROOT / "netops.toml"))
    config = NetopsConfig()
    if config_path.is_file():
        data = tomllib.loads(config_path.read_text(encoding="utf-8"))
        server = data.get("server", {})
        config.host = str(server.get("host", config.host))
        config.port = int(server.get("port", config.port))
        config.session_ttl = int(server.get("session_ttl", config.session_ttl))
        config.secure_cookies = bool(server.get("secure_cookies", config.secure_cookies))
        if server.get("db_path"):
            config.db_path = (config_path.parent / server["db_path"]).resolve()
        if server.get("rotator_config"):
            config.rotator_config = (config_path.parent / server["rotator_config"]).resolve()
        initial = data.get("initial_admin", None)
        if isinstance(initial, dict):
            config.initial_admin = str(initial.get("username", config.initial_admin))
            config.initial_password = initial.get("password") or None
        elif isinstance(initial, str) and initial:
            config.initial_admin = initial
        control = data.get("server_control", {})
        if "services_allowlist" in control:
            config.services_allowlist = tuple(str(s) for s in control["services_allowlist"])
        config.use_sudo_for_services = bool(
            control.get("use_sudo", config.use_sudo_for_services)
        )
        config.scanner = _policy(data.get("scanner", {}))
        config.browser = _browser_policy(data.get("browser", {}))
    return config


def _browser_policy(raw: dict) -> BrowserPolicy:
    defaults = BrowserPolicy()
    bool_keys = (
        "enabled", "headless", "require_headless", "block_third_party_cookies",
        "resist_fingerprinting", "https_only", "disable_webrtc", "disable_javascript",
        "block_service_workers", "block_notifications", "disable_pdf_viewer",
        "ignore_https_errors", "no_sandbox", "proxy_dns", "cache_enabled",
        "clear_on_close", "has_touch", "prefers_dark",
    )
    values: dict[str, object] = {}
    for key in bool_keys:
        if key in raw:
            values[key] = bool(raw[key])
    for key in (
        "viewport_width", "viewport_height", "max_tabs", "max_tabs_per_user",
        "idle_timeout",
    ):
        if key in raw:
            values[key] = int(raw[key])
    for key in ("navigation_timeout", "device_scale_factor"):
        if key in raw:
            values[key] = float(raw[key])
    for key in ("engine", "locale", "timezone", "executable_path", "user_agent",
                "storage_state", "downloads_path"):
        if raw.get(key):
            values[key] = str(raw[key])
    for key in ("blocklist", "permissions", "extra_args"):
        if raw.get(key):
            values[key] = tuple(str(item) for item in raw[key])
    if raw.get("env"):
        values["env"] = tuple((str(k), str(v)) for k, v in dict(raw["env"]).items())
    engine = str(values.get("engine", defaults.engine))
    if engine not in ("chromium", "firefox"):
        raise ValueError(f"browser.engine must be chromium or firefox, got {engine!r}")
    return BrowserPolicy(**values)  # type: ignore[arg-type]