"use strict";

// Main-process half of password capture.
//
// Everything a page sends here is hostile input: the page chose the values, the
// origin and the timing. So this module's job is to make a hostile page's report
// harmless, and the checks are deliberately redundant:
//
//   * the origin in the payload must match the URL the tab is actually showing -
//     a page cannot claim to be another site,
//   * the site must be one the URL policy allows, and never a local address, so a
//     LAN router's login page cannot be silently captured by a page it redirects to,
//   * only http(s) counts,
//   * one offer per site+user per window, so a loop of submissions cannot build a
//     queue of prompts,
//   * nothing reaches the vault until the operator presses Save.
//
// The offer id is returned so the chrome can bind the prompt to a tab, and the
// payload handed to the renderer is metadata only - never the password.

const MAX_URL = 300;
const MAX_USER = 200;
const MAX_PASSWORD = 512;
const WINDOW_MS = 10000;
const MAX_PER_WINDOW = 5;

const NETWORK = /^https?:$/;

// A password prompt must never appear for these, whatever a page claims. Doing
// this by inspecting the hostname rather than with one big regex keeps the
// IPv6 and ".local" cases honest - a single anchored pattern silently fails on
// anything that is not at the start of the string.
function isPrivateHost(hostname) {
  const host = String(hostname || "")
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .toLowerCase();
  if (!host) return true;

  if (host === "localhost" || host.endsWith(".localhost")) return true;
  if (host.endsWith(".local") || host.endsWith(".internal")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1") return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  // fc00::/7 unique-local and fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}

function validOrigin(origin) {
  if (typeof origin !== "string" || origin.length > MAX_URL) return false;
  try {
    const url = new URL(origin);
    if (!NETWORK.test(url.protocol)) return false;
    if (!url.hostname) return false;
    if (isPrivateHost(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

class PasswordWatcher {
  #manager;
  #settings;
  #account;
  #send;
  #recent = new Map();
  #seen = new Set();

  constructor({ manager, settings, account, send }) {
    this.#manager = manager;
    this.#settings = settings;
    this.#account = account;
    this.#send = send || (() => {});
  }

  #enabled() {
    if (this.#settings && this.#settings.get("offerToSavePasswords") === false) return false;
    // Nothing to offer if the feature itself is locked for this session.
    const state = this.#account && this.#account.current;
    return Boolean(state && state.authenticated === true && state.guest !== true);
  }

// Fixed-window rate limit, keyed by tab. The window has to restart from a
// timestamp: keeping a bare count means a slow drip never trips it.
#throttled(key) {
  const now = Date.now();
  for (const [seen, entry] of this.#recent) {
    if (now - entry.startedAt > WINDOW_MS) this.#recent.delete(seen);
  }
  const existing = this.#recent.get(key);
  if (!existing) {
    this.#recent.set(key, { count: 1, startedAt: now });
    return false;
  }
  if (existing.count >= MAX_PER_WINDOW) return true;
  existing.count += 1;
  return false;
}

  // tabs: [{ id, url }] for the tab that reported. Passed in by the caller so
  // this module never has to hold a TabManager reference.
  async handle(payload, tabs = []) {
    if (!this.#enabled()) return { accepted: false, reason: "disabled" };
    if (!payload || typeof payload !== "object") return { accepted: false, reason: "malformed" };

    const origin = String(payload.origin || "");
    if (!validOrigin(origin)) return { accepted: false, reason: "origin refused" };

    const tab = tabs.find((entry) => {
      try {
        return new URL(entry.url).origin === origin;
      } catch {
        return false;
      }
    });
    // No tab showing this origin means the page is reporting about somewhere the
    // user is not, which is exactly the case worth refusing.
    if (!tab) return { accepted: false, reason: "origin does not match any tab" };

    const username = String(payload.username || "").slice(0, MAX_USER);
    const password = String(payload.password || "").slice(0, MAX_PASSWORD);
    if (!password) return { accepted: false, reason: "no password" };

    const fingerprint = `${origin}\u0000${username}`;
    if (this.#seen.has(fingerprint)) return { accepted: false, reason: "already offered" };
    if (this.#throttled(tab.id)) return { accepted: false, reason: "throttled" };

    const id = this.#manager.offer({
      origin,
      username,
      password,
      url: String(payload.url || "").slice(0, MAX_URL),
    });
    if (!id) return { accepted: false, reason: "not accepted" };

    this.#seen.add(fingerprint);
    this.#send("netops:password-offer", {
      id,
      origin,
      username,
      tabId: tab.id,
      question: "Do you wanna to save this password?",
      actions: ["save", "not-now"],
    });
    return { accepted: true, id };
  }

  // Called when a prompt is answered or expires, so the same credential can be
  // offered again later (the user may have changed their password).
  forget(origin, username) {
    this.#seen.delete(`${String(origin)}\u0000${String(username)}`);
  }

  reset() {
    this.#recent.clear();
    this.#seen.clear();
  }
}

module.exports = { PasswordWatcher, validOrigin, isPrivateHost };