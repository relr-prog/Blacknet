"use strict";

// Every privileged operation the chrome UI can ask for, in one map.
//
// main.js registers these on ipcMain; the smoke test calls them directly. That
// keeps the verification honest - it exercises the real code path, not a
// parallel test-only copy.
//
// The settings/account/password actions are added here rather than in main.js so
// there is exactly one list of what the renderer can reach. Each one either
// returns public data or goes through the gating in its own module; nothing in
// this file is trusted to enforce access control.

const { detectAudio } = require("./audio");
const { Account } = require("./account");

// The rotator is admin-only in the control plane. This mirrors that rule in the
// shell so a guest switch is refused before a request is made, and the UI can
// explain why without a round trip.
//
// The session cookie has to travel with the request. Without it the control
// plane sees an anonymous caller and answers 401/403 no matter who is signed in,
// which is why the switch looked broken while the local gate happily passed.
function rotatorAction(settings, account, endpoint, cookies) {
  return async function (enabled) {
    const want = Boolean(enabled);
    const state = account ? account.current : null;
    if (!state || state.authenticated !== true || state.guest === true) {
      const reason = state && state.guest ? "guest" : "signed out";
      throw new Error(`log in as an administrator to change the rotator (${reason})`);
    }
    if (!state.isAdmin) throw new Error("administrator role required to change the rotator");

    const header = typeof cookies === "function" ? await cookies() : cookies;
    const response = await fetch(`${endpoint}/api/rotator/${want ? "start" : "stop"}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(header ? { cookie: header } : {}),
      },
      body: JSON.stringify({}),
    });
    if (!response.ok) {
      throw new Error(`the rotator service refused the change (http ${response.status})`);
    }
    const body = await response.json().catch(() => ({}));
    // The service is the source of truth for whether it is running; the stored
    // preference only mirrors it for the next paint.
    return settings.setRotatorState({
      enabled: want,
      state: body.state || (want ? "running" : "stopped"),
      detail: body.detail || "",
      adminOnly: true,
    });
  };
}

async function rotatorStatus(settings, endpoint, cookies) {
  const stored = settings.all();
  try {
    const header = typeof cookies === "function" ? await cookies() : cookies;
    const response = await fetch(`${endpoint}/api/rotator/status`, {
      headers: header ? { cookie: header } : {},
    });
    if (!response.ok) throw new Error(`http ${response.status}`);
    const body = await response.json();
    const enabled = Boolean(body.enabled ?? body.running);
    settings.setRotatorState({
      enabled,
      state: body.state || (enabled ? "running" : "stopped"),
      detail: body.detail || body.upstreams || "",
      adminOnly: true,
    });
    return { ...settings.all(), live: true };
  } catch {
    // The control plane may be down; show the last known state rather than an
    // error, because the switch is a preference display.
    return { ...stored, live: false };
  }
}

function createActions({ core, tabs, service, settings, account, passwords, rotatorEndpoint }) {
  const actions = {
    // --- tabs -------------------------------------------------------------
    "netops:tabs:list": () => tabs.list(),
    "netops:tabs:create": (options) => tabs.create(options || {}),
    "netops:tabs:close": (id) => tabs.close(id),
    "netops:tabs:activate": (id) => tabs.activate(id),
    "netops:tabs:navigate": (id, url) => tabs.navigate(id, url),
    "netops:tabs:go": (id, delta) => tabs.go(id, delta),
    "netops:tabs:reload": (id, hard) => tabs.reload(id, hard),
    "netops:tabs:stop": (id) => tabs.stop(id),
    "netops:tabs:mute": (id, muted) => tabs.setMuted(id, muted),

    // --- privacy ----------------------------------------------------------
    "netops:cookies:report": (profile) => tabs.cookieReport(profile),
    "netops:cookies:clear": (profile, domain) => tabs.clearCookies(profile, domain),
    "netops:cache:report": (profile) => tabs.cacheReport(profile),
    "netops:cache:clear": (profile) => tabs.clearCache(profile),
    "netops:blocklist:check": (url) => core.verdictFor(url),
    "netops:theme:apply": (patch) => core.applyTheme(patch),

    // --- proxy pool -------------------------------------------------------
    "netops:pool:stats": () => core.pool.stats(),
    "netops:pool:upstreams": () => core.pool.listUpstreams(),
    "netops:pool:pick": (profile) => core.pickUpstream(profile),

    // --- shell ------------------------------------------------------------
    "netops:service:status": () => service.status(),
    "netops:audio:status": () => detectAudio(),
    "netops:logs": () => (global.__netopsLogs ? global.__netopsLogs.slice(-120) : []),
  };

  // The rest only exist when their module was constructed. Keeping them out of
  // the map otherwise means the renderer gets a clean "no such action" instead of
  // a TypeError from a missing dependency.
  if (settings) {
    actions["netops:settings:read"] = () => settings.all();
    actions["netops:settings:write"] = (patch) => settings.patch(patch || {});
    actions["netops:settings:css-variables"] = () => settings.cssVariables();
  }

  if (account) {
    actions["netops:account:state"] = async (force) => {
      // Cookies live in the active tab's session partition; read them from there
      // so the shell sees the same identity the dashboard does.
      const cookies = await tabs.sessionCookies();
      return account.state(cookies, { force: Boolean(force) });
    };
    actions["netops:account:available"] = async () => {
      const cookies = await tabs.sessionCookies();
      const state = await account.state(cookies);
      return { ...state, gate: Account.gate(state, "account") };
    };
    actions["netops:account:open-dashboard"] = () => tabs.openDashboard();
  }

  if (rotatorEndpoint) {
    // Read the cookie header at call time, not at wiring time: the session
    // cookie is issued by the dashboard tab, which may not have loaded yet.
    const sessionCookie = async () => {
      if (!tabs || !account) return "";
      const jar = await tabs.sessionCookies();
      return Account.cookieHeader(jar, rotatorEndpoint);
    };
    actions["netops:rotator:status"] = () => rotatorStatus(settings, rotatorEndpoint, sessionCookie);
    actions["netops:rotator:set"] = rotatorAction(settings, account, rotatorEndpoint, sessionCookie);
  }

  if (passwords) {
    actions["netops:passwords:status"] = () => passwords.status();
    actions["netops:passwords:list"] = () => passwords.list();
    actions["netops:passwords:reveal"] = (id, options) => passwords.reveal(id, options);
    actions["netops:passwords:copy"] = (id, options) =>
      passwords.copy(id, { ...options, clipboard: service.clipboard() });
    actions["netops:passwords:remove"] = (id) => passwords.remove(id);
    actions["netops:passwords:save"] = (entry) => passwords.save(entry || {});
    actions["netops:passwords:verify"] = () => passwords.verifyAll();
    actions["netops:passwords:lock"] = () => passwords.lock();
    actions["netops:passwords:offers"] = () => passwords.offers();
    actions["netops:passwords:answer-offer"] = async (id, options) => {
      const result = await passwords.resolveOffer(id, {
        save: Boolean(options && options.save),
        sudoPassword: options && options.sudoPassword,
        method: options && options.method,
      });
      // The site can legitimately ask again after the password was changed.
      if (passwords.onOfferResolved) passwords.onOfferResolved(result);
      return result;
    };
    actions["netops:passwords:reauth-available"] = () => passwords.reauthAvailable();
    actions["netops:passwords:reauth"] = (options) => passwords.reauth(options || {});
  }

  return actions;
}

module.exports = { createActions };