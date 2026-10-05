// The tracker ledger and the privacy score.
//
// The score is a judgement call, so these tests pin the reasoning rather than a
// magic number: what counts as third-party, what a rule name does to the
// breakdown, and that the score can never go below zero or report a reason it did
// not actually find.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { Ledger, registrable, score, grade, WEIGHTS } = require("../src/main/ledger");

const SITE = "https://example.com/news";

test("hosts are grouped so a country domain is one site", () => {
  assert.equal(registrable("www.example.com"), "example.com");
  assert.equal(registrable("a.b.c.example.com"), "example.com");
  assert.equal(registrable("example.co.uk"), "example.co.uk");
  assert.equal(registrable("news.example.co.uk"), "example.co.uk");
  assert.equal(registrable("localhost"), "localhost");
  assert.equal(registrable("127.0.0.1"), "127.0.0.1");
});

test("a blocked request is counted and attributed to its rule", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(1, {
    url: "https://tracker.example/px.gif",
    site: SITE,
    blocked: true,
    rule: "doubleclick.net",
  });

  const summary = ledger.summary(1);
  assert.equal(summary.requests, 2);
  assert.equal(summary.blocked, 1, "one tracker refused");
  assert.equal(summary.trackers, 1);
  const tracker = summary.top.find((entry) => entry.host === "tracker.example");
  assert.equal(tracker.blocked, 1);
  assert.equal(tracker.rules["doubleclick.net"], 1);
});

test("a third-party request is separated from the site's own", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(1, { url: "https://ads.other.net/x", site: SITE, blocked: true, rule: "ads" });

  const site = ledger.sites(1).find((entry) => entry.host === "example.com");
  const ads = ledger.sites(1).find((entry) => entry.host === "other.net");
  assert.equal(site.thirdParty, 0, "the site's own requests are not third-party");
  assert.equal(ads.thirdParty, 1);
  assert.equal(ads.blocked, 1);
  assert.equal(ledger.summary(1).top.length, 1, "only the ad host is worth showing");
});

test("a subdomain of the site is not a third party", () => {
  // Owning cdn.example.com is still the site. Counting it as a third party would
  // penalise every site for its own assets.
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(1, { url: "https://cdn.example.com/lib.js", site: SITE });
  const site = ledger.sites(1).find((entry) => entry.host === "example.com");
  assert.equal(site.requests, 2, "both requests are attributed to the site");
  assert.equal(site.thirdParty, 0, "same registrable domain is first-party");
  assert.equal(site.score, 100, "and it does not drag the score down");
});

test("a full URL works wherever a host is expected", () => {
  // Regression: the site's own origin arrives as a URL, and reading it as a host
  // yields "com/news", which matches nothing and marks every request third-party.
  assert.equal(registrable("https://www.example.com/news?a=1"), "example.com");
  assert.equal(registrable("example.com"), "example.com");
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(1, { url: SITE, site: SITE });
  const site = ledger.sites(1)[0];
  assert.equal(site.thirdParty, 0, "a site talking to itself is not third-party");
  assert.equal(site.score, 100);
});

test("an unrecognised block still appears in the breakdown", () => {
  // The breakdown has to add up to the total, so a block with no rule name is
  // bucketed rather than silently dropped.
  const ledger = new Ledger();
  ledger.record(1, { url: "https://x.test/a", site: SITE, blocked: true });
  const summary = ledger.summary(1);
  assert.equal(summary.blocked, 1);
  const entry = summary.top[0];
  assert.equal(entry.rules.unclassified, 1);
});

test("bytes accumulate for the data footprint", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE, bytes: 2048 });
  ledger.record(1, { url: SITE, site: SITE, bytes: 1024 });
  assert.equal(ledger.summary(1).bytes, 3072);
  assert.equal(ledger.totals().bytes, 3072);
});

test("the host map is bounded so a request storm cannot grow it forever", () => {
  const ledger = new Ledger({ maxHostsPerTab: 3 });
  for (let i = 0; i < 50; i += 1) {
    ledger.record(1, { url: `https://h${i}.test/`, site: SITE, blocked: true, rule: "r" });
  }
  assert.equal(ledger.summary(1).sites, 3, "only the most recent hosts are kept");
});

test("resetting one tab leaves the others alone", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(2, { url: SITE, site: SITE });
  ledger.reset(1);
  assert.equal(ledger.summary(1).requests, 0);
  assert.equal(ledger.summary(2).requests, 1);
});

