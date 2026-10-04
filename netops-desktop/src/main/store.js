"use strict";

// A tiny durable JSON store for the shell's own state (settings, credential
// index, pending password prompts).
//
// Why not SQLite: the control plane owns user/session/audit data in its own
// database, and this process only keeps a handful of small local records. A
// single file per concern, written atomically, is easier to reason about than an
// embedded SQL engine we would have to ship.
//
// Durability rules:
//   - write to "<file>.tmp" in the same directory, fsync, then rename. A crash
//     mid-write therefore leaves either the old file or the new one, never a
//     half-written one.
//   - the directory is created on demand, mode 0700: these files describe the
//     user's browser, not the world.
//   - a corrupt or unreadable file is quarantined, not deleted, so a bug can be
//     diagnosed instead of silently losing the user's settings.

const fs = require("fs");
const path = require("path");

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

class JsonStore {
  #file;
  #dir;
  #data;
  #defaults;

  constructor(filePath, defaults = {}) {
    this.#file = filePath;
    this.#dir = path.dirname(filePath);
    this.#defaults = defaults;
    this.#data = this.#read();
  }

  get file() {
    return this.#file;
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.#file, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ...structuredClone(this.#defaults), ...parsed };
      }
      throw new Error("top level value is not an object");
    } catch (error) {
      if (error.code === "ENOENT") return structuredClone(this.#defaults);
      // Keep the unreadable file around: overwriting it would destroy evidence
      // and, worse, silently reset the user's settings.
      const quarantine = `${this.#file}.corrupt-${Date.now()}`;
      try {
        fs.renameSync(this.#file, quarantine);
      } catch {
        /* nothing else to try */
      }
      return structuredClone(this.#defaults);
    }
  }

  all() {
    return structuredClone(this.#data);
  }

  get(key, fallback = undefined) {
    return key in this.#data ? structuredClone(this.#data[key]) : fallback;
  }

  set(key, value) {
    this.#data[key] = value;
    this.flush();
    return structuredClone(value);
  }

  patch(values) {
    Object.assign(this.#data, values || {});
    this.flush();
    return this.all();
  }

  delete(key) {
    const existed = key in this.#data;
    delete this.#data[key];
    if (existed) this.flush();
    return existed;
  }

  flush() {
    fs.mkdirSync(this.#dir, { recursive: true, mode: DIR_MODE });
    const tmp = `${this.#file}.tmp`;
    const handle = fs.openSync(tmp, "w", FILE_MODE);
    try {
      fs.writeFileSync(handle, `${JSON.stringify(this.#data, null, 2)}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.#file);
    return this.#file;
  }
}

module.exports = { JsonStore };