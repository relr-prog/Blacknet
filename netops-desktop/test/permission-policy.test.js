"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isPermissionAllowed } = require("../src/main/permission-policy");

test("permissions are denied by default", () => {
  for (const permission of ["notifications", "geolocation", "media", "camera", "microphone"]) {
    assert.equal(isPermissionAllowed([], permission), false);
    assert.equal(isPermissionAllowed(undefined, permission), false);
  }
});

test("only exact explicitly configured permissions are allowed", () => {
  assert.equal(isPermissionAllowed(["notifications"], "notifications"), true);
  assert.equal(isPermissionAllowed(["notifications"], "geolocation"), false);
  assert.equal(isPermissionAllowed(["media"], "media"), true);
  assert.equal(isPermissionAllowed(["media"], "mediaKeySystem"), false);
});

test("invalid or empty permission names fail closed", () => {
  assert.equal(isPermissionAllowed(["notifications"], ""), false);
  assert.equal(isPermissionAllowed(["notifications"], null), false);
  assert.equal(isPermissionAllowed("notifications", "notifications"), false);
});