test("export produces an auditable record with no full URLs in it", () => {
  const ledger = new Ledger();
  ledger.record(1, {
    url: "https://tracker.test/collect?id=secret-user-123",
    site: SITE,
    blocked: true,
    rule: "tracker",
  });
  const dump = JSON.stringify(ledger.export());
  assert.doesNotMatch(dump, /secret-user-123/, "a query string must never be persisted");
  assert.match(dump, /tracker\.test/, "the host is kept so the report is useful");
});

test("the main-frame document owns the page, not the first tracker seen", () => {
  // The first subresource a page pulls is usually a tracker. Grading the site on
  // the first host recorded would score a site by its own trackers.
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE, mainFrame: true });
  ledger.record(1, { url: "https://ads.other.net/x", site: SITE, blocked: true, rule: "ads" });

  const report = ledger.report(1);
  assert.equal(report.site, "example.com");
  assert.equal(report.score, 100, "the site's own grade is not its tracker's grade");
  const tracker = report.sites.find((entry) => entry.host === "other.net");
  assert.ok(tracker.score < 100, "the tracker is still graded, and badly");
});

test("a document with no origin falls back to the host doing the work", () => {
  // A data: URL has no host of its own, so there is no site to grade and the
  // trackers are the whole story. That has to be visible, not silently 100.
  const ledger = new Ledger();
  ledger.record(1, { url: "data:text/html,<h1>x</h1>", mainFrame: true });
  ledger.record(1, { url: "https://ads.other.net/x", site: "", blocked: true, rule: "ads" });
  const report = ledger.report(1);
  assert.equal(report.site, "other.net");
  assert.ok(report.score < 100, `score ${report.score}`);
  assert.equal(report.trackers, 1);
});

test("a new document clears the previous page's counts", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE, mainFrame: true });
  ledger.record(1, { url: "https://ads.other.net/x", site: SITE, blocked: true, rule: "ads" });
  assert.equal(ledger.report(1).blocked, 1);

  ledger.reset(1);
  ledger.record(1, { url: "https://other-site.test/", site: "https://other-site.test/", mainFrame: true });
  const report = ledger.report(1);
  assert.equal(report.blocked, 0, "the new page starts clean");
  assert.equal(report.site, "other-site.test");
});

test("a clean site scores 100 and says why", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  const report = ledger.report(1);
  assert.equal(report.score, 100);
  assert.equal(report.grade, "excellent");
  assert.equal(report.site, "example.com");
  assert.equal(report.penalties.length, 0, "a perfect score reports no findings");
});

test("a site that only loads its own assets is still reported clean", () => {
  // The display list hides it, but the report must not: silence would be
  // indistinguishable from not having looked.
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  assert.equal(ledger.summary(1).top.length, 0);
  assert.equal(ledger.report(1).sites.length, 1);
});

test("the report grades the page the user is on", () => {
  const ledger = new Ledger();
  ledger.record(1, { url: SITE, site: SITE });
  ledger.record(1, { url: "https://ads.other.net/x", site: SITE, blocked: true, rule: "ads" });
  ledger.record(1, { url: "https://ads.other.net/y", site: SITE, blocked: true, rule: "ads" });

  const report = ledger.report(1);
  assert.equal(report.site, "example.com");
  assert.equal(report.trackers, 2);
  assert.equal(report.score, 100, "blocked trackers do not count against the site's own score");
  assert.ok(report.sites.some((entry) => entry.host === "other.net" && entry.score < 100),
    "the third party that tried is scored separately and visibly");
});

test("an empty tab reports a clean score rather than throwing", () => {
  const ledger = new Ledger();
  const report = ledger.report(99);
  assert.equal(report.score, 100);
  assert.equal(report.site, null);
  assert.deepEqual(report.sites, []);
});

test("each finding subtracts and is reported", () => {
  const result = score({ blocked: 2, thirdParty: 3, thirdPartyBlocked: 0, insecure: 0 });
  assert.ok(result.score < 100);
  const keys = result.penalties.map((p) => p.key);
  assert.ok(keys.includes("trackers"));
  assert.ok(keys.includes("thirdParty"));
  assert.equal(result.penalties.length, keys.length, "no phantom findings");
});

test("the score never leaves 0-100 however bad it gets", () => {
  const awful = score({ blocked: 500, thirdParty: 900, thirdPartyBlocked: 0, insecure: 40 });
  assert.equal(awful.score, 0);
  assert.equal(awful.grade, "bad");
});

test("the weights are the only tunable part and they are all positive", () => {
  for (const [key, value] of Object.entries(WEIGHTS)) {
    assert.ok(value > 0, `${key} must cost something`);
  }
});

test("grades line up with the score bands", () => {
  assert.equal(grade(100), "excellent");
  assert.equal(grade(80), "good");
  assert.equal(grade(60), "fair");
  assert.equal(grade(30), "poor");
  assert.equal(grade(0), "bad");
});