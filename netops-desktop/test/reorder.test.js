// Tab drag reorder: the only way the tab order changes outside create/close.
// The strip hands the main process a full left-to-right list of ids, so the
// store must reject anything that is not the same set in a new order - a renderer
// working from a stale view must not be allowed to drop or duplicate a tab. The
// session store re-keys its slots so a restart restores the dragged order.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { TabManager } = require("../src/main/tabs");
const { Session } = require("../src/main/session");

function stubTab(id, url) {
  const state = { url };
  const wc = {
    getURL: () => state.url,
    isDestroyed: () => false,
    isLoading: () => false,
    isAudioMuted: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on() {},
  };
  return { tab: { id, profile: null, title: "t", pendingUrl: url, view: { webContents: wc } }, state };
}

function managerWith(tabs) {
  const manager = new TabManager({
    window: null,
    native: {
      resolve: (input) => ({ url: input, host: new URL(input).hostname }),
      validateHost: () => ({ ok: true }),
      shouldBlockRequest: () => false,
    },
    config: { newTabUrl: "about:blank", searchUrl: null, defaultPermissions: [] },
    log: () => {},
  });
  for (const entry of tabs) {
    manager.tabs.set(entry.tab.id, entry.tab);
    manager.order.push(entry.tab.id);
  }
  manager.activeId = tabs[0].tab.id;
  return manager;
}

test("reorder permutes the tab list and leaves the active tab alone", () => {
  const manager = managerWith([stubTab(1, "https://a.example/"), stubTab(2, "https://b.example/"), stubTab(3, "https://c.example/")]);
  manager.reorder([3, 1, 2]);
  assert.deepEqual(
    manager.list().map((tab) => tab.id),
    [3, 1, 2],
  );
  assert.equal(manager.activeId, 1, "dragging must not change the front tab");
});

test("reorder rejects a list that does not name every tab", () => {
  const manager = managerWith([stubTab(1, "https://a.example/"), stubTab(2, "https://b.example/")]);
  assert.throws(() => manager.reorder([1]), /permutation/);
  assert.throws(() => manager.reorder([1, 3]), /permutation/);
  assert.throws(() => manager.reorder([1, 1]), /permutation/);
  assert.throws(() => manager.reorder("1,2"), /full tab list/);
});

test("a rejected reorder changes nothing", () => {
  const manager = managerWith([stubTab(1, "https://a.example/"), stubTab(2, "https://b.example/")]);
  assert.throws(() => manager.reorder([1]));
  assert.deepEqual(
    manager.list().map((tab) => tab.id),
    [1, 2],
  );
});

test("reorder re-keys session slots so restart follows the dragged order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-session-"));
  const session = new Session({ userDataPath: dir, enabled: true });
  session.record({ id: 1, url: "https://one.example/" });
  session.record({ id: 2, url: "https://two.example/" });
  session.record({ id: 3, url: "https://three.example/" });
  session.setActive(2);

  session.reorder([3, 2, 1]);

  assert.deepEqual(
    session.all().map((entry) => entry.url),
    ["https://three.example/", "https://two.example/", "https://one.example/"],
  );
  assert.deepEqual(
    session.all().map((entry) => entry.slot),
    [1, 2, 3],
    "slots are re-sequenced with the new order, so a later sort-by-slot cannot revert it",
  );
  assert.equal(session.focusSlot(), 2, "the front tab keeps its place");

  const reopened = new Session({ userDataPath: dir, enabled: true });
  assert.deepEqual(
    reopened.all().map((entry) => entry.url),
    ["https://three.example/", "https://two.example/", "https://one.example/"],
  );
  assert.equal(reopened.focusSlot(), 2);
});

test("reorder drops nothing and duplicates nothing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-session-"));
  const session = new Session({ userDataPath: dir, enabled: true });
  session.record({ id: 1, url: "https://one.example/" });
  session.record({ id: 2, url: "https://two.example/" });
  session.record({ id: 3, url: "https://three.example/" });
  session.reorder([3, 1, 2]);
  assert.equal(session.all().length, 3, "every restorable tab survives");
  // Reordering again works from the new mapping.
  session.reorder([2, 3, 1]);
  assert.deepEqual(
    session.all().map((entry) => entry.url),
    ["https://two.example/", "https://three.example/", "https://one.example/"],
  );
});