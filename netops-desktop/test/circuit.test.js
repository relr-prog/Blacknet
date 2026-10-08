// What the shell reads out of the daemon's own output, and what it does with the
// port that output names. None of it is inferred: a wrong port or a wrong
// percentage would be shown as fact, and a request that does not actually pass
// through the port would make "the system can" a lie.
//
// Nothing here touches the network outside this machine: the proxy is a fake one
// written for the test, so the assertions hold with no connectivity at all.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");

const {
  CircuitService,
  parseSocksPort,
  parseBootstrap,
  parsePhase,
  parseError,
  findCircuitBinary,
  socksConnect,
  readHttpReply,
  request,
} = require("../src/main/circuit");

test("the SOCKS port is read from the daemon's own listener line", () => {
  const line =
    "Oct 06 14:48:14.000 [notice] Opened Socks listener connection (ready) on 127.0.0.1:54660";
  assert.equal(parseSocksPort(line), 54660);
});

test("lines that are not about the listener give no port", () => {
  assert.equal(parseSocksPort("Oct 06 14:48:14.000 [notice] Bootstrapped 0% (starting): Starting"), null);
  assert.equal(parseSocksPort(""), null);
});

test("bootstrap percentage and phase come from the same line", () => {
  const line =
    "Oct 06 14:48:42.847 [notice] Bootstrapped 69% (loading_descriptors): Loading relay descriptors";
  assert.equal(parseBootstrap(line), 69);
  assert.equal(parsePhase(line), "loading_descriptors");
});

test("a line with no percentage reports no phase either", () => {
  assert.equal(parseBootstrap("Opened Socks listener"), null);
  assert.equal(parsePhase("Opened Socks listener"), "");
});

test("an error line is reported without the timestamp prefix", () => {
  // The failure reason is shown to whoever is watching the log, so they should
  // read the message, not a timestamp they can get from the log itself.
  assert.equal(
    parseError("Oct 06 14:48:42.847 [err] Failed to find an exit node"),
    "Failed to find an exit node",
  );
  assert.equal(
    parseError("Oct 06 14:48:42.847 [notice] Bootstrapped 5% (conn): Connecting to a relay"),
    null,
  );
});

test("the binary is found even when PATH does not contain it", () => {
  // Desktop entries start the shell with a minimal PATH; /usr/sbin is where the
  // package puts the executable and is checked even when PATH omits it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-circuit-bin-"));
  fs.writeFileSync(path.join(dir, "tor"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(findCircuitBinary(dir), path.join(dir, "tor"));
});

test("a service with no binary says so instead of pretending", async () => {
  const service = new CircuitService({ binary: null, userDataPath: os.tmpdir() });
  assert.equal(service.status().available, false);
  assert.equal(await service.start(), "unavailable");
  assert.equal(service.socks(), null);
  assert.equal(service.status().state, "unavailable");
});

test("a service that was never started reports no port", () => {
  const service = new CircuitService({ binary: "/usr/sbin/tor", userDataPath: os.tmpdir() });
  assert.equal(service.socks(), null);
  assert.deepEqual(service.status().socks, null);
  assert.equal(service.status().state, "stopped");
});

// --- the SOCKS conversation ---------------------------------------------------

// A stand-in for the daemon's SOCKS port: it answers the handshake, records the
// CONNECT target, and then speaks HTTP itself. splitReply writes the response in
// two pieces so the byte that arrives while no reader is attached is covered.
function fakeProxy({ httpReply, splitReply = false, onConnect, onRequest } = {}) {
  const server = net.createServer((socket) => {
    let stage = 0;
    function handleConnect(chunk) {
      if (chunk.length < 5 || chunk[1] !== 1) return;
      const atyp = chunk[3];
      let host = "";
      let offset = 4;
      if (atyp === 3) {
        const len = chunk[4];
        host = chunk.subarray(5, 5 + len).toString("utf8");
        offset = 5 + len;
      } else if (atyp === 1) {
        host = Array.from(chunk.subarray(4, 8)).join(".");
        offset = 8;
      }
      const port = chunk.readUInt16BE(offset);
      if (onConnect) onConnect({ host, port });
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      if (!httpReply) return;
      // Whatever the client writes next, after accepting the reply, is its
      // request line - recorded so a test can assert the bytes that were sent.
      socket.once("data", (payload) => {
        if (onRequest) onRequest(payload.toString("utf8"));
        const buffer = Buffer.from(httpReply, "binary");
        if (!splitReply) {
          socket.write(buffer);
          return;
        }
        socket.write(buffer.subarray(0, 4));
        setTimeout(() => socket.write(buffer.subarray(4)), 10);
      });
    }
    socket.on("data", (chunk) => {
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([5, 0])); // method chosen: no authentication
        if (chunk.length > 3) handleConnect(chunk.subarray(3));
        return;
      }
      handleConnect(chunk);
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

test("the CONNECT request carries the name, not a local lookup", async () => {
  const seen = [];
  const server = fakeProxy({ onConnect: (target) => seen.push(target) });
  const port = await listen(server);
  try {
    const socket = await socksConnect(port, "example.test", 80);
    assert.ok(socket.writable);
    await new Promise((resolve) => socket.end(resolve));
    assert.deepEqual(seen, [{ host: "example.test", port: 80 }]);
  } finally {
    server.close();
  }
});

test("a reply that arrives in two pieces is still read whole", async () => {
  const server = fakeProxy({
    splitReply: true,
    httpReply: "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nhello",
  });
  const port = await listen(server);
  try {
    const result = await request(port, "http://example.test/path?q=1");
    assert.equal(result.status, 200);
    assert.equal(result.body, "hello");
    assert.equal(result.bytes, 5);
  } finally {
    server.close();
  }
});

test("a non-default port is dialled and the request line is the caller's", async () => {
  const seen = [];
  let sent = "";
  const server = fakeProxy({
    onConnect: (target) => seen.push(target),
    onRequest: (text) => {
      sent += text;
    },
    httpReply: "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n",
  });
  const port = await listen(server);
  try {
    // An explicit port is passed through as dialled; no local resolver runs.
    const result = await request(port, "http://example.test:8443/missing");
    assert.equal(result.status, 404);
    assert.deepEqual(seen, [{ host: "example.test", port: 8443 }]);
    assert.match(sent, /^GET \/missing HTTP\/1\.1\r\n/);
    assert.match(sent, /Host: example\.test:8443\r\n/);
    assert.match(sent, /Connection: close\r\n/);
  } finally {
    server.close();
  }
});

test("a chunked reply is decoded before it is handed back", async () => {
  const server = fakeProxy({
    httpReply:
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n",
  });
  const port = await listen(server);
  try {
    const result = await request(port, "http://example.test/");
    assert.equal(result.status, 200);
    assert.equal(result.body, "hello world");
  } finally {
    server.close();
  }
});

test("an unsupported scheme is refused before anything is dialled", async () => {
  await assert.rejects(request(1, "ftp://example.test/"), /unsupported scheme/);
});

test("a reply with no length is taken when the connection closes", async () => {
  const stream = new PassThrough();
  const pending = readHttpReply(stream);
  stream.write("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\npartial");
  stream.end();
  const reply = await pending;
  assert.equal(reply.status, 200);
  assert.equal(reply.body.toString(), "partial");
});

test("a reply that stops mid-body does not resolve", async () => {
  const stream = new PassThrough();
  const pending = readHttpReply(stream, { timeoutMs: 50 });
  stream.write("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nshort");
  await assert.rejects(pending, /timed out reading the reply/);
});
