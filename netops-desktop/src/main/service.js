"use strict";

// Supervises the local Python control plane (netops FastAPI). The desktop shell
// owns its lifetime: started on boot, restarted with backoff if it dies, killed
// on quit. If Python is unavailable the shell still runs, just without
// server-backed features - the renderer is told the state instead of hanging.
//
// Two details that are easy to get wrong:
//   * netops reads host/port from netops.toml, never from the environment, so the
//     bind address has to be given to uvicorn on the command line.
//   * `python -m netops.web.app` calls asyncio.run() from inside uvicorn's loop
//     and dies instantly; driving uvicorn directly avoids that entirely.

const { spawn } = require("child_process");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DEFAULT_PORT = 8787;
const READY_ATTEMPTS = 60;
const READY_INTERVAL_MS = 250;
const RESTART_DELAYS_MS = [1000, 2000, 5000, 15000, 30000];
const MAX_RESTARTS = 5;

function candidateHomes() {
  const homes = [];
  if (process.env.NETOPS_HOME) homes.push(process.env.NETOPS_HOME);
  homes.push(path.join(os.homedir(), "projects", "netops"));
  return homes;
}

function findPythonProject() {
  for (const home of candidateHomes()) {
    const python = path.join(home, ".venv", "bin", "python");
    if (fs.existsSync(python) && fs.existsSync(path.join(home, "netops"))) {
      return { home, python };
    }
  }
  return null;
}

function ping(port) {
  return new Promise((resolve) => {
    const request = http.get(
      { host: "127.0.0.1", port, path: "/health", timeout: 750 },
      (response) => {
        response.resume();
        resolve(response.statusCode < 500);
      },
    );
    request.on("error", () => resolve(false));
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class PythonService {
  constructor({ port = DEFAULT_PORT, log } = {}) {
    this.port = port;
    this.log = log || (() => {});
    this.child = null;
    this.project = null;
    this.state = "stopped";
    this.detail = "not started";
    this.restarts = 0;
    this.timer = null;
    this.wanted = false; // the operator asked for it to run

    // If Electron dies without a clean shutdown, do not leave a server behind.
    process.once("exit", () => {
      if (this.child) this.child.kill("SIGKILL");
    });
  }

  async start() {
    this.wanted = true;
    if (this.child || this.state === "starting") return this.state;

    this.project = findPythonProject();
    if (!this.project) {
      this.state = "unavailable";
      this.detail = "no netops checkout found (set NETOPS_HOME)";
      this.log(this.detail);
      return this.state;
    }

    this.state = "starting";
    this.detail = `${this.project.home} on 127.0.0.1:${this.port}`;

    this.child = spawn(
      this.project.python,
      [
        "-m",
        "uvicorn",
        "netops.web.app:get_app",
        "--factory",
        "--host",
        "127.0.0.1",
        "--port",
        String(this.port),
        // The desktop shell renders its own UI; server logging stays quiet.
        "--log-level",
        "warning",
      ],
      {
        cwd: this.project.home,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    this.child.stdout.on("data", (chunk) => this.#note(chunk));
    this.child.stderr.on("data", (chunk) => this.#note(chunk));
    this.child.on("exit", (code, signal) => {
      this.child = null;
      if (!this.wanted) {
        this.state = "stopped";
        this.detail = "stopped on request";
        return;
      }
      this.state = "crashed";
      this.detail = `exited with code ${code} signal ${signal}`;
      this.#scheduleRestart();
    });
    this.child.on("error", (error) => {
      this.child = null;
      this.state = "crashed";
      this.detail = error.message;
      this.#scheduleRestart();
    });

    for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
      if (!this.child) break; // died on the way up; exit handler took over
      if (await ping(this.port)) {
        this.state = "running";
        this.detail = `127.0.0.1:${this.port}`;
        this.restarts = 0;
        this.log(`[python] control plane ready on ${this.detail}`);
        return this.state;
      }
      await sleep(READY_INTERVAL_MS);
    }

    if (this.state === "starting") {
      this.detail = `no answer on 127.0.0.1:${this.port} after ${READY_ATTEMPTS} tries`;
    }
    return this.state;
  }

  #note(chunk) {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) this.log(`[python] ${line.trimEnd()}`);
    }
  }

  // A control plane that dies on its own is a bug the operator needs to see, but
  // a window that is simply gone would leave the shell half-dead. Restart a few
  // times with backoff, then give up and stay honest about it.
  #scheduleRestart() {
    if (this.restarts >= MAX_RESTARTS) {
      this.state = "failed";
      this.detail = `gave up after ${this.restarts} restarts; restart netops-desktop`;
      this.log(`[python] ${this.detail}`);
      return;
    }
    const delay = RESTART_DELAYS_MS[Math.min(this.restarts, RESTART_DELAYS_MS.length - 1)];
    this.restarts += 1;
    this.log(`[python] restarting in ${delay}ms (attempt ${this.restarts}/${MAX_RESTARTS})`);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.start().catch((error) => this.log(`[python] restart failed: ${error.message}`));
    }, delay);
  }

  async stop() {
    this.wanted = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.child) {
      this.state = "stopped";
      this.detail = "stopped on request";
      return;
    }

    this.state = "stopping";
    const child = this.child;
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 3000);
      child.on("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.state = "stopped";
    this.detail = "stopped on request";
  }

  status() {
    return {
      state: this.state,
      detail: this.detail,
      endpoint: this.state === "running" ? `http://127.0.0.1:${this.port}` : null,
      restarts: this.restarts,
    };
  }

  // Electron's clipboard, exposed as the tiny shape the password manager wants.
  // Loaded lazily so this module stays usable in plain Node tests where Electron
  // is not present.
  clipboard() {
    if (!this._clipboard) {
      const { clipboard } = require("electron");
      this._clipboard = {
        writeText: (text) => clipboard.writeText(String(text)),
        readText: () => clipboard.readText(),
      };
    }
    return this._clipboard;
  }
}

module.exports = { PythonService, findPythonProject };