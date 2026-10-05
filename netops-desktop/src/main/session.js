"use strict";

// The tabs that were open, so a restart does not lose them.
//
// A browser that forgets everything on quit is a browser people stop trusting
// with anything they meant to come back to. This is the ordinary convenience
// every browser has, and it is worth being precise about what is stored: the
// URL, the profile, and which tab was in front. No page content, no cookies, no
// history - those belong to the session partitions, which are already on disk and
// already cleaned on their own terms.
//
// The tension worth naming: this is a browsing history file. It is small and it
// is local, and it is opt-out via settings.restoreSession, because a tool that
// records where people go should not do it silently.

const { JsonStore } = require("./store");

const MAX_TABS = 50;

// Anything that is not a page we can reopen. A dead tab in a restored session is
// worse than a missing one: the operator gets a failed load and no idea why.
function restorable(described) {
  if (!described || typeof described.url !== "string") return false;
  return /^https?:\/\//i.test(described.url);
}

class Session {
  constructor({ userDataPath, log, enabled = true }) {
    this.log = log || (() => {});
    this.enabled = enabled !== false;
    this.store = new JsonStore(`${userDataPath}/session.json`, { tabs: [], activeId: null });
    // Re-keyed by a stable slot, not by the tab id: ids restart at 1 every launch,
    // so a tab's id in the previous run means nothing in this one.
    this.slots = new Map();
    // tab id in this run -> slot in the store, so a tab keeps its slot across
    // navigations and is found again after a reload.
    this.slotFor = new Map();
    this.activeSlot = null;
    this.nextSlot = 1;
    this.#load();
  }

  #load() {
    if (!this.enabled) return;
    const data = this.store.all();
    const tabs = Array.isArray(data.tabs) ? data.tabs : [];
    let slot = 0;
    for (const entry of tabs.slice(0, MAX_TABS)) {
      if (!restorable(entry)) continue;
      // The slot in the file is trusted, so the stored activeId still means what
      // it said it meant. A file without usable slot numbers gets sequential ones.
      const claimed = Number(entry.slot);
      slot = Number.isInteger(claimed) && claimed > 0 ? claimed : slot + 1;
      if (this.slots.has(slot)) slot += 1;
      this.slots.set(slot, {
        slot,
        url: entry.url,
        profile: typeof entry.profile === "string" ? entry.profile : null,
      });
    }
    this.nextSlot = this.slots.size
      ? Math.max(...this.slots.keys()) + 1
      : 1;
    const active = Number(data.activeId);
    // Checked against what actually loaded: a file naming a tab that is no longer
    // there would otherwise focus nothing, or worse, the wrong tab.
    this.activeSlot = Number.isInteger(active) && this.slots.has(active) ? active : null;
    if (this.nextSlot > 1) {
      this.log(`session: ${this.slots.size} tab(s) available to restore`);
    }
  }

  all() {
    return this.enabled
      ? Array.from(this.slots.values()).sort((a, b) => a.slot - b.slot)
      : [];
  }

  // Where a tab should be after a restart.
  restoredSlotFor(id) {
    if (!this.enabled) return null;
    return this.slotFor.get(id) || null;
  }

  // Binds a live tab to an existing slot, so a restored tab keeps its place and
  // its focus instead of being appended and re-keyed.
  claim(id, slot) {
    if (!this.enabled || !this.slots.has(slot)) return false;
    this.slotFor.set(id, slot);
    return true;
  }

  // Where the front tab was last time, or null if there was none.
  focusSlot() {
    return this.enabled ? this.activeSlot : null;
  }

  // Called after every create, so the store is written once per tab rather than
  // on a timer that has to be flushed before quit.
  record(described) {
    if (!this.enabled || !described) return;
    const slot = this.restoredSlotFor(described.id) || this.nextSlot;
    if (!this.slotFor.has(described.id)) {
      this.slotFor.set(described.id, slot);
      this.nextSlot = Math.max(this.nextSlot, slot + 1);
    }
    if (!restorable(described)) return;
    this.slots.set(slot, {
      slot,
      url: described.url,
      profile: described.profile || null,
    });
    this.#persist();
  }

  // Keeps the stored URL current. Called on commit rather than on every keystroke,
  // because the address bar can hold half-typed input that is not a page yet.
  navigate(described) {
    if (!this.enabled || !described) return;
    const slot = this.restoredSlotFor(described.id);
    if (slot === null) return;
    this.record(described);
  }

  forget(id) {
    const slot = this.restoredSlotFor(id);
    this.slotFor.delete(id);
    if (slot === null) return;
    this.slots.delete(slot);
    this.#persist();
  }

  setActive(id) {
    if (!this.enabled) return;
    const slot = this.restoredSlotFor(id);
    if (slot === null) return;
    if (this.activeSlot === slot) return;
    this.activeSlot = slot;
    this.#persist();
  }

  #persist() {
    this.store.set(
      "tabs",
      Array.from(this.slots.values()).sort((a, b) => a.slot - b.slot),
    );
    this.store.set("activeId", this.activeSlot);
  }

  clear() {
    this.slots.clear();
    this.slotFor.clear();
    this.activeSlot = null;
    this.nextSlot = 1;
    this.store.set("tabs", []);
    this.store.set("activeId", null);
  }
}

module.exports = { Session, restorable };