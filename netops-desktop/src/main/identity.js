"use strict";

// Who this browser belongs to.
//
// There is exactly one identity per installation, created on first run. There is
// deliberately no password and no server behind it, which is a change from the
// dashboard era where a signed-in session was one of the two factors guarding the
// vault. That factor existed to protect a localhost HTTP API from the browser
// sitting next to it; with the control plane gone there is no API to protect, and
// a password file would only add something phishable and something to leak.
//
// What still protects the vault is unchanged and is the real answer to "who is
// this": the step-up check. On Linux the vault key is read out of a root-only file
// after a real sudo proof, so it only exists while that proof is fresh. On Windows
// Hello is a presence check and the key stays wrapped by DPAPI. Neither depends
// on anything stored here.
//
// The name is therefore a label, not a credential: it says whose vault this is in
// the UI and gives sync something to key on later. It grants nothing.

const crypto = require("crypto");
const path = require("path");

const { JsonStore } = require("./store");

const MAX_NAME = 60;
const DEFAULT_NAME = "Local";

// Control characters and newlines are refused so the name can be rendered into a
// label without any escaping story at all.
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function cleanName(value) {
  const text = String(value == null ? "" : value).replace(CONTROL_CHARS, "").trim();
  if (!text) return "";
  return text.slice(0, MAX_NAME);
}

class Identity {
  #store;
  #log;

  constructor({ userDataPath, log } = {}) {
    this.#log = log || (() => {});
    this.#store = new JsonStore(path.join(userDataPath, "identity.json"), {});
  }

  // Created on first read so every caller can assume an identity exists. Writing
  // an id keeps the file useful if sync ever needs a stable handle; it is not a
  // secret and grants nothing.
  ensure() {
    const existing = this.#store.all();
    if (existing.name && existing.createdAt) return existing;
    const created = {
      id: crypto.randomBytes(8).toString("hex"),
      name: cleanName(existing.name) || DEFAULT_NAME,
      createdAt: Number(existing.createdAt) || Date.now(),
    };
    this.#store.patch(created);
    this.#log(`[identity] local identity ready (${created.name})`);
    return created;
  }

  // The identity, or null if it has never been created. Synchronous: gating runs
  // inside permission checks that cannot await.
  current() {
    const values = this.#store.all();
    if (!values.name) return null;
    return {
      id: String(values.id || ""),
      name: String(values.name),
      createdAt: Number(values.createdAt) || 0,
    };
  }

  // A display label the UI can render. Deliberately says nothing about whether the
  // vault is open - that is #unlocked(), and conflating the two would let the UI
  // claim a vault is unlocked when no key has been presented.
  describe() {
    const identity = this.current();
    return {
      available: Boolean(identity),
      name: identity ? identity.name : "",
      createdAt: identity ? identity.createdAt : 0,
    };
  }

  rename(value) {
    const name = cleanName(value);
    if (!name) throw new Error("a profile name is required");
    const current = this.ensure();
    this.#store.patch({ name });
    return { ...current, name };
  }
}

module.exports = { Identity, cleanName, DEFAULT_NAME, MAX_NAME };