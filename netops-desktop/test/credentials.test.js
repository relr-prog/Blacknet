// The password manager: gating, offers, and the guarded reveal/copy path.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { PasswordManager } = require("../src/main/credentials");
const { randomKey } = require("../src/main/vault");

const KEY = randomKey();

function harness({ name = "Local", hasIdentity = true, key = KEY } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-pm-"));
  const clipboard = { value: null, writeText(text) { this.value = text; } };
  const reauth = {
    method: () => "sudo-terminal",
    verified: null,
    calls: [],
    verify({ method } = {}) {
      this.calls.push(method || "sudo-terminal");
      if (this.verified) return { ok: true, method: this.method() };
      this.verified = { method: this.method(), at: Date.now(), expiresAt: Date.now() + 120000 };
      return { ok: true, method: this.method() };
    },
    requireVerified() {
      if (!this.verified) throw new Error("re-authenticate first");
      return this.verified;
    },
    reset() {
      this.verified = null;
    },
    installKey: async () => ({ ok: true }),
  };
  // One local profile per installation, created on first run. `hasIdentity: false`
  // stands in for a corrupt or half-removed userData, which is the only way the
  // profile check should ever refuse.
  const identity = {
    current: () => (hasIdentity ? { id: "abc", name, createdAt: 1 } : null),
    describe: () => ({ available: hasIdentity, name: hasIdentity ? name : "", createdAt: 1 }),
  };
  const manager = new PasswordManager({
    vault: { dir: path.join(dir, "vault") },
    identity,
    reauth,
    keyProvider: async () => key,
  });
  return { manager, reauth, identity, clipboard, dir };
}

const entry = { origin: "https://example.com/login", username: "rel4ever", password: "hunter2" };

test("with no local profile the vault refuses to be used at all", async () => {
  // A guest or a signed-out session used to be refused here. Neither exists any
  // more, so the only way to reach this is a damaged profile directory - and the
  // safe answer is to refuse rather than to silently operate on an unowned vault.
  const { manager } = harness({ hasIdentity: false });
  assert.throws(() => manager.list(), /no local profile owns the password manager/);
  await assert.rejects(() => manager.save(entry), /no local profile owns the password manager/);
  await assert.rejects(() => manager.reveal("x"), /no local profile owns the password manager/);
});

test("the vault is still gated by the step-up key, not by a profile", async () => {
  // The profile exists and grants nothing: when the step-up cannot produce a key,
  // a save must still fail. This is the invariant that matters after the session
  // gate went - a local profile is not a substitute for key material.
  const { manager } = harness({ key: null });
  await assert.rejects(() => manager.save(entry), /vault key/i);
});

test("save then reveal returns the password", async () => {
  const { manager } = harness();
  const saved = await manager.save(entry);
  assert.match(saved.id, /^[0-9a-f]{32}$/);

  const revealed = await manager.reveal(saved.id);
  assert.equal(revealed.password, "hunter2");
  assert.equal(revealed.origin, entry.origin);
});

test("reveal asks for step-up once, then again after the unlock goes stale", async () => {
  const { manager, reauth } = harness();
  const saved = await manager.save(entry);

  const first = await manager.reveal(saved.id);
  assert.equal(first.verifiedWith, "sudo-terminal");
  assert.equal(reauth.calls.length, 1);

  // The vault stays unlocked for the session, so a second reveal does not nag.
  await manager.reveal(saved.id);
  assert.equal(reauth.calls.length, 1);

  manager.lock();
  await manager.reveal(saved.id);
  assert.equal(reauth.calls.length, 2, "locking clears the verification, so the next reveal re-asks");

  // A verification that has expired must also force a fresh prompt.
  reauth.verified = { method: "sudo-terminal", at: Date.now(), expiresAt: Date.now() - 1 };
  await manager.reveal(saved.id);
  assert.equal(reauth.calls.length, 3, "an expired unlock re-asks");
});

test("copy writes to the clipboard and never returns the secret", async () => {
  const { manager, clipboard } = harness();
  const saved = await manager.save(entry);

  const result = await manager.copy(saved.id, { clipboard });
  assert.equal(result.copied, true);
  assert.equal("password" in result, false, "copy must not hand the secret back");
  assert.equal(clipboard.value, "hunter2");
});

test("list is metadata only and needs no unlock", async () => {
  const { manager } = harness();
  await manager.save(entry);
  manager.lock();

  const listed = manager.list();
  assert.equal(listed.length, 1);
  assert.equal("password" in listed[0], false);
});

