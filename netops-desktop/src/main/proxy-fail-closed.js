"use strict";

const NON_NETWORK_SCHEME = /^(about|data|blob|chrome|chrome-extension|devtools):/i;

function shouldBlockForMissingProxy({
  wanted,
  proxyAvailable,
  proxyApplied,
  url,
  shellFile = false,
}) {
  if (!wanted || (proxyAvailable && proxyApplied)) return false;
  if (!url || NON_NETWORK_SCHEME.test(url) || shellFile) return false;
  return true;
}

module.exports = { shouldBlockForMissingProxy };
