// Smoke test for the C++ addon as Node/Electron will actually call it.
// Run with: npm run test:native
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const native = require(path.join(__dirname, "..", "build", "native", "netops_native.node"));

test("version is reported", () => {
  assert.match(native.version, /netops-native/);
  // the function form still exposes the built-in list sizes for the about page
  assert.equal(typeof native.version, "string");
});

test("normaliseUrl upgrades bare hosts and refuses dangerous schemes", () => {
  const bare = native.normaliseUrl("example.com");
  assert.equal(bare.ok, true);
  assert.equal(bare.url, "https://example.com");
  assert.equal(bare.secure, true);

  const withPort = native.normaliseUrl("example.com:8443/a?b=1");
  assert.equal(withPort.url, "https://example.com:8443/a?b=1");
  assert.equal(withPort.host, "example.com");
  assert.equal(withPort.port, 8443);
  assert.equal(withPort.path, "/a?b=1");

  assert.equal(native.normaliseUrl("javascript:alert(1)").ok, false);
  assert.equal(native.normaliseUrl("file:///etc/passwd").ok, false);
  assert.match(native.normaliseUrl("javascript:alert(1)").error, /not allowed/);

  const plain = native.normaliseUrl("http://plain.test", { httpsOnly: false });
  assert.equal(plain.url, "http://plain.test");
  assert.equal(plain.secure, false);

  // credentials in the authority are a phishing trick
  assert.match(native.normaliseUrl("https://user:pass@example.com").error, /credentials/);
});

test("validateHost enforces the private-network policy", () => {
  assert.deepEqual(native.validateHost("Example.COM"), { ok: true, host: "example.com" });
  assert.match(native.validateHost("127.0.0.1").error, /private and loopback/);
  assert.match(native.validateHost("localhost").error, /blocked by policy/);
  assert.match(native.validateHost("printer.local").error, /mDNS/);
  assert.equal(native.validateHost("127.0.0.1", { allowPrivate: true }).host, "127.0.0.1");
  assert.equal(native.validateHost("localhost", { allowLocalhost: true }).host, "localhost");
});

test("Blocklist matches built-ins, subdomains and operator rules", () => {
  const list = new native.Blocklist({
    includeBuiltin: true,
    extra: [".ads.example", "re:tracker[0-9]", "192.0.2.0/24"],
  });

  assert.equal(list.check("https://www.google-analytics.com/collect").blocked, true);
  assert.equal(list.check("https://stats.doubleclick.net/pixel").source, "builtin");
  assert.equal(list.check("https://en.wikipedia.org/wiki/Main_Page").blocked, false);
  assert.equal(list.check("about:blank").blocked, false);
  // naive substring matching would wrongly block this one
  assert.equal(list.check("https://notgoogle-analytics.com.attacker.test/").blocked, false);

  assert.equal(list.check("https://cdn.ads.example/x.js").blocked, true);
  assert.equal(list.check("https://ads.example/x.js").blocked, false);
  assert.equal(list.check("https://tracker7.example/p").blocked, true);
  assert.equal(list.check("https://tracking.example/p").blocked, false);
  assert.equal(list.check("https://metrics.example/c?ip=192.0.2.5").blocked, true);
  assert.equal(list.check("https://metrics.example/c?ip=8.8.8.8").blocked, false);

  assert.equal(list.checkHost("doubleclick.net").blocked, true);
  assert.equal(list.checkHost("example.com").blocked, false);

  const rules = JSON.parse(list.toJSON());
  assert.ok(rules.length > 50, "built-in list should be included");
  assert.ok(rules.some((rule) => rule.kind === "cidr"));

  list.clear();
  assert.equal(list.size(), 0);
});

test("CookieJar reports shapes without leaking values", () => {
  const jar = new native.CookieJar();
  jar.ingest([
    { name: "session", value: "super-secret-token", domain: ".example.com" },
    { name: "pref", value: "dark", domain: ".example.com", expires: 4102444800 },
    { name: "analytics", value: "ga-value", domain: "tracker.test" },
  ]);

  const report = jar.report(1000);
  assert.equal(report.count, 3);
  assert.equal(report.thirdParty, 1);
  assert.equal(report.domains.length, 2);
  assert.equal(report.cookies[0].valuePreview, "supe…");
  assert.equal(report.cookies[0].value, undefined);

  const json = JSON.stringify(report);
  assert.ok(!json.includes("super-secret-token"), "raw cookie values must never be serialised");
  assert.ok(!json.includes("ga-value"));

  assert.equal(jar.select(".example.com").length, 2);
  assert.equal(jar.select("tracker.test").length, 1);
  jar.clear();
  assert.equal(jar.size(), 0);
});

