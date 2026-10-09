// The meta-search: what a query becomes, and what a source is allowed to put in
// front of the operator.
//
// Two properties matter and are pinned here. First, the merge is deterministic:
// the same inputs rank the same way every time, so a results list does not
// shuffle itself between two identical searches. Second, a source is untrusted
// input - a malformed body, a non-2xx status, a slow endpoint or a hostile
// result URL must degrade that one source and never the search as a whole.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const {
  SOURCES,
  SOURCE_IDS,
  search,
  merge,
  safe_url,
  strip_tags,
  clamp_text,
  result_key,
} = require("../src/main/search");

function respond(body, status = 200) {
  return {
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// A fetch stub keyed by URL fragment, so a test says which source answers what.
function fetcher(table) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    for (const [fragment, value] of Object.entries(table)) {
      if (url.includes(fragment)) {
        if (value instanceof Error) throw value;
        if (typeof value === "function") return value(url, init);
        return value;
      }
    }
    throw new Error(`no stub for ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

test("every source builds a request whose query is encoded", () => {
  const query = "a & b/c?d";
  for (const id of SOURCE_IDS) {
    const { url } = SOURCES[id].request(query, 5);
    assert.match(url, /^https:\/\//, id);
    // Encoded, never raw: an "&" or "/" typed into the address bar must not turn
    // into a second parameter or another path segment on the upstream request.
    assert.ok(!url.includes("a & b/c?d"), `${id} left the query raw`);
    assert.ok(url.includes("a+%26+b%2Fc%3Fd") || url.includes("a%20%26%20b%2Fc%3Fd"), id);
  }
});

test("each source parses its own shape into title/url/snippet", () => {
  const wiki = SOURCES.wikipedia.parse(JSON.stringify({
    query: { search: [{ title: "Ada Lovelace", pageid: 123, snippet: "<span>a <b>mathematician</b></span>" }] },
  }));
  assert.deepEqual(wiki, [{
    title: "Ada Lovelace",
    url: "https://en.wikipedia.org/?curid=123",
    snippet: "a mathematician",
  }]);

  const hn = SOURCES.hackernews.parse(JSON.stringify({
    hits: [{ title: "Show HN: thing", url: "https://example.com/x", points: 10, num_comments: 4 }],
  }));
  assert.equal(hn[0].url, "https://example.com/x");
  assert.match(hn[0].snippet, /10 points, 4 comments/);

  const hnSelf = SOURCES.hackernews.parse(JSON.stringify({
    hits: [{ story_title: "Ask HN: q", objectID: "42" }],
  }));
  assert.equal(hnSelf[0].url, "https://news.ycombinator.com/item?id=42");

  const so = SOURCES.stackoverflow.parse(JSON.stringify({
    items: [{ title: "How to X", link: "https://stackoverflow.com/q/1", excerpt: "<p>body</p>" }],
  }));
  assert.deepEqual(so[0], { title: "How to X", url: "https://stackoverflow.com/q/1", snippet: "body" });

  const gh = SOURCES.github.parse(JSON.stringify({
    items: [{ full_name: "relr-prog/blacknet", html_url: "https://github.com/relr-prog/blacknet", description: "browser" }],
  }));
  assert.equal(gh[0].title, "relr-prog/blacknet");
});

test("a body that is not the expected shape yields no rows, not a throw", () => {
  for (const id of SOURCE_IDS) {
    assert.deepEqual(SOURCES[id].parse("not json"), []);
    assert.deepEqual(SOURCES[id].parse(JSON.stringify({ unexpected: true })), []);
  }
});

test("result URLs are restricted to http and https", () => {
  assert.equal(safe_url("https://example.com/"), "https://example.com/");
  assert.equal(safe_url("http://example.com/"), "http://example.com/");
  assert.equal(safe_url("javascript:alert(1)"), "");
  assert.equal(safe_url("data:text/html,x"), "");
  assert.equal(safe_url("file:///etc/passwd"), "");
  assert.equal(safe_url("  https://example.com/ "), "https://example.com/");
  assert.equal(safe_url(null), "");
  assert.equal(safe_url(42), "");
});

test("snippets lose their markup and keep their meaning", () => {
  assert.equal(strip_tags("<b>bold</b> &amp; <i>italic</i>"), "bold & italic");
  assert.equal(strip_tags("Q&amp;A &#39;quoted&#39;"), "Q&A 'quoted'");
  assert.equal(strip_tags("&unknown;"), "&unknown;"); // not a known entity: left alone
  assert.equal(strip_tags(undefined), "");
});

test("text is collapsed and capped", () => {
  assert.equal(clamp_text("  a\n\t b  ", 10), "a b");
  assert.equal(clamp_text("abcdef", 3), "abc");
  assert.equal(clamp_text(null, 3), "");
});

test("the merge drops duplicates, ranks on the query, and caps the list", () => {
  const raw = [
    { title: "Cats", url: "https://example.com/a", snippet: "", source: "wikipedia", weight: 3 },
    { title: "Cats again", url: "https://example.com/a?utm=1", snippet: "", source: "github", weight: 2 },
    { title: "Dogs", url: "https://example.com/b", snippet: "", source: "github", weight: 2 },
    { title: "Cats everywhere", url: "https://example.com/c", snippet: "cats", source: "hackernews", weight: 2 },
  ];
  const out = merge(raw, "cats", 10);
  // The two /a links collapse to one; the title match outranks the snippet match.
  assert.equal(out.length, 3);
  assert.equal(out[0].title, "Cats");
  assert.equal(out.filter((r) => r.url.startsWith("https://example.com/a")).length, 1);
  assert.equal(merge(raw, "cats", 2).length, 2);
});

test("equal-scoring results keep the order the sources gave them", () => {
  const raw = ["a", "b", "c"].map((p) => ({
    title: p, url: `https://example.com/${p}`, snippet: "", source: "wikipedia", weight: 2,
  }));
  assert.deepEqual(merge(raw, "", 10).map((r) => r.title), ["a", "b", "c"]);
});

