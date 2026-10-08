// A name this browser refuses, and what the tab is shown instead of it.
//
// Two things are being pinned down: the address is parsed to a host the same
// way no matter how it was written (a scheme, a port, a path, a stray uppercase
// letter must not change the decision), and the refusal happens so early that
// the shell's own resolver and URL policy never see the name at all. If either
// of those moves, the tab ends up on an error Chromium produced instead of the
// explanation the shell chose - or on a thrown refusal that closes the tab.
//
// The rule itself is main-process knowledge. The last test asserts that no
// module reachable from a renderer mentions it or the capability behind it.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const { onionHost } = require("../src/main/onion");
const { TabManager } = require("../src/main/tabs");

test("the host is read out of the address, whichever way it was written", () => {
  const host = "example.onion";
  assert.equal(onionHost(`http://${host}/`), host);
  assert.equal(onionHost(`https://${host}:8080/a/b?x=1#y`), host);
  assert.equal(onionHost(`//${host}`), host);
  assert.equal(onionHost(`${host}/page`), host);
  assert.equal(onionHost(`${host}:8080`), host);
  assert.equal(onionHost(`${host}.`), host); // the root dot is presentation
  assert.equal(onionHost(`HTTP://${host.toUpperCase()}/`), host);
  assert.equal(onionHost(`  ${host}  `), host);
});

test("credentials and paths are not part of the name", () => {
  // The host decides, so "example.onion@evil.test" is a visit to evil.test and
  // "evil.test/x.onion" is a path on evil.test - neither may be refused as if
  // it named the refused family.
  assert.equal(onionHost("http://user:pass@example.onion/"), "example.onion");
  assert.equal(onionHost("http://example.onion@evil.test/"), null);
  assert.equal(onionHost("http://evil.test/x.onion"), null);
  assert.equal(onionHost("http://evil.test/?x=example.onion"), null);
});

test("a name that only ends in the refused suffix does not match", () => {
  assert.equal(onionHost("http://example.onion.evil.test/"), null);
  assert.equal(onionHost("notonion"), null);
  assert.equal(onionHost(".onion"), null);
  assert.equal(onionHost("http://example.com/"), null);
  assert.equal(onionHost("file:///etc/passwd"), null);
  assert.equal(onionHost(""), null);
  assert.equal(onionHost(null), null);
  assert.equal(onionHost(42), null);
});

// Just enough of a tab for navigate(). webContents is the only part that
// behaves like an object with state, and loadFile is recorded because the whole
// point of the refusal is which file ends up painted.
function stubTab(url = "https://example.com/") {
  const calls = { loaded: [], files: [] };
  let current = url;
  const wc = {
    getURL: () => current,
    isLoading: () => false,
    isAudioMuted: () => false,
    isDestroyed: () => false,
    loadURL: (target) => {
      calls.loaded.push(target);
      current = target;
      return Promise.resolve();
    },
    loadFile: (file, options) => {
      calls.files.push({ file, options });
      current = `file://${file}`;
      return Promise.resolve();
    },
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    session: { on() {}, setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    on() {},
  };
  return {
    tab: {
      id: 1,
      profile: null,
      title: "Example",
      pendingUrl: current,
      view: { webContents: wc },
    },
    calls,
  };
}

function managerWith(tab, overrides = {}) {
  const asked = [];
  const manager = new TabManager({
    window: null,
    native: {
      // Asked only by the URL policy. A refused name must never get here, so
      // the stub records it and refuses the name outright: a test that passes
      // with this in place proves the check runs before the policy, not after.
      resolve: (input) => {
        asked.push(input);
        if (onionHost(input)) throw new Error("the refused name reached the resolver");
        return { url: input, host: new URL(input).hostname };
      },
      validateHost: () => ({ ok: true }),
      shouldBlockRequest: () => false,
      verdictFor: () => ({ pattern: "test", source: "test" }),
    },
    config: { newTabUrl: "about:blank", searchUrl: null, defaultPermissions: [] },
    log: () => {},
    ...overrides,
  });
  manager.tabs.set(tab.id, tab);
  manager.order = [tab.id];
  manager.activeId = tab.id;
  return { manager, asked };
}

test("a refused name opens the explanation instead of throwing", () => {
  const { tab, calls } = stubTab();
  const { manager, asked } = managerWith(tab);

  const described = manager.navigate(tab.id, "http://example.onion/path");
  assert.equal(described.url, "http://example.onion/path");
  assert.equal(tab.blockedUrl, "http://example.onion/path");
  assert.equal(tab.title, "example.onion");
  assert.equal(calls.loaded.length, 0, "nothing was sent to the network");

  assert.equal(calls.files.length, 1);
  assert.match(calls.files[0].file, /unreachable\.html$/);
  assert.equal(calls.files[0].options.query.url, "http://example.onion/path");
  // The policy never saw the name: no resolver call, no verdict, no socket.
  assert.deepEqual(asked, []);
});

test("the address bar keeps the refused name, not the page explaining it", () => {
  const { tab } = stubTab();
  const { manager } = managerWith(tab);
  manager.navigate(tab.id, "http://example.onion/");
  // loadFile has committed the explanation, so wc.getURL() is the file: URL
  // of the page - which is exactly what must not be shown as the address.
  assert.equal(manager.describe(tab).url, "http://example.onion/");
  assert.equal(manager.active().url, "http://example.onion/");
});

test("the refused name is what the session file would reopen", () => {
  const { tab } = stubTab();
  const { manager } = managerWith(tab);
  const written = [];
  manager.sessionStore = { navigate: (described) => written.push(described) };

  manager.navigate(tab.id, "http://example.onion/");
  assert.equal(written.length, 1);
  assert.equal(written[0].url, "http://example.onion/");
});

test("a name that is not refused still goes through the policy", () => {
  const { tab, calls } = stubTab();
  const { manager, asked } = managerWith(tab);

  manager.navigate(tab.id, "http://example.com/page");
  // The policy asks once for its verdict and once to normalise the URL; the
  // only thing that matters here is that the name went to the resolver at all.
  assert.deepEqual([...new Set(asked)], ["http://example.com/page"]);
  assert.deepEqual(calls.loaded, ["http://example.com/page"]);
  assert.equal(tab.blockedUrl, undefined);
  assert.equal(calls.files.length, 0);
});

test("the rule and the capability behind it never reach a renderer", () => {
  // The refusal lives in main-process code and the shell's own client for that
  // address lives beside it. Neither may appear in the action map, in the
  // window's IPC registrations, or in a preload - a renderer that can name the
  // rule can also ask for the capability that answers it.
  const sources = ["actions.js", "main.js"].map((name) =>
    path.join(__dirname, "..", "src", "main", name),
  );
  sources.push(path.join(__dirname, "..", "src", "preload", "preload.js"));
  sources.push(path.join(__dirname, "..", "src", "preload", "password-hook.js"));

  for (const file of sources) {
    const text = fs.readFileSync(file, "utf8");
    assert.ok(!/\bonion\b/i.test(text), `${path.basename(file)} names the rule`);
    assert.ok(!/\bcircuit\b/i.test(text), `${path.basename(file)} names the capability`);
    assert.ok(!/require\(["']\.\/(onion|circuit)["']\)/.test(text), `${file} loads it`);
  }
});
