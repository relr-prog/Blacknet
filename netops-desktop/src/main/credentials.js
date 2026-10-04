"use strict";

// The password manager: the layer the settings UI actually talks to.
//
// It composes the two pieces that still exist and enforces the order they have to
// be used in:
//
//   1. a local identity must be present, so the vault belongs to somebody,
//   2. every secret-bearing action needs a fresh step-up check, and only then is
//      the vault unlocked and the secret returned.
//
// The signed-in session that used to be the first check is gone. It existed to
// keep a browser on the same machine out of a localhost API; there is no API any
// more, and the step-up key is the factor that actually matters - on Linux it
// only exists while a real sudo proof is fresh, on Windows the key stays wrapped
// by DPAPI. Removing the session therefore does not weaken the vault, it removes
// a check that was guarding a door that no longer exists.
//
// Saving is deliberately *not* gated behind step-up: storing a password should
// not demand the sudo password, and refusing to save would push people to write
// it on paper. Only reading a secret back out is guarded. That split is the whole
// point of the feature, so it is enforced here rather than left to the UI.
//
// A pending offer (from the password hook) is held in memory only, expires on its
// own, and is never written to disk: if BlackNet crashes before the operator
// answers, the offer is simply gone rather than leaking a password into a file.

const crypto = require("crypto");
const { Vault, credentialId, randomKey } = require("./vault");

const OFFER_TTL_MS = 5 * 60 * 1000;
const MAX_OFFERS = 8;
const MAX_ORIGIN = 300;
const MAX_USERNAME = 200;
const MAX_PASSWORD = 512;

const COPY_ACTION = "copy";

// `vault` may be a Vault, a directory string, or { dir } - accept all three so
// main.js and the tests do not have to care.
function toVault(vault) {
  if (vault instanceof Vault) return vault;
  const dir = typeof vault === "string" ? vault : (vault && vault.dir) || null;
  if (!dir) throw new Error("a vault directory is required");
  return new Vault({ dir });
}

class PasswordManager {
  #vault;
  #identity;
  #reauth;
  #keyProvider;
  #offers = new Map();

  constructor({ vault, identity, reauth, keyProvider = null }) {
    this.#vault = toVault(vault);
    this.#identity = identity;
    this.#reauth = reauth;
    this.#keyProvider = keyProvider;
  }

  get vault() {
    return this.#vault;
  }

