"use strict";

// Browser configuration for the desktop shell.
//
// The Python service remains the source of truth for the [browser] table in
// netops.toml; this file mirrors the defaults it ships with so the shell can
// start standalone (and so a misconfigured service cannot silently loosen the
// privacy policy). Values may be overridden by <userData>/browser.json.

const path = require("path");

const DEFAULTS = {
  // --- navigation ---------------------------------------------------------
  httpsOnly: true,
  allowDataUrls: false,
  newTabUrl: "about:blank",
  searchUrl: "https://duckduckgo.com/?q=%s",
  blockPrivateHosts: true,

  // --- privacy ------------------------------------------------------------
  blockTrackers: true,
  blocklist: [],
  resistFingerprinting: true,
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
