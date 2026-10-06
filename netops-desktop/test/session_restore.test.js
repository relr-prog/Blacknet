// Session restore's own defect, and it compounds.
//
// restore() opened a tab with create(), and create() records the tab as a brand
// new session entry before restore() claimed it back onto the slot it came from.
// So every launch appended one entry per tab on top of the entries that were
// already there: 2 tabs stayed 2 after one launch, then became 4, then 8. The
// file doubled each restart and the tab strip filled with copies.
//
// create() itself needs Electron to build a real view, so these stub it - but
// the stub records exactly as the real method does when asked to, so the call
// sequence under test is restore()'s. What is asserted is the on-disk session
// file, because that is the artefact that was growing.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Session } = require("../src/main/session");
const { TabManager } = require("../src/main/tabs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-restore-"));
}

function seed(dir, entries, activeId = 1) {
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({ tabs: entries, activeId }, null, 2),
  );
}

function read(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "session.json"), "utf8"));
}

function manager() {
  const mgr = new TabManager({
    window: null,
    native: {
      resolve: (input) => ({ url: input, host: new URL(input).hostname }),
      validateHost: () => ({ ok: true }),
      shouldBlockRequest: () => false,
    },
    config: { newTabUrl: "about:blank", searchUrl: null, defaultPermissions: [] },
    log: () => {},
  });

  let nextId = 100;
  const seen = [];
  // describe() reads through view.webContents, and activate() ends up calling
  // it, so a stub tab has to be complete enough for the real describe() to run
  // rather than throwing before any assertion gets a chance to fail.
  const stubTab = (id, url) => ({
    id,
    profile: "default",
    title: "t",
    pendingUrl: url,
    view: {
      webContents: {
        getURL: () => url,
        isLoading: () => false,
        isAudioMuted: () => false,
        navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        on() {},
        session: { on() {} },
      },
    },
  });
  // Stands in for create(): same contract, including recording the tab as a new
  // session entry unless it is told not to. That is the part that decides
  // whether the file grows, so it has to be faithful rather than a no-op.
  mgr.create = ({ profile, url, record = true } = {}) => {
    if (url && url.includes("blocked.example")) throw new Error("not allowed");
    const id = nextId;
    nextId += 1;
    const described = { id, profile, url, title: "t" };
    mgr.tabs.set(id, stubTab(id, url));
    mgr.order.push(id);
    if (record && mgr.sessionStore) mgr.sessionStore.record(described);
    seen.push(described);
    return described;
  };
  mgr.seen = seen;
  return mgr;
}

// --- one launch over a seeded file ------------------------------------------

function launch(dir) {
  const session = new Session({ userDataPath: dir, log: () => {}, enabled: true });
  const mgr = manager();
  mgr.sessionStore = session;
  const result = mgr.restore();
  return { session, mgr, result };
}

// --- the file must not grow --------------------------------------------------

test("restore does not append the tabs it is reopening", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://example.com/two", profile: "default" },
  ]);

  const { result, session } = launch(dir);
  assert.equal(result.opened, 2, "both entries reopen");
  assert.equal(result.skipped, 0, "nothing skipped");
  assert.equal(session.all().length, 2, "in-memory slot map stays at 2");
  assert.equal(read(dir).tabs.length, 2, "session file stays at 2");
});

test("the session file survives three consecutive launches unchanged", () => {
  const dir = tempDir();
  const entries = [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://example.com/two", profile: "default" },
  ];
  seed(dir, entries);

  launch(dir);
  const after1 = read(dir).tabs.length;
  launch(dir);
  const after2 = read(dir).tabs.length;
  launch(dir);
  const after3 = read(dir).tabs.length;

  assert.equal(after1, 2, "first launch");
  assert.equal(after2, 2, "second launch");
  assert.equal(after3, 2, "third launch");
});

test("restored tabs land back on their original slots", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://example.com/two", profile: "default" },
  ]);

  const { session, mgr } = launch(dir);
  const slots = mgr.order.map((id) => session.restoredSlotFor(id));
  assert.deepEqual(slots, [1, 2], "one tab per original slot, in order");
});

test("the tab that was in front is focused again", () => {
  const dir = tempDir();
  seed(
    dir,
    [
      { slot: 1, url: "https://example.com/one", profile: "default" },
      { slot: 2, url: "https://example.com/two", profile: "default" },
    ],
    2,
  );

  const { session, mgr } = launch(dir);
  const front = mgr.order.find((id) => session.restoredSlotFor(id) === 2);
  assert.equal(mgr.activeId, front, "slot 2 is active again");
  assert.equal(session.focusSlot(), 2, "the stored focus slot is unchanged");
});

// --- partial failures --------------------------------------------------------

test("a refused entry is skipped and stays in the file for next time", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://blocked.example/two", profile: "default" },
  ]);

  const { result, session } = launch(dir);
  assert.equal(result.opened, 1, "the healthy entry still opens");
  assert.equal(result.skipped, 1, "the refused one is counted");
  const stored = session.all().map((entry) => entry.url);
  assert.deepEqual(
    stored,
    ["https://example.com/one", "https://blocked.example/two"],
    "the refused entry is kept so a temporary policy does not erase a tab",
  );
  assert.equal(read(dir).tabs.length, 2, "file still has both entries");
});

test("every entry refused still leaves the file as it was", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://blocked.example/one", profile: "default" },
    { slot: 2, url: "https://blocked.example/two", profile: "default" },
  ]);

  const { result } = launch(dir);
  assert.equal(result.opened, 0, "nothing opened");
  assert.equal(result.skipped, 2, "both counted as skipped");
  assert.equal(read(dir).tabs.length, 2, "file unchanged");
});

// --- slot gone missing -------------------------------------------------------

test("a tab the store refuses to rebind is appended, not dropped", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://example.com/two", profile: "default" },
  ]);

  const session = new Session({ userDataPath: dir, log: () => {}, enabled: true });
  const mgr = manager();
  mgr.sessionStore = session;
  // claim() only fails when the slot is really gone, so the slot is removed
  // between all() and claim() rather than stubbing claim to lie: a tab that is
  // open now must be kept. Losing it because bookkeeping lost a race would be
  // worse than carrying an extra entry.
  const realAll = session.all.bind(session);
  let taken = false;
  session.all = () => {
    const entries = realAll();
    if (!taken) {
      taken = true;
      session.slots.delete(1);
    }
    return entries;
  };

  mgr.restore();

  const stored = session.all().map((entry) => entry.url);
  assert.ok(
    stored.includes("https://example.com/one"),
    `the open tab stayed in the session: ${JSON.stringify(stored)}`,
  );
  assert.equal(read(dir).tabs.length, 2, "one entry per restored tab, not more");
});

// --- the feature being off ---------------------------------------------------

test("with the feature off, restore opens nothing and writes nothing", () => {
  const dir = tempDir();
  seed(dir, [
    { slot: 1, url: "https://example.com/one", profile: "default" },
    { slot: 2, url: "https://example.com/two", profile: "default" },
  ]);
  const before = fs.readFileSync(path.join(dir, "session.json"), "utf8");

  const session = new Session({ userDataPath: dir, log: () => {}, enabled: false });
  const mgr = manager();
  mgr.sessionStore = session;
  const result = mgr.restore();

  assert.equal(result.opened, 0, "restoreSession off means no restore");
  assert.equal(
    fs.readFileSync(path.join(dir, "session.json"), "utf8"),
    before,
    "the file is untouched",
  );
});