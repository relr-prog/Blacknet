from __future__ import annotations

from pathlib import Path

import pytest

from rotator.config import build_pool, load_config
from rotator.models import UpstreamKind
from rotator.pool import Strategy

CONFIG = """
[gateway]
host = "127.0.0.1"
port = 8899
socks_port = 1099
metrics_port = 9099
strategy = "weighted_random"
sticky_ttl = 60

[health]
enabled = true
interval = 30
url = "http://127.0.0.1:9/json"

[[tier]]
name = "premium"
strategy = "round_robin"
max_slots = 4
files = ["pools/premium.txt"]

[[tier]]
name = "backup"
strategy = "random"
kind = "socks5"
inline = ["socks5://127.0.0.1:9050#tag=tor", "direct"]
"""


@pytest.fixture
def config_dir(tmp_path: Path) -> Path:
    (tmp_path / "pools").mkdir()
    (tmp_path / "pools" / "premium.txt").write_text(
        "# premium pool\n10.0.0.1:8080:user:pass\n10.0.0.2:8080#weight=5,country=us,fast\n",
        encoding="utf-8",
    )
    (tmp_path / "rotator.toml").write_text(CONFIG, encoding="utf-8")
    return tmp_path


def test_load_and_build(config_dir: Path):
    config = load_config(config_dir / "rotator.toml")
    assert config.gateway.port == 8899
    assert config.gateway.socks_port == 1099
    assert config.gateway.metrics_port == 9099
    assert config.gateway.sticky_ttl == 60
    assert config.strategy is Strategy.WEIGHTED_RANDOM
    assert config.health is not None and config.health.interval == 30
    assert [t.name for t in config.tiers] == ["premium", "backup"]

    pool = build_pool(config)
    assert len(pool) == 4
    assert pool.strategy is Strategy.WEIGHTED_RANDOM
    assert pool.tiers == [0, 1]

    premium = pool.tier_states(0)
    assert premium[0].spec.username == "user"
    assert premium[1].spec.weight == 5
    assert premium[1].spec.country == "us"
    assert premium[1].spec.tags == frozenset({"fast"})
    assert premium[0].max_slots == 4

    backup = pool.tier_states(1)
    kinds = sorted(s.spec.kind.value for s in backup)
    assert kinds == ["direct", "socks5"]
    assert any("tor" in s.spec.tags for s in backup)


def test_missing_pool_file_is_a_warning_not_a_crash(config_dir: Path):
    (config_dir / "pools" / "premium.txt").unlink()
    config = load_config(config_dir / "rotator.toml")
    pool = build_pool(config)
    assert len(pool) == 2  # only the backup tier survived


def test_config_without_tiers_is_rejected(tmp_path: Path):
    (tmp_path / "bad.toml").write_text('[gateway]\nport = 1\n', encoding="utf-8")
    with pytest.raises(ValueError, match=r"no \[\[tier\]\]"):
        load_config(tmp_path / "bad.toml")


def test_unknown_strategy_is_rejected(tmp_path: Path):
    (tmp_path / "bad.toml").write_text(
        '[gateway]\nstrategy = "spiral"\n[[tier]]\ninline = ["direct"]\n', encoding="utf-8"
    )
    with pytest.raises(ValueError, match="spiral"):
        load_config(tmp_path / "bad.toml")


def test_tier_without_sources_is_rejected(tmp_path: Path):
    (tmp_path / "bad.toml").write_text('[[tier]]\nname = "empty"\n', encoding="utf-8")
    with pytest.raises(ValueError, match="files"):
        load_config(tmp_path / "bad.toml")


def test_shipped_example_config_is_valid():
    root = Path(__file__).parent.parent
    config = load_config(root / "rotator.toml")
    pool = build_pool(config)
    assert len(pool) > 0
    assert any(s.spec.kind is UpstreamKind.SOCKS5 for s in pool.states)