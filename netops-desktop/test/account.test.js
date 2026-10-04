// Account state and the guest gate.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Account } = require("../src/main/account");

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

test("cookie header keeps only cookies that match the endpoint", () => {
  const header = Account.cookieHeader(
    [
      { name: "netops_session", value: "abc", domain: "127.0.0.1" },
      { name: "other", value: "nope", domain: "example.com" },
      { name: "path_scoped", value: "p", domain: "127.0.0.1" },
    ],
    "http://127.0.0.1:8787/api/auth/state",
  );
  assert.match(header, /netops_session=abc/);
  assert.doesNotMatch(header, /nope/);
});

test("no cookies means no header at all", () => {
  assert.equal(Account.cookieHeader([], "http://127.0.0.1:8787"), "");
  assert.equal(Account.cookieHeader(null, "http://127.0.0.1:8787"), "");
});

test("a signed-in user unlocks the account features", async () => {
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () =>
      jsonResponse({ authenticated: true, user: { username: "rel4ever", role: "admin" } }),
  });

  const state = await account.refresh([]);
  assert.equal(state.authenticated, true);
  assert.equal(state.guest, false);
  assert.equal(state.username, "rel4ever");
  assert.equal(state.isAdmin, true);

  const gate = Account.gate(state, "passwords");
  assert.equal(gate.unlocked, true);
  assert.equal(gate.locked, false);
});

test("a guest session is reported as a guest and locks account features", async () => {
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () =>
      jsonResponse({ authenticated: true, user: { username: "guest", role: "guest", is_guest: true } }),
  });

  const state = await account.refresh([]);
  assert.equal(state.guest, true);
  assert.equal(state.authenticated, false, "a guest must never count as signed in");
  assert.equal(state.isAdmin, false);

  const gate = Account.gate(state, "passwords");
  assert.equal(gate.locked, true);
  assert.equal(gate.reason, "guest");
  assert.equal(gate.message, "Please log in to unlock this feature.");
});

test("signed out locks with the same message", async () => {
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () => jsonResponse({ authenticated: false, user: null }),
  });
  const state = await account.refresh([]);
  assert.equal(state.authenticated, false);
  assert.equal(Account.gate(state, "account").locked, true);
  assert.equal(Account.gate(state, "account").reason, "signed out");
});

test("an unreachable control plane means signed out, not a crash", async () => {
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    timeoutMs: 50,
  });
  const state = await account.refresh([]);
  assert.equal(state.authenticated, false);
  assert.equal(Account.gate(state, "passwords").locked, true);
});

test("a non-2xx answer is treated as signed out", async () => {
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () => jsonResponse({}, { ok: false, status: 503 }),
  });
  const state = await account.refresh([]);
  assert.equal(state.authenticated, false);
  assert.equal(state.reason, "http 503");
});

test("state is cached, and force refreshes", async () => {
  let calls = 0;
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ authenticated: true, user: { username: "rel4ever", role: "operator" } });
    },
  });

  await account.state([]);
  await account.state([]);
  assert.equal(calls, 1, "second read must come from the cache");

  await account.state([], { force: true });
  assert.equal(calls, 2);

  account.invalidate();
  await account.state([]);
  assert.equal(calls, 3);
});

test("concurrent readers share one request", async () => {
  let calls = 0;
  const account = new Account({
    endpoint: "http://127.0.0.1:8787",
    fetchImpl: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ authenticated: false, user: null });
    },
  });

  await Promise.all([account.state([]), account.state([]), account.state([])]);
  assert.equal(calls, 1);
});

test("admin-only actions are refused for guests and operators", () => {
  assert.throws(() => Account.requiresAdmin(null), /log in first/);
  assert.throws(
    () => Account.requiresAdmin({ authenticated: false, guest: true }),
    /guest sessions cannot/,
  );
  assert.throws(
    () => Account.requiresAdmin({ authenticated: true, guest: false, isAdmin: false }),
    /administrator role required/,
  );
  assert.doesNotThrow(() =>
    Account.requiresAdmin({ authenticated: true, guest: false, isAdmin: true }),
  );
});

test("the request carries the session cookie and asks the auth state route", async () => {
  const seen = {};
  const account = new Account({
    endpoint: "http://127.0.0.1:8787/",
    fetchImpl: async (url, options) => {
      seen.url = url;
      seen.cookie = options.headers.cookie;
      return jsonResponse({ authenticated: false, user: null });
    },
  });

  await account.refresh([{ name: "netops_session", value: "s3cret", domain: "127.0.0.1" }]);
  assert.equal(seen.url, "http://127.0.0.1:8787/api/auth/state");
  assert.equal(seen.cookie, "netops_session=s3cret");
});

test("the guest cookie is recognised for diagnostics", () => {
  assert.equal(Account.isGuestCookie([{ name: "netops_guest", value: "1" }]), true);
  assert.equal(Account.isGuestCookie([{ name: "netops_session", value: "1" }]), false);
  assert.equal(Account.isGuestCookie(null), false);
});