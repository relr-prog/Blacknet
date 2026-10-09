"use strict";

// Browser configuration for the desktop shell.
//
// The Python service remains the source of truth for the [browser] table in
// netops.toml; this file mirrors the defaults it ships with so the shell can
// start standalone (and so a misconfigured service cannot silently loosen the
// privacy policy). Values may be overridden by <userData>/browser.json.

const path = require("path");
const { SOURCE_IDS } = require("./search");

const DEFAULTS = {
  // --- navigation ---------------------------------------------------------
  httpsOnly: true,
  allowDataUrls: false,
  newTabUrl: "about:blank",
  // The shell's own meta-search, run in the main process. There is no
  // third-party engine behind the address bar and no API key: a query goes to
  // this fixed set of public JSON APIs and the merged list is shown on the
  // shell's own page. Set enabled to false to make the address bar accept
  // addresses only again.
  search: {
    enabled: true,
    sources: [...SOURCE_IDS],
    limit: 10,
    perSource: 8,
    timeoutMs: 6000,
  },
  blockPrivateHosts: true,
  // The shell's own client for the local circuit daemon. The browser refuses a
  // name in the refused family up front, so the shell keeps its own way to reach
  // one; this is the one internal job it does with it - prove the circuit
  // actually carries a request rather than only holding a port open. Off by
  // default: the daemon is started only when a profile asks for it. selfCheckUrl
  // may be any http(s) URL the daemon should reach; the default proves the
  // circuit works without leaning on a name that only exists inside it.
  circuit: {
    enabled: false,
    selfCheckUrl: "https://example.com/",
    selfCheckIntervalMs: 300000,
    timeoutMs: 30000,
  },

  // --- privacy ------------------------------------------------------------
  blockTrackers: true,
  blocklist: [],
  resistFingerprinting: true,
  // Letterbox the page to Tor's 200 x 100 grid: the content area is rounded down
  // and centered, so two windows a few pixels apart report the same viewport and
  // size stops being a fingerprint. The address bar keeps the full window width.
  letterbox: { enabled: true, widthStep: 200, heightStep: 100 },
  disableWebRtc: true,
  blockNotifications: true,
  blockWebBeacons: true,
  defaultPermissions: [],

  // --- proxy --------------------------------------------------------------
  // Either a Chromium proxy string or a C++ pool tier list; the pool decides
  // which upstream serves a profile and Electron is told the current host:port.
  proxy: { mode: "direct" },
  poolTiers: [],

  // --- ui -----------------------------------------------------------------
  maxTabs: 12,
  theme: { name: "midnight", mode: "dark" },
};

function load(userDataPath, overrides = {}) {
  const config = { ...DEFAULTS, ...overrides };

  // Each profile gets its own Chromium partition, so cookies/caches never leak
  // between operators on a shared machine.
  config.profileRoot = path.join(userDataPath, "profiles");
  config.defaultProfile = "default";
  return config;
}

module.exports = { DEFAULTS, load };
