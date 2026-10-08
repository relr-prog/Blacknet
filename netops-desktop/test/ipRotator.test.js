// Supervising the rotating proxy gateway as a child process.
//
// The ports are the interesting part. rotator.toml asks for 8888, but the gateway
// silently takes a different port when that one is busy, so anything that assumed
// a fixed port would appear to work and then route traffic into the void. These
// tests pin the parsing of the real startup line and the health wording.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parsePorts, describe, rotationVerdict } = require("../src/main/ipRotator");

// The status payload shape the gateway actually returns, trimmed to what is read.
function status(rows) {
  return {
    pool: { upstreams: rows.length, healthy: rows.filter((r) => r.healthy).length },
    upstreams: rows,
  };
}

function upstream(over = {}) {
  return {
    id: "u1",
    label: "http://1.2.3.4:8080",
    tier: 1,
    kind: "http",
    healthy: true,
    in_use: false,
    latency_ms: 120,
    ok: 3,
    fail: 0,
    last_error: null,
    ...over,
  };
}

const REAL_LINE =
  "18:11:47 INFO    ipRotator          listening: http=127.0.0.1:8888 socks5=127.0.0.1:1080 status=127.0.0.1:9099 | upstreams=7 healthy=7";

test("the gateway's listening line yields all three ports", () => {
  assert.deepEqual(parsePorts(REAL_LINE), {
    http: "127.0.0.1:8888",
    socks5: "127.0.0.1:1080",
    status: "127.0.0.1:9099",
  });
});

test("a disabled front end is null rather than the dash it logs", () => {
  // socks_port = 0 and metrics_port = 0 are logged as "-"; treating that as a
  // host would produce a proxy rule pointing at nothing.
  const ports = parsePorts("listening: http=127.0.0.1:8888 socks5=- status=-");
  assert.equal(ports.http, "127.0.0.1:8888");
  assert.equal(ports.socks5, null);
  assert.equal(ports.status, null);
});

test("a non-default port is read, not assumed", () => {
  const ports = parsePorts("listening: http=127.0.0.1:41234 socks5=- status=127.0.0.1:41235");
  assert.equal(ports.http, "127.0.0.1:41234");
  assert.equal(ports.status, "127.0.0.1:41235");
});

test("an unrelated log line is not mistaken for a listener", () => {
  assert.equal(parsePorts("some other ipRotator log line"), null);
  assert.equal(parsePorts(""), null);
});

test("listening is not reported as healthy", () => {
  // The failure this guards: a gateway with every upstream dead still binds its
  // port, and "running" would tell the operator their traffic is rotating.
  assert.equal(describe({ pool: { upstreams: 7, healthy: 0 } }), "no healthy upstreams (7 configured)");
  assert.equal(describe({ pool: { upstreams: 0, healthy: 0 } }), "no upstreams configured");
  assert.equal(describe({}), "no upstreams configured");
});

test("a partly healthy pool reports both numbers", () => {
  assert.equal(describe({ pool: { upstreams: 7, healthy: 5 } }), "5/7 upstreams healthy");
  assert.equal(describe({ pool: { upstreams: 3, healthy: 3 } }), "3/3 upstreams healthy");
});

// --- is the exit IP actually rotating? --------------------------------------
//
// The whole feature is a claim about the network, and a claim about the network
// has to be checked against the network. A pool of healthy upstreams is not
// evidence of rotation: they can all resolve to the same address, and none of
// them has to have been identified yet. Reporting "rotating" in either case is
// the most useful-looking lie available, so the verdict comes from observed exit
// IPs only.

test("several distinct exit IPs is the only thing called rotating", () => {
  const verdict = rotationVerdict(status([
    upstream({ id: "a", exit_ip: "198.51.100.1" }),
    upstream({ id: "b", exit_ip: "198.51.100.2" }),
    upstream({ id: "c", exit_ip: "198.51.100.3" }),
  ]));
  assert.equal(verdict.verdict, "rotating");
  assert.equal(verdict.distinctExitIps, 3);
  assert.equal(verdict.total, 3);
});

test("healthy upstreams sharing one exit IP are not rotation", () => {
  // Three healthy upstreams, one address. A count of healthy upstreams would call
  // this a healthy pool; it is a single exit wearing three hats.
  const verdict = rotationVerdict(status([
    upstream({ id: "a", exit_ip: "198.51.100.1" }),
    upstream({ id: "b", exit_ip: "198.51.100.1" }),
    upstream({ id: "c", exit_ip: "198.51.100.1" }),
  ]));
  assert.equal(verdict.verdict, "single-exit");
  assert.equal(verdict.distinctExitIps, 1);
  assert.equal(verdict.healthy, 3, "they really are healthy");
});

test("nothing identified yet is unknown, not rotation and not failure", () => {
  const verdict = rotationVerdict(status([
    upstream({ id: "a", exit_ip: null }),
    upstream({ id: "b", exit_ip: null }),
  ]));
  assert.equal(verdict.verdict, "unknown");
  assert.equal(verdict.observed, 0);
  assert.equal(verdict.healthy, 2);
});

test("an empty pool is unconfigured and a dead pool is down", () => {
  assert.equal(rotationVerdict(status([])).verdict, "unconfigured");
  assert.equal(rotationVerdict({}).verdict, "unconfigured");
  const down = rotationVerdict(status([
    upstream({ id: "a", healthy: false, exit_ip: null }),
    upstream({ id: "b", healthy: false, exit_ip: null }),
  ]));
  assert.equal(down.verdict, "down");
  assert.equal(down.total, 2);
});

test("one working exit among dead upstreams still rotates nothing extra", () => {
  const verdict = rotationVerdict(status([
    upstream({ id: "a", healthy: true, exit_ip: "198.51.100.1" }),
    upstream({ id: "b", healthy: false, exit_ip: null }),
  ]));
  assert.equal(verdict.verdict, "single-exit");
  assert.equal(verdict.healthy, 1);
  assert.equal(verdict.total, 2);
});

test("unhealthy upstreams are left out of the exit count", () => {
  // A quarantined upstream may still hold the last exit IP it saw. Counting it
  // would invent a second exit that traffic cannot currently reach.
  const verdict = rotationVerdict(status([
    upstream({ id: "a", healthy: true, exit_ip: "198.51.100.1" }),
    upstream({ id: "b", healthy: false, exit_ip: "198.51.100.9" }),
  ]));
  assert.equal(verdict.distinctExitIps, 1);
  assert.equal(verdict.verdict, "single-exit");
});