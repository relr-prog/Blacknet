// The internal-page allowlist.
//
// A tab showing one of these pages is the only tab besides the chrome frame that
// gets the full preload bridge, so this list is a security boundary: the name
// arrives over IPC from a renderer, and it must never turn into a path of the
// caller's choosing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { INTERNAL_PAGES, internalPage, RENDERER_DIR } = require("../src/main/internal-pages");

test("the settings page resolves to the file we ship", () => {
  const page = internalPage("settings");
  assert.ok(page, "settings should resolve");
  assert.equal(path.basename(page.file), "settings.html");
  assert.ok(page.title.length > 0, "a page needs a title for the tab strip");
});

test("every listed page exists on disk", () => {
  for (const name of Object.keys(INTERNAL_PAGES)) {
    const page = internalPage(name);
    assert.ok(page, `${name} should resolve`);
    assert.ok(fs.existsSync(page.file), `${name} is missing ${page.file}`);
  }
});

test("a resolved page always stays inside the renderer directory", () => {
  for (const name of Object.keys(INTERNAL_PAGES)) {
    const { file } = internalPage(name);
    assert.ok(
      file.startsWith(RENDERER_DIR + path.sep),
      `${name} escaped the renderer directory: ${file}`,
    );
  }
});

test("an unknown name resolves to nothing", () => {
  for (const name of ["", "newtab", "Settings", "settings ", "settings.html"]) {
    assert.equal(internalPage(name), null, `${name} should not resolve`);
  }
});

test("traversal is not a path", () => {
  // None of these are table entries, so the lookup alone rejects them. They are
  // spelled out because "the name is only looked up" is exactly the property
  // that has to hold.
  const attempts = [
    "../../preload/preload.js",
    "..\\..\\preload\\preload.js",
    "pages/../../main/actions.js",
    "/etc/passwd",
    "file:///etc/passwd",
  ];
  for (const name of attempts) {
    assert.equal(internalPage(name), null, `${name} should not resolve`);
  }
});

test("inherited property names are not entries", () => {
  // A plain object literal has Object.prototype on it. A naive `if (name in
  // table)` or `table[name]` lookup would happily hand back a function here.
  for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
    assert.equal(internalPage(name), null, `${name} should not resolve`);
  }
});

test("a non-string name resolves to nothing", () => {
  for (const name of [null, undefined, 0, 1, true, {}, [], Symbol("settings")]) {
    assert.equal(internalPage(name), null, `${String(name)} should not resolve`);
  }
});