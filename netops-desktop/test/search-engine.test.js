// The search engines a query can be routed to. These are the low-level facts
// that keep an external-engine search honest: the default keeps queries on the
// machine, every engine is an https URL of a fixed host, the only thing that can
// enter the URL is the encoded query, and an unknown engine name never invents a
// URL to visit.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  ENGINES,
  DEFAULT_ENGINE,
  ENGINE_IDS,
  searchEngineUrl,
} = require("../src/main/search");

test("the default engine is the shell's own search", () => {
  assert.equal(DEFAULT_ENGINE, "blacknet");
  assert.ok(ENGINE_IDS.includes("blacknet"));
  assert.equal(ENGINES.blacknet, null, "blacknet has no remote URL to visit");
});

test("every engine is an https URL of a fixed host with a %s slot", () => {
  for (const id of ENGINE_IDS) {
    const template = ENGINES[id];
    if (id === "blacknet") continue;
    assert.match(template, /^https:\/\/[a-z0-9.-]+\//);
    assert.ok(template.includes("%s"), `${id} must mark the query slot`);
  }
});

test("query text is encoded into the engine URL", () => {
  assert.equal(
    searchEngineUrl("duckduckgo", "hello world"),
    "https://duckduckgo.com/?q=hello%20world",
  );
  assert.equal(
    searchEngineUrl("google", "cat & dog"),
    "https://www.google.com/search?q=cat%20%26%20dog",
  );
  assert.equal(
    searchEngineUrl("bing", "a=b&c=d"),
    "https://www.bing.com/search?q=a%3Db%26c%3Dd",
  );
});

test("blacknet returns no URL: it means the shell's own search", () => {
  assert.equal(searchEngineUrl("blacknet", "anything"), null);
});

test("an unknown or bad engine never produces a URL", () => {
  assert.equal(searchEngineUrl("goolge", "typo"), null);
  assert.equal(searchEngineUrl("", "query"), null);
  assert.equal(searchEngineUrl(undefined, "query"), null);
  assert.equal(searchEngineUrl("javascript:", "x"), null);
});

test("a query can never smuggle a second parameter in", () => {
  const url = searchEngineUrl("duckduckgo", "a&utm_source=blacknet");
  assert.equal(url, "https://duckduckgo.com/?q=a%26utm_source%3Dblacknet");
  assert.ok(!url.includes("utm_source="), "the encoded query stays one value");
});