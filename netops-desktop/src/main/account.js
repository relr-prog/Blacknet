"use strict";

// Account state for the shell.
//
// The control plane owns identities; this module only asks it who the current
// browser session is and caches the answer. Two facts matter to the UI:
//
//   guest        - anonymous session: read-only, and the account/password
//                  features must not exist for it at all.
//   authenticated- a real account, so those features unlock.
//
// Guest is treated as "logged out with extra steps" on purpose: a guest cookie
// must never be a way to reach an admin-only surface, and the shell must not
// pretend a guest can own a password vault.

const SESSION_COOKIES = ["netops_session", "netops_guest"];
const DEFAULT_TIMEOUT_MS = 4000;

// How long a cached answer is trusted. Long enough that opening Settings does
// not hammer the control plane, short enough that a logout in the dashboard is
// noticed while the operator is still looking at the screen.
const CACHE_MS = 5000;

class Account {
  #endpoint;
  #fetch;
  #cache = null;
  #inflight = null;

  constructor({ endpoint, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.#endpoint = String(endpoint || "").replace(/\/+$/, "");
    this.#fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  // --- cookie plumbing -----------------------------------------------------
  // The session cookie lives in the tab's Chromium session, not in the shell, so
  // the caller hands us the cookie header it read from the profile.
  static cookieHeader(cookies, url) {
    const jar = Array.isArray(cookies) ? cookies : [];
    const target = new URL(url);
    const applicable = jar.filter((cookie) => {
      if (!cookie || typeof cookie.name !== "string") return false;
      const domain = String(cookie.domain || "").replace(/^\./, "");
      if (domain && target.hostname !== domain && !target.hostname.endsWith(`.${domain}`)) {
        return false;
      }
      if (cookie.secure && target.protocol !== "https:") return false;
      return true;
    });
    if (applicable.length === 0) return "";
    return applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  }

  static isGuestCookie(cookies) {
    const jar = Array.isArray(cookies) ? cookies : [];
    return jar.some((cookie) => cookie && cookie.name === "netops_guest");
  }

  // --- state ---------------------------------------------------------------
  // shape: { authenticated, guest, username, role, isAdmin, setupRequired,
  //          reason, checkedAt }
  describe(state) {
    const user = state && state.user ? state.user : null;
    const authenticated = Boolean(state && state.authenticated && user);
    // Trust the explicit flag from the control plane, but never let a guest
    // look authenticated even if a future role name slips through.
    const guest = Boolean(user && (user.is_guest === true || user.guest === true));
    const role = authenticated ? String(user.role || "operator") : "anonymous";
    // A caller may pass a reason through (an http status, a transport error);
    // keep it, otherwise fall back to the plain signed-out wording.
    const reason = authenticated || guest ? "" : String((state && state.reason) || "signed out");
    return {
      authenticated: authenticated && !guest,
      guest,
      username: authenticated ? String(user.username || "") : null,
      role: guest ? "guest" : role,
      isAdmin: authenticated && !guest && role === "admin",
      setupRequired: Boolean(state && state.setup_required),
      reason,
      checkedAt: Date.now(),
    };
  }

  async refresh(cookies) {
    const header = Account.cookieHeader(cookies, this.#endpoint);
    if (!this.#endpoint || !this.#fetch) {
      return this.describe({ authenticated: false });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.#fetch(`${this.#endpoint}/api/auth/state`, {
        method: "GET",
        headers: header ? { cookie: header } : {},
        signal: controller.signal,
      });
      if (!response.ok) {
        return this.describe({ authenticated: false, reason: `http ${response.status}` });
      }
      const body = await response.json();
      return this.describe(body);
    } catch (error) {
      // Offline or a control plane that is still starting is not an error the
      // operator can act on; it just means "no account right now".
      return this.describe({ authenticated: false, reason: error.message });
    } finally {
      clearTimeout(timer);
    }
  }

  // Cached read for the settings UI; concurrent callers share one request.
  async state(cookies, { force = false } = {}) {
    const now = Date.now();
    if (!force && this.#cache && now - this.#cache.checkedAt < CACHE_MS) return this.#cache;
    if (this.#inflight) return this.#inflight;

    this.#inflight = this.refresh(cookies)
      .then((state) => {
        this.#cache = state;
        return state;
      })
      .finally(() => {
        this.#inflight = null;
      });
    return this.#inflight;
  }

  // The last known state, synchronously.
  //
  // Gating has to answer "may this session use the password manager?" without an
  // await, because it runs inside a synchronous permission check. Callers that
  // need fresh data call state(cookies, { force: true }) first.
  get current() {
    return this.#cache;
  }

  invalidate() {
    this.#cache = null;
  }

  // Feature gating, in one place so the UI cannot disagree with itself.
  //
  //   guest / signed out -> locked, and the UI must not render the feature
  //   account              -> unlocked
  static gate(state, feature) {
    const value = state || {};
    const known = value.authenticated === true && value.guest !== true;
    if (!known) {
      return {
        unlocked: false,
        locked: true,
        reason: value.guest ? "guest" : "signed out",
        message: "Please log in to unlock this feature.",
      };
    }
    return { unlocked: true, locked: false, reason: "", message: "" };
  }

  static requiresAdmin(state, action = "this action") {
    // Guest is checked before "logged in" so the message names the real blocker:
    // a guest session is present but structurally unable to do this.
    if (state && state.guest) throw new Error("guest sessions cannot " + action);
    if (!state || state.authenticated !== true) {
      throw new Error("log in first");
    }
    if (!state.isAdmin) throw new Error("administrator role required to " + action);
  }
}

module.exports = { Account, SESSION_COOKIES };