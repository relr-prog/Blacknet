"use strict";

// The credential vault.
//
// Design, and the reasoning behind it:
//
//  * AES-256-GCM with a random 96-bit IV per record. The IV is stored next to the
//    ciphertext and is *not* secret; reusing it under one key is catastrophic for
//    GCM, so a fresh one is drawn for every save.
//  * The key never lives in this file in the clear. The vault holds a random
//    32-byte data key, and every record is sealed with it. That data key is what
//    step-up authentication unlocks: on Linux it lives in a root-only file that
//    sudo reads, on Windows it is wrapped by DPAPI under the user account. So the
//    vault is useless to anyone who has only the vault file.
//  * AAD binds each record to its id, origin and account. Moving a sealed record
//    to another slot, or replaying another account's entry, fails to decrypt.
//  * Records are stored one JSON file per entry, so a single corrupt file costs
//    one credential instead of the whole vault.
//
// The index (id, site, username, timestamps) is deliberately *not* encrypted -
// it is what the settings list shows - but it holds no secret, only metadata, and
// it is readable without any unlock.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function randomKey() {
  return crypto.randomBytes(KEY_BYTES);
}

// scrypt is used when the caller has a passphrase to stretch. The step-up flows
// hand over 32 raw bytes instead, so this is only for the fallback passphrase
// path - and its parameters are deliberately heavy.
function stretch(passphrase, salt = crypto.randomBytes(16)) {
  // N=2^15 with r=8 needs 128*N*r = 32 MiB, which is exactly Node's default
  // scrypt maxmem, so the cap has to be raised or this throws at run time.
  return crypto.scryptSync(String(passphrase), salt, KEY_BYTES, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 128 * 1024 * 1024,
  });
}

class Vault {
  #dir;
  #key = null;

  constructor({ dir }) {
    this.#dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }

  get dir() {
    return this.#dir;
  }

  get locked() {
    return this.#key === null;
  }

  // id is validated because it becomes a file name; a traversal attempt must be
  // rejected here rather than by the filesystem.
  static safeId(id) {
    const value = String(id || "");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new Error("invalid credential id");
    return value;
  }

  #file(id) {
    return path.join(this.#dir, `${Vault.safeId(id)}.json`);
  }

  // The AAD is built from the id the record is *stored under*, not the id it
  // claims for itself: otherwise a record copied to another file name would
  // still authenticate, and the binding would be decorative.
  #aad({ id, origin, username }) {
    return Buffer.from(`${id}\u0000${origin || ""}\u0000${username || ""}`, "utf8");
  }

  // --- key handling --------------------------------------------------------
  unlock(key) {
    if (key instanceof Buffer && key.length !== KEY_BYTES) {
      throw new Error("vault key must be 32 bytes");
    }
    const material = key instanceof Buffer ? key : stretch(key);
    if (material.length !== KEY_BYTES) throw new Error("vault key must be 32 bytes");
    this.#key = Buffer.from(material);
    return { ok: true };
  }

  lock() {
    // Overwrite before dropping the reference so the bytes do not linger in the
    // heap until the next allocation.
    if (this.#key) this.#key.fill(0);
    this.#key = null;
    return { ok: true };
  }

  #requireKey() {
    if (!this.#key) throw new Error("the vault is locked - authenticate to unlock it");
    return this.#key;
  }

  // --- records -------------------------------------------------------------
  seal({ id, origin, username, password, note = "" }) {
    const key = this.#requireKey();
    const safe = Vault.safeId(id);
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    cipher.setAAD(this.#aad({ id: safe, origin, username }));
    const ciphertext = Buffer.concat([
      cipher.update(String(password), "utf8"),
      cipher.final(),
    ]);
    const record = {
      id: safe,
      origin: String(origin || ""),
      username: String(username || ""),
      note: String(note || "").slice(0, 500),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.#file(safe), `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
    return record;
  }

  #read(id) {
    try {
      const record = JSON.parse(fs.readFileSync(this.#file(id), "utf8"));
      if (!record || typeof record !== "object" || typeof record.data !== "string") {
        throw new Error("malformed record");
      }
      return record;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #open(record, id) {
    const key = this.#requireKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(record.iv, "base64"));
    decipher.setAAD(this.#aad({ id, origin: record.origin, username: record.username }));
    decipher.setAuthTag(Buffer.from(record.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.data, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  }

  // Reveal is the one path that returns a secret, so it is explicit and total:
  // no silent coercion, no caching of the plaintext in the record.
  reveal(id) {
    const record = this.#read(id);
    if (!record) return null;
    return { ...this.strip(record), password: this.#open(record, id) };
  }

  strip(record) {
    const { iv, tag, data, ...meta } = record || {};
    return meta;
  }

  // The list the settings UI renders: metadata only, so opening the list does
  // not require the vault to be unlocked and cannot leak a password.
  list() {
    let entries;
    try {
      entries = fs.readdirSync(this.#dir);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.endsWith(".json"))
      .map((name) => Vault.safeId(name.slice(0, -5)))
      .map((id) => {
        try {
          const record = this.#read(id);
          return record ? this.strip(record) : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(a.origin).localeCompare(String(b.origin)));
  }

  update(id, patch = {}) {
    const record = this.#read(id);
    if (!record) return null;
    // Any change re-seals, including a metadata-only one: the AAD binds origin
    // and username, so editing either would invalidate the old ciphertext.
    const password = patch.password !== undefined ? patch.password : this.#open(record, id);
    return this.strip(
      this.seal({
        id,
        origin: patch.origin ?? record.origin,
        username: patch.username ?? record.username,
        password,
        note: patch.note ?? record.note,
      }),
    );
  }

  remove(id) {
    const file = this.#file(id);
    if (!fs.existsSync(file)) return false;
    fs.unlinkSync(file);
    return true;
  }

  count() {
    return this.list().length;
  }

  // A tamper check the user can run from the settings UI: with the vault locked
  // it proves nothing, so callers must unlock first.
  verify() {
    const results = [];
    for (const meta of this.list()) {
      try {
        this.#open(this.#read(meta.id), meta.id);
        results.push({ id: meta.id, ok: true });
      } catch (error) {
        results.push({ id: meta.id, ok: false, error: error.message });
      }
    }
    return results;
  }
}

// Deterministic ids so re-saving the same site updates one entry instead of
// piling up duplicates. Scoped by account so two users of the same browser do
// not share a slot.
function credentialId({ origin, username, account = "" }) {
  let host = String(origin || "");
  try {
    host = new URL(host).hostname || host;
  } catch {
    /* keep the raw string for non-URL origins */
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${account}\u0000${host.toLowerCase()}\u0000${String(username || "")}`)
    .digest("hex");
  return digest.slice(0, 32);
}

module.exports = { Vault, credentialId, randomKey, stretch, ALGO, KEY_BYTES };