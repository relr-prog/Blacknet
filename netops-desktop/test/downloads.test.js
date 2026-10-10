// Downloads: the record, not the byte stream. What survives a restart, how a
// filename is tamed, and that a list that grew past its cap drops the oldest.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Downloads, sanitizeFilename, MAX_DOWNLOADS } = require("../src/main/downloads");

function tempDownloads() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-downloads-"));
  return new Downloads({ userDataPath: dir });
}

test("a hostile filename cannot escape the download directory", () => {
  assert.equal(sanitizeFilename("report.pdf"), "report.pdf");
  assert.equal(sanitizeFilename("../../etc/passwd"), "etcpasswd");
  assert.equal(sanitizeFilename("C:\\evil.exe"), "evil.exe");
  assert.equal(sanitizeFilename(".."), "download");
  assert.equal(sanitizeFilename("."), "download");
  assert.equal(sanitizeFilename(""), "download");
  assert.equal(sanitizeFilename("name."), "name");
  assert.equal(sanitizeFilename("name "), "name");
  assert.equal(sanitizeFilename(null), "download");
});

test("a new download is active, then completes with its numbers", () => {
  const dl = tempDownloads();
  const item = dl.add({ filename: "blob.bin", url: "https://example.com/blob.bin", totalBytes: 1000, savePath: "/tmp/blob.bin" });
  assert.equal(item.state, "active");
  assert.equal(item.receivedBytes, 0);
  assert.equal(item.totalBytes, 1000);

  dl.update(item.id, { receivedBytes: 400 });
  assert.equal(dl.get(item.id).receivedBytes, 400);
  assert.equal(dl.get(item.id).state, "active");

  dl.update(item.id, { state: "completed", receivedBytes: 1000, endedAt: 9 });
  const done = dl.get(item.id);
  assert.equal(done.state, "completed");
  assert.equal(done.endedAt, 9);
});

test("an unknown state cannot be written onto a record", () => {
  const dl = tempDownloads();
  const item = dl.add({ filename: "a.bin" });
  dl.update(item.id, { state: "suspicious" });
  assert.equal(dl.get(item.id).state, "active");
});

test("removing one row and clearing the store behave differently", () => {
  const dl = tempDownloads();
  const a = dl.add({ filename: "a.bin" });
  dl.add({ filename: "b.bin" });
  assert.equal(dl.remove(a.id).id, a.id);
  assert.equal(dl.all().length, 1);
  dl.clear();
  assert.equal(dl.all().length, 0);
});

test("downloads survive a restart with their state intact", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-downloads-"));
  const first = new Downloads({ userDataPath: dir });
  const item = first.add({ filename: "report.pdf", url: "https://example.com/r.pdf", savePath: "/tmp/report.pdf", totalBytes: 500 });
  first.update(item.id, { state: "completed", receivedBytes: 500, endedAt: 7 });

  const reopened = new Downloads({ userDataPath: dir });
  const restored = reopened.get(item.id);
  assert.equal(restored.filename, "report.pdf");
  assert.equal(restored.state, "completed");
  assert.equal(restored.receivedBytes, 500);
  assert.equal(restored.endedAt, 7);
});

test("a corrupt file is quarantined and the store stays usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-downloads-"));
  fs.writeFileSync(path.join(dir, "downloads.json"), "{ not json");
  const dl = new Downloads({ userDataPath: dir });
  assert.equal(dl.all().length, 0);
  dl.add({ filename: "a.bin" });
  assert.equal(dl.all().length, 1);
});

test("the list cannot grow past the cap", () => {
  const dl = tempDownloads();
  for (let i = 0; i < MAX_DOWNLOADS + 25; i += 1) {
    dl.add({ filename: `f-${i}.bin` });
  }
  assert.equal(dl.all().length, MAX_DOWNLOADS);
  assert.equal(dl.all()[0].filename, "f-25.bin", "the oldest entries were dropped");
});