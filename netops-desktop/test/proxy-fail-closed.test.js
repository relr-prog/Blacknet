"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { shouldBlockForMissingProxy } = require("../src/main/proxy-fail-closed");

test("blocks network requests when proxy was requested but is unavailable", () => {
  for (const url of [
    "https://example.com/",
    "http://example.com/image.png",
    "wss://example.com/socket",
  ]) {
    assert.equal(shouldBlockForMissingProxy({
      wanted: true, proxyAvailable: false, url,
    }), true, url);
  }
});

test("does not block when proxy is off or available", () => {
  assert.equal(shouldBlockForMissingProxy({
    wanted: false, proxyAvailable: false, url: "https://example.com/",
  }), false);
  assert.equal(shouldBlockForMissingProxy({
    wanted: true, proxyAvailable: true, url: "https://example.com/",
  }), false);
});

test("does not block local shell documents or non-network schemes", () => {
  assert.equal(shouldBlockForMissingProxy({
    wanted: true, proxyAvailable: false, url: "file:///app/renderer/newtab.html", shellFile: true,
  }), false);
  for (const url of ["about:blank", "data:text/plain,hello", "blob:https://example.com/id"]) {
    assert.equal(shouldBlockForMissingProxy({
      wanted: true, proxyAvailable: false, url,
    }), false, url);
  }
});
