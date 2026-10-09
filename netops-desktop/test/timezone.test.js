// UTC clock pinning: the two probes a page uses to read the operator's zone,
// the exact source that reaches a page, and the best-effort attach that carries
// it. The source is stringified from install(), so this test proves the bytes
// injected into a page behave the same as the function under test.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { test } = require("node:test");

const { SPOOF_SOURCE, install, attach, pinEnvironment } = require("../src/main/timezone");

function fakeWorld() {
  const date = { prototype: { getTimezoneOffset: () => 999 } };
  const intl = {
    DateTimeFormat: {
      prototype: {
        resolvedOptions() {
          return { timeZone: "America/Los_Angeles", locale: "en-US" };
        },
      },
    },
  };
  return { Date: date, Intl: intl };
}

test("install() answers both zone probes with UTC", () => {
  const world = fakeWorld();
  assert.equal(install(world), world);
  assert.equal(world.Date.prototype.getTimezoneOffset(), 0);
  assert.equal(world.Intl.DateTimeFormat.prototype.resolvedOptions().timeZone, "UTC");
});

test("install() wraps resolvedOptions instead of discarding it", () => {
  const world = fakeWorld();
  install(world);
  const options = world.Intl.DateTimeFormat.prototype.resolvedOptions();
  assert.equal(options.locale, "en-US", "the other fields survive");
  assert.equal(options.timeZone, "UTC", "only the zone is rewritten");
});

test("install() is safe on a world missing either built-in", () => {
  assert.doesNotThrow(() => install({}));
  assert.doesNotThrow(() => install({ Date: {} }));
});

test("the injected source patches a page global exactly like install()", () => {
  const world = fakeWorld();
  const context = vm.createContext(world);
  vm.runInContext(SPOOF_SOURCE, context);
  assert.equal(world.Date.prototype.getTimezoneOffset(), 0);
  assert.equal(world.Intl.DateTimeFormat.prototype.resolvedOptions().timeZone, "UTC");
});

test("attach() enables the page domain and registers the source once", () => {
  const calls = [];
  const webContents = {
    debugger: {
      isAttached: () => false,
      attach: (version) => calls.push(["attach", version]),
      sendCommand: (method, params) => {
        calls.push([method, params]);
        return Promise.resolve({});
      },
    },
  };
  assert.equal(attach(webContents), true);
  assert.deepEqual(calls, [
    ["attach", "1.3"],
    ["Page.enable", undefined],
    ["Page.addScriptToEvaluateOnNewDocument", { source: SPOOF_SOURCE }],
  ]);
});

test("attach() does not re-attach an already attached debugger", () => {
  const calls = [];
  const webContents = {
    debugger: {
      isAttached: () => true,
      attach: () => calls.push(["attach"]),
      sendCommand: (method) => {
        calls.push([method]);
        return Promise.resolve({});
      },
    },
  };
  attach(webContents);
  assert.deepEqual(calls, [["Page.enable"], ["Page.addScriptToEvaluateOnNewDocument"]]);
});

test("attach() reports failure instead of throwing", () => {
  const messages = [];
  const refused = { debugger: { isAttached: () => false, attach: () => {
    throw new Error("another debugger is attached");
  } } };
  assert.equal(attach(refused, (m) => messages.push(m)), false);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /another debugger is attached/);
  assert.equal(attach({}), false);
});

test("pinEnvironment() forces TZ to UTC even when it was set", () => {
  const env = { TZ: "Europe/Paris" };
  assert.equal(pinEnvironment(env), env);
  assert.equal(env.TZ, "UTC");
});
