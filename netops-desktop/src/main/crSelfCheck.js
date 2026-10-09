"use strict";

// The shell's own reachability self-check for its local circuit daemon.
//
// The browser refuses a name in the refused family before it builds anything: a
// tab never makes the request. The shell keeps a client of its own (./circuit)
// that can reach such a name, and this module is the one caller of it. It owns a
// single question the client can answer and nothing else can: does the circuit
// actually carry a request, or is it only a port that happens to be open? An open
// port proves a listener; only a request that came back proves the circuit.
//
// It is off unless the profile asks for it (config.circuit.enabled). When it is
// on, it starts the daemon, asks once through the client's own port, records the
// answer, and refreshes it on a slow timer. When it is off it does nothing at
// all - it does not start a daemon to check a daemon nobody wanted.
//
// Main process only. Nothing here is on the IPC action map, so no renderer or
// page can start the daemon, ask for its port, or send a request through it. The
// status is kept for the shell's own log, not for a page.

const { CircuitService } = require("./circuit");

const DEFAULT_URL = "https://example.com/";
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30000;

class CrSelfCheck {
  constructor({ log, config, service, userDataPath, now, setInterval: schedule, clearInterval: cancel } = {}) {
    this.log = log || (() => {});
    this.config = (config && config.circuit) || {};
    this.now = now || Date.now;
    // Timers are injectable so a test drives the interval instead of waiting it
    // out, and the service is injectable so the daemon never has to run.
    this.schedule = schedule || setInterval;
    this.cancel = cancel || clearInterval;
    this.service = service || new CircuitService({ log: this.log, userDataPath: userDataPath || "" });
    this.timer = null;
    this.result = { reachable: null, status: 0, bytes: 0, checkedAt: null, error: null };
  }

  enabled() {
    return this.config.enabled === true;
  }

  url() {
    return typeof this.config.selfCheckUrl === "string" && this.config.selfCheckUrl
      ? this.config.selfCheckUrl
      : DEFAULT_URL;
  }

  intervalMs() {
    return Number.isFinite(this.config.selfCheckIntervalMs)
      ? Math.max(0, this.config.selfCheckIntervalMs)
      : DEFAULT_INTERVAL_MS;
  }

  timeoutMs() {
    return Number.isFinite(this.config.timeoutMs) ? this.config.timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  status() {
    return {
      enabled: this.enabled(),
      reachable: this.result.reachable,
      status: this.result.status,
      bytes: this.result.bytes,
      checkedAt: this.result.checkedAt,
      error: this.result.error,
      daemon: this.service.status(),
    };
  }

  // One question, answered by the client: did a request come back? A rejection
  // becomes a recorded answer rather than a thrown error, because "the circuit
  // did not carry a request" is the answer, not a failure of the check itself.
  async check() {
    try {
      const reply = await this.service.fetch(this.url(), { timeoutMs: this.timeoutMs() });
      const ok = reply.status >= 200 && reply.status < 400;
      this.result = {
        reachable: ok,
        status: reply.status,
        bytes: reply.bytes,
        checkedAt: this.now(),
        error: ok ? null : `the circuit answered with HTTP ${reply.status}`,
      };
    } catch (error) {
      this.result = {
        reachable: false,
        status: 0,
        bytes: 0,
        checkedAt: this.now(),
        error: error.message,
      };
    }
    this.log(
      `[cr-self-check] ${this.result.reachable ? "reached" : "not reached"} ${this.url()}` +
        (this.result.error ? ` (${this.result.error})` : ""),
    );
    return this.result;
  }

  async start() {
    if (!this.enabled()) {
      this.log("[cr-self-check] disabled");
      return this.status();
    }
    await this.check();
    const interval = this.intervalMs();
    if (interval > 0 && !this.timer) {
      this.timer = this.schedule(() => {
        void this.check();
      }, interval);
    }
    return this.status();
  }

  async stop() {
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    await this.service.stop();
    return this.status();
  }
}

module.exports = { CrSelfCheck, DEFAULT_URL, DEFAULT_INTERVAL_MS, DEFAULT_TIMEOUT_MS };
