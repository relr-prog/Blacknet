// The Chromium hardening switches this shell applies at startup.
//
// What is pinned down: exactly which switches go on the command line and with
// which values, that no switch is listed twice, and that the single off switch
// empties the set. The mapping from each switch to the LibreWolf default it
// stands in for lives beside the list itself.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { SWITCHES, switches, apply } = require("../src/main/hardening");

test("the hardening set is the expected, deduplicated switches", () => {
  const names = SWITCHES.map((s) => s.name);
  assert.deepEqual(names, [
    "no-pings",
    "dns-prefetch-disable",
    "force-webrtc-ip-handling-policy",
    "disable-background-networking",
  ]);
  assert.equal(new Set(names).size, names.length, "no switch is listed twice");
});

test("the WebRTC policy is pinned to refusing non-proxied UDP", () => {
  const policy = SWITCHES.find((s) => s.name === "force-webrtc-ip-handling-policy");
  assert.equal(policy.value, "disable_non_proxied_udp");
});

test("switches() hands back a copy, not the list itself", () => {
  const list = switches();
  list.push({ name: "tampered" });
  assert.equal(SWITCHES.length, 4);
});

test("the whole set can be turned off with one switch", () => {
  assert.deepEqual(switches({ enabled: false }), []);
});

test("apply() puts every switch on the command line with the right value", () => {
  const seen = [];
  const app = { commandLine: { appendSwitch: (name, value) => seen.push([name, value]) } };
  apply(app);
  assert.deepEqual(seen, [
    ["no-pings", undefined],
    ["dns-prefetch-disable", undefined],
    ["force-webrtc-ip-handling-policy", "disable_non_proxied_udp"],
    ["disable-background-networking", undefined],
  ]);
});

test("apply() adds nothing when the set is off", () => {
  const seen = [];
  const app = { commandLine: { appendSwitch: (name) => seen.push(name) } };
  apply(app, { enabled: false });
  assert.deepEqual(seen, []);
});
