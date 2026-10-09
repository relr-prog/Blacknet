// Bookmarks: the star and the bar. The store is the promise - what survives a
// restart, what is refused, and that a bookmark is never silently dropped.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Bookmarks, isBookmarkable } = require("../src/main/bookmarks");

function tempBookmarks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-bookmarks-"));
  return new Bookmarks({ userDataPath: dir });
}

test("only http(s) can be bookmarked", () => {
  assert.equal(isBookmarkable("https://example.com/"), true);
  assert.equal(isBookmarkable("http://example.com/"), true);
  assert.equal(isBookmarkable("about:blank"), false);
  assert.equal(isBookmarkable("file:///etc/passwd"), false);
  assert.equal(isBookmarkable("javascript:alert(1)"), false);
  assert.equal(isBookmarkable(""), false);
  const marks = tempBookmarks();
  assert.throws(() => marks.add({ url: "about:blank" }), /http/);
});

test("toggle adds then removes, and says which way it went", () => {
  const marks = tempBookmarks();
  const added = marks.toggle({ url: "https://example.com/", title: "Example" });
  assert.equal(added.action, "added");
  assert.equal(added.items.length, 1);
  assert.equal(added.item.title, "Example");
  assert.equal(marks.has("https://example.com/"), true);

  const removed = marks.toggle({ url: "https://example.com/", title: "Example" });
  assert.equal(removed.action, "removed");
  assert.equal(removed.items.length, 0);
  assert.equal(marks.has("https://example.com/"), false);
});

test("a bookmark without a title falls back to the host", () => {
  const marks = tempBookmarks();
  const item = marks.add({ url: "https://news.example.com/story?id=1" });
  assert.equal(item.title, "news.example.com");
});

test("adding the same URL twice does not duplicate it", () => {
  const marks = tempBookmarks();
  const first = marks.add({ url: "https://example.com/", title: "One" });
  const second = marks.add({ url: "https://example.com/", title: "Two" });
  assert.equal(marks.all().length, 1);
  assert.equal(first.id, second.id);
  assert.equal(second.title, "One", "the original title is kept");
});

test("bookmarks survive a restart, in order", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-bookmarks-"));
  const first = new Bookmarks({ userDataPath: dir });
  first.add({ url: "https://a.example/", title: "A" });
  first.add({ url: "https://b.example/", title: "B" });

  const second = new Bookmarks({ userDataPath: dir });
  assert.deepEqual(
    second.all().map((item) => item.url),
    ["https://a.example/", "https://b.example/"],
  );
  // And a third URL added after the restart gets an id that was not reused.
  const third = second.add({ url: "https://c.example/", title: "C" });
  assert.ok(third.id > 2);
});

test("a corrupt file is quarantined, not fatal", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-bookmarks-"));
  fs.writeFileSync(path.join(dir, "bookmarks.json"), "{ not json");
  const marks = new Bookmarks({ userDataPath: dir });
  assert.deepEqual(marks.all(), []);
  assert.equal(
    fs.readdirSync(dir).some((name) => name.startsWith("bookmarks.json.corrupt-")),
    true,
  );
});

test("entries that are not bookmarks are dropped on read", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-bookmarks-"));
  fs.writeFileSync(
    path.join(dir, "bookmarks.json"),
    JSON.stringify({ items: [{ url: "about:blank" }, { url: "https://ok.example/", title: "OK" }] }),
  );
  const marks = new Bookmarks({ userDataPath: dir });
  assert.deepEqual(
    marks.all().map((item) => item.url),
    ["https://ok.example/"],
  );
});

test("remove reports whether anything was there", () => {
  const marks = tempBookmarks();
  marks.add({ url: "https://example.com/", title: "Example" });
  assert.equal(marks.remove("https://example.com/").removed, true);
  assert.equal(marks.remove("https://example.com/").removed, false);
});