test("result_key ignores the fragment and the query, not the path", () => {
  assert.equal(result_key("https://example.com/a?x=1#y"), result_key("https://example.com/a"));
  assert.notEqual(result_key("https://example.com/a"), result_key("https://example.com/b"));
});

test("search fans out, merges and reports which sources answered", async () => {
  const fetchImpl = fetcher({
    "en.wikipedia.org": respond({ query: { search: [{ title: "Cats", pageid: 1, snippet: "felines" }] } }),
    "hn.algolia.com": respond({ hits: [{ title: "Cat news", url: "https://example.com/cat", points: 1, num_comments: 0 }] }),
    "api.stackexchange.com": respond({ items: [] }),
    "api.github.com": respond({ items: [] }),
  });

  const summary = await search("cats", { fetchImpl });
  assert.equal(summary.query, "cats");
  assert.equal(summary.results.length, 2);
  assert.deepEqual(summary.answered.sort(), SOURCE_IDS.slice().sort());
  assert.deepEqual(summary.failed, []);
  assert.ok(summary.results.some((r) => r.source === "wikipedia"));
  // Every source was asked exactly once.
  assert.equal(fetchImpl.calls.length, SOURCE_IDS.length);
});

test("one failing source does not sink the search", async () => {
  const fetchImpl = fetcher({
    "en.wikipedia.org": respond({ query: { search: [{ title: "Cats", pageid: 1, snippet: "" }] } }),
    "hn.algolia.com": new Error("socket closed"),
    "api.stackexchange.com": respond({}, 500),
    "api.github.com": respond({ items: [{ full_name: "x/y", html_url: "https://github.com/x/y", description: "" }] }),
  });

  const summary = await search("cats", { fetchImpl });
  const answered = summary.answered.sort();
  const failed = summary.failed.map((f) => f.source).sort();
  assert.deepEqual(answered, ["github", "wikipedia"]);
  assert.deepEqual(failed, ["hackernews", "stackoverflow"]);
  assert.equal(summary.results.length, 2);
  for (const f of summary.failed) assert.ok(typeof f.error === "string" && f.error.length > 0);
});

test("a source that never answers is cut off by the timeout", async () => {
  const hang = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new Error("aborted")));
  });
  const summary = await search("cats", { fetchImpl: hang, timeoutMs: 5 });
  assert.equal(summary.results.length, 0);
  assert.equal(summary.answered.length, 0);
  assert.equal(summary.failed.length, SOURCE_IDS.length);
});

test("an empty query asks nothing", async () => {
  let asked = 0;
  const fetchImpl = async () => {
    asked += 1;
    return respond({});
  };
  const summary = await search("   ", { fetchImpl });
  assert.equal(asked, 0);
  assert.deepEqual(summary.results, []);
});

test("hostile rows inside an otherwise valid source are dropped", async () => {
  const fetchImpl = fetcher({
    "en.wikipedia.org": respond({
      query: {
        search: [
          { title: "Good", pageid: 1, snippet: "" },
          { pageid: 2, snippet: "no title" },
          { title: "No id", snippet: "no url" },
        ],
      },
    }),
    "hn.algolia.com": respond({ hits: [] }),
    "api.stackexchange.com": respond({ items: [] }),
    "api.github.com": respond({ items: [{ full_name: "x/y", html_url: "javascript:alert(1)", description: "" }] }),
  });

  const summary = await search("q", { fetchImpl });
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].title, "Good");
  assert.ok(summary.results.every((r) => r.url.startsWith("https://")));
});
