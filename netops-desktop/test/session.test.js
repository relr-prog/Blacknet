// Session restore: the tabs that were open should still be open.
//
// What is worth testing here is not "does JSON round trip" - it is the
// decisions around it. Which entries are worth restoring, what happens to a
// session file that has been tampered with or truncated, and whether turning the
// feature off actually stops the record from growing. The failure modes that
// matter are the ones where a browser quietly forgets or quietly invents.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Session, restorable } = require("../src/main/session");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-session-"));
}

function page(url, profile = null) {
  return { id: Math.floor(Math.random() * 1e6), url, profile, title: "t" };
}

// --- what is worth restoring -------------------------------------------------

test("only real web pages are restorable", () => {
  assert.equal(restorable({ url: "https://example.com/" }), true);
  assert.equal(restorable({ url: "http://example.com/x?y=1" }), true);
  // Internal shell pages are reopened by name, not by file path, and the
  // non-http schemes have no meaning once the process that owned them is gone.
  assert.equal(restorable({ url: "about:blank" }), false);
  assert.equal(restorable({ url: "chrome://version" }), false);
  assert.equal(restorable({ url: "file:///etc/passwd" }), false);
  assert.equal(restorable({ url: "" }), false);
  assert.equal(restorable({ url: 42 }), false);
  assert.equal(restorable(null), false);
});

// --- round trip --------------------------------------------------------------

test("tabs recorded in one run are offered in the next", () => {
  const dir = tempDir();
  const first = new Session({ userDataPath: dir, log: () => {} });
  const one = page("https://one.example/");
  const two = page("https://two.example/", "work");
  first.record(one);
  first.record(two);
  first.setActive(two.id);

  const second = new Session({ userDataPath: dir, log: () => {} });
  const tabs = second.all();
  assert.equal(tabs.length, 2);
  assert.equal(tabs[0].url, "https://one.example/");
  assert.equal(tabs[1].profile, "work", "the profile a tab was on has to come back too");
  assert.equal(second.focusSlot(), first.restoredSlotFor(two.id));
  assert.notEqual(
    second.focusSlot(),
    first.restoredSlotFor(one.id),
    "the tab that was in front comes back in front",
  );
});

test("a tab keeps its slot across navigations instead of growing the session", () => {
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  const tab = page("https://one.example/");
  session.record(tab);
  session.navigate({ ...tab, url: "https://one.example/final" });

  assert.equal(session.all().length, 1, "navigating is not opening a tab");
  assert.equal(session.all()[0].url, "https://one.example/final");
});

test("navigate does not record a tab it has never seen", () => {
  // Otherwise the first address-bar load of a restored run would append a slot
  // next to the one that was just restored for it.
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  session.navigate(page("https://ghost.example/"));
  assert.equal(session.all().length, 0);
});

test("closing a tab drops it from the next run", () => {
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  session.record(page("https://keep.example/"));
  const gone = page("https://gone.example/");
  session.record(gone);
  session.forget(gone.id);

  const next = new Session({ userDataPath: dir, log: () => {} });
  assert.deepEqual(next.all().map((entry) => entry.url), ["https://keep.example/"]);
});

test("a claimed slot is reused rather than appended", () => {
  const dir = tempDir();
  const first = new Session({ userDataPath: dir, log: () => {} });
  const entry = first.all();
  assert.equal(entry.length, 0);

  const writer = new Session({ userDataPath: dir, log: () => {} });
  const original = page("https://a.example/");
  writer.record(original);
  const slot = writer.restoredSlotFor(original.id);

  const reader = new Session({ userDataPath: dir, log: () => {} });
  const restored = page("https://a.example/");
  assert.equal(reader.claim(restored.id, slot), true);
  reader.record(restored);
  assert.equal(reader.all().length, 1, "a restored tab must not also be appended");
  assert.equal(reader.restoredSlotFor(restored.id), slot);
});

test("claiming a slot that is not there is refused, not invented", () => {
  const session = new Session({ userDataPath: tempDir(), log: () => {} });
  assert.equal(session.claim(1, 99), false);
  assert.equal(session.restoredSlotFor(1), null);
});

// --- opt out -----------------------------------------------------------------