  #limit(value, max) {
    return String(value === undefined || value === null ? "" : value).slice(0, max);
  }

  // --- gating --------------------------------------------------------------
  // The vault has to belong to somebody. This is a presence check, not a
  // credential: the identity carries no secret and proves nothing. Throws because
  // every caller here is a privileged IPC action and the UI renders the message.
  //
  // It is not the thing protecting the secrets - #unlock() and the step-up key
  // are. This only refuses to operate at all when the profile has no owner, which
  // is a corrupt or half-removed userData rather than a normal state.
  #requireIdentity(feature) {
    const identity = this.#identity && this.#identity.current();
    if (!identity) {
      throw new Error(`no local profile owns the ${feature}`);
    }
    return identity;
  }

  // Resolves the data key, or null when none is available yet.
  //
  // Two sources, in order: a platform key provider (the OS-wrapped copy on
  // Windows), or the key the last Linux step-up handed back. Linux never has a
  // copy sitting around, because the whole point is that only root can read it -
  // so the key exists only for as long as the verification that produced it.
  async #dataKey() {
    if (this.#keyProvider) return this.#keyProvider();
    const verified = this.#reauth.verified;
    const key = verified && verified.key;
    return key && key.length === 32 ? key : null;
  }

  // A verification is "fresh" for as long as Reauth says it is. Vault lock state
  // is deliberately not the trigger: on Windows the vault can already be open
  // even though nothing has been presented, and on Linux the key arrives *from*
  // the check. Asking the question that actually matters - "has this operator
  // been verified recently?" - covers both.
  #verificationFresh() {
    const verified = this.#reauth.verified;
    if (!verified) return false;
    if (verified.expiresAt && verified.expiresAt < Date.now()) return false;
    return true;
  }

  // Makes sure the vault is open, and returns nothing on the happy path.
  //
  // `create` is the first-save case: there is no key file yet, so a fresh one is
  // generated and handed to the step-up check to be installed under root. The
  // check returns whichever key the machine actually has, so an existing vault
  // is never overwritten by this path.
  async #unlock({ create = false, method, password } = {}) {
    if (!this.#vault.locked) return true;

    let key = await this.#dataKey();
    if (!key && create) {
      const candidate = randomKey();
      const check = await this.#reauth.verify({ method, password, stageKey: candidate });
      if (!check.ok) throw new Error(check.error || "authentication was cancelled");
      key = check.key || (this.#reauth.verified && this.#reauth.verified.key) || null;
      if (!key) throw new Error("the vault key could not be read after authenticating");
    }

    if (!key) throw new Error("authenticate once before unlocking the password manager");
    this.#vault.unlock(key);
    return true;
  }

  // --- offers --------------------------------------------------------------
  // Called by the password watcher when a form looks like it just created a
  // login. Idempotent per site+user so a double submit cannot stack prompts.
  offer({ origin, username, password, url = "" }) {
    const site = this.#limit(origin, MAX_ORIGIN);
    const user = this.#limit(username, MAX_USERNAME);
    const secret = this.#limit(password, MAX_PASSWORD);
    if (!site || !secret) return null;

    const id = crypto.randomBytes(8).toString("hex");
    const fingerprint = `${site}\u0000${user}`;
    for (const [existing, offer] of this.#offers) {
      if (offer.fingerprint === fingerprint) return existing;
    }

    this.#pruneOffers();
    this.#offers.set(id, {
      id,
      fingerprint,
      origin: site,
      username: user,
      password: secret,
      url: this.#limit(url, MAX_ORIGIN),
      createdAt: Date.now(),
      expiresAt: Date.now() + OFFER_TTL_MS,
    });
    return id;
  }

  #pruneOffers() {
    const now = Date.now();
    for (const [id, offer] of this.#offers) {
      if (offer.expiresAt < now) this.#offers.delete(id);
    }
    // Bound the queue even if offers arrive faster than they expire.
    while (this.#offers.size >= MAX_OFFERS) {
      const oldest = [...this.#offers.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
      if (!oldest) break;
      this.#offers.delete(oldest[0]);
    }
  }

  // The prompt text the chrome shows. Never includes the password itself.
  offers({ enabled = true } = {}) {
    if (!enabled) {
      this.#offers.clear();
      return [];
    }
    this.#pruneOffers();
    return [...this.#offers.values()].map((offer) => ({
      id: offer.id,
      origin: offer.origin,
      username: offer.username,
      expiresAt: offer.expiresAt,
    }));
  }

  // "Not now" - drop it. "Save" - seal it.
  async resolveOffer(id, { save, sudoPassword, method } = {}) {
    this.#pruneOffers();
    const offer = this.#offers.get(id);
    if (!offer) throw new Error("that prompt expired, try logging in again on the page");
    this.#offers.delete(id);
    if (!save) return { saved: false };

    const record = await this.save({
      origin: offer.origin,
      username: offer.username,
      password: offer.password,
      sudoPassword,
      method,
    });
    return { saved: true, ...record };
  }

  // --- CRUD ----------------------------------------------------------------
  //
  // sudoPassword exists for the no-terminal fallback, where the operator types the
  // password into the app instead of a terminal. It is passed straight to sudo
  // and never stored, logged, or put in the vault.
  async save({ origin, username, password, sudoPassword, method }) {
    this.#requireIdentity("password manager");
    const site = this.#limit(origin, MAX_ORIGIN);
    const user = this.#limit(username, MAX_USERNAME);
    const secret = this.#limit(password, MAX_PASSWORD);
    if (!site || !secret) throw new Error("a site and a password are required");

    // First save creates the key file as a side effect of the step-up, so this
    // is one prompt rather than "authenticate, then save, then it still fails".
    await this.#unlock({ create: true, method, password: sudoPassword });
    const id = credentialId({ origin: site, username: user });
    // Keep the AAD's username in step with the id's input, otherwise reveal()
    // would fail to authenticate the record we just wrote.
    const record = this.#vault.seal({ id, origin: site, username: user, password: secret });
    return { id, origin: record.origin, username: record.username, updatedAt: record.updatedAt };
  }

  // Metadata only: safe to render without a step-up, and it cannot leak.
  list() {
    this.#requireIdentity("password manager");
    return this.#vault.list();
  }

  count() {
    return this.#vault.count();
  }

  // The guarded path. Step-up first, then read.
  //
  // `password` is only for the no-terminal fallback, where the sudo password is
  // typed into the app. It goes straight to sudo and is never retained.
  async reveal(id, { method, password } = {}) {
    this.#requireIdentity("password manager");
    // Ask again whenever the last verification has gone stale, but do not nag
    // for every keystroke of a still-valid unlock.
    if (!this.#verificationFresh()) {
      const check = await this.#reauth.verify({ method, password });
      if (!check.ok) throw new Error(check.error || "authentication was cancelled");
    }
    const verified = this.#reauth.requireVerified();
    await this.#unlock();

    const record = this.#vault.reveal(id);
    if (!record) throw new Error("no such saved password");
    return { ...record, verifiedWith: verified.method };
  }

  // Copy and reveal are the same operation as far as the vault is concerned; the
  // difference is that copy never returns the secret to the renderer. The
  // clipboard write happens in the main process.
  async copy(id, { method, password, clipboard } = {}) {
    const record = await this.reveal(id, { method, password });
    if (clipboard) clipboard.writeText(record.password);
    return { copied: true, origin: record.origin, username: record.username, verifiedWith: record.verifiedWith };
  }

  async remove(id) {
    this.#requireIdentity("password manager");
    const removed = this.#vault.remove(id);
    return { removed };
  }

  async verifyAll() {
    this.#requireIdentity("password manager");
    await this.#unlock();
    return this.#vault.verify();
  }

  // Locking is cheap and local; the UI calls it when the settings dialog closes
  // so a closed window does not leave an unlocked vault behind.
  lock() {
    this.#vault.lock();
    this.#reauth.reset();
    for (const offer of this.#offers.values()) offer.password = "";
    this.#offers.clear();
    return { ok: true };
  }

  // What the settings panel renders. Includes the unlock state so the UI can
  // explain why the reveal buttons are disabled.
  status() {
    try {
      const identity = this.#identity && this.#identity.current();
      return {
        available: Boolean(identity),
        method: this.#reauth.method(),
        locked: this.#vault.locked,
        verified: this.#verificationFresh(),
        count: this.#vault.count(),
        pending: this.#offers.size,
        action: COPY_ACTION,
      };
    } catch {
      return {
        available: false,
        method: this.#reauth.method(),
        locked: true,
        verified: false,
        count: 0,
        pending: 0,
        action: COPY_ACTION,
      };
    }
  }

  // Which step-up the UI should offer, and whether it needs the in-app prompt.
  async reauthAvailable() {
    try {
      return await this.#reauth.available();
    } catch {
      return { available: false, method: this.#reauth.method(), inline: false, terminal: null };
    }
  }

  // A deliberate unlock from the settings panel ("Unlock now"), separate from a
  // reveal. The result never contains key material.
  async reauth({ method, password } = {}) {
    this.#requireIdentity("password manager");
    // An unlock is allowed to bootstrap a missing key file, the same as the
    // first save; if one already exists the check returns that one untouched.
    const result = await this.#unlock({ create: true, method, password });
    const verified = this.#reauth.verified;
    return {
      ok: Boolean(result),
      method: (verified && verified.method) || this.#reauth.method(),
      locked: this.#vault.locked,
    };
  }

  // Lets main.js tell the capture watcher that an offer was answered, so the
  // same site may be offered again after a password change.
  onOfferResolved(handler) {
    this.onOfferResolved = handler;
    return this;
  }
}

module.exports = { PasswordManager, OFFER_TTL_MS, MAX_OFFERS };