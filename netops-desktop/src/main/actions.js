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

// The rotator is admin-only in the control plane. This mirrors that rule in the
// shell so a guest switch is refused before a request is made, and the UI can
// explain why without a round trip.
//
// The rotator is a child process now, not a server route, so there is no session
// cookie and no HTTP round trip. The gateway itself is the source of truth for
// whether it is running; the stored preference only mirrors it for the next
// paint. Flipping the proxy is a local desktop action, so it is no longer gated
// on a dashboard administrator session - the operator already owns the machine.
function rotatorAction(settings, rotator, tabs) {
  return async function (enabled) {
    if (!rotator) throw new Error("the rotator is not available");
    const want = Boolean(enabled);
    const state = want ? await rotator.start() : await rotator.stop();
    const live = await rotator.snapshot();
    const status = rotator.status();
    settings.setRotatorState({
      enabled: state === "running",
      state,
      detail: live ? live.detail : status.detail,
      adminOnly: false,
    });
    if (tabs && typeof tabs.refreshProxy === "function") tabs.refreshProxy();
    return settings.all();
  };
}

async function rotatorStatus(settings, rotator) {
  const stored = settings.all();
  if (!rotator) return { ...stored, live: false };
  const live = await rotator.snapshot();
  const status = rotator.status();
  settings.setRotatorState({
    enabled: status.state === "running",
    state: status.state,
    detail: live ? live.detail : status.detail,
    adminOnly: false,
  });
  return { ...settings.all(), live: Boolean(live), pool: live };
}

function createActions({ core, tabs, clipboard, settings, identity, passwords, rotator }) {
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
    // Local pages of the shell, shown in a tab. The page name is validated
    // against a fixed table in tabs.js.
    "netops:tabs:internal": (name, options) => tabs.openInternalPage(name, options || {}),

    // --- privacy ----------------------------------------------------------
    "netops:cookies:report": (profile) => tabs.cookieReport(profile),
    "netops:cookies:clear": (profile, domain) => tabs.clearCookies(profile, domain),
    "netops:cache:report": (profile) => tabs.cacheReport(profile),
    "netops:cache:clear": (profile) => tabs.clearCache(profile),
    "netops:blocklist:check": (url) => core.verdictFor(url),
    "netops:theme:apply": (patch) => core.applyTheme(patch),

    // --- tracker telemetry ------------------------------------------------
    // Read-only and in-memory. There is no action to clear the ledger on demand:
    // it already resets on every navigation, so a manual clear would only be a
    // way to lose the current page's count.
    "netops:privacy:report": (id) => tabs.telemetry(id),
    "netops:privacy:export": () => tabs.telemetryAll(),

    // --- proxy pool -------------------------------------------------------
    "netops:pool:stats": () => core.pool.stats(),
    "netops:pool:upstreams": () => core.pool.listUpstreams(),
    "netops:pool:pick": (profile) => core.pickUpstream(profile),

    // --- shell ------------------------------------------------------------
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

  // One local identity, created on first run, with no password behind it. There is
// nothing to log in to and no dashboard to send anyone to, so this answers
// synchronously and never touches the network or the cookie jar.
function identityAction(settings, identity, passwords) {
  const state = () => ({
    ...(identity ? identity.describe() : { available: false, name: "", createdAt: 0 }),
    local: true,
    gate: { unlocked: true, locked: false, reason: "", message: "" },
  });
  return {
    state: async () => state(),
    available: async () => state(),
    rename: async (name) => {
      if (!identity) throw new Error("no local profile");
      const next = identity.rename(name);
      log(`[identity] renamed to ${next.name}`);
      return state();
    },
    // The step-up is what actually unlocks the vault, so the panel asks the
    // password manager directly rather than asking a session to vouch for it.
    unlock: async (options) => {
      if (!passwords) throw new Error("the password manager is not available");
      const result = await passwords.reauth(options || {});
      return { ...state(), unlock: result };
    },
    status: async () => (passwords ? passwords.status() : { available: false, locked: true }),
  };
}

  if (identity) {
    const profile = identityAction(settings, identity, passwords);
    actions["netops:account:state"] = profile.state;
    actions["netops:account:available"] = profile.available;
    actions["netops:account:rename"] = profile.rename;
    actions["netops:account:unlock"] = profile.unlock;
    actions["netops:account:status"] = profile.status;
  }

  if (rotator) {
    actions["netops:rotator:status"] = () => rotatorStatus(settings, rotator);
    actions["netops:rotator:set"] = rotatorAction(settings, rotator, tabs);
  }

  if (passwords) {
    actions["netops:passwords:status"] = () => passwords.status();
    actions["netops:passwords:list"] = () => passwords.list();
    actions["netops:passwords:reveal"] = (id, options) => passwords.reveal(id, options);
    actions["netops:passwords:copy"] = (id, options) =>
      passwords.copy(id, { ...options, clipboard });
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