test("restoreSession off records nothing at all", () => {
  const dir = tempDir();
  const off = new Session({ userDataPath: dir, log: () => {}, enabled: false });
  const tab = page("https://private.example/");
  off.record(tab);
  off.navigate({ ...tab, url: "https://private.example/next" });
  off.setActive(tab.id);
  assert.deepEqual(off.all(), []);
  assert.equal(off.focusSlot(), null);

  // The important half: nothing was written either, so re-enabling later cannot
  // resurrect the tabs the operator asked not to be kept.
  const on = new Session({ userDataPath: dir, log: () => {} });
  assert.deepEqual(on.all(), []);
});

test("clearing drops everything for the next run", () => {
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  const tab = page("https://a.example/");
  session.record(tab);
  session.setActive(tab.id);
  session.clear();

  assert.deepEqual(new Session({ userDataPath: dir, log: () => {} }).all(), []);
});

// --- hostile or damaged files ------------------------------------------------

test("a session file that is not valid JSON is quarantined, not trusted", () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, "session.json"), "{not json");
  const session = new Session({ userDataPath: dir, log: () => {} });
  assert.deepEqual(session.all(), [], "an unreadable file must not become an empty-but-trusted session");
  const left = fs.readdirSync(dir).filter((name) => name.includes("corrupt"));
  assert.equal(left.length, 1, "the damaged file is kept for diagnosis");
});

test("entries that are not restorable pages are dropped on load", () => {
  // A hand-edited file, or one written by an older build. Either way the file is
  // local and trusted-looking, and none of it should reach the address bar.
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({
      tabs: [
        { slot: 1, url: "https://ok.example/", profile: null },
        { slot: 2, url: "javascript:alert(1)", profile: null },
        { slot: 3, profile: null },
        { slot: 4, url: "https://also-ok.example/" },
        "nonsense",
      ],
      activeId: 4,
    }),
  );
  const session = new Session({ userDataPath: dir, log: () => {} });
  assert.deepEqual(session.all().map((entry) => entry.url), [
    "https://ok.example/",
    "https://also-ok.example/",
  ]);
  // Slots stay tied to their entries, so focus lands on the tab that was in
  // front rather than on whatever happens to end up second.
  assert.equal(session.focusSlot(), 4);
});

test("activeId pointing at a tab that is gone is simply ignored", () => {
  const dir = tempDir();
  fs.writeFileSync(
    path.join(dir, "session.json"),
    JSON.stringify({ tabs: [{ slot: 1, url: "https://a.example/" }], activeId: 42 }),
  );
  const session = new Session({ userDataPath: dir, log: () => {} });
  assert.equal(session.focusSlot(), null);
  assert.equal(session.all().length, 1);
});

test("a huge session file is capped rather than reopened wholesale", () => {
  // The file is local, so it cannot grow by itself, but a runaway loop in an
  // earlier build could have left a lot of entries behind.
  const dir = tempDir();
  const tabs = Array.from({ length: 500 }, (_, index) => ({
    slot: index + 1,
    url: `https://tab-${index}.example/`,
  }));
  fs.writeFileSync(path.join(dir, "session.json"), JSON.stringify({ tabs, activeId: null }));
  const session = new Session({ userDataPath: dir, log: () => {} });
  assert.equal(session.all().length, 50);
});

test("the file is only URLs, profiles and the active tab", () => {
  // Worth pinning: this file is the shell's whole browsing record. A title, a
  // cookie or a page body appearing here would be a different kind of store than
  // the one session.js promises.
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  session.record({
    id: 1,
    url: "https://a.example/",
    profile: null,
    title: "A private document title",
    cookies: ["secret=1"],
  });
  const written = fs.readFileSync(path.join(dir, "session.json"), "utf8");
  assert.ok(!written.includes("private document title"));
  assert.ok(!written.includes("secret=1"));
  assert.ok(written.includes("https://a.example/"));
});

test("the session file is private to the user", () => {
  const dir = tempDir();
  const session = new Session({ userDataPath: dir, log: () => {} });
  session.record(page("https://a.example/"));
  if (process.platform === "win32") return; // POSIX mode bits only
  const mode = fs.statSync(path.join(dir, "session.json")).mode & 0o777;
  assert.equal(mode, 0o600, "where these URLs live, only the owner should look");
});