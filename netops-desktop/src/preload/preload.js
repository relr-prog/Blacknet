"use strict";

// The only bridge between the chrome UI and the privileged main process.
// Nothing here is callable from a browser page: it lives in the chrome's
// isolated context and every channel is an explicit allow-list entry.

const { contextBridge, ipcRenderer } = require("electron");

// Channels the main process may push without the UI asking first.
const EVENTS = [
  "netops:tabs",
  "netops:blocked",
  "netops:load-failed",
  "netops:crashed",
  "netops:download",
  "netops:password-offer",
  "netops:settings",
  "netops:account",
];

contextBridge.exposeInMainWorld("netops", {
  // --- tabs ---------------------------------------------------------------
  tabs: {
    list: () => ipcRenderer.invoke("netops:tabs:list"),
    create: (options) => ipcRenderer.invoke("netops:tabs:create", options),
    close: (id) => ipcRenderer.invoke("netops:tabs:close", id),
    activate: (id) => ipcRenderer.invoke("netops:tabs:activate", id),
    navigate: (id, url) => ipcRenderer.invoke("netops:tabs:navigate", id, url),
    go: (id, delta) => ipcRenderer.invoke("netops:tabs:go", id, delta),
    reload: (id, hard) => ipcRenderer.invoke("netops:tabs:reload", id, hard),
    stop: (id) => ipcRenderer.invoke("netops:tabs:stop", id),
    mute: (id, muted) => ipcRenderer.invoke("netops:tabs:mute", id, muted),
  },

  // --- privacy ------------------------------------------------------------
  privacy: {
    cookies: (profile) => ipcRenderer.invoke("netops:cookies:report", profile),
    clearCookies: (profile, domain) => ipcRenderer.invoke("netops:cookies:clear", profile, domain),
    cache: (profile) => ipcRenderer.invoke("netops:cache:report", profile),
    clearCache: (profile) => ipcRenderer.invoke("netops:cache:clear", profile),
    checkUrl: (url) => ipcRenderer.invoke("netops:blocklist:check", url),
    applyTheme: (patch) => ipcRenderer.invoke("netops:theme:apply", patch),
  },

  // --- proxy pool ---------------------------------------------------------
  pool: {
    stats: () => ipcRenderer.invoke("netops:pool:stats"),
    upstreams: () => ipcRenderer.invoke("netops:pool:upstreams"),
    pick: (profile) => ipcRenderer.invoke("netops:pool:pick", profile),
  },

  // --- shell --------------------------------------------------------------
  service: () => ipcRenderer.invoke("netops:service:status"),
  audio: () => ipcRenderer.invoke("netops:audio:status"),
  logs: () => ipcRenderer.invoke("netops:logs"),
  openExternal: (url) => ipcRenderer.invoke("netops:open-external", url),

  // --- rotator -------------------------------------------------------------
  // Admin-only in the control plane; main refuses for guests and operators.
  rotator: {
    status: () => ipcRenderer.invoke("netops:rotator:status"),
    set: (enabled) => ipcRenderer.invoke("netops:rotator:set", Boolean(enabled)),
  },

  // --- settings ------------------------------------------------------------
  // Appearance, browser colour and the rotator switch. Reads never need an
  // argument; writes take a partial patch and are validated in main.
  settings: {
    read: () => ipcRenderer.invoke("netops:settings:read"),
    write: (patch) => ipcRenderer.invoke("netops:settings:write", patch),
    cssVariables: () => ipcRenderer.invoke("netops:settings:css-variables"),
  },

  // --- account -------------------------------------------------------------
  // state() is safe to call anywhere: it reports the session without unlocking
  // anything. requireAccount() is the one that throws for a guest.
  account: {
    state: (refresh) => ipcRenderer.invoke("netops:account:state", Boolean(refresh)),
    available: () => ipcRenderer.invoke("netops:account:available"),
    openDashboard: () => ipcRenderer.invoke("netops:account:open-dashboard"),
  },

  // --- passwords -----------------------------------------------------------
  // Every call is gated in main by the account check and, for anything that
  // returns a secret, by a step-up prompt. list() never returns a password.
  passwords: {
    status: () => ipcRenderer.invoke("netops:passwords:status"),
    list: () => ipcRenderer.invoke("netops:passwords:list"),
    reveal: (id, options) => ipcRenderer.invoke("netops:passwords:reveal", id, options || {}),
    copy: (id, options) => ipcRenderer.invoke("netops:passwords:copy", id, options || {}),
    remove: (id) => ipcRenderer.invoke("netops:passwords:remove", id),
    save: (entry) => ipcRenderer.invoke("netops:passwords:save", entry),
    verifyAll: () => ipcRenderer.invoke("netops:passwords:verify"),
    lock: () => ipcRenderer.invoke("netops:passwords:lock"),
    pendingOffers: () => ipcRenderer.invoke("netops:passwords:offers"),
    answerOffer: (id, save) => ipcRenderer.invoke("netops:passwords:answer-offer", id, Boolean(save)),
    reauthAvailable: () => ipcRenderer.invoke("netops:passwords:reauth-available"),
    reauth: (options) => ipcRenderer.invoke("netops:passwords:reauth", options || {}),
  },

  // --- events -------------------------------------------------------------
  // subscribe(channel, handler) -> unsubscribe
  subscribe(channel, handler) {
    if (!EVENTS.includes(channel)) {
      throw new Error(`unknown event channel: ${channel}`);
    }
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
