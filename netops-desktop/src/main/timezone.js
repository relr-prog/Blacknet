"use strict";

// Clock pinning, the way Tor Browser does it: a page must not be able to read
// which timezone the operator is really in. Tor patches its engine; a shell
// that only embeds Chromium has to say it in JavaScript instead, and the patch
// has to land in the page's own world before any page script runs.
//
// A page reads the zone two ways, so both are answered:
//   * Date.prototype.getTimezoneOffset() - the legacy numeric offset.
//   * Intl.DateTimeFormat().resolvedOptions().timeZone - the modern name.
//
// This is best-effort and deliberately narrow. It covers those two probes, in
// the main world of every document the injected target creates. It does not
// reach a formatting path that reads the zone inside the engine (Date#toString,
// Date#toLocaleString), which no script could fake either. That limit is the
// reason this is one switch among many rather than a guarantee.
//
// The patch is defined once, as install(), and injected by stringifying it, so
// what the test exercises against a plain object is exactly what a page runs.

function install(target) {
  const { Date: D, Intl: I } = target;
  if (D && D.prototype) {
    D.prototype.getTimezoneOffset = function getTimezoneOffset() {
      return 0;
    };
  }
  if (I && I.DateTimeFormat && I.DateTimeFormat.prototype) {
    const proto = I.DateTimeFormat.prototype;
    const original = proto.resolvedOptions;
    proto.resolvedOptions = function resolvedOptions() {
      const options = original.call(this);
      options.timeZone = "UTC";
      return options;
    };
  }
  return target;
}

// The exact bytes injected into the page: the same function, applied to the
// page's global object, inside a guard so a frozen built-in cannot throw.
const SPOOF_SOURCE =
  `try { (${install.toString()})(globalThis); } catch (e) {}`;

// A failed spoof command is worth a line only when the renderer is still there
// to be spoofed. A page that crashed or navigated away closes the target, and
// that is not this module's fault to report.
const BENIGN_ATTACH_ERROR = /(target closed|target crashed|not attached|detached)/i;

// Registers the spoof with a webContents so Chromium runs it for the next
// document, in the main world, ahead of the page. Kept behind try/catch and a
// rejected-command handler: a renderer that cannot be attached to must still
// browse. Returns whether the debugger was attached.
function attach(webContents, log = () => {}) {
  const dbg = webContents && webContents.debugger;
  if (!dbg) return false;
  const report = (method, error) => {
    if (!BENIGN_ATTACH_ERROR.test(error.message)) {
      log(`clock spoof command failed (${method}): ${error.message}`);
    }
  };
  try {
    if (!dbg.isAttached()) dbg.attach("1.3");
  } catch (error) {
    report("attach", error);
    return false;
  }
  dbg.sendCommand("Page.enable").catch((error) => report("Page.enable", error));
  dbg
    .sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: SPOOF_SOURCE })
    .catch((error) => report("addScript", error));
  return true;
}

// Pins the process's own clock. On Linux this also reaches the renderers'
// ICU zone; on Windows it only reaches V8's Date, which is why the injected
// patch above does the work a page actually sees.
function pinEnvironment(env = process.env) {
  env.TZ = "UTC";
  return env;
}

module.exports = { SPOOF_SOURCE, install, attach, pinEnvironment };
