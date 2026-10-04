// Supervising the rotating proxy gateway as a child process.
//
// The ports are the interesting part. rotator.toml asks for 8888, but the gateway
// silently takes a different port when that one is busy, so anything that assumed
// a fixed port would appear to work and then route traffic into the void. These
// tests pin the parsing of the real startup line and the health wording.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { parsePorts, describe } = require("../src/main/rotator");

const REAL_LINE =
  "18:11:47 INFO    rotator          listening: http=127.0.0.1:8888 socks5=127.0.0.1:1080 status=127.0.0.1:9099 | upstreams=7 healthy=7";

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
  assert.equal(parsePorts("some other rotator log line"), null);
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