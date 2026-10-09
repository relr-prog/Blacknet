"use strict";

// New Identity and clear-on-exit both come down to two operations on TabManager:
// wipe every profile that could have written to disk, and (for New Identity)
// close every tab first. #createTab needs a real WebContentsView, so the tab
// manager is driven here with a fake session resolver and fake webContents - the
// reset/clear logic is the part that carries the privacy promise and is what
// these tests pin.

const test = require("node:test");
const assert = require("node:assert");

const { TabManager } = require("../src/main/tabs");

function sessionCalls(calls, profile) {
  return {
    async clearStorageData() {
      calls.push(`${profile}:storage`);
    },
    async clearCache() {
      calls.push(`${profile}:cache`);
    },
    async clearAuthCache() {
      calls.push(`${profile}:auth`);
    },
  };
}

function makeManager(sessionFromPartition) {
  const calls = [];
  const sessions = new Map();
  const manager = new TabManager({
    window: null,
    native: {},
    config: { defaultProfile: "default", newTabUrl: "about:blank", maxTabs: 12 },
    log: () => {},
    send: null,
    sessionFromPartition:
      sessionFromPartition ||
      ((profile) => {
        if (!sessions.has(profile)) sessions.set(profile, sessionCalls(calls, profile));
        return sessions.get(profile);
      }),
  });
  return { manager, calls, sessions };
}

function addTab(manager, id, profile) {
  const webContents = {
    id,
    closed: false,
    destroyed: false,
    close() {
      this.closed = true;
    },
    isDestroyed() {
      return this.destroyed;
    },
    destroy() {
      this.destroyed = true;
    },
    getURL() {
      return "about:blank";
    },
    isLoading() {
      return false;
    },
    isAudioMuted() {
      return false;
    },
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
    },
  };
  const tab = { id, profile, view: { webContents } };
  manager.tabs.set(id, tab);
  manager.order.push(id);
  if (manager.activeId === null) manager.activeId = id;
  return tab;
}

test("reset discards every tab and wipes every profile in use", async () => {
  const { manager, calls, sessions } = makeManager();
  const forgotten = [];
  let cleared = 0;
  manager.sessionStore = {
    forget: (id) => forgotten.push(id),
    clear: () => {
      cleared += 1;
    },
  };
  addTab(manager, 1, "default");
  addTab(manager, 2, "work");
  addTab(manager, 3, "default");

  const report = await manager.reset();

  assert.deepEqual(report, { profiles: ["default", "work"], cleared: true });
  assert.equal(manager.tabs.size, 0, "every tab is gone");
  assert.deepEqual(manager.order, []);
  assert.equal(manager.activeId, null);
  assert.deepEqual(forgotten.sort(), [1, 2, 3], "each slot is forgotten");
  assert.equal(cleared, 1, "and the saved session is cleared once");
  for (const profile of ["default", "work"]) {
    assert.ok(calls.includes(`${profile}:storage`), `${profile} storage`);
    assert.ok(calls.includes(`${profile}:cache`), `${profile} cache`);
    assert.ok(calls.includes(`${profile}:auth`), `${profile} auth`);
  }
  assert.equal(sessions.size, 2, "one session per profile, not one per tab");
});

test("clearAllData wipes the profiles but leaves the tabs alone", async () => {
  const { manager, calls } = makeManager();
  const tab = addTab(manager, 1, "work");

  const report = await manager.clearAllData();

  assert.deepEqual(report, { profiles: ["default", "work"], cleared: true });
  assert.equal(manager.tabs.size, 1, "the strip is untouched");
  assert.equal(tab.view.webContents.closed, false);
  assert.ok(calls.includes("default:storage"));
  assert.ok(calls.includes("work:cache"));
});

test("the default profile is wiped even when no tab is open", async () => {
  const { manager, calls } = makeManager();

  const report = await manager.clearAllData();

  assert.deepEqual(report.profiles, ["default"]);
  assert.ok(calls.includes("default:storage"), "a fresh tab would land in this partition");
});

test("a profile that cannot be resolved does not abort the others", async () => {
  const calls = [];
  const { manager } = makeManager((profile) => {
    if (profile === "default") throw new Error("no such partition");
    return sessionCalls(calls, profile);
  });
  addTab(manager, 1, "work");

  const report = await manager.clearAllData();

  assert.deepEqual(report.profiles, ["default", "work"]);
  assert.ok(calls.includes("work:storage"), "the reachable profile still clears");
});
