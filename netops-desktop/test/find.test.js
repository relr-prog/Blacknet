// Find in page: the decisions, not Electron.
//
// TabManager.find() hands Chromium the query and returns the request id; the
// match count is pushed back later on the found-in-page event, which the smoke
// test exercises against a real page. What is worth pinning here is how find()
// chooses the options, and that an empty query clears the highlight rather than
// searching for nothing.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { TabManager } = require("../src/main/tabs");

function stubTab({ url = "https://example.com/page" } = {}) {
  const calls = { finds: [], stops: 0 };
  let nextRequestId = 41;
  const wc = {
    getURL: () => url,
    isLoading: () => false,
    isAudioMuted: () => false,
    findInPage: (text, options) => {
      calls.finds.push({ text, options });
      return nextRequestId++;
    },
    stopFindInPage: (action) => {
      calls.stops += 1;
      calls.lastStopAction = action;
    },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on() {},
  };
  return { tab: { id: 1, profile: null, title: "Example", view: { webContents: wc } }, calls };
}

function managerWith(tab) {
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
  manager.tabs.set(tab.id, tab);
  manager.order = [tab.id];
  manager.activeId = tab.id;
  return manager;
}

test("find hands the query to the active page and defaults to forward", () => {
  const { tab, calls } = stubTab();
  const manager = managerWith(tab);

  const result = manager.find(1, "needle");

  assert.equal(calls.finds.length, 1);
  assert.equal(calls.finds[0].text, "needle");
  assert.equal(calls.finds[0].options.forward, true);
  // Chromium answers found-in-page only for a request that carries the options
  // it needs: sending findNext/matchCase as an explicit false returns a request
  // id but never a count. A plain search must therefore send just forward.
  assert.deepEqual(Object.keys(calls.finds[0].options), ["forward"]);
  assert.equal(result.requestId, 41);
  assert.equal(tab.findRequestId, 41, "the request id is kept so a stale count is dropped");
});

test("stepping through matches sets findNext, and backward is honoured", () => {
  const { tab, calls } = stubTab();
  const manager = managerWith(tab);

  manager.find(1, "needle", { forward: false, findNext: true });

  assert.equal(calls.finds[0].options.findNext, true);
  assert.equal(calls.finds[0].options.forward, false);
});

test("an empty query clears the selection instead of searching for nothing", () => {
  const { tab, calls } = stubTab();
  const manager = managerWith(tab);

  const result = manager.find(1, "");

  assert.equal(calls.finds.length, 0, "nothing is sent to the find engine");
  assert.equal(calls.stops, 1);
  assert.equal(calls.lastStopAction, "clearSelection");
  assert.equal(result.cleared, true);
  assert.equal(tab.findRequestId, null);
});

test("stopFind clears the highlight and is a no-op for a missing tab", () => {
  const { tab, calls } = stubTab();
  const manager = managerWith(tab);

  manager.stopFind(1);
  assert.equal(calls.stops, 1);
  assert.equal(calls.lastStopAction, "clearSelection");

  assert.equal(manager.stopFind(99), null);
});
