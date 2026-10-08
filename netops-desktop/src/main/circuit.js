"use strict";

// Runs a local circuit daemon as a child process, the way the shell already runs
// the rotating gateway: the process is ours, the port is read back from what it
// says rather than assumed, and the state is what was observed rather than what
// we hoped happened.
//
// Three things this deliberately does not do:
//   * It does not use a service another process may already have listening. That
//     would make "on" mean "a port is open locally" instead of "we started it,
//     we can see its bootstrap, and we can stop it".
//   * It does not read a system-wide configuration file (-f points at one we
//     write). Nothing an administrator configured can turn this into a relay or
//     fight the settings.
//   * It does not treat an open SOCKS port as proof of a circuit. Anything that
//     matters is answered by making a request through the port.
//
// Reach: main process only. This module is never put on the IPC action map, so
// no renderer can start it, ask it for a port, or send a request through it.
// Tabs get their proxy from the gateway and the pool, never from here.

const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const tls = require("tls");

const READY_ATTEMPTS = 240; // 60s: bootstrap is a network operation, not a local one
const READY_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3000;
const READ_TIMEOUT_MS = 15000;
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

// "Opened Socks listener connection (ready) on 127.0.0.1:55545"
const SOCKS_LINE = /Opened Socks listener.* on 127\.0\.0\.1:(\d+)/;
// "[notice] Bootstrapped 62% (loading_descriptors): Loading relay descriptors"
const BOOTSTRAP_LINE = /Bootstrapped (\d+)%/;
const PHASE_LINE = /Bootstrapped (\d+)% \(([^)]+)\)/;
const ERROR_LINE = /\[err\]/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseSocksPort(line) {
  const match = SOCKS_LINE.exec(line);
  return match ? Number(match[1]) : null;
}

function parseBootstrap(line) {
  const match = BOOTSTRAP_LINE.exec(line);
  return match ? Number(match[1]) : null;
}

// The daemon's own word for the phase, kept because it is what somebody reading
// its log would see. Inventing our own vocabulary would make the shell and the
// log disagree about the same event.
function parsePhase(line) {
  const match = PHASE_LINE.exec(line);
  return match ? match[2] : "";
}

// Everything up to and including "[err]" is dropped, so what is left is the
// message itself. The timestamp is deliberately not kept: this string is what a
// caller shows as the failure reason, and the time is already in the log.
function parseError(line) {
  if (!ERROR_LINE.test(line)) return null;
  const at = line.indexOf("[err]");
  const message = line.slice(at + "[err]".length).trim();
  return message || line;
}

// Where the binary might be. Checked in order, and /usr/sbin is appended
// because the shell is sometimes started from a desktop entry whose minimal
// PATH does not include it - which would report the capability as missing on a
// machine that has it.
function findCircuitBinary(envPath = process.env.PATH) {
  const dirs = String(envPath || "").split(path.delimiter).filter(Boolean);
  for (const extra of ["/usr/sbin", "/usr/bin"]) if (!dirs.includes(extra)) dirs.push(extra);
  for (const dir of dirs) {
    const candidate = path.join(dir, "tor");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

// --- reading through the SOCKS port -------------------------------------------
//
// One 'data' listener for the whole negotiation. Attaching and detaching a
// listener per read loses whatever lands in the gap between reads, and the
// reply to the CONNECT request arrives in exactly such a gap - which is how the
// first attempt at this hung instead of failing.
function makeReader(socket) {
  let incoming = Buffer.alloc(0);
  let waiting = null;

  const settle = (apply) => {
    const pending = waiting;
    waiting = null;
    if (pending) {
      clearTimeout(pending.timer);
      apply(pending);
    }
  };

  const onData = (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    if (!waiting || incoming.length < waiting.n) return;
    const out = incoming.subarray(0, waiting.n);
    incoming = incoming.subarray(waiting.n);
    settle((pending) => pending.resolve(out));
  };
  const onError = (error) => settle((pending) => pending.reject(error));
  const onClose = () => settle((pending) => pending.reject(new Error("connection closed")));

  socket.on("data", onData);
  socket.on("error", onError);
  socket.on("close", onClose);

  return {
    read(n, timeoutMs = READ_TIMEOUT_MS) {
      if (waiting) return Promise.reject(new Error("overlapping read"));
      if (incoming.length >= n) {
        const out = incoming.subarray(0, n);
        incoming = incoming.subarray(n);
        return Promise.resolve(out);
      }
      return new Promise((resolve, reject) => {
        waiting = {
          n,
          resolve,
          reject,
          timer: setTimeout(() => {
            waiting = null;
            reject(new Error(`timed out reading ${n} bytes from the proxy`));
          }, timeoutMs),
        };
      });
    },
    // The proxy layer is done; whatever reads the socket next attaches its own
    // listeners. Leaving ours in place would swallow the TLS handshake.
    detach() {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
      const surplus = incoming;
      incoming = Buffer.alloc(0);
      return surplus;
    },
  };
}

// CONNECT through the local SOCKS port. ATYP=3, so the *name* goes to the proxy
// and resolution happens on the far side - which is the whole point for names
// that do not resolve here.
async function socksConnect(proxyPort, host, port) {
  const socket = net.connect({ port: proxyPort, host: "127.0.0.1" });
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const reader = makeReader(socket);
  socket.write(Buffer.from([5, 1, 0])); // SOCKS5, one method: no authentication
  const greet = await reader.read(2);
  if (greet[0] !== 5 || greet[1] !== 0) {
    socket.destroy();
    throw new Error(`the proxy did not accept the handshake (${greet.toString("hex")})`);
  }
  const hostBuf = Buffer.from(host, "utf8");
  if (hostBuf.length > 255) {
    socket.destroy();
    throw new Error("the name is too long for the proxy protocol");
  }
  socket.write(
    Buffer.concat([
      Buffer.from([5, 1, 0, 3, hostBuf.length]),
      hostBuf,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]),
  );
  const head = await reader.read(4);
  if (head[1] !== 0) {
    socket.destroy();
    throw new Error(`the proxy refused the connection (${head[1]})`);
  }
  if (head[3] === 1) await reader.read(4 + 2);
  else if (head[3] === 3) {
    const len = await reader.read(1);
    await reader.read(len[0] + 2);
  } else if (head[3] === 4) await reader.read(16 + 2);
  else {
    socket.destroy();
    throw new Error(`unexpected address type ${head[3]} in the proxy reply`);
  }
  const surplus = reader.detach();
  if (surplus.length) socket.unshift(surplus); // hand the socket back intact
  return socket;
}

// Split a chunked body into one buffer, or null while it is still incomplete.
function dechunk(buffer) {
  const parts = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf("\r\n", offset);
    if (lineEnd < 0) return null;
    const size = Number.parseInt(buffer.subarray(offset, lineEnd).toString("ascii"), 16);
    if (!Number.isFinite(size)) return null;
    if (size === 0) return Buffer.concat(parts);
    const start = lineEnd + 2;
    if (buffer.length < start + size + 2) return null;
    parts.push(buffer.subarray(start, start + size));
    offset = start + size + 2;
  }
  return null;
}

// Read one HTTP reply off a stream: headers first, then a body sized by
// content-length, by chunked framing, or by the connection closing. Bounded in
// both time and bytes - this runs inside the shell, so a hostile or endless
// reply must not be able to hold the process.
function readHttpReply(stream, { timeoutMs = REQUEST_TIMEOUT_MS, maxBytes = MAX_RESPONSE_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("close", onEnd);
      stream.removeListener("error", onError);
      // A later error still has to go somewhere: an EventEmitter with no 'error'
      // listener turns a stray byte into a crash of the whole shell.
      stream.on("error", () => {});
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error("timed out reading the reply")), timeoutMs);
    const fail = (error) => finish(error instanceof Error ? error : new Error(String(error)));
    const onError = (error) => fail(error);

    const body = () => {
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) return null;
      const head = buffer.subarray(0, split).toString("utf8");
      const status = Number((head.split("\r\n")[0] || "").split(" ")[1]) || 0;
      const rest = buffer.subarray(split + 4);
      const length = /content-length:\s*(\d+)/i.exec(head);
      if (length) {
        const want = Number(length[1]);
        if (rest.length < want) return null;
        return { status, head, body: rest.subarray(0, want) };
      }
      if (/transfer-encoding:\s*chunked/i.test(head)) {
        const decoded = dechunk(rest);
        return decoded ? { status, head, body: decoded } : null;
      }
      return null; // sized by the connection closing
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > maxBytes) {
        fail(new Error(`reply larger than ${maxBytes} bytes`));
        return;
      }
      const reply = body();
      if (reply) finish(null, reply);
    };
    const onEnd = () => {
      const reply = body();
      if (reply) {
        finish(null, reply);
        return;
      }
      const split = buffer.indexOf("\r\n\r\n");
      if (split < 0) {
        finish(new Error("the connection closed before the headers arrived"));
        return;
      }
      const head = buffer.subarray(0, split).toString("utf8");
      finish(null, {
        status: Number((head.split("\r\n")[0] || "").split(" ")[1]) || 0,
        head,
        body: buffer.subarray(split + 4),
      });
    };

    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    stream.on("error", onError);
  });
}

// One GET through the local SOCKS port, by hand rather than through the http
// module: the socket has to be negotiated before any request line exists, and
// Node's agents do not offer a hook early enough for that.
async function request(proxyPort, url, options = {}) {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error(`unsupported scheme ${target.protocol}`);
  }
  const secure = target.protocol === "https:";
  const port = target.port ? Number(target.port) : secure ? 443 : 80;
  const socket = await socksConnect(proxyPort, target.hostname, port);
  try {
    let stream = socket;
    if (secure) {
      stream = await new Promise((resolve, reject) => {
        const wrapper = tls.connect({ socket, servername: target.hostname });
        const timer = setTimeout(() => {
          wrapper.destroy();
          reject(new Error("timed out on the encrypted handshake"));
        }, READ_TIMEOUT_MS);
        wrapper.once("secureConnect", () => {
          clearTimeout(timer);
          resolve(wrapper);
        });
        wrapper.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });
    }
    stream.write(
      `GET ${target.pathname || "/"}${target.search || ""} HTTP/1.1\r\n` +
        `Host: ${target.host}\r\n` +
        "User-Agent: BlackNet\r\n" +
        "Accept: */*\r\n" +
        "Accept-Encoding: identity\r\n" +
        "Connection: close\r\n\r\n",
    );
    const reply = await readHttpReply(stream, options);
    return { status: reply.status, body: reply.body.toString("utf8"), bytes: reply.body.length };
  } finally {
    socket.destroy();
  }
}

class CircuitService {
  constructor({ log, userDataPath, binary } = {}) {
    this.log = log || (() => {});
    this.userDataPath = userDataPath || "";
    this.binary = binary === undefined ? findCircuitBinary() : binary;

    this.child = null;
    this.state = "stopped"; // stopped | starting | bootstrapping | running | crashed | unavailable | stopping
    this.detail = "not connected";
    this.bootstrap = 0;
    this.phase = "";
    this.port = null;
    this.wanted = false;
    this.lastError = "";

    // If the shell dies without a clean shutdown, do not leave it behind.
    process.once("exit", () => {
      if (this.child) this.child.kill("SIGKILL");
    });
  }

  dataDirectory() {
    return path.join(this.userDataPath, "circuit");
  }

  socks() {
    if (this.state !== "running" || !this.port) return null;
    return `socks5://127.0.0.1:${this.port}`;
  }

  status() {
    return {
      available: Boolean(this.binary),
      binary: this.binary,
      state: this.state,
      detail: this.detail,
      bootstrap: this.bootstrap,
      phase: this.phase,
      port: this.port,
      socks: this.socks(),
      error: this.lastError || null,
    };
  }

  async start() {
    this.wanted = true;
    if (this.state === "running" && this.port) return this.state;
    if (this.child) return this.awaitReady(); // already coming up

    if (!this.binary) {
      this.state = "unavailable";
      this.detail = "the circuit daemon is not installed";
      this.log(`[circuit] ${this.detail} (checked PATH and /usr/sbin)`);
      return this.state;
    }

    const dir = this.dataDirectory();
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // Our own config, so nothing a system administrator wrote applies: the
      // data directory is private to this profile and SocksPort auto avoids
      // colliding with anything else that may already hold a fixed port.
      fs.writeFileSync(
        path.join(dir, "circuit.conf"),
        [
          `DataDirectory ${dir}`,
          "SocksPort auto",
          "Log notice stdout",
          "RunAsDaemon 0",
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
    } catch (error) {
      this.state = "crashed";
      this.detail = error.message;
      this.log(`[circuit] ${error.message}`);
      return this.state;
    }

    this.state = "starting";
    this.detail = "starting";
    this.bootstrap = 0;
    this.phase = "";
    this.port = null;
    this.lastError = "";

    this.child = spawn(this.binary, ["-f", path.join(dir, "circuit.conf")], {
      cwd: dir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (line) => {
      this.log(`[circuit] ${line}`);

      const port = parseSocksPort(line);
      if (port && !this.port) {
        this.port = port;
        if (this.state === "starting") {
          this.state = "bootstrapping";
          this.detail = "building a circuit";
        }
      }

      const percent = parseBootstrap(line);
      if (percent !== null) {
        const phase = parsePhase(line);
        if (phase) this.phase = phase;
        if (percent > this.bootstrap || percent === 100) this.bootstrap = percent;
        if (percent >= 100) {
          this.state = "running";
          this.detail = "connected";
        } else if (this.state !== "crashed") {
          this.state = "bootstrapping";
          this.detail = `bootstrapped ${percent}% (${this.phase || "working"})`;
        }
      }

      const error = parseError(line);
      if (error) this.lastError = error;
    };

    for (const stream of [this.child.stdout, this.child.stderr]) {
      stream.on("data", (chunk) => {
        for (const line of chunk.toString().split("\n")) if (line.trim()) onLine(line.trim());
      });
    }

    this.child.on("exit", (code, signal) => {
      this.child = null;
      this.port = null;
      this.bootstrap = 0;
      if (!this.wanted) {
        this.state = "stopped";
        this.detail = "not connected";
      } else {
        this.state = "crashed";
        this.detail = this.lastError || `exited with code ${code} signal ${signal}`;
      }
      this.log(`[circuit] ${this.detail}`);
    });

    this.child.on("error", (error) => {
      this.child = null;
      this.state = "crashed";
      this.detail = error.message;
      this.log(`[circuit] ${error.message}`);
    });

    return this.awaitReady();
  }

  // Waits for a circuit. Returns whatever state we end in rather than throwing,
  // because "still bootstrapping" is a state a caller has to show, not an error
  // the caller has to swallow.
  async awaitReady() {
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (this.state === "running" || this.state === "crashed" || this.state === "unavailable") {
        return this.state;
      }
      if (!this.wanted || !this.child) return this.state;
      await sleep(READY_INTERVAL_MS);
    }
    return this.state;
  }

  async stop() {
    this.wanted = false;
    const child = this.child;
    if (!child) {
      this.state = "stopped";
      this.detail = "not connected";
      this.port = null;
      this.bootstrap = 0;
      return this.state;
    }

    this.state = "stopping";
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, STOP_GRACE_MS);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.child = null;
    this.port = null;
    this.bootstrap = 0;
    this.state = "stopped";
    this.detail = "not connected";
    return this.state;
  }

  // The shell's own client. This is the one caller that may reach a name a tab
  // cannot: it runs in the main process, is never registered on the IPC action
  // map, and therefore cannot be reached from a renderer or a page.
  async fetch(url, options = {}) {
    if (!this.port || this.state !== "running") {
      const state = await this.start();
      if (state !== "running") throw new Error(this.detail || "no circuit available");
    }
    return request(this.port, url, options);
  }
}

module.exports = {
  CircuitService,
  parseSocksPort,
  parseBootstrap,
  parsePhase,
  parseError,
  findCircuitBinary,
  makeReader,
  socksConnect,
  readHttpReply,
  request,
};
