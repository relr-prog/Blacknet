// Per-site zoom: what a site remembers, how the ladder steps, and that a
// restart brings the sizes back. The store is the promise.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Zoom, originOf, snap, LEVELS, DEFAULT } = require("../src/main/zoom");
const { TabManager } = require("../src/main/tabs");

function tempZoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-zoom-"));
  return { dir, zoom: new Zoom({ userDataPath: dir }) };
}

test("only http(s) has an origin worth remembering", () => {
  assert.equal(originOf("https://example.com/a?b=1"), "https://example.com");
  assert.equal(originOf("http://news.example.com:8080/x"), "http://news.example.com:8080");
  assert.equal(originOf("file:///etc/passwd"), null);
  assert.equal(originOf("data:text/html,hi"), null);
  assert.equal(originOf("about:blank"), null);
  assert.equal(originOf("javascript:alert(1)"), null);
  assert.equal(originOf(""), null);
  assert.equal(originOf(null), null);
});

test("a fresh site is 100%", () => {
  const { zoom } = tempZoom();
  assert.equal(zoom.factorFor("https://example.com"), DEFAULT);
  assert.equal(zoom.factorFor(null), DEFAULT);
});

test("the ladder steps one rung and reverses", () => {
  const { zoom } = tempZoom();
  const origin = "https://example.com";
  // In from 100%, then back down the same rungs.
  assert.equal(zoom.next(origin, "in"), 1.1);
  assert.equal(zoom.next(origin, "in"), 1.1, "not stored yet, so still from 100%");
  zoom.set(origin, 1.1);
  assert.equal(zoom.next(origin, "in"), 1.25);
  assert.equal(zoom.next(origin, "out"), 1);
  assert.equal(zoom.next(origin, "reset"), DEFAULT);
});

test("the ladder clamps at both ends", () => {
  const { zoom } = tempZoom();
  const origin = "https://example.com";
  zoom.set(origin, LEVELS[0]);
  assert.equal(zoom.next(origin, "out"), LEVELS[0]);
  zoom.set(origin, LEVELS[LEVELS.length - 1]);
  assert.equal(zoom.next(origin, "in"), LEVELS[LEVELS.length - 1]);
});

test("reset forgets the site instead of storing 100%", () => {
  const { zoom } = tempZoom();
  const origin = "https://example.com";
  zoom.set(origin, 1.5);
  assert.equal(zoom.factorFor(origin), 1.5);
  assert.equal(zoom.set(origin, 1), DEFAULT);
  assert.equal(zoom.factorFor(origin), DEFAULT);
  assert.equal(Object.prototype.hasOwnProperty.call(zoom.sites, origin), false);
});

test("an off-ladder or hand-edited value snaps to the nearest rung", () => {
  assert.equal(snap(1.037), 1);
  assert.equal(snap(1.6), 1.5);
  assert.equal(snap("2"), 2);
  assert.equal(snap("nonsense"), DEFAULT);
  const { zoom } = tempZoom();
  assert.equal(zoom.set("https://example.com", 1.6), 1.5);
});

test("a site's factor survives a restart", () => {
  const { dir, zoom } = tempZoom();
  zoom.set("https://a.example", 1.25);
  zoom.set("https://b.example", 0.75);
  const reopened = new Zoom({ userDataPath: dir });
  assert.equal(reopened.factorFor("https://a.example"), 1.25);
  assert.equal(reopened.factorFor("https://b.example"), 0.75);
});

test("a corrupt file is quarantined and the store stays usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-zoom-"));
  fs.writeFileSync(path.join(dir, "zoom.json"), "{ not json");
  const zoom = new Zoom({ userDataPath: dir });
  assert.equal(zoom.factorFor("https://example.com"), DEFAULT);
  zoom.set("https://example.com", 1.5);
  assert.equal(zoom.factorFor("https://example.com"), 1.5);
});

test("clear forgets every site", () => {
  const { zoom } = tempZoom();
  zoom.set("https://a.example", 1.25);
  zoom.set("https://b.example", 0.75);
  zoom.clear();
  assert.equal(zoom.factorFor("https://a.example"), DEFAULT);
  assert.equal(zoom.factorFor("https://b.example"), DEFAULT);
});

// --- TabManager integration: which tabs move, and what is remembered --------

function stubZoomTab(id, url) {
  const state = { url, factor: 1 };
  const wc = {
    getURL: () => state.url,
    isDestroyed: () => false,
    isLoading: () => false,
    isAudioMuted: () => false,
    getZoomFactor: () => state.factor,
    setZoomFactor: (value) => {
      state.factor = value;
    },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    on() {},
  };
  return { tab: { id, profile: null, title: "t", pendingUrl: url, view: { webContents: wc } }, state };
}

function managerWith(zoom, tabs) {
  const manager = new TabManager({
    window: null,
    native: {
      resolve: (input) => ({ url: input, host: new URL(input).hostname }),
      validateHost: () => ({ ok: true }),
      shouldBlockRequest: () => false,
    },
    config: { newTabUrl: "about:blank", searchUrl: null, defaultPermissions: [] },
    log: () => {},
    zoom,
  });
  for (const entry of tabs) {
    manager.tabs.set(entry.tab.id, entry.tab);
    manager.order.push(entry.tab.id);
  }
  manager.activeId = tabs[0].tab.id;
  return manager;
}

test("zooming a site moves every tab on it and remembers the factor", () => {
  const { zoom } = tempZoom();
  const a = stubZoomTab(1, "https://example.com/a");
  const b = stubZoomTab(2, "https://example.com/b");
  const c = stubZoomTab(3, "https://other.example/");
  const manager = managerWith(zoom, [a, b, c]);

  const result = manager.zoom(1, "in");

  assert.equal(result.origin, "https://example.com");
  assert.equal(result.factor, 1.1);
  assert.equal(result.percent, 110);
  assert.equal(result.applied, 2, "both tabs on the site move together");
  assert.equal(a.state.factor, 1.1);
  assert.equal(b.state.factor, 1.1);
  assert.equal(c.state.factor, 1, "another site is left alone");
  assert.equal(zoom.factorFor("https://example.com"), 1.1);
});

test("zooming out from 100% steps to the next rung down", () => {
  const { zoom } = tempZoom();
  const a = stubZoomTab(1, "https://example.com/");
  const manager = managerWith(zoom, [a]);

  const result = manager.zoom(1, "out");
  const expected = LEVELS[LEVELS.indexOf(DEFAULT) - 1];
  assert.equal(result.factor, expected);
  assert.equal(result.percent, Math.round(expected * 100));
});

test("reset returns the site to 100% and forgets it", () => {
  const { zoom } = tempZoom();
  const a = stubZoomTab(1, "https://example.com/");
  const manager = managerWith(zoom, [a]);
  manager.zoom(1, "in");
  manager.zoom(1, "in");

  const result = manager.zoom(1, "reset");
  assert.equal(result.factor, 1);
  assert.equal(result.percent, 100);
  assert.equal(a.state.factor, 1);
  assert.equal(zoom.factorFor("https://example.com"), 1);
});

test("a page with no origin is left at 100%", () => {
  const { zoom } = tempZoom();
  const a = stubZoomTab(1, "data:text/html,hi");
  const manager = managerWith(zoom, [a]);

  const result = manager.zoom(1, "in");
  assert.equal(result.origin, null);
  assert.equal(result.factor, 1);
  assert.equal(result.applied, 0);
  assert.equal(a.state.factor, 1);
});

