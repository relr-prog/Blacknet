from __future__ import annotations

import pytest

from rotator.models import UpstreamKind, parse_pool_text, parse_upstream_line


def test_host_port():
    spec = parse_upstream_line("1.2.3.4:8080")
    assert (spec.host, spec.port, spec.kind) == ("1.2.3.4", 8080, UpstreamKind.HTTP)


def test_legacy_host_port_user_pass():
    spec = parse_upstream_line("proxy.example.com:3128:alice:s3cr3t")
    assert spec.host == "proxy.example.com"
    assert spec.port == 3128
    assert spec.username == "alice"
    assert spec.password == "s3cr3t"


def test_uri_forms():
    http = parse_upstream_line("http://user:p%40ss@host.example:9000")
    assert (http.username, http.password, http.port) == ("user", "p@ss", 9000)

    socks = parse_upstream_line("socks5://127.0.0.1:1080")
    assert socks.kind is UpstreamKind.SOCKS5
    assert socks.port == 1080


def test_default_ports_per_scheme():
    assert parse_upstream_line("http://host.example").port == 8080
    assert parse_upstream_line("socks5://host.example").port == 1080


def test_fragment_options():
    spec = parse_upstream_line(
        "socks5://host.example:1080#weight=7,country=US,tag=fast,eu,cdn"
    )
    assert spec.weight == 7
    assert spec.country == "us"
    assert spec.tags == frozenset({"fast", "eu", "cdn"})


def test_direct_upstream_binds_source_address():
    spec = parse_upstream_line("direct:203.0.113.7")
    assert spec.kind is UpstreamKind.DIRECT
    assert spec.bind_address == "203.0.113.7"

    plain = parse_upstream_line("direct")
    assert plain.bind_address is None


def test_comments_and_blank_lines_are_skipped():
    specs = parse_pool_text(
        """
        # a comment line
        1.1.1.1:8080
        2.2.2.2:8080   # trailing comment
        3.3.3.3:8080
        """
    )
    assert [s.host for s in specs] == ["1.1.1.1", "2.2.2.2", "3.3.3.3"]


def test_duplicates_are_collapsed():
    specs = parse_pool_text("1.1.1.1:8080\n1.1.1.1:8080\n")
    assert len(specs) == 1


def test_error_messages_carry_line_numbers():
    with pytest.raises(ValueError) as excinfo:
        parse_pool_text("1.1.1.1:8080\nnot a proxy at all\n", source="pools/x.txt")
    message = str(excinfo.value)
    assert "pools/x.txt:2" in message
    assert "1.1.1.1:8080" not in message


def test_bad_port_rejected():
    with pytest.raises(ValueError, match="port out of range"):
        parse_upstream_line("1.1.1.1:70000")
    with pytest.raises(ValueError, match="invalid port"):
        parse_upstream_line("1.1.1.1:abc")


def test_id_is_stable_and_secrets_are_hidden():
    spec = parse_upstream_line("http://user:pass@1.2.3.4:8080")
    assert spec.id == parse_upstream_line("http://user:other@1.2.3.4:8080").id
    assert spec.id != parse_upstream_line("http://user:pass@1.2.3.5:8080").id
    assert "pass" not in spec.label
    assert "user:***@" in spec.label


# --- credentials from the environment ---------------------------------------
#
# A password in pools/*.txt ends up in git history, in a Docker image and in a bug
# report, and none of those can be taken back. ${VAR} keeps it in the environment,
# which is the only place a secret can actually be revoked from.


def test_password_can_come_from_the_environment(monkeypatch):
    monkeypatch.setenv("TEST_PW", "hunter2")
    spec = parse_upstream_line("socks5://user:${TEST_PW}@1.2.3.4:1080")
    assert spec.username == "user"
    assert spec.password == "hunter2"
    assert "hunter2" not in spec.label, "an expanded password must never be shown"


def test_a_missing_variable_is_an_error_not_an_empty_password(monkeypatch):
    # socks5://:@host would look like a broken proxy rather than a missing secret.
    monkeypatch.delenv("TEST_ABSENT", raising=False)
    with pytest.raises(ValueError, match="TEST_ABSENT"):
        parse_upstream_line("socks5://user:${TEST_ABSENT}@1.2.3.4:1080")


def test_an_empty_variable_is_treated_as_missing(monkeypatch):
    monkeypatch.setenv("TEST_EMPTY", "")
    with pytest.raises(ValueError, match="TEST_EMPTY"):
        parse_upstream_line("socks5://user:${TEST_EMPTY}@1.2.3.4:1080")


def test_a_default_makes_a_variable_optional(monkeypatch):
    monkeypatch.delenv("TEST_DEFAULT", raising=False)
    spec = parse_upstream_line("socks5://user:${TEST_DEFAULT:-guest}@1.2.3.4:1080")
    assert spec.password == "guest"


def test_expansion_happens_before_parsing(monkeypatch):
    monkeypatch.setenv("TEST_PW", "pw")
    monkeypatch.setenv("TEST_HOST", "1.2.3.4")
    spec = parse_upstream_line("http://user:${TEST_PW}@${TEST_HOST}:8080")
    assert (spec.host, spec.port) == ("1.2.3.4", 8080)


def test_pool_text_expands_too(monkeypatch):
    monkeypatch.setenv("TEST_PW", "hunter2")
    specs = parse_pool_text("# comment\nsocks5://u:${TEST_PW}@1.2.3.4:1080\n")
    assert specs[0].password == "hunter2"


def test_no_error_message_echoes_an_expanded_secret(monkeypatch):
    monkeypatch.setenv("TEST_SECRET", "topsecret123")
    with pytest.raises(ValueError) as excinfo:
        parse_upstream_line("ftp://user:${TEST_SECRET}@1.2.3.4:21")
    assert "topsecret123" not in str(excinfo.value)


def test_an_unset_variable_message_names_the_variable_not_the_line(monkeypatch):
    monkeypatch.delenv("TEST_NAMED", raising=False)
    with pytest.raises(ValueError) as excinfo:
        parse_upstream_line("socks5://user:${TEST_NAMED}@1.2.3.4:1080")
    message = str(excinfo.value)
    assert "TEST_NAMED" in message, "the operator needs to know which one to set"
    assert "@1.2.3.4" not in message, "and not the line it came from"