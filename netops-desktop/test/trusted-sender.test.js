"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { test } = require("node:test");
const { isTrustedUiSender } = require("../src/main/trusted-sender");

const root = path.join(os.tmpdir(), "blacknet-renderer");
const chrome = pathToFileURL(path.join(root, "chrome.html")).href;

function event(url, { topFrame = true } = {}) {
  const mainFrame = { url: chrome };
  const senderFrame = topFrame ? mainFrame : { url };
  return { sender: { mainFrame }, senderFrame };
}

test("trusted local top-level renderer may invoke privileged IPC", () => {
  assert.equal(isTrustedUiSender(event(chrome), root), true);
});

test("remote and non-file documents are refused", () => {
  assert.equal(isTrustedUiSender(event("https://attacker.example/"), root), false);
  assert.equal(isTrustedUiSender(event("javascript:alert(1)"), root), false);
});

test("local files outside the renderer root are refused", () => {
  const outside = pathToFileURL(path.join(os.tmpdir(), "evil.html")).href;
  assert.equal(isTrustedUiSender(event(outside), root), false);
});

test("subframes and missing sender metadata are refused", () => {
  assert.equal(isTrustedUiSender(event("https://attacker.example/", { topFrame: false }), root), false);
  assert.equal(isTrustedUiSender(null, root), false);
});

test("encoded traversal cannot escape the renderer root", () => {
  const traversal = pathToFileURL(path.join(root, "..", "evil.html")).href;
  assert.equal(isTrustedUiSender(event(traversal), root), false);
});
