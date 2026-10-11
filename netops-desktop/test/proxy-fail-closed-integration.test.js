"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../src/main/tabs.js"),
  "utf8",
);

test("proxy fail-closed guard is wired into the session request boundary", () => {
  assert.match(source, /webRequest\.onBeforeRequest\(\{ urls: \["<all_urls>"\] \}, handler\)/);
  assert.match(source, /shouldBlockForMissingProxy\(\{/);
  assert.match(source, /proxyAvailable: Boolean\(this\.ipRotator\?\.proxy\(\)\)/);
  assert.match(source, /callback\(\{ cancel: true \}\)/);
});

test("proxy fail-closed decision runs before the native URL verdict", () => {
  const guard = source.indexOf("if (shouldBlockForMissingProxy({");
  const nativeVerdict = source.indexOf("const reason = this.#verdict(details.url, profile);");
  assert.notEqual(guard, -1, "proxy guard must exist");
  assert.notEqual(nativeVerdict, -1, "native URL policy must exist");
  assert.ok(guard < nativeVerdict, "missing proxy must be rejected before ordinary request handling");
});
