"use strict";

// Chromium command-line hardening, aligned with the defaults LibreWolf ships.
//
// LibreWolf is a Firefox build hardened through preferences. This shell is
// Chromium/Electron, so the same intent has to be said in Chromium's own words,
// before the app is ready - Chromium reads its command line once, at startup.
//
// Only the defaults that have no equivalent in this shell's own policy live
// here. Everything else LibreWolf hardens is already enforced by config.js and
// the C++ policy, so it is deliberately not repeated as a switch: HTTPS-Only,
// tracker and web-beacon blocking, resist-fingerprinting, denying permissions by
// default, disabling WebRTC, blocking private-range and refused names.
//
// Each entry is a real, current Chromium switch or feature. Referrer stripping
// and DNS-prefetch suppression are checked against Chromium's own list: the
// referrer rule is the NoReferrers feature (there is no switch for it), and
// there is no command-line switch to disable DNS prefetching any more, so that
// intent is deliberately left out rather than asserted.
//
// Kept as data, so the list can be asserted without starting Electron.
const SWITCHES = [
  // browser.send_pings=false - no <a ping> hyperlink auditing.
  { name: "no-pings" },
  // network.http.referer.XOriginPolicy=2 - no cross-site referrer. A feature,
  // not a switch, so it is enabled rather than appended bare.
  { name: "enable-features", value: "NoReferrers" },
  // media.peerconnection.ice.no_host / default_address_only - WebRTC may not
  // route around the proxy to learn the real address. Only non-proxied UDP is
  // refused; a page that legitimately needs WebRTC over TCP still works.
  { name: "force-webrtc-ip-handling-policy", value: "disable_non_proxied_udp" },
  // toolkit telemetry and connectivity checks off - no background phone-home.
  { name: "disable-background-networking" },
];

// The switches to apply, honouring a single off switch so a build can drop the
// whole set without editing it here.
function switches(config = {}) {
  return config.enabled === false ? [] : SWITCHES.slice();
}

// `app` is Electron's app; this is the only place the switches meet it. Called
// once, before the app is ready.
function apply(app, config) {
  for (const { name, value } of switches(config)) {
    if (value === undefined) app.commandLine.appendSwitch(name);
    else app.commandLine.appendSwitch(name, value);
  }
}

module.exports = { SWITCHES, switches, apply };
