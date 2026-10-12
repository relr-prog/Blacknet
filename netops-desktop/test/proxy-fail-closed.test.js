"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { shouldBlockForMissingProxy } = require("../src/main/proxy-fail-closed");

const source = fs.readFileSync(path.join(__dirname, "../src/main/tabs.js"), "utf8");

test("blocks network requests if the requested proxy is unavailable or unapplied", () => {
  for (const state of [
    { proxyAvailable: false, proxyApplied: false },
    { proxyAvailable: true, proxyApplied: false },
  ]) {
    assert.equal(shouldBlockForMissingProxy({
      wanted: true,
      url: "https://example.com/",
      ...state,
    }), true);
  }
});

test("allows direct mode and an available proxy that is applied to the tab", () => {
  assert.equal(shouldBlockForMissingProxy({
    wanted: false,
    proxyAvailable: false,
    proxyApplied: false,
    url: "https://example.com/",
  }), false);
  assert.equal(shouldBlockForMissingProxy({
    wanted: true,
    proxyAvailable: true,
    proxyApplied: true,
    url: "https://example.com/",
  }), false);
});

test("does not block shell-local files or non-network schemes", () => {
  assert.equal(shouldBlockForMissingProxy({
    wanted: true,
    proxyAvailable: false,
    proxyApplied: false,
    url: "file:///app/renderer/newtab.html",
    shellFile: true,
  }), false);
  for (const url of ["about:blank", "data:text/plain,hello", "blob:https://example.com/id"]) {
    assert.equal(shouldBlockForMissingProxy({
      wanted: true,
      proxyAvailable: false,
      proxyApplied: false,
      url,
    }), false, url);
  }
});

test("runs the fail-closed guard at the session request boundary before URL policy", () => {
  const guard = source.indexOf("if (shouldBlockForMissingProxy({");
  const nativeVerdict = source.indexOf("const reason = this.#verdict(details.url, profile);");
  assert.match(source, /webRequest\.onBeforeRequest\(\{ urls: \["<all_urls>"\] \}, handler\)/);
  assert.match(source, /proxyApplied: Boolean\(tab && requestedProxy && tab\.proxy === requestedProxy\)/);
  assert.notEqual(guard, -1);
  assert.notEqual(nativeVerdict, -1);
  assert.ok(guard < nativeVerdict);
});

test("does not select a fallback route while the requested gateway is unavailable", () => {
  const unavailable = source.indexOf("if (this.ipRotator?.wanted === true && !gateway)");
  const fallback = source.indexOf("const upstream = this.native.pickUpstream(tab.profile);");
  assert.notEqual(unavailable, -1);
  assert.notEqual(fallback, -1);
  assert.ok(unavailable < fallback);
});
