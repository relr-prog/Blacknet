"use strict";

// Thin wrapper around the C++ addon. Everything privacy-relevant (URL policy,
// tracker blocking, cookie redaction, cache accounting, proxy pool state) is
// decided in C++; this file only adapts it to the shape the main process wants
// and keeps a single Blocklist instance in sync with config changes.

const path = require("path");

const ADDON_PATH = path.join(__dirname, "..", "..", "build", "native", "netops_native.node");

let native;
try {
  native = require(ADDON_PATH);
} catch (error) {
  throw new Error(
    `the netops native addon is not built (${error.message}). ` +
      `Run: npm run configure:native && npm run build:native`,
  );
}

class Native {
  constructor(config) {
    this.config = config;
    this.blocklist = this.#buildBlocklist(config);
    this.pool = new native.Pool();
    this.theme = native.buildTheme(config.theme || {});
    this.cache = new native.CacheIndex(config.profileRoot);
    this.caches = new Map(); // profile dir -> CacheIndex
    this.jars = new Map(); // partition -> CookieJar
  }

  #buildBlocklist(config) {
    const list = new native.Blocklist({
      includeBuiltin: config.blockTrackers !== false,
      extra: config.blocklist || [],
    });
    return list;
  }

  // --- URL policy ---------------------------------------------------------
  // Throws with an operator-readable reason when the address bar input is not
  // something we are willing to load.
  resolve(input) {
    const result = native.normaliseUrl(input, {
      httpsOnly: this.config.httpsOnly !== false,
      allowDataHtml: false,
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  // --- host policy --------------------------------------------------------
  validateHost(host) {
    return native.validateHost(host, {
      allowPrivate: this.config.allowPrivateHosts === true,
      allowLocalhost: this.config.allowLoopback === true,
    });
  }

  // --- tracker blocking ---------------------------------------------------
  verdictFor(url) {
    return this.blocklist.check(url);
  }

  shouldBlockRequest(url) {
    // Never break the app's own chrome or the local control plane.
    if (url.startsWith("file://") || url.startsWith("devtools://")) return false;
    return this.blocklist.check(url).blocked;
  }

  // --- cookies ------------------------------------------------------------
  jar(partition) {
    if (!this.jars.has(partition)) this.jars.set(partition, new native.CookieJar());
    return this.jars.get(partition);
  }

  // --- cache ---------------------------------------------------------------
  // One index per profile directory; rebuilt on demand because Electron creates
  // the partition directory lazily.
  cacheFor(root) {
    if (!root) return this.cache;
    if (!this.caches.has(root)) this.caches.set(root, new native.CacheIndex(root));
    return this.caches.get(root);
  }

  // --- proxy pool ---------------------------------------------------------
  configurePool(tiers) {
    this.pool = new native.Pool();
    for (const tier of tiers || []) {
      this.pool.addTier({
        name: tier.name,
        strategy: tier.strategy || "round_robin",
        upstreams: tier.upstreams || [],
      });
    }
    return this.pool.stats();
  }

  pickUpstream(partition) {
    return this.pool.select(partition || "");
  }

  reportSuccess(id, bytes) {
    this.pool.noteSuccess(id, { bytes: bytes || 0 });
  }

  reportFailure(id, error) {
    this.pool.noteFailure(id, String(error || "request failed"));
  }

  // --- theme --------------------------------------------------------------
  applyTheme(patch) {
    const merged = native.buildTheme({ ...(this.config.theme || {}), ...(patch || {}) });
    if (!merged.ok) throw new Error(merged.error);
    this.theme = merged;
    return merged;
  }
}

module.exports = { native, Native };