test("CacheIndex scans and clears a profile cache", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "netops-cache-"));
  const cacheDir = path.join(root, "Cache", "data_0");
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "entry"), Buffer.alloc(192));

  const index = new native.CacheIndex(root);
  const scan = index.scan();
  assert.equal(scan.totalBytes, 192);
  assert.equal(scan.files, 1);
  assert.equal(scan.cacheBytes, 192);

  index.clear();
  assert.equal(index.scan().totalBytes, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("buildTheme renders CSS from a validated theme", () => {
  const theme = native.buildTheme({
    name: "midnight",
    mode: "dark",
    colors: { accent: "#38bdf8" },
    fontFamily: "Inter",
  });
  assert.equal(theme.ok, true);
  assert.equal(theme.mode, "dark");
  assert.equal(theme.colors.accent, "#38bdf8");
  assert.match(theme.css, /::selection\{background:#38bdf8/);
  assert.match(theme.css, /font-family:Inter/);

  const auto = native.buildTheme({ mode: "auto" });
  assert.match(auto.css, /prefers-color-scheme/);
  assert.ok(Object.keys(theme.presets).length >= 3);

  assert.equal(native.buildTheme({ mode: "neon" }).ok, false);
  const bad = native.buildTheme({ colors: { accent: "not-a-colour" } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /accent/);
});

test("Pool routes round robin, sticks sessions and quarantines failures", () => {
  const pool = new native.Pool();
  pool.addTier({
    name: "lab",
    strategy: "round_robin",
    upstreams: ["1.1.1.1:8080#tag=a", { host: "1.1.1.2", port: 8080, tag: "b" }],
  });
  pool.addTier({ name: "backup", strategy: "failover", upstreams: ["socks5://127.0.0.1:1080"] });

  assert.equal(pool.upstreamCount(), 3);
  assert.deepEqual(pool.tierNames(), ["lab", "backup"]);

  const first = pool.select();
  const second = pool.select();
  assert.notEqual(first.id, second.id, "round robin must advance");
  assert.equal(first.kind, "http");
  assert.match(first.display, /^http:\/\/1\.1\.1\./);

  // sticky routing is a tier strategy: it needs a pool whose first tier uses it
  const stickyPool = new native.Pool();
  stickyPool.addTier({ name: "sticky-lab", strategy: "sticky", upstreams: ["3.3.3.3:8080", "3.3.3.4:8080"] });
  assert.equal(stickyPool.select("user-1").id, stickyPool.select("user-1").id);
  assert.equal(stickyPool.select("user-2").id, stickyPool.select("user-2").id);

  // a sick upstream is skipped by the selector
  pool.noteFailure(first.id, "connect timeout");
  for (let i = 0; i < 8; i += 1) {
    assert.notEqual(pool.select().id, first.id);
  }

  pool.quarantine(first.id);
  assert.notEqual(pool.select().id, first.id);

  pool.noteSuccess(second.id, { bytes: 4096 });
  const stats = pool.stats();
  assert.equal(stats.upstreams, 3);
  assert.equal(stats.tiers, 2);

  const rows = pool.listUpstreams();
  assert.equal(rows.length, 3);
  const healthy = rows.find((row) => row.id === second.id);
  assert.equal(healthy.health, "healthy");
  assert.equal(healthy.successRate, 1);
  assert.equal(rows.find((row) => row.id === first.id).health, "quarantined");
  assert.ok(!JSON.stringify(rows).includes("1080@"), "credentials must stay hidden");

  // re-adding a tier name replaces it and drops the orphaned upstreams
  pool.addTier({ name: "lab", strategy: "sticky", upstreams: ["9.9.9.9:8080"] });
  assert.equal(pool.upstreamCount(), 2);
  assert.equal(pool.removeTier("backup"), true);
  assert.equal(pool.upstreamCount(), 1);
});
