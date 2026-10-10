"use strict";

// Downloads: what the shell recovered from the network, one file per user.
//
// A download is the one file a site is allowed to write to disk, so it gets the
// same treatment as a bookmark - a local record the operator owns, kept
// separately from the restorable session, so clearing the session never loses
// it. Nothing here touches the network or the filesystem beyond the JSON file:
// the byte transfer and the save path are the tab manager's job, because they
// need the live session that produced them.
//
// Only the shape is stored - name, where it was saved, how big, how it ended.
// The byte stream itself lives on disk until the operator deletes it; this list
// is the pointer to that file, not a copy of it.

const { JsonStore } = require("./store");

const MAX_DOWNLOADS = 200;
const STATES = new Set(["active", "completed", "cancelled", "interrupted"]);

// A filename is a filename: a server can hand back anything in a
// Content-Disposition header, and none of it may escape the download directory
// or walk up the tree. Trailing dots and spaces are stripped because Windows
// treats them as part of the path (and quietly drops them at the API boundary).
function sanitizeFilename(name) {
  if (typeof name !== "string") return "download";
  let base = name.trim();
  if (!base || base === "." || base === "..") return "download";
  // Strip path characters and drive letters, then collapse to a single part.
  base = base.replace(/[\\/]/g, "").replace(/^[a-zA-Z]:/, "");
  // A name cannot be "." or ".." after cleaning, so a path that collapsed into
  // those (or a leading "..") must not hand back a traversal.
  base = base.replace(/^[.]+/, "");
  base = base.replace(/[.]+\s*$/g, "").replace(/\s+$/g, "");
  if (!base || base === "." || base === "..") return "download";
  if (base.length > 220) base = base.slice(0, 220);
  return base;
}

class Downloads {
  constructor({ userDataPath, userData, log } = {}) {
    this.log = log || (() => {});
    const dir = userDataPath || userData || ".";
    this.store = new JsonStore(`${dir}/downloads.json`, { items: [] });
    let nextId = 0;
    this.items = [];
    const data = this.store.all();
    const raw = Array.isArray(data.items) ? data.items : [];
    for (const entry of raw) {
      if (!entry || typeof entry.filename !== "string") continue;
      const id = Number(entry.id);
      const state = STATES.has(entry.state) ? entry.state : "interrupted";
      const item = {
        id: Number.isInteger(id) && id > 0 ? id : 0,
        filename: sanitizeFilename(entry.filename),
        url: typeof entry.url === "string" ? entry.url : "",
        savePath: typeof entry.savePath === "string" ? entry.savePath : "",
        mimeType: typeof entry.mimeType === "string" ? entry.mimeType : "",
        state,
        totalBytes: this.#bytes(entry.totalBytes),
        receivedBytes: this.#bytes(entry.receivedBytes),
        startedAt: Number(entry.startedAt) || 0,
        endedAt: Number(entry.endedAt) || 0,
      };
      nextId = Math.max(nextId, item.id);
      this.items.push(item);
    }
    for (const item of this.items) {
      if (!item.id) {
        nextId += 1;
        item.id = nextId;
      }
    }
    this.nextId = nextId + 1;
  }

  #bytes(value) {
    const n = Math.round(Number(value));
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  all() {
    return this.items.map((item) => ({ ...item }));
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  add({ filename, url = "", savePath = "", totalBytes = 0, mimeType = "" } = {}) {
    const item = {
      id: this.nextId,
      filename: sanitizeFilename(filename),
      url,
      savePath,
      mimeType,
      state: "active",
      totalBytes: this.#bytes(totalBytes),
      receivedBytes: 0,
      startedAt: Date.now(),
      endedAt: 0,
    };
    this.nextId += 1;
    this.items.push(item);
    this.#trim();
    this.#persist();
    return { ...item };
  }

  update(id, patch) {
    const item = this.get(id);
    if (!item) return null;
    if (patch.state !== undefined && STATES.has(patch.state)) item.state = patch.state;
    if (patch.receivedBytes !== undefined) item.receivedBytes = this.#bytes(patch.receivedBytes);
    if (patch.endedAt !== undefined) item.endedAt = Number(patch.endedAt) || 0;
    this.#persist();
    return { ...item };
  }

  remove(id) {
    const item = this.get(id);
    if (!item) return null;
    this.items = this.items.filter((candidate) => candidate !== item);
    this.#persist();
    return { ...item };
  }

  clear() {
    this.items = [];
    this.nextId = 1;
    this.#persist();
  }

  // Oldest-first eviction past the cap, so the list cannot grow without bound.
  #trim() {
    if (this.items.length <= MAX_DOWNLOADS) return;
    const excess = this.items.length - MAX_DOWNLOADS;
    this.items = this.items.slice(excess);
  }

  #persist() {
    this.store.set("items", this.items);
  }
}

module.exports = { Downloads, sanitizeFilename, MAX_DOWNLOADS };