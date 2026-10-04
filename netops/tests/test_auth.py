"""Auth flow: first-user bootstrap, login, throttle, sessions, role gates."""

from __future__ import annotations

from fastapi.testclient import TestClient

PASSWORD = "sup3rsecret1"


def test_state_reports_setup_required(client):
    body = client.get("/api/auth/state").json()
    assert body["setup_required"] is True
    assert body["authenticated"] is False


def test_first_signup_becomes_admin(client):
    response = client.post("/api/auth/signup", json={"username": "admin", "password": PASSWORD})
    assert response.status_code == 200, response.text
    assert response.json()["user"]["role"] == "admin"
    assert client.cookies.get("netops_session")


def test_unauthenticated_requests_are_rejected(client):
    assert client.get("/api/monitor/overview").status_code == 401
    assert client.get("/api/rotator/status").status_code == 401


def test_second_signup_requires_an_admin(admin_client):
    anonymous = TestClient(admin_client.app)
    denied = anonymous.post(
        "/api/auth/signup", json={"username": "evil", "password": "sup3rsecret2"}
    )
    assert denied.status_code == 401

    created = admin_client.post(
        "/api/auth/signup", json={"username": "newbie", "password": "sup3rsecret2"}
    )
    assert created.status_code == 200, created.text
    assert created.json()["user"]["role"] == "operator"


def test_login_and_logout(admin_client):
    assert admin_client.post(
        "/api/auth/login", json={"username": "admin", "password": "wrongpassword1"}
    ).status_code == 401

    ok = admin_client.post("/api/auth/login", json={"username": "admin", "password": PASSWORD})
    assert ok.status_code == 200
    assert admin_client.get("/api/monitor/overview").status_code == 200

    assert admin_client.post("/api/auth/logout").status_code == 200
    assert admin_client.get("/api/monitor/overview").status_code == 401


def test_login_throttle_blocks_repeated_failures(admin_client):
    for _ in range(5):
        admin_client.post(
            "/api/auth/login", json={"username": "admin", "password": "badbadbad12"}
        )
    blocked = admin_client.post(
        "/api/auth/login", json={"username": "admin", "password": PASSWORD}
    )
    assert blocked.status_code == 429


def test_weak_password_is_rejected(client):
    response = client.post("/api/auth/signup", json={"username": "admin", "password": "short"})
    assert response.status_code == 400
    assert "at least 10" in response.json()["detail"]


def test_duplicate_username_conflicts(client):
    assert client.post("/api/auth/signup", json={"username": "admin", "password": PASSWORD}).status_code == 200
    second = TestClient(client.app)
    response = second.post("/api/auth/signup", json={"username": "admin", "password": PASSWORD})
    assert response.status_code == 401 or response.status_code == 409


def test_password_change_revokes_sessions(admin_client):
    assert admin_client.post(
        "/api/auth/password",
        json={"current_password": PASSWORD, "new_password": "anothersecret9"},
    ).status_code == 200
    assert admin_client.get("/api/monitor/overview").status_code == 401

    fresh = TestClient(admin_client.app)
    assert fresh.post(
        "/api/auth/login", json={"username": "admin", "password": "anothersecret9"}
    ).status_code == 200


def test_operator_cannot_control_server_or_scanner(admin_client):
    assert admin_client.post(
        "/api/auth/signup", json={"username": "newbie", "password": "sup3rsecret2"}
    ).status_code == 200

    operator = TestClient(admin_client.app)
    assert operator.post(
        "/api/auth/login", json={"username": "newbie", "password": "sup3rsecret2"}
    ).status_code == 200

    assert operator.get("/api/auth/state").json()["user"]["role"] == "operator"
    assert operator.get("/api/server/services").status_code == 403
    response = operator.post("/api/scan/ports", json={"target": "127.0.0.1", "ports": "22"})
    assert response.status_code == 403
    # operators may still read monitoring data and use the lookup tools
    assert operator.get("/api/monitor/overview").status_code == 200
    assert operator.get("/api/ip/lookup?ip=127.0.0.1").status_code == 200


def test_admin_cannot_disable_self(admin_client):
    me = admin_client.get("/api/auth/state").json()["user"]
    response = admin_client.post(f"/api/auth/users/{me['id']}", json={"disabled": True})
    assert response.status_code == 400


def test_admin_can_promote_and_disable_others(admin_client):
    created = admin_client.post(
        "/api/auth/signup", json={"username": "newbie", "password": "sup3rsecret2"}
    ).json()
    user_id = created["user"]["id"]

    assert admin_client.post(f"/api/auth/users/{user_id}", json={"role": "admin"}).status_code == 200
    listing = admin_client.get("/api/auth/users").json()["users"]
    assert listing[1]["role"] == "admin"

    assert admin_client.post(f"/api/auth/users/{user_id}", json={"disabled": True}).status_code == 200
    assert listing[1]["disabled"] is False  # previous snapshot, not refreshed
    refreshed = admin_client.get("/api/auth/users").json()["users"]
    assert refreshed[1]["disabled"] is True