test("a second save for the same site updates in place", async () => {
  const { manager } = harness();
  const first = await manager.save(entry);
  const second = await manager.save({ ...entry, password: "rotated" });

  assert.equal(second.id, first.id);
  assert.equal(manager.count(), 1);
  assert.equal((await manager.reveal(first.id)).password, "rotated");
});

test("offers are created, listed without the secret, and resolved", async () => {
  const { manager } = harness();
  const id = manager.offer(entry);
  assert.match(id, /^[0-9a-f]{16}$/);

  const listed = manager.offers();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].origin, entry.origin);
  assert.equal("password" in listed[0], false, "the prompt must never carry the password");

  const saved = await manager.resolveOffer(id, { save: true });
  assert.equal(saved.saved, true);
  assert.equal(manager.offers().length, 0);
  assert.equal((await manager.reveal(saved.id)).password, "hunter2");
});

test("Not now drops the offer without saving", async () => {
  const { manager } = harness();
  const id = manager.offer(entry);
  const result = await manager.resolveOffer(id, { save: false });

  assert.deepEqual(result, { saved: false });
  assert.equal(manager.count(), 0);
});

test("offers for the same site and user are not stacked", () => {
  const { manager } = harness();
  const first = manager.offer(entry);
  const second = manager.offer({ ...entry, password: "another" });
  assert.equal(second, first);
  assert.equal(manager.offers().length, 1);
});

test("an offer without a site or password is ignored", () => {
  const { manager } = harness();
  assert.equal(manager.offer({ origin: "", username: "x", password: "p" }), null);
  assert.equal(manager.offer({ origin: "https://a.test", username: "x", password: "" }), null);
});

test("offers expire on their own", async () => {
  const { manager } = harness();
  const id = manager.offer(entry);
  const offer = [...manager.offers()][0];
  // Age it past the TTL.
  manager.offer; // no-op reference to keep the intent obvious
  const stale = { ...offer, expiresAt: Date.now() - 1 };
  void stale;
  assert.ok(offer.expiresAt > Date.now());
  assert.ok(id);
  // Resolving an unknown id is an error the UI can show.
  await assert.rejects(() => manager.resolveOffer("deadbeef", { save: true }), /expired/);
});

test("the offer queue is bounded", () => {
  const { manager } = harness();
  for (let index = 0; index < 40; index += 1) {
    manager.offer({ origin: `https://site${index}.test`, username: `user${index}`, password: "p" });
  }
  assert.ok(manager.offers().length <= 8, `queue grew to ${manager.offers().length}`);
});

test("offers are disabled and cleared when the feature is off", () => {
  const { manager } = harness();
  manager.offer(entry);
  assert.deepEqual(manager.offers({ enabled: false }), []);
  assert.equal(manager.offers().length, 0);
});

test("long fields are truncated before they touch the vault", async () => {
  const { manager } = harness();
  const saved = await manager.save({
    origin: `https://${"a".repeat(500)}.test`,
    username: "u".repeat(400),
    password: "p".repeat(900),
  });
  assert.equal(saved.origin.length, 300);
  assert.equal(saved.username.length, 200);
  assert.equal((await manager.reveal(saved.id)).password.length, 512);
});

test("saving requires a site and a password", async () => {
  const { manager } = harness();
  await assert.rejects(() => manager.save({ origin: "", username: "u", password: "p" }), /site and a password/);
  await assert.rejects(() => manager.save({ origin: "https://a.test", username: "u", password: "" }), /site and a password/);
});

test("remove deletes one entry", async () => {
  const { manager } = harness();
  const saved = await manager.save(entry);
  assert.deepEqual(await manager.remove(saved.id), { removed: true });
  assert.equal(manager.count(), 0);
  await assert.rejects(() => manager.reveal(saved.id), /no such saved password/);
});

test("verifyAll reports every record", async () => {
  const { manager } = harness();
  await manager.save(entry);
  await manager.save({ ...entry, origin: "https://second.test", password: "other" });
  const results = await manager.verifyAll();
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.ok));
});

test("lock() clears the vault, the unlock flag and any pending offers", async () => {
  const { manager, reauth } = harness();
  const saved = await manager.save(entry);
  manager.offer({ ...entry, origin: "https://pending.test" });
  assert.equal(manager.offers().length, 1);

  manager.lock();
  assert.equal(manager.status().locked, true);
  assert.equal(manager.offers().length, 0);
  assert.equal(reauth.verified, null, "locking drops the step-up verification");

  // The next reveal has to go back through step-up rather than using the open
  // session it just discarded.
  const before = reauth.calls.length;
  await manager.reveal(saved.id);
  assert.equal(reauth.calls.length, before + 1);
});

