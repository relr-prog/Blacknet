"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(
  path.join(__dirname, "../src/preload/password-hook.js"),
  "utf8",
);

test("password capture preload does not expose a page-callable bridge", () => {
  assert.doesNotMatch(source, /contextBridge\.exposeInMainWorld/);
  assert.doesNotMatch(source, /__blacknetPasswordHook/);
  assert.match(source, /document\.addEventListener\(["']submit["']/);
  assert.match(source, /ipcRenderer\.send\(["']netops:password-detected["']/);
});
