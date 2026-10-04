"""SQLite storage for users, sessions, audit trail and app settings."""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from pathlib import Path
from typing import Any, Iterable

from .security import hash_password, token_fingerprint, validate_password, validate_username

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'operator',
    disabled      INTEGER NOT NULL DEFAULT 0,
    created_at    REAL NOT NULL,
    last_login_at REAL,
    failed_logins INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
    fingerprint TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  REAL NOT NULL,
    expires_at  REAL NOT NULL,
    ip          TEXT,
    user_agent  TEXT
);

CREATE TABLE IF NOT EXISTS magic_links (
    token        TEXT PRIMARY KEY,
    email        TEXT NOT NULL,
    user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE,
    created_at   REAL NOT NULL,
    expires_at   REAL NOT NULL,
    consumed_at  REAL,
    ip           TEXT,
    user_agent   TEXT
);
CREATE TABLE IF NOT EXISTS oauth_accounts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    provider   TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT,
    created_at REAL NOT NULL,
    UNIQUE (provider, provider_id)
);

CREATE TABLE IF NOT EXISTS audit (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    ts       REAL NOT NULL,
    user_id  INTEGER,
    username TEXT,
    action   TEXT NOT NULL,
    target   TEXT,
    outcome  TEXT NOT NULL,
    detail   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit(user_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
"""


class Database:
    """Thread-safe SQLite wrapper (the app runs a worker thread for the proxy)."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        with self.connect() as conn:
            conn.executescript(SCHEMA)

    # ------------------------------------------------------------ plumbing
    def connect(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=15, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return conn

    def execute(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
        with self._write_lock:
            conn = self.connect()
            cursor = conn.execute(sql, tuple(params))
            conn.commit()
            return cursor

    def query(self, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
        return list(self.connect().execute(sql, tuple(params)).fetchall())

    def one(self, sql: str, params: Iterable[Any] = ()) -> sqlite3.Row | None:
        return self.connect().execute(sql, tuple(params)).fetchone()

    def scalar(self, sql: str, params: Iterable[Any] = ()) -> Any:
        row = self.one(sql, params)
        return row[0] if row is not None else None

    # --------------------------------------------------------------- users
    def user_count(self) -> int:
        return int(self.scalar("SELECT COUNT(*) FROM users") or 0)

    def create_user(
        self, username: str, password: str, role: str = "operator", *, allow_admin: bool = False
    ) -> sqlite3.Row:
        username = validate_username(username)
        password = validate_password(password)
        first_user = self.user_count() == 0
        if role == "admin" and not allow_admin and not first_user:
            role = "operator"
        if first_user:
            # the very first account owns the installation
            role = "admin" if allow_admin else role
        cursor = self.execute(
            "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
            (username, hash_password(password), role, time.time()),
        )
        return self.get_user_by_id(int(cursor.lastrowid))  # type: ignore[return-value]

    def get_user(self, username: str) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE username = ?", (username,))

    def get_user_by_id(self, user_id: int) -> sqlite3.Row | None:
        return self.one("SELECT * FROM users WHERE id = ?", (user_id,))

    def list_users(self) -> list[sqlite3.Row]:
        return self.query("SELECT * FROM users ORDER BY id")

    def touch_login(self, user_id: int) -> None:
        self.execute(
            "UPDATE users SET last_login_at = ?, failed_logins = 0 WHERE id = ?", (time.time(), user_id)
        )

    def note_failed_login(self, user_id: int) -> None:
        self.execute("UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ?", (user_id,))

    def set_disabled(self, user_id: int, disabled: bool) -> None:
        self.execute("UPDATE users SET disabled = ? WHERE id = ?", (1 if disabled else 0, user_id))
        if disabled:
            self.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    def set_role(self, user_id: int, role: str) -> None:
        self.execute("UPDATE users SET role = ? WHERE id = ?", (role, user_id))

    def set_password(self, user_id: int, password: str) -> None:
        password = validate_password(password)
        self.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hash_password(password), user_id))
        self.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))

    # ------------------------------------------------------------ sessions
    def create_session(
        self, user_id: int, token: str, ttl: float, ip: str | None, user_agent: str | None
    ) -> float:
        now = time.time()
        expires = now + ttl
        self.execute(
            "INSERT INTO sessions (fingerprint, user_id, created_at, expires_at, ip, user_agent)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (token_fingerprint(token), user_id, now, expires, ip, (user_agent or "")[:200]),
        )
        return expires

    def session_user(self, token: str) -> sqlite3.Row | None:
        row = self.one(
            "SELECT s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id"
            " WHERE s.fingerprint = ?",
            (token_fingerprint(token),),
        )
        if row is None:
            return None
        if float(row["expires_at"]) < time.time():
            self.delete_session(token)
            return None
        if int(row["disabled"]):
            self.delete_session(token)
            return None
        return row

    def delete_session(self, token: str) -> None:
        self.execute("DELETE FROM sessions WHERE fingerprint = ?", (token_fingerprint(token),))

    def purge_expired(self) -> int:
        cursor = self.execute("DELETE FROM sessions WHERE expires_at < ?", (time.time(),))
        return cursor.rowcount or 0

    def sessions_for_user(self, user_id: int) -> list[sqlite3.Row]:
        return self.query("SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC", (user_id,))

    # --------------------------------------------------------------- audit
    def audit(
        self,
        action: str,
        *,
        user_id: int | None = None,
        username: str | None = None,
        target: str | None = None,
        outcome: str = "ok",
        detail: str | None = None,
    ) -> None:
        self.execute(
            "INSERT INTO audit (ts, user_id, username, action, target, outcome, detail)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                time.time(),
                user_id,
                username,
                action,
                (target or "")[:200] or None,
                outcome,
                (detail or "")[:1000] or None,
            ),
        )

    def recent_audit(self, limit: int = 100, user_id: int | None = None) -> list[sqlite3.Row]:
        if user_id is not None:
            return self.query(
                "SELECT * FROM audit WHERE user_id = ? ORDER BY ts DESC LIMIT ?", (user_id, limit)
            )
        return self.query("SELECT * FROM audit ORDER BY ts DESC LIMIT ?", (limit,))

    # ----------------------------------------------------------- magic links
    def create_magic_link(
        self,
        email: str,
        token: str,
        user_id: int | None,
        ttl: float,
        ip: str | None,
        user_agent: str | None,
    ) -> float:
        now = time.time()
        expires = now + ttl
        self.execute(
            "INSERT INTO magic_links (token, email, user_id, created_at, expires_at, ip, user_agent)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (token, email.lower(), user_id, now, expires, ip, (user_agent or "")[:200]),
        )
        return expires

    def consume_magic_link(self, token: str) -> sqlite3.Row | None:
        row = self.one(
            "SELECT * FROM magic_links WHERE token = ? AND consumed_at IS NULL AND expires_at > ?",
            (token, time.time()),
        )
        if row is None:
            return None
        self.execute("UPDATE magic_links SET consumed_at = ? WHERE token = ?", (time.time(), token))
        return row

    # ------------------------------------------------------------ settings
    def set_setting(self, key: str, value: Any) -> None:
        self.execute(
            "INSERT INTO settings (key, value) VALUES (?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (key, json.dumps(value)),
        )

    def get_setting(self, key: str, default: Any = None) -> Any:
        row = self.one("SELECT value FROM settings WHERE key = ?", (key,))
        if row is None:
            return default
        try:
            return json.loads(row["value"])
        except json.JSONDecodeError:
            return default