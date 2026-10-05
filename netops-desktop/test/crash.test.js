// What happens after a tab's renderer goes away.
//
// The failure being tested is a loop the operator cannot get out of: the crash
// page is what the tab is showing, so reloading reloads the crash page, and the
// page tells them to reload. Both halves of that are correct on their own and
// useless together, so the URL has to be kept and Reload has to mean "go back to
// the page".
//
// TabManager needs Electron to build a real view, so these exercise the methods
// against a stub view. That is the honest unit under test: the decisions, not
// Electron.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { TabManager } = require("../src/main/tabs");

// Just enough of a tab for the code paths below. webContents is the only part
// that behaves like an object with state.
function stubTab({ url = "https://example.com/page", crashed = false, crashedUrl = null } = {}) {
  const calls = { reloads: 0, loaded: [] };
  const wc = {
    getURL: () => url,
    isLoading: () => false,
    isAudioMuted: () => false,
    reloadIgnoringCache: () => {
      calls.reloads += 1;
    },
    loadURL: (target) => {
      calls.loaded.push(target);
      url = target;
      return Promise.resolve();
    },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    session: { on() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    on() {},
  };
  return {
    tab: { id: 1, profile: null, title: "Example", pendingUrl: url, crashed, crashedUrl, view: { webContents: wc } },
    calls,
  };
}

// A real TabManager with one stubbed tab. The instance matters: navigate() calls
// the private URL policy check, and a plain object literal cannot satisfy that.
function managerWith(tab) {
  const manager = new TabManager({
    window: null,
    native: {
      // The native resolver hands back the normalised URL and the host the URL
      // policy reads; the stub does the same so navigate() takes its real path.
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

test("reloading a crashed tab goes back to the page it was on", () => {
  const { tab, calls } = stubTab({ url: "https://example.com/page" });
  tab.crashed = true;
  tab.crashedUrl = "https://example.com/page";
  const manager = managerWith(tab);

  manager.reload(1);

  assert.equal(calls.reloads, 0, "reloading the crash page is the loop being avoided");
  assert.deepEqual(calls.loaded, ["https://example.com/page"]);
  assert.equal(tab.crashed, false, "and the tab is no longer marked crashed");
});

test("a crashed tab with no remembered URL still reloads instead of hanging", () => {
  const { tab, calls } = stubTab({ url: "file:///crashed.html" });
  tab.crashed = true;
  tab.crashedUrl = null;
  const manager = managerWith(tab);

  manager.reload(1);

  assert.equal(calls.reloads, 1, "with nothing to go back to, a reload is the best left");
  assert.equal(tab.crashed, false);
});

test("a healthy tab reloads normally", () => {
  const { tab, calls } = stubTab();
  const manager = managerWith(tab);

  manager.reload(1, true);

  assert.equal(calls.reloads, 1);
  assert.deepEqual(calls.loaded, [], "no navigation is invented for a tab that did not crash");
});

test("reload is a no-op for a tab that is not there", () => {
  const { tab } = stubTab();
  const manager = managerWith(tab);
  assert.equal(manager.reload(99), null);
});

test("describe marks a crashed tab, so the chrome can say so", () => {
  const { tab } = stubTab();
  const manager = managerWith(tab);

  tab.crashed = true;
  assert.equal(manager.describe(tab).crashed, true);
  tab.crashed = false;
  assert.equal(manager.describe(tab).crashed, false);
});