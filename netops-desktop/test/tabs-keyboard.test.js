// The tab-switcher's ring: Ctrl+Tab walks right, Ctrl+Shift+Tab walks left, and
// walking off either end wraps instead of stopping or erroring. The chrome and
// the main process both answer the same shortcuts, and both land on this one
// method, so the wrapping rule has exactly one implementation to test.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { TabManager } = require("../src/main/tabs");

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
  return manager;
}

function stubTab(id) {
  const wc = {
    getURL: () => "about:blank",
    isDestroyed: () => false,
    isLoading: () => false,
    isAudioMuted: () => false,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on() {},
  };
  return { tab: { id, profile: null, title: "t", pendingUrl: "about:blank", view: { webContents: wc } } };
}

function withActive(manager, id) {
  manager.activeId = id;
  return manager;
}

test("Ctrl+Tab walks right and wraps off the end", () => {
  const manager = withActive(managerWith([stubTab(1), stubTab(2), stubTab(3)]), 1);
  assert.equal(manager.cycleTab(1), 2);
  assert.equal(manager.cycleTab(1), 3);
  assert.equal(manager.cycleTab(1), 1, "the ring wraps back to the front");
});

test("Ctrl+Shift+Tab walks left and wraps off the front", () => {
  const manager = withActive(managerWith([stubTab(1), stubTab(2), stubTab(3)]), 1);
  assert.equal(manager.cycleTab(-1), 3, "backwards from the first tab wraps to the last");
  assert.equal(manager.cycleTab(-1), 2);
  assert.equal(manager.cycleTab(-1), 1);
});

test("cycling with one tab goes nowhere", () => {
  const manager = withActive(managerWith([stubTab(1)]), 1);
  assert.equal(manager.cycleTab(1), 1);
  assert.equal(manager.cycleTab(-1), 1);
});

test("a cycle whose active tab vanished still activates the next one", () => {
  const manager = managerWith([stubTab(1), stubTab(2), stubTab(3)]);
  manager.activeId = 99; // closed underneath the switcher, never in the order
  assert.equal(manager.cycleTab(1), 2);
});