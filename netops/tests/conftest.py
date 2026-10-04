"""Shared fixtures: an isolated config, database and authenticated client."""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from netops.config import load_config  # noqa: E402
from netops.db import Database  # noqa: E402


@pytest.fixture
def rotator_config(tmp_path: Path) -> Path:
    pool = tmp_path / "pools" / "test.txt"
    pool.parent.mkdir(parents=True, exist_ok=True)
    pool.write_text(
        "\n".join(
            [
                "# test upstreams",
                "127.0.0.1:18080",
                "127.0.0.1:18081:user:pass#tag=lab",
                "direct#tag=local",
                "",
            ]
        )
        + "\n",
        encoding="utf-8",
    )
    path = tmp_path / "rotator.toml"
    path.write_text(
        f"""
[gateway]
host = "127.0.0.1"
port = {_free_port()}
socks_port = {_free_port()}
metrics_port = {_free_port()}

[health]
url = "https://api.ipify.org?format=json"
interval = 3600.0

[[tier]]
name = "file-tier"
strategy = "round_robin"
files = ["pools/test.txt"]

[[tier]]
name = "inline-tier"
kind = "socks5"
inline = ["socks5://user:pass@127.0.0.1:1080#tag=tor"]
""",
        encoding="utf-8",
    )
    return path


def _free_port() -> int:
    import socket

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


@pytest.fixture
def netops_config(tmp_path: Path, rotator_config: Path) -> Path:
    path = tmp_path / "netops.toml"
    path.write_text(
        f"""
[server]
host = "127.0.0.1"
port = {_free_port()}
db_path = "data/netops.db"
rotator_config = "{rotator_config.as_posix()}"

[server_control]
services_allowlist = ["tor.service", "ssh.service"]
use_sudo = false

[scanner]
enabled = true
allow_private_targets = true
allowed_targets = ["127.0.0.1", "localhost"]
max_ports = 40
nmap_enabled = true
nmap_flags = ["-sT", "--top-ports", "100"]
tools_enabled = true
tool_timeout = 15
""",
        encoding="utf-8",
    )
    return path


@pytest.fixture
def db(netops_config: Path) -> Database:
    return Database(load_config(netops_config).db_path)


@pytest.fixture
def client(netops_config: Path):
    from fastapi.testclient import TestClient

    from netops.web.app import create_app

    os.environ["NETOPS_CONFIG"] = str(netops_config)
    app = create_app(netops_config)
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin_client(client):
    response = client.post("/api/auth/signup", json={"username": "admin", "password": "sup3rsecret1"})
    assert response.status_code == 200, response.text
    return client
