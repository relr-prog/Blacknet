"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const tabsSource = fs.readFileSync(
  path.join(__dirname, "../src/main/tabs.js"),
  "utf8",
);

test("tab webContents explicitly denies unmanaged popup windows", () => {
  assert.match(tabsSource, /wc\.setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
});

test("popup policy is installed in the common tab wiring path", () => {
  const wireTab = tabsSource.indexOf("#wireTab(tab)");
  const popupGuard = tabsSource.indexOf('wc.setWindowOpenHandler(() => ({ action: "deny" }))');
  assert.notEqual(wireTab, -1, "tab wiring method must exist");
  assert.notEqual(popupGuard, -1, "popup denial must be installed");
  assert.ok(popupGuard > wireTab, "popup denial must be installed in tab wiring");
});
