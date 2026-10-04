// The privileged action map: rotator control without a control plane.
//
// The rotator used to be an HTTP route on the Python control plane, so these
// tests asserted on cookie forwarding and dashboard-admin gating. It is now a
// child process supervised by the shell, which deletes both concerns at once:
// there is no request to leak a cookie into, and flipping a local proxy is not a
// dashboard privilege. What matters now is that the *gateway* decides whether it
// is running, that settings mirror it, and that tabs are re-pointed at it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createActions } = require("../src/main/actions");
const { Settings } = require("../src/main/settings");

function fakeRotator({ state = "running", proxy = "http://127.0.0.1:8888", detail = "5/7 upstreams healthy" } = {}) {
  const calls = { start: 0, stop: 0, snapshot: 0, refresh: 0 };
  return {
    calls,
    async start() {
      calls.start += 1;
      return "running";
    },
    async stop() {
      calls.stop += 1;
      return "stopped";
    },
    async snapshot() {
      calls.snapshot += 1;
      if (state !== "running") return null;
      return {
        uptimeSeconds: 12,
        connections: 3,
        strategy: "round_robin",
        upstreams: 7,
        healthy: 5,
        countries: ["DE", "NL"],
        detail,
      };
    },
    proxy: () => proxy,
    socks: () => null,
    status: () => ({ state, detail, proxy, socks: null, ports: {} }),
  };
}

function harness(rotatorOptions = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const settings = new Settings({ userDataPath });
  const rotator = fakeRotator(rotatorOptions);
  const refreshed = { count: 0 };
  const tabs = {
    sessionCookies: async () => [],
    refreshProxy: () => {
      refreshed.count += 1;
    },
  };
  const actions = createActions({ tabs, settings, rotator });
  return { actions, settings, rotator, refreshed };
}

test("turning the rotator on starts the gateway", async () => {
  const { actions, rotator } = harness();
  const result = await actions["netops:rotator:set"](true);
  assert.equal(rotator.calls.start, 1);
  assert.equal(rotator.calls.stop, 0);
  assert.equal(result.rotatorEnabled, true);
  assert.equal(result.rotatorState, "running");
});

test("turning the rotator off stops the gateway", async () => {
  const { actions, rotator, settings } = harness();
  await actions["netops:rotator:set"](false);
  assert.equal(rotator.calls.stop, 1);
  assert.equal(rotator.calls.start, 0);
  assert.equal(settings.get("rotatorEnabled"), false);
  assert.equal(settings.get("rotatorState"), "stopped");
});

test("a guest can move the rotator because it is a local proxy switch", async () => {
  // No dashboard, no administrator role, no session cookie: the operator already
  // owns the machine. What must still hold is that the gateway is consulted.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const settings = new Settings({ userDataPath });
  const rotator = fakeRotator();
  const actions = createActions({
    tabs: { sessionCookies: async () => [] },
    settings,
    account: { current: { authenticated: false, guest: true, isAdmin: false } },
    rotator,
  });
  await actions["netops:rotator:set"](true);
  assert.equal(rotator.calls.start, 1);
});

test("no session cookie is read for the rotator at all", async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const settings = new Settings({ userDataPath });
  const rotator = fakeRotator();
  let cookieReads = 0;
  const actions = createActions({
    tabs: {
      sessionCookies: async () => {
        cookieReads += 1;
        return [{ name: "netops_session", value: "abc123", domain: "127.0.0.1", path: "/" }];
      },
    },
    settings,
    rotator,
  });
  await actions["netops:rotator:set"](true);
  await actions["netops:rotator:status"]();
  assert.equal(cookieReads, 0, "the rotator path must not touch the cookie jar");
});

test("toggling the rotator re-points every tab at the new proxy", async () => {
  const { actions, refreshed } = harness();
  await actions["netops:rotator:set"](true);
  assert.equal(refreshed.count, 1);
});

test("rotator status mirrors live pool health into settings", async () => {
  const { actions, settings } = harness();
  const status = await actions["netops:rotator:status"]();
  assert.equal(status.live, true);
  assert.equal(status.rotatorEnabled, true);
  assert.equal(status.rotatorDetail, "5/7 upstreams healthy");
  assert.equal(settings.get("rotatorDetail"), "5/7 upstreams healthy");
  assert.equal(status.pool.healthy, 5);
  assert.equal(status.pool.upstreams, 7);
});

test("a gateway that is listening with nothing healthy says so", async () => {
  const { actions } = harness({ state: "running", detail: "no healthy upstreams (7 configured)" });
  const status = await actions["netops:rotator:status"]();
  assert.match(status.rotatorDetail, /no healthy upstreams/);
});

test("rotator status degrades to the last known state when the gateway is down", async () => {
  // A gateway that stopped answering: snapshot() returns null while status()
  // still reports the state the process is actually in.
  const { actions } = harness({ state: "crashed" });
  const status = await actions["netops:rotator:status"]();
  assert.equal(status.live, false);
  assert.equal(status.rotatorState, "crashed");
  assert.equal(status.rotatorEnabled, false);
});

test("adminOnly is false: there is no dashboard role left to mirror", async () => {
  const { actions, settings } = harness();
  await actions["netops:rotator:status"]();
  assert.equal(settings.get("rotatorAdminOnly"), false);
});

test("no rotator service means no rotator actions at all", () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const actions = createActions({
    tabs: { sessionCookies: async () => [] },
    settings: new Settings({ userDataPath }),
    account: { current: { authenticated: true, isAdmin: true } },
  });
  assert.equal(actions["netops:rotator:set"], undefined);
  assert.equal(actions["netops:rotator:status"], undefined);
});

test("the internal-page action passes the name and options straight through", () => {
  // tabs.js owns the allowlist; this only checks that the route reaches it and
  // does not quietly rewrite what the renderer asked for.
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const seen = [];
  const actions = createActions({
    tabs: {
      sessionCookies: async () => [],
      openInternalPage: async (name, options) => {
        seen.push({ name, options });
        return { id: 1, internalPage: name };
      },
    },
    settings: new Settings({ userDataPath }),
    account: { current: { authenticated: true, isAdmin: true } },
  });

  return actions["netops:tabs:internal"]("settings", { view: "cookies" }).then((result) => {
    assert.equal(seen.length, 1);
    assert.equal(seen[0].name, "settings");
    assert.deepEqual(seen[0].options, { view: "cookies" });
    assert.equal(result.internalPage, "settings");
  });
});

test("the internal-page action defaults to no options", () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const seen = [];
  const actions = createActions({
    tabs: {
      sessionCookies: async () => [],
      openInternalPage: async (name, options) => {
        seen.push(options);
        return null;
      },
    },
    settings: new Settings({ userDataPath }),
    account: { current: { authenticated: true, isAdmin: true } },
  });

  // A renderer is allowed to send nothing at all here, so this must not throw.
  return actions["netops:tabs:internal"]("settings").then(() => {
    assert.deepEqual(seen[0], {});
  });
});