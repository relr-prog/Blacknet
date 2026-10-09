"use strict";

// Per-site zoom. Chromium already scales a page from a trackpad gesture, but a
// keyboard zoom is the shell's to remember: the factor is kept per origin, so
// every tab on a site opens at the size the operator last chose and the choice
// survives a restart. That is what a browser is expected to do, and it is why
// this is one small local JSON file per user rather than a session setting.
//
// Only http(s) has an origin worth remembering. A file: page and a data: page
// both report the origin "null"; remembering one of those would leak the size of
// a local page onto the next one, so they are not tracked.

const { JsonStore } = require("./store");

// Chromium's own zoom ladder. Stepping through a fixed list rather than
// multiplying keeps a run of zoom-ins reversible: 100 -> 110 -> 125 -> 150 and
// straight back down the same values, instead of drifting off the rungs.
const LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5,
];

const DEFAULT = 1;
const MAX_SITES = 500;

// The origin a URL belongs to, or null for a page the shell will not track.
// http(s) only: everything else (file:, data:, about:) has no origin to key on.
function originOf(url) {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url.trim())) return null;
  try {
    return new URL(url.trim()).origin;
  } catch {
    return null;
  }
}

// The rung nearest a stored factor, so a hand-edited file cannot pin a page at
// 1.037x. A value that is not a number lands back on 100%.
function snap(factor) {
  const n = Number(factor);
  if (!Number.isFinite(n)) return DEFAULT;
  let best = DEFAULT;
  let bestGap = Infinity;
  for (const level of LEVELS) {
    const gap = Math.abs(level - n);
    if (gap < bestGap) {
      bestGap = gap;
      best = level;
    }
  }
  return best;
}

class Zoom {
  constructor({ userDataPath, userData, log } = {}) {
    this.log = log || (() => {});
    const dir = userDataPath || userData || ".";
    this.store = new JsonStore(`${dir}/zoom.json`, { sites: {} });
    const data = this.store.all();
    const raw = data.sites && typeof data.sites === "object" ? data.sites : {};
    this.sites = {};
    // Object key order is insertion order for string keys, so the first key is
    // the oldest and trimming from the front keeps the most recent sites.
    for (const [origin, factor] of Object.entries(raw)) {
      if (!/^https?:\/\//i.test(origin)) continue;
      const level = snap(factor);
      if (level === DEFAULT) continue; // 100% is the absence of an entry
      this.sites[origin] = level;
      if (Object.keys(this.sites).length >= MAX_SITES) break;
    }
  }

  factorFor(origin) {
    return origin && this.sites[origin] ? this.sites[origin] : DEFAULT;
  }

  // Steps one rung in a direction, or back to 100% for a reset. The new factor
  // is not stored here: the caller applies it with set() once it has decided.
  next(origin, direction) {
    if (!origin || direction === "reset" || direction === undefined) return DEFAULT;
    const current = this.factorFor(origin);
    let index = LEVELS.indexOf(current);
    if (index < 0) index = LEVELS.indexOf(DEFAULT);
    index += direction === "out" ? -1 : 1;
    index = Math.max(0, Math.min(LEVELS.length - 1, index));
    return LEVELS[index];
  }

  // Records a factor for a site. 100% is stored as the absence of an entry, so
  // "reset" really forgets rather than pinning a no-op row.
  set(origin, factor) {
    if (!origin) return DEFAULT;
    const level = snap(factor);
    if (level === DEFAULT) {
      if (this.sites[origin] !== undefined) {
        delete this.sites[origin];
        this.#persist();
      }
      return DEFAULT;
    }
    this.sites[origin] = level;
    const keys = Object.keys(this.sites);
    if (keys.length > MAX_SITES) {
      for (const key of keys.slice(0, keys.length - MAX_SITES)) delete this.sites[key];
    }
    this.#persist();
    return level;
  }

  clear() {
    this.sites = {};
    this.#persist();
  }

  #persist() {
    this.store.set("sites", this.sites);
  }
}

module.exports = { Zoom, originOf, snap, LEVELS, DEFAULT, MAX_SITES };
