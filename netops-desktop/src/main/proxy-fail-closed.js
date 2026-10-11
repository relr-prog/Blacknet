"use strict";

const NON_NETWORK_SCHEME = /^(about|data|blob|chrome|chrome-extension|devtools):/i;

// Keep the fail-closed decision pure so it can be tested without Electron.
// A wanted-but-unavailable gateway must never downgrade network traffic to direct.
function shouldBlockForMissingProxy({ wanted, proxyAvailable, url, shellFile = false }) {
  if (!wanted || proxyAvailable) return false;
  if (!url || NON_NETWORK_SCHEME.test(url) || shellFile) return false;
  return true;
}

module.exports = { shouldBlockForMissingProxy };
