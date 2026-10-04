"""Database layer: hashing, sessions, user management, settings."""

from __future__ import annotations

import time

import pytest

from netops.security import verify_password


def test_password_hash_roundtrip(db):
    row = db.create_user("alice", "correcthorse1", role="operator")
    assert verify_password("correcthorse1", row["password_hash"])
    assert not verify_password("wronghorse1", row["password_hash"])
    assert row["password_hash"].startswith("scrypt$")


def test_admin_role_requires_explicit_permission(db):
    first = db.create_user("first", "correcthorse1", role="admin")  # no users yet
    assert first["role"] == "admin"
    second = db.create_user("second", "correcthorse1", role="operator")
    assert second["role"] == "operator"
    third = db.create_user("third", "correcthorse1", role="admin", allow_admin=True)
    assert third["role"] == "admin"


def test_duplicate_username_fails(db):
    db.create_user("alice", "correcthorse1")
    with pytest.raises(Exception):
        db.create_user("alice", "correcthorse2")


def test_sessions_expire_and_purge(db):
    user = db.create_user("alice", "correcthorse1")
    token = "abc123"
    db.create_session(int(user["id"]), token, ttl=-1, ip="127.0.0.1", user_agent="pytest")
    assert db.session_user(token) is None

    db.create_session(int(user["id"]), token, ttl=60, ip="127.0.0.1", user_agent="pytest")
    assert db.session_user(token) is not None
    assert db.delete_session(token) is None
    assert db.session_user(token) is None


def test_password_reset_revokes_sessions(db):
    user = db.create_user("alice", "correcthorse1")
    token = "keepme"
    db.create_session(int(user["id"]), token, 300, "127.0.0.1", "pytest")
    db.set_password(int(user["id"]), "newpassword9")
    assert db.session_user(token) is None


def test_disabling_user_revokes_sessions(db):
    user = db.create_user("alice", "correcthorse1")
    token = "disabled"
    db.create_session(int(user["id"]), token, 300, "127.0.0.1", "pytest")
    db.set_disabled(int(user["id"]), True)
    assert db.session_user(token) is None


def test_audit_and_settings_roundtrip(db):
    db.audit("test.action", user_id=1, username="alice", target="host", detail="ok")
    entries = db.recent_audit(limit=5)
    assert entries[0]["action"] == "test.action"
    assert db.recent_audit(limit=5, user_id=99) == []

    db.set_setting("rotator_pool_overrides", {"added": [{"line": "x"}]})
    assert db.get_setting("rotator_pool_overrides")["added"] == [{"line": "x"}]
    assert db.get_setting("missing", {"fallback": 1}) == {"fallback": 1}


def test_user_count_and_listing(db):
    assert db.user_count() == 0
    db.create_user("alice", "correcthorse1")
    db.create_user("bob", "correcthorse2")
    assert db.user_count() == 2
    assert [row["username"] for row in db.list_users()] == ["alice", "bob"]
    db.touch_login(int(db.get_user("alice")["id"]))
    assert db.get_user("alice")["last_login_at"] <= time.time()