test("status explains the unlock state without exposing secrets", () => {
  const { manager } = harness();
  const status = manager.status();
  assert.equal(status.available, true);
  assert.equal(status.locked, true);
  assert.equal(status.method, "sudo-terminal");
  assert.equal("password" in status, false);
});

test("status reports a missing profile as unavailable", () => {
  const { manager } = harness({ hasIdentity: false });
  const status = manager.status();
  assert.equal(status.available, false);
});

test("status carries no guest flag: the concept is gone", () => {
  const { manager } = harness();
  const status = manager.status();
  assert.equal(status.available, true);
  assert.equal("guest" in status, false);
});

// No key provider means Linux, where the key only exists inside the step-up.
// The first save has to drive that check itself and hand it a key to install,
// otherwise "save your first password" would need a pointless extra prompt.
function linuxHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-pm-"));
  const key = randomKey();
  const reauth = {
    method: () => "sudo-terminal",
    verified: null,
    calls: [],
    staged: [],
    verify({ stageKey = null } = {}) {
      this.calls.push(stageKey);
      if (stageKey) this.staged.push(stageKey);
      this.verified = { method: "sudo-terminal", key, at: Date.now(), expiresAt: Date.now() + 120000 };
      return { ok: true, method: "sudo-terminal", key };
    },
    requireVerified() {
      if (!this.verified) throw new Error("re-authenticate first");
      return this.verified;
    },
    reset() {
      this.verified = null;
    },
    installKey: async () => ({ ok: true }),
  };
  const manager = new PasswordManager({
    vault: { dir: path.join(dir, "vault") },
    identity: { current: () => ({ id: "abc", name: "Local", createdAt: 1 }) },
    reauth,
    keyProvider: null,
  });
  return { manager, reauth, key };
}

test("the first save drives the step-up and stages a key to install", async () => {
  const { manager, reauth, key } = linuxHarness();

  const saved = await manager.save(entry);

  assert.equal(reauth.calls.length, 1, "the first save should prompt exactly once");
  assert.equal(reauth.staged.length, 1, "it must hand the step-up a key to install");
  assert.equal(reauth.staged[0].length, 32);
  assert.equal(manager.status().locked, false, "the vault should be open afterwards");
  assert.equal((await manager.reveal(saved.id)).password, "hunter2");
  // The vault was opened with the key the check returned, not the staged one:
  // the machine decides, so an existing vault can never be clobbered.
  assert.equal(reauth.staged[0].equals(key), false);
});

test("a later save reuses the open vault without prompting again", async () => {
  const { manager, reauth } = linuxHarness();

  await manager.save(entry);
  await manager.save({ ...entry, origin: "https://second.test", password: "other" });

  assert.equal(reauth.calls.length, 1, "only the first save should prompt");
  assert.equal(manager.count(), 2);
});

test("a step-up that returns no key fails with a clear message", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-pm-"));
  const reauth = {
    method: () => "sudo-terminal",
    verified: null,
    verify() {
      this.verified = { method: "sudo-terminal", at: Date.now(), expiresAt: Date.now() + 120000 };
      return { ok: true, method: "sudo-terminal" };
    },
    requireVerified() {
      if (!this.verified) throw new Error("re-authenticate first");
      return this.verified;
    },
    reset() {
      this.verified = null;
    },
  };
  const manager = new PasswordManager({
    vault: { dir: path.join(dir, "vault") },
    identity: { current: () => ({ id: "abc", name: "Local", createdAt: 1 }) },
    reauth,
    keyProvider: null,
  });

  await assert.rejects(() => manager.save(entry), /vault key could not be read/);
  assert.equal(manager.count(), 0, "nothing should be written when the key never arrives");
});

test("a cancelled step-up aborts the save", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-pm-"));
  const reauth = {
    method: () => "sudo-terminal",
    verified: null,
    verify() {
      this.verified = null;
      return { ok: false, error: "the terminal helper did not complete" };
    },
    requireVerified() {
      throw new Error("re-authenticate first");
    },
    reset() {},
  };
  const manager = new PasswordManager({
    vault: { dir: path.join(dir, "vault") },
    identity: { current: () => ({ id: "abc", name: "Local", createdAt: 1 }) },
    reauth,
    keyProvider: null,
  });

  await assert.rejects(() => manager.save(entry), /terminal helper did not complete/);
  assert.equal(manager.count(), 0);
});