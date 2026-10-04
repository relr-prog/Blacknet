// The privileged action map: rotator gating and session forwarding.
//
// The rotator bug this covers was invisible to every other suite: the local
// admin gate passed, the request went out with no cookie, and the control plane
// answered 401. So the tests assert on the wire format, not just the return
// value.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { createActions } = require("../src/main/actions");
const { Settings } = require("../src/main/settings");

const ENDPOINT = "http://127.0.0.1:8787";

function harness({
  authenticated = true,
  guest = false,
  isAdmin = true,
  cookies = [{ name: "netops_session", value: "abc123", domain: "127.0.0.1", path: "/" }],
} = {}) {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const settings = new Settings({ userDataPath });
  const account = { current: { authenticated, guest, isAdmin, username: "rel4ever" } };
  const tabs = { sessionCookies: async () => cookies };

  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      json: async () => ({ enabled: true, running: true, state: "running", detail: "2 upstreams" }),
    };
  };

  const actions = createActions({ tabs, settings, account, rotatorEndpoint: ENDPOINT });
  const restore = () => {
    globalThis.fetch = realFetch;
  };
  return { actions, calls, settings, account, restore };
}

function headerOf(call, name) {
  const headers = call.options.headers || {};
  return headers[name] || "";
}

test("the rotator switch forwards the session cookie", async () => {
  const { actions, calls, restore } = harness();
  try {
    await actions["netops:rotator:set"](true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ENDPOINT}/api/rotator/start`);
    assert.equal(calls[0].options.method, "POST");
    assert.match(headerOf(calls[0], "cookie"), /netops_session=abc123/);
  } finally {
    restore();
  }
});

test("stopping the rotator posts to stop, with the cookie", async () => {
  const { actions, calls, restore } = harness();
  try {
    await actions["netops:rotator:set"](false);
    assert.equal(calls[0].url, `${ENDPOINT}/api/rotator/stop`);
    assert.match(headerOf(calls[0], "cookie"), /netops_session=abc123/);
  } finally {
    restore();
  }
});

test("rotator status authenticates too", async () => {
  const { actions, calls, restore } = harness();
  try {
    const status = await actions["netops:rotator:status"]();
    assert.match(headerOf(calls[0], "cookie"), /netops_session=abc123/);
    assert.equal(status.live, true);
    assert.equal(status.rotatorEnabled, true, "the service response is mirrored into settings");
  } finally {
    restore();
  }
});

test("a guest cannot move the rotator and nothing is sent", async () => {
  const { actions, calls, restore } = harness({ guest: true });
  try {
    await assert.rejects(() => actions["netops:rotator:set"](true), /administrator.*guest/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("a signed-out session cannot move the rotator", async () => {
  const { actions, calls, restore } = harness({ authenticated: false });
  try {
    await assert.rejects(() => actions["netops:rotator:set"](true), /administrator.*signed out/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("a signed-in non-admin is refused", async () => {
  const { actions, calls, restore } = harness({ isAdmin: false });
  try {
    await assert.rejects(() => actions["netops:rotator:set"](true), /administrator role required/);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test("cookies for other domains are not leaked to the control plane", async () => {
  const { actions, calls, restore } = harness({
    cookies: [
      { name: "netops_session", value: "abc123", domain: "127.0.0.1", path: "/" },
      { name: "tracking", value: "nope", domain: "example.com", path: "/" },
    ],
  });
  try {
    await actions["netops:rotator:set"](true);
    const cookie = headerOf(calls[0], "cookie");
    assert.match(cookie, /netops_session=abc123/);
    assert.doesNotMatch(cookie, /tracking/);
  } finally {
    restore();
  }
});

test("no cookies means no cookie header rather than an empty one", async () => {
  const { actions, calls, restore } = harness({ cookies: [] });
  try {
    await actions["netops:rotator:set"](true);
    assert.equal(calls[0].options.headers.cookie, undefined);
  } finally {
    restore();
  }
});

test("a refused rotator request surfaces the status code", async () => {
  const { actions, restore } = harness();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await assert.rejects(() => actions["netops:rotator:set"](true), /http 403/);
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test("rotator status degrades to the last known state when the service is down", async () => {
  const { actions, settings, restore } = harness();
  settings.setRotatorState({ enabled: true, state: "running", detail: "cached" });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  try {
    const status = await actions["netops:rotator:status"]();
    assert.equal(status.live, false);
    assert.equal(status.rotatorEnabled, true, "the cached state is still shown");
  } finally {
    globalThis.fetch = realFetch;
    restore();
  }
});

test("no rotator endpoint means no rotator actions at all", () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-actions-"));
  const actions = createActions({
    tabs: { sessionCookies: async () => [] },
    settings: new Settings({ userDataPath }),
    account: { current: { authenticated: true, isAdmin: true } },
  });
  assert.equal(actions["netops:rotator:set"], undefined);
  assert.equal(actions["netops:rotator:status"], undefined);
});