"use strict";

// Runs the rotating proxy gateway as a child process and talks to its status
// port directly. It used to be a library imported inside the Python control
// plane and reached over HTTP, which meant the browser shipped a second language
// runtime and a localhost web server just to switch a proxy on. The gateway is
// already a standalone daemon (`rotator serve`), so the shell supervises it the
// same way it supervises everything else.
//
// Two details that are easy to get wrong:
//   * The listening ports are not known up front. rotator.toml asks for 8888,
//     but the gateway picks a different port when that one is taken, so the
//     ports are read back from its startup line rather than assumed.
//   * A gateway with no healthy upstreams still listens. "running" therefore
//     means the process is up and answering /status, not that traffic will flow.

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const READY_ATTEMPTS = 40;
const READY_INTERVAL_MS = 250;
const STOP_GRACE_MS = 3000;
const STATUS_TIMEOUT_MS = 1500;

// "listening: http=127.0.0.1:8888 socks5=127.0.0.1:1080 status=127.0.0.1:9099 | ..."
// A disabled front end is logged as "-", which means "no such port".
const LISTENING = /listening:\s*http=(\S+)\s+socks5=(\S+)\s+status=(\S+)/;

function candidateHomes() {
  const homes = [];
  if (process.env.ROTATOR_HOME) homes.push(process.env.ROTATOR_HOME);
  homes.push(path.join(os.homedir(), "projects", "proxy-rotator"));
  return homes;
}

function findRotatorProject() {
  for (const home of candidateHomes()) {
    const bin = path.join(home, ".venv", "bin", "rotator");
    const config = path.join(home, "rotator.toml");
    if (fs.existsSync(bin) && fs.existsSync(config)) return { home, bin, config };
  }
  return null;
}

function parsePorts(line) {
  const match = LISTENING.exec(line);
  if (!match) return null;
  const clean = (value) => (value && value !== "-" ? value : null);
  return { http: clean(match[1]), socks5: clean(match[2]), status: clean(match[3]) };
}

function getJson(hostPort, path_, timeout = STATUS_TIMEOUT_MS) {
  const index = hostPort.lastIndexOf(":");
  if (index <= 0) return Promise.reject(new Error("bad address"));
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: hostPort.slice(0, index), port: Number(hostPort.slice(index + 1)), path: path_, timeout },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 512 * 1024) request.destroy();
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`http ${response.statusCode}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`bad json: ${error.message}`));
          }
        });
      },
    );
    request.on("error", reject);
    request.on("timeout", () => {
      request.destroy();
      reject(new Error("timeout"));
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class RotatorService {
  constructor({ log } = {}) {
    this.log = log || (() => {});
    this.child = null;
    this.project = null;
    this.state = "stopped";
    this.detail = "not started";
    this.ports = { http: null, socks5: null, status: null };
    this.wanted = false; // the operator asked for it to run

    // If Electron dies without a clean shutdown, do not leave a proxy behind.
    process.once("exit", () => {
      if (this.child) this.child.kill("SIGKILL");
    });
  }

  async start() {
    this.wanted = true;
    if (this.child || this.state === "starting") return this.state;

    this.project = findRotatorProject();
    if (!this.project) {
      this.state = "unavailable";
      this.detail = "no proxy-rotator checkout found (set ROTATOR_HOME)";
      this.log(`[rotator] ${this.detail}`);
      return this.state;
    }

    this.state = "starting";
    this.detail = "starting";

    this.child = spawn(this.project.bin, ["serve", "-c", this.project.config], {
      cwd: this.project.home,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const onLine = (line) => {
      if (!this.ports.http) {
        const ports = parsePorts(line);
        if (ports) this.ports = ports;
      }
      this.log(`[rotator] ${line}`);
    };
    this.child.stdout.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) onLine(line.trimEnd());
    });
    this.child.stderr.on("data", (chunk) => {
      for (const line of chunk.toString().split("\n")) if (line.trim()) onLine(line.trimEnd());
    });

    this.child.on("exit", (code, signal) => {
      this.child = null;
      this.ports = { http: null, socks5: null, status: null };
      if (!this.wanted) {
        this.state = "stopped";
        this.detail = "stopped on request";
        return;
      }
      this.state = "crashed";
      this.detail = `exited with code ${code} signal ${signal}`;
    });
    this.child.on("error", (error) => {
      this.child = null;
      this.ports = { http: null, socks5: null, status: null };
      this.state = "crashed";
      this.detail = error.message;
    });

    // Listening is not the same as ready: wait for /status to answer too, so the
    // switch never claims to be on before the pool has been read.
    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (!this.child) break; // died on the way up; the exit handler took over
      if (this.ports.status) {
        try {
          const body = await getJson(this.ports.status, "/status");
          this.state = "running";
          this.detail = describe(body);
          this.log(`[rotator] gateway ready on ${this.ports.http} | ${this.detail}`);
          return this.state;
        } catch {
          // still coming up
        }
      }
      await sleep(READY_INTERVAL_MS);
    }

    if (this.state === "starting") {
      this.state = this.child ? "running" : "crashed";
      if (this.child) this.detail = "gateway did not report a usable status port";
    }
    return this.state;
  }

  async stop() {
    this.wanted = false;
    if (!this.child) {
      this.state = "stopped";
      this.detail = "stopped on request";
      this.ports = { http: null, socks5: null, status: null };
      return this.state;
    }

    this.state = "stopping";
    const child = this.child;
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
    this.ports = { http: null, socks5: null, status: null };
    this.state = "stopped";
    this.detail = "stopped on request";
    return this.state;
  }

  // The proxy Chromium should use, or null when the gateway is not up. This is
  // what replaces the control plane's rotator for tabs.
  proxy() {
    if (this.state !== "running" || !this.ports.http) return null;
    return `http://${this.ports.http}`;
  }

  socks() {
    if (this.state !== "running" || !this.ports.socks5) return null;
    return `socks5://${this.ports.socks5}`;
  }

  status() {
    return {
      state: this.state,
      detail: this.detail,
      proxy: this.proxy(),
      socks: this.socks(),
      ports: { ...this.ports },
    };
  }

  // Pool health straight from the gateway, for the rotator switch and the
  // settings view. Returns null when the gateway is not answering.
  async snapshot() {
    if (this.state !== "running" || !this.ports.status) return null;
    try {
      const body = await getJson(this.ports.status, "/status");
      return {
        uptimeSeconds: Number(body.uptime_seconds) || 0,
        connections: Number(body.connections) || 0,
        strategy: (body.pool && body.pool.strategy) || "",
        upstreams: (body.pool && Number(body.pool.upstreams)) || 0,
        healthy: (body.pool && Number(body.pool.healthy)) || 0,
        countries: (body.pool && body.pool.countries) || [],
        detail: describe(body),
      };
    } catch {
      return null;
    }
  }
}

// A gateway can be listening with nothing healthy behind it, and "listening" on
// its own would tell the operator their traffic is rotating when it is not.
function describe(body) {
  const pool = (body && body.pool) || {};
  const total = Number(pool.upstreams) || 0;
  const healthy = Number(pool.healthy) || 0;
  if (!total) return "no upstreams configured";
  if (!healthy) return `no healthy upstreams (${total} configured)`;
  return `${healthy}/${total} upstreams healthy`;
}

module.exports = { RotatorService, findRotatorProject, parsePorts, describe };