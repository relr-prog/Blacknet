"use strict";

// Bookmarks: the star in the address bar and the bar under the toolbar.
//
// Local, plain JSON, one file per user. What is stored is what a bookmark is -
// a URL, the title it had when it was saved, and when - and nothing about the
// page. http(s) only: the shell refuses everything else anyway, and a bookmark
// that cannot be reopened is not a bookmark.
//
// Bookmarks and the restorable session are different promises. The session is
// opt-out because it is a browsing history; a bookmark is a list the operator
// built on purpose and means to keep, so it does not follow that switch.

const { JsonStore } = require("./store");

const MAX_BOOKMARKS = 500;
const MAX_TITLE = 200;

function isBookmarkable(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url.trim());
}

// The title a bookmark falls back to when the page never gave one.
function titleFor(url, title) {
  const text = typeof title === "string" ? title.trim() : "";
  if (text) return text.slice(0, MAX_TITLE);
  try {
    return new URL(url).host.slice(0, MAX_TITLE);
  } catch {
    return url.slice(0, MAX_TITLE);
  }
}

class Bookmarks {
  constructor({ userDataPath, log, userData } = {}) {
    this.log = log || (() => {});
    const dir = userDataPath || userData || ".";
    this.store = new JsonStore(`${dir}/bookmarks.json`, { items: [] });
    const data = this.store.all();
    const raw = Array.isArray(data.items) ? data.items : [];
    let nextId = 0;
    this.items = [];
    for (const entry of raw) {
      if (!entry || !isBookmarkable(entry.url)) continue;
      const id = Number(entry.id);
      const item = {
        id: Number.isInteger(id) && id > 0 ? id : 0,
        url: entry.url.trim(),
        title: titleFor(entry.url, entry.title),
        addedAt: Number(entry.addedAt) || 0,
      };
      nextId = Math.max(nextId, item.id);
      this.items.push(item);
    }
    // Re-number anything that arrived without a usable id, then set the counter
    // past the highest id actually in use.
    for (const item of this.items) {
      if (!item.id) {
        nextId += 1;
        item.id = nextId;
      }
    }
    this.nextId = nextId + 1;
  }

  all() {
    return this.items.map((item) => this.#shape(item));
  }

  has(url) {
    return Boolean(this.find(url));
  }

  find(url) {
    if (!isBookmarkable(url)) return null;
    const target = url.trim();
    return this.items.find((item) => item.url === target) || null;
  }

  // The star's one action. Returns what happened so the UI can update without a
  // second round trip, and so a caller that only asked "toggle" does not have to
  // re-read the whole list to know which way it went.
  toggle({ url, title } = {}) {
    const existing = this.find(url);
    if (existing) {
      this.#removeItem(existing);
      return { action: "removed", item: this.#shape(existing), items: this.all() };
    }
    const item = this.add({ url, title });
    return { action: "added", item, items: this.all() };
  }

  add({ url, title } = {}) {
    if (!isBookmarkable(url)) throw new Error("only http(s) addresses can be bookmarked");
    const target = url.trim();
    const existing = this.find(target);
    if (existing) return this.#shape(existing);
    if (this.items.length >= MAX_BOOKMARKS) {
      throw new Error(`bookmark limit reached (${MAX_BOOKMARKS})`);
    }
    const item = {
      id: this.nextId,
      url: target,
      title: titleFor(target, title),
      addedAt: Date.now(),
    };
    this.nextId += 1;
    this.items.push(item);
    this.#persist();
    return this.#shape(item);
  }

  remove(url) {
    const item = this.find(url);
    if (!item) return { removed: false, items: this.all() };
    this.#removeItem(item);
    return { removed: true, item: this.#shape(item), items: this.all() };
  }

  clear() {
    this.items = [];
    this.nextId = 1;
    this.#persist();
  }

  #removeItem(item) {
    this.items = this.items.filter((candidate) => candidate !== item);
    this.#persist();
  }

  #shape(item) {
    return { id: item.id, url: item.url, title: item.title, addedAt: item.addedAt };
  }

  #persist() {
    this.store.set("items", this.items);
  }
}

module.exports = { Bookmarks, isBookmarkable };
