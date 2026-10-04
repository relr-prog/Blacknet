// The credential vault.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Vault, credentialId, randomKey } = require("../src/main/vault");

const KEY = randomKey();

function tempVault() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-vault-"));
  return new Vault({ dir: path.join(dir, "vault") });
}

const entry = { id: "abc123", origin: "https://example.com/login", username: "rel4ever", password: "hunter2" };

test("a fresh vault is locked and refuses to work", () => {
  const vault = tempVault();
  assert.equal(vault.locked, true);
  assert.throws(() => vault.seal(entry), /locked/);
});

test("a record round-trips through seal and reveal", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  const revealed = vault.reveal("abc123");
  assert.equal(revealed.password, "hunter2");
  assert.equal(revealed.username, "rel4ever");
  assert.equal(revealed.origin, entry.origin);
});

test("list() needs no unlock and never contains a password", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  vault.lock();

  const listed = vault.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].username, "rel4ever");
  for (const field of ["password", "data", "iv", "tag"]) {
    assert.equal(field in listed[0], false, `${field} must not be exposed`);
  }
});

test("the file on disk contains no plaintext", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  const raw = fs.readFileSync(path.join(vault.dir, "abc123.json"), "utf8");
  assert.doesNotMatch(raw, /hunter2/);
  assert.equal(fs.statSync(path.join(vault.dir, "abc123.json")).mode & 0o777, 0o600);
});

test("a different key cannot decrypt", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  vault.unlock(randomKey());

  assert.throws(() => vault.reveal("abc123"), /unable to authenticate|bad decrypt|Unsupported/i);
});

test("every seal uses a fresh IV", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  const first = vault.seal(entry);
  const second = vault.seal(entry);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.data, second.data);
});

test("the AAD binds a record to its id, origin and username", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  // Rewrite the metadata but keep the ciphertext: the seal must stop verifying.
  const file = path.join(vault.dir, "abc123.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.username = "somebody-else";
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => vault.reveal("abc123"), /unable to authenticate|bad decrypt|Unsupported/i);
});

test("moving a sealed record to another id fails to decrypt", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  const from = JSON.parse(fs.readFileSync(path.join(vault.dir, "abc123.json"), "utf8"));
  fs.writeFileSync(path.join(vault.dir, "def456.json"), JSON.stringify(from));
  assert.throws(() => vault.reveal("def456"), /unable to authenticate|bad decrypt|Unsupported/i);
});

test("ids cannot traverse out of the vault directory", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  for (const bad of ["../../etc/passwd", "a/b", "", "x".repeat(80), "id with space", "id.json"]) {
    assert.throws(() => vault.reveal(bad), /invalid credential id/, `accepted: ${bad}`);
  }
});

test("unlock rejects a key of the wrong length and accepts a passphrase", () => {
  const vault = tempVault();
  assert.throws(() => vault.unlock(Buffer.alloc(16)), /must be 32 bytes/);
  assert.throws(() => vault.unlock(Buffer.alloc(64)), /must be 32 bytes/);
  assert.equal(vault.unlock("correct horse battery staple").ok, true);
  assert.equal(vault.reveal("abc123"), null);
});

test("lock() drops the key so an existing record can no longer be opened", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  assert.equal(vault.reveal("abc123").password, "hunter2");

  vault.lock();
  assert.equal(vault.locked, true);
  assert.throws(() => vault.reveal("abc123"), /locked/);
  assert.throws(() => vault.seal({ ...entry, id: "new" }), /locked/);
});

test("update re-seals when the password changes", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  vault.update("abc123", { password: "new-password" });
  assert.equal(vault.reveal("abc123").password, "new-password");

  // Metadata-only edits keep the same secret and still open.
  vault.update("abc123", { username: "renamed" });
  const revealed = vault.reveal("abc123");
  assert.equal(revealed.password, "new-password");
  assert.equal(revealed.username, "renamed");
});

test("update of a missing entry returns null", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  assert.equal(vault.update("nothing", { password: "x" }), null);
});

test("remove deletes one entry and reports whether it existed", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  assert.equal(vault.remove("abc123"), true);
  assert.equal(vault.remove("abc123"), false);
  assert.equal(vault.count(), 0);
});

test("list is sorted by origin and survives a corrupt file", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  vault.seal({ ...entry, id: "zzz", origin: "https://alpha.test" });
  vault.seal({ ...entry, id: "aaa", origin: "https://zulu.test" });
  fs.writeFileSync(path.join(vault.dir, "broken.json"), "{ not json");

  const origins = vault.list().map((record) => record.origin);
  assert.deepEqual(origins, [
    "https://alpha.test",
    "https://example.com/login",
    "https://zulu.test",
  ]);
});

test("verify() reports a tampered record and an intact one", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);
  vault.seal({ ...entry, id: "second" });

  const file = path.join(vault.dir, "second.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.data = Buffer.from("tampered").toString("base64");
  fs.writeFileSync(file, JSON.stringify(record));

  const results = Object.fromEntries(vault.verify().map((r) => [r.id, r.ok]));
  assert.equal(results.abc123, true);
  assert.equal(results.second, false);
});

test("a truncated ciphertext is rejected rather than returning junk", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  vault.seal(entry);

  const file = path.join(vault.dir, "abc123.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.data = Buffer.from(record.data, "base64").subarray(0, 3).toString("base64");
  fs.writeFileSync(file, JSON.stringify(record));

  assert.throws(() => vault.reveal("abc123"));
});

test("credentialId is stable, account-scoped and host-normalised", () => {
  const a = credentialId({ origin: "https://Example.com/login", username: "rel", account: "one" });
  const b = credentialId({ origin: "https://example.com/other/page", username: "rel", account: "one" });
  assert.equal(a, b, "same site and user is one entry");

  assert.notEqual(a, credentialId({ origin: "https://example.com", username: "rel", account: "two" }));
  assert.notEqual(a, credentialId({ origin: "https://example.com", username: "other", account: "one" }));
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("credentialId copes with an origin that is not a URL", () => {
  const id = credentialId({ origin: "about:blank", username: "" });
  assert.match(id, /^[0-9a-f]{32}$/);
});

test("the notes field is length-capped", () => {
  const vault = tempVault();
  vault.unlock(KEY);
  const record = vault.seal({ ...entry, note: "n".repeat(900) });
  assert.equal(record.note.length, 500);
});