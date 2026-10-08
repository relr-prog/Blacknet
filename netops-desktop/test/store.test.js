// Tests for the durable JSON store the shell keeps its own state in.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { JsonStore } = require("../src/main/store");

function tempFile(name = "settings.json") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-store-"));
  return path.join(dir, name);
}

test("missing file yields the defaults", () => {
  const store = new JsonStore(tempFile(), { scheme: "auto", ipRotator: false });
  assert.deepEqual(store.all(), { scheme: "auto", ipRotator: false });
});

test("set and get survive a reload", () => {
  const file = tempFile();
  const store = new JsonStore(file, { scheme: "auto" });
  store.set("scheme", "light");

  const reloaded = new JsonStore(file, { scheme: "auto" });
  assert.equal(reloaded.get("scheme"), "light");
});

test("unknown keys read back as the caller's fallback", () => {
  const store = new JsonStore(tempFile(), {});
  assert.equal(store.get("missing", "fallback"), "fallback");
  assert.equal(store.get("missing"), undefined);
});

test("patch merges and returns a copy the caller cannot mutate", () => {
  const store = new JsonStore(tempFile(), { a: 1, b: 2 });
  const snapshot = store.patch({ b: 3, c: 4 });
  assert.deepEqual(snapshot, { a: 1, b: 3, c: 4 });

  snapshot.b = 99;
  assert.equal(store.get("b"), 3, "get must not hand out a live reference");
});

test("delete reports whether the key existed", () => {
  const store = new JsonStore(tempFile(), { a: 1 });
  assert.equal(store.delete("a"), true);
  assert.equal(store.delete("a"), false);
  assert.deepEqual(store.all(), {});
});

test("writes are atomic: no temp file is left behind", () => {
  const file = tempFile();
  const store = new JsonStore(file, {});
  store.set("a", 1);

  assert.equal(fs.existsSync(file), true);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600, "file must not be world readable");
});

test("a corrupt file is quarantined and defaults are used", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ this is not json");

  const store = new JsonStore(file, { scheme: "dark" });
  assert.deepEqual(store.all(), { scheme: "dark" });

  const siblings = fs.readdirSync(path.dirname(file));
  assert.equal(siblings.includes("settings.json"), false, "corrupt file must be moved");
  assert.ok(
    siblings.some((name) => name.startsWith("settings.json.corrupt-")),
    `expected a quarantined copy, saw ${siblings.join(", ")}`,
  );
});

test("a JSON array at the top level is treated as corrupt", () => {
  const file = tempFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "[1, 2, 3]");

  const store = new JsonStore(file, { scheme: "dark" });
  assert.deepEqual(store.all(), { scheme: "dark" });
});

test("the directory is created on demand", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-store-"));
  const file = path.join(dir, "nested", "deeper", "settings.json");
  const store = new JsonStore(file, { a: 1 });
  store.set("a", 2);
  assert.equal(fs.existsSync(file), true);
});