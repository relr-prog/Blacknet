// The shell's own reachability self-check.
//
// Two things are being pinned down: the check asks through the shell's own
// client rather than trusting an open port, and it is honest about the answer -
// a request that came back is "reachable", anything else (a wrong status, a
// refusal, a timeout) is not, and a failed check is recorded rather than thrown.
// The last test runs the check through a real client port against a fake proxy,
// so "it reached" means bytes actually crossed the socket.
//
// Nothing here touches the network outside this machine: the proxy is a fake one
// written for the test.
const assert = require("node:assert/strict");
const net = require("node:net");
const os = require("node:os");
const { test } = require("node:test");

const { CircuitService } = require("../src/main/circuit");
const { CrSelfCheck } = require("../src/main/crSelfCheck");

// A stand-in for the shell's client: it records what it was asked to fetch and
// answers however the test wants, without a daemon or a socket.
function fakeClient({ status = 200, bytes = 5, error = null } = {}) {
  const calls = { fetch: [], stop: 0 };
  return {
    calls,
    async fetch(url, options) {
      calls.fetch.push({ url, options });
      if (error) throw new Error(error);
      return { status, bytes, body: "hello" };
    },
    async stop() {
      calls.stop += 1;
      return "stopped";
    },
    status() {
      return { state: "running", port: 1234 };
    },
  };
}

function config(circuit) {
  return { circuit };
}

test("it is off until a profile asks for it", async () => {
  const client = fakeClient();
  const check = new CrSelfCheck({ config: config({}), service: client, log: () => {} });
  const status = await check.start();
  assert.equal(status.enabled, false);
  assert.equal(check.status().reachable, null);
  assert.equal(client.calls.fetch.length, 0, "no daemon is started to check a daemon nobody wanted");
});

test("when asked, it proves the circuit carries a request", async () => {
  const client = fakeClient({ status: 200, bytes: 5 });
  const check = new CrSelfCheck({
    config: config({ enabled: true, selfCheckUrl: "http://example.test/", selfCheckIntervalMs: 0 }),
    service: client,
    now: () => 1000,
    log: () => {},
  });
  const status = await check.start();
  assert.equal(status.enabled, true);
  assert.equal(status.reachable, true);
  assert.equal(status.status, 200);
  assert.equal(status.bytes, 5);
  assert.equal(status.checkedAt, 1000);
  assert.equal(status.error, null);
  assert.deepEqual(client.calls.fetch, [
    { url: "http://example.test/", options: { timeoutMs: 30000 } },
  ]);
  assert.deepEqual(status.daemon, { state: "running", port: 1234 });
});

test("an answer that is not a success is not reachable", async () => {
  const client = fakeClient({ status: 500, bytes: 12 });
  const check = new CrSelfCheck({
    config: config({ enabled: true, selfCheckIntervalMs: 0 }),
    service: client,
    log: () => {},
  });
  const result = await check.check();
  assert.equal(result.reachable, false);
  assert.equal(result.status, 500);
  assert.match(result.error, /HTTP 500/);
});

test("a client that cannot answer is recorded, not thrown", async () => {
  const client = fakeClient({ error: "no circuit available" });
  const check = new CrSelfCheck({
    config: config({ enabled: true, selfCheckIntervalMs: 0 }),
    service: client,
    log: () => {},
  });
  const result = await check.check();
  assert.equal(result.reachable, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "no circuit available");
});

test("the check repeats on its interval and stop cancels it", async () => {
  const client = fakeClient();
  const timers = { set: [], cleared: [] };
  const check = new CrSelfCheck({
    config: config({ enabled: true, selfCheckIntervalMs: 2500 }),
    service: client,
    log: () => {},
    setInterval: (fn, ms) => {
      timers.set.push({ fn, ms });
      return "handle";
    },
    clearInterval: (handle) => timers.cleared.push(handle),
  });
  await check.start();
  assert.equal(client.calls.fetch.length, 1);
  assert.equal(timers.set.length, 1);
  assert.equal(timers.set[0].ms, 2500);

  // Run the scheduled refresh: the check happens again through the same client.
  await timers.set[0].fn();
  assert.equal(client.calls.fetch.length, 2);

  await check.stop();
  assert.deepEqual(timers.cleared, ["handle"]);
  assert.equal(client.calls.stop, 1);
});

// A stand-in for the daemon's SOCKS port: it completes the handshake, accepts
// the CONNECT, and then answers the request with one HTTP reply.
function fakeSocksProxy(httpReply) {
  return net.createServer((socket) => {
    let stage = 0;
    const accept = () => {
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      stage = 2;
      // The client's request line arrives next, after it has read the reply.
      socket.once("data", () => socket.write(Buffer.from(httpReply, "binary")));
    };
    socket.on("data", () => {
      // The client sends the greeting, waits for the method reply, then sends
      // CONNECT - so each arrives as its own chunk.
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([5, 0]));
        return;
      }
      if (stage === 1) accept();
    });
  });
}

test("it reaches a name through a real client port", async () => {
  const server = fakeSocksProxy("HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello");
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  const service = new CircuitService({ binary: null, userDataPath: os.tmpdir() });
  // The daemon is not spawned here: the client is put in the one state a passing
  // check leaves it in, so only the request path is under test.
  service.state = "running";
  service.port = port;

  try {
    const check = new CrSelfCheck({
      config: config({ enabled: true, selfCheckUrl: "http://example.test/", selfCheckIntervalMs: 0 }),
      service,
      log: () => {},
    });
    const result = await check.check();
    assert.equal(result.reachable, true);
    assert.equal(result.status, 200);
    assert.equal(result.bytes, 5);
    assert.equal(result.error, null);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
