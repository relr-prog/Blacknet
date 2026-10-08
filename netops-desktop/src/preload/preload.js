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
    // Opens a local page of the shell in a tab, optionally on a given view.
    internal: (name, options) => ipcRenderer.invoke("netops:tabs:internal", name, options),
  },

  // --- privacy ------------------------------------------------------------
  privacy: {
    cookies: (profile) => ipcRenderer.invoke("netops:cookies:report", profile),
    clearCookies: (profile, domain) => ipcRenderer.invoke("netops:cookies:clear", profile, domain),
    cache: (profile) => ipcRenderer.invoke("netops:cache:report", profile),
    clearCache: (profile) => ipcRenderer.invoke("netops:cache:clear", profile),
    checkUrl: (url) => ipcRenderer.invoke("netops:blocklist:check", url),
    applyTheme: (patch) => ipcRenderer.invoke("netops:theme:apply", patch),

    // Tracker counter and privacy grade. Read-only, and only on this bridge,
    // which ordinary pages never receive.
    report: (tabId) => ipcRenderer.invoke("netops:privacy:report", tabId),
    export: () => ipcRenderer.invoke("netops:privacy:export"),
  },

  // --- proxy pool ---------------------------------------------------------
  pool: {
    stats: () => ipcRenderer.invoke("netops:pool:stats"),
    upstreams: () => ipcRenderer.invoke("netops:pool:upstreams"),
    pick: (profile) => ipcRenderer.invoke("netops:pool:pick", profile),
  },

  // --- shell --------------------------------------------------------------
  audio: () => ipcRenderer.invoke("netops:audio:status"),
  logs: () => ipcRenderer.invoke("netops:logs"),
  openExternal: (url) => ipcRenderer.invoke("netops:open-external", url),

  // --- IP rotator -------------------------------------------------------------
  // A local action on a child process this shell started. There is no dashboard
  // role to check, because there is no dashboard: the operator already owns the
  // machine, and an "administrator" gate here would have protected nothing.
  ipRotator: {
    status: () => ipcRenderer.invoke("netops:ip-rotator:status"),
    set: (enabled) => ipcRenderer.invoke("netops:ip-rotator:set", Boolean(enabled)),
  },

  // --- settings ------------------------------------------------------------
  // Appearance, browser colour and the IP rotator switch. Reads never need an
  // argument; writes take a partial patch and are validated in main.
  settings: {
    read: () => ipcRenderer.invoke("netops:settings:read"),
    write: (patch) => ipcRenderer.invoke("netops:settings:write", patch),
    cssVariables: () => ipcRenderer.invoke("netops:settings:css-variables"),
  },

  // --- session ------------------------------------------------------------
  // The saved tab list. Read is for showing what would be restored; clear is
  // separate from the restoreSession switch so that turning the feature off is
  // not the same operation as erasing what it already recorded.
  session: {
    clear: () => ipcRenderer.invoke("netops:session:clear"),
  },

  // --- account -------------------------------------------------------------
  // The local profile. There is no session to inspect and nothing to log in to,
  // so every call here is a local read or a local rename. The one that matters
  // is unlock(): it asks the step-up to prove the operator is present, and that
  // proof - not this profile - is what opens the vault.
  account: {
    state: () => ipcRenderer.invoke("netops:account:state"),
    available: () => ipcRenderer.invoke("netops:account:available"),
    rename: (name) => ipcRenderer.invoke("netops:account:rename", String(name || "")),
    unlock: (options) => ipcRenderer.invoke("netops:account:unlock", options || {}),
    status: () => ipcRenderer.invoke("netops:account:status"),
  },

  // --- passwords -----------------------------------------------------------
  // Every call is gated in main, and anything that returns a secret is gated
  // behind a fresh step-up. list() never returns a password.
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
