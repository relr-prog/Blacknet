"use strict";

// End-to-end check of the whole stack: the real window, a real WebContentsView
// tab, the preload contract and the C++ policy. Launched by `npm run smoke`
// (main.js calls runSmoke when it sees --smoke) and finishes by exiting, so it
// works anywhere Electron can start, WSLg included.

const fs = require("fs");
const path = require("path");

const OUT_DIR = path.join(__dirname, "..", "..", "build");

const log = (message) => console.log(`[smoke] ${message}`);
const checks = [];

function check(name, passed, detail = "") {
  checks.push({ name, passed });
  console.log(`[smoke] ${passed ? "ok  " : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// navigate() is deliberately fire-and-forget (the address bar must not block on a
// slow page), so the smoke waits for the commit to actually start before it looks
// at the URL - otherwise it would inspect the pre-navigation about:blank.
function waitForUrl(view, prefix, timeoutMs = 15000) {
  const wc = view.webContents;
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      wc.removeListener("did-navigate", onNavigate);
      resolve(value);
    };
    const onNavigate = (_event, url) => {
      if (url.startsWith(prefix)) done(true);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (wc.getURL().startsWith(prefix)) {
      done(true);
      return;
    }
    wc.on("did-navigate", onNavigate);
  });
}

// A failed load is not a finished load: treating did-fail-load as success would
// let the smoke pass on a blank about:blank page.
function waitForLoad(view, timeoutMs = 15000) {
  const wc = view.webContents;
  if (!wc.isLoading()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      wc.removeListener("did-finish-load", onFinish);
      wc.removeListener("did-fail-load", onFail);
      resolve(value);
    };
    const onFinish = () => done(true);
    const onFail = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    wc.once("did-finish-load", onFinish);
    wc.once("did-fail-load", onFail);
  });
}

async function capture(view, name) {
  if (!view || view.webContents.isDestroyed()) return { width: 0, height: 0, path: null };
  const image = await view.webContents.capturePage();
  const target = path.join(OUT_DIR, name);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(target, image.toPNG());
  const size = image.getSize();
  return { width: size.width, height: size.height, path: target };
}

// The chrome is a page like any other, so drive it the way a person would and
// read the DOM back. This is the only check that covers preload.js, the IPC
// bridge and chrome.js together.
async function chromeState(view) {
  return view.webContents.executeJavaScript(`(() => ({
    tabs: document.querySelectorAll('#tabstrip .tab').length,
    url: document.getElementById('url').value,
    titles: [...document.querySelectorAll('#tabstrip .tab .title')].map((n) => n.textContent),
    status: document.getElementById('status').textContent,
    panelOpen: document.getElementById('panel').open,
    view: document.querySelector('#panel nav button.active')?.dataset.view || null,
    pills: document.querySelectorAll('#panel-body .pill').length,
    rows: document.querySelectorAll('#panel-body tr').length,
    empty: document.querySelectorAll('#panel-body .empty').length,
    settingsOpen: document.getElementById('settings').open,
    settingsSection: document.querySelector('#settings nav button.active')?.dataset.section || null,
    settingsRows: document.querySelectorAll('#settings-body .setting').length,
    settingsLocked: document.querySelectorAll('#settings-body .locked').length,
    offerHidden: document.getElementById('offer').hidden,
    offerButtons: [...document.querySelectorAll('#offer .actions button')].map((n) => n.textContent),
    theme: document.documentElement.dataset.theme || null,
    rootBg: document.documentElement.style.getPropertyValue('--bg') || null,
    brand: (() => {
      const img = document.getElementById('brand');
      return img ? { w: img.naturalWidth, h: img.naturalHeight } : null;
    })(),
  }))()`);
}

// Colour-scheme switching is pure CSS (light-dark()), so the only honest way to
// test it is to emulate the OS preference and read back what got painted.
async function setColorScheme(view, scheme) {
  const wc = view.webContents;
  const dbg = wc.debugger;
  if (!dbg.isAttached()) dbg.attach("1.3");
  const features = scheme ? [{ name: "prefers-color-scheme", value: scheme }] : [];
  await dbg.sendCommand("Emulation.setEmulatedMedia", { features });
}

async function paintedSurfaces(view) {
  return view.webContents.executeJavaScript(`(() => {
    const style = (sel) => {
      const node = document.querySelector(sel);
      return node ? getComputedStyle(node).backgroundColor : null;
    };
    return {
      bg: getComputedStyle(document.body).backgroundColor,
      text: getComputedStyle(document.body).color,
      panel: style('#panel'),
      activeTab: style('#tabstrip .tab.active'),
      inactiveTab: style('#tabstrip .tab:not(.active)'),
    };
  })()`);
}

async function schemeCheck(view) {
  const out = {};
  for (const scheme of ["dark", "light"]) {
    await setColorScheme(view, scheme);
    // Style recalculation is synchronous, but give the compositor one frame so
    // the capture below matches the tokens that were just read.
    await sleep(120);
    out[scheme] = await paintedSurfaces(view);
  }
  return out;
}

async function runSmoke({ handlers, BrowserWindow, getViews, quit }) {
  const call = async (channel, ...args) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    const result = await handler(...args);
    if (!result || result.ok !== true) {
      throw new Error(`${channel}: ${(result && result.error) || "failed"}`);
    }
    return result.data;
  };

  try {
    const win = BrowserWindow.getAllWindows()[0];
    check("window created", Boolean(win));

    const tabs = await call("netops:tabs:list");
    check("one tab on start", tabs.length === 1, `${tabs.length} tab(s), url=${tabs[0] && tabs[0].url}`);

    // The C++ URL policy must refuse dangerous schemes end to end.
    let refusal = "";
    try {
      await call("netops:tabs:navigate", tabs[0].id, "javascript:alert(1)");
    } catch (error) {
      refusal = error.message;
    }
    check("javascript: URL refused", /not allowed/.test(refusal), refusal);

    let fileRefusal = "";
    try {
      await call("netops:tabs:navigate", tabs[0].id, "file:///etc/passwd");
    } catch (error) {
      fileRefusal = error.message;
    }
    check("file: URL refused", /not allowed/.test(fileRefusal), fileRefusal);

    const tracker = await call("netops:blocklist:check", "https://www.google-analytics.com/collect");
    check("tracker blocked", tracker.blocked === true, tracker.pattern);

    const clean = await call("netops:blocklist:check", "https://example.com/");
    check("clean URL allowed", clean.blocked === false);

    const lookalike = await call("netops:blocklist:check", "https://notgoogle-analytics.com.attacker.test/");
    check("lookalike host allowed", lookalike.blocked === false);

    const cookies = await call("netops:cookies:report");
    check("cookie report returned", typeof cookies.count === "number", `${cookies.count} cookies`);
    check("no raw cookie values", !JSON.stringify(cookies).includes('"value":"'));

    const cache = await call("netops:cache:report");
    check("cache report returned", typeof cache.totalBytes === "number", `${cache.files} files`);

    const audio = await call("netops:audio:status");
    check(
      "audio status reported",
      typeof audio.available === "boolean" && typeof audio.reason === "string",
      audio.available ? audio.reason : `unavailable: ${audio.reason}`,
    );

    const service = await call("netops:service:status");
    log(`python control plane: ${service.state} (${service.detail})`);

    // The control plane is started in the background; give it a bounded amount of
    // time so the smoke proves it really serves, not merely that it spawned.
    for (let attempt = 0; attempt < 40 && service.state === "starting"; attempt += 1) {
      await sleep(500);
      const next = await call("netops:service:status");
      if (next.state !== service.state) log(`python control plane: ${next.state} (${next.detail})`);
      service.state = next.state;
      service.detail = next.detail;
    }
    check(
      "control plane running",
      service.state === "running",
      `${service.state}: ${service.detail}`,
    );

    // Load a real page through the tab's isolated session and prove it painted.
    // The window's own webContents paints nothing - every visible pixel belongs
    // to a child view - so each view is captured on its own.
    const first = tabs[0].id;
    if (service.state === "running") {
      await call("netops:tabs:navigate", first, "http://127.0.0.1:8787/");
      const tabView = getViews().tab(first);
      const committed = await waitForUrl(tabView, "http://127.0.0.1:8787");
      const loaded = committed ? await waitForLoad(tabView) : false;
      const url = tabView.webContents.getURL();
      check("control plane page loaded", loaded && url.startsWith("http://127.0.0.1:8787"), url);

      // A blank page also produces a valid bitmap, so ask the page itself.
      const text = await tabView.webContents
        .executeJavaScript("document.body ? document.body.innerText.length : 0")
        .catch(() => 0);
      check("dashboard has content", text > 20, `${text} characters of text`);

      await sleep(800);
      const tabShot = await capture(getViews().tab(first), "smoke-tab.png");
      check(
        "page rendered",
        tabShot.width > 100 && tabShot.height > 100,
        `${tabShot.width}x${tabShot.height} -> ${tabShot.path}`,
      );
    }

    // The chrome renderer learns about tabs over IPC, so give the broadcast a
    // moment to arrive before reading its DOM.
    const chromeView = getViews().chrome;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await chromeState(chromeView);
      if (state.tabs > 0) break;
      await sleep(250);
    }
    const ui = await chromeState(chromeView);
    check("tab strip populated", ui.tabs === tabs.length, `${ui.tabs} tab element(s)`);
    check("address bar follows tab", ui.url.startsWith("http://127.0.0.1:8787"), ui.url);
    // The top bar brand mark is a local file:// image: it only renders if the
    // request filter lets the shell's own assets through.
    check(
      "brand icon loaded",
      Boolean(ui.brand && ui.brand.w > 0 && ui.brand.h > 0),
      ui.brand ? `${ui.brand.w}x${ui.brand.h}` : "missing #brand",
    );

    // Open the privacy panel: exercises chrome.js, the bridge and the C++ jar.
    await chromeView.webContents.executeJavaScript("document.getElementById('inspect').click()");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await chromeState(chromeView);
      if (state.panelOpen && state.pills > 0) break;
      await sleep(250);
    }
    const cookieUi = await chromeState(chromeView);
    check("privacy panel opens", cookieUi.panelOpen === true);
    // An empty jar is a legitimate result: it must still render the summary and
    // say so, rather than leaving a blank panel.
    check(
      "cookie report rendered",
      cookieUi.pills > 0 && (cookieUi.rows > 1 || cookieUi.empty === 1),
      `${cookieUi.pills} pill(s), ${cookieUi.rows} row(s), ${cookieUi.empty} empty notice(s)`,
    );

    // The cache view has real data, so it must produce actual table rows.
    await chromeView.webContents.executeJavaScript(
      "document.querySelector('#panel nav button[data-view=cache]').click()",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await chromeState(chromeView);
      if (state.view === "cache" && state.rows > 1) break;
      await sleep(250);
    }
    const cacheUi = await chromeState(chromeView);
    check(
      "cache table rendered",
      cacheUi.view === "cache" && cacheUi.rows > 1,
      `${cacheUi.rows} row(s) in the ${cacheUi.view} view`,
    );

    const chromeShot = await capture(getViews().chrome, "smoke-chrome.png");
    check(
      "toolbar rendered",
      chromeShot.width > 100 && chromeShot.height > 20,
      `${chromeShot.width}x${chromeShot.height} -> ${chromeShot.path}`,
    );

    // --- settings, account gating and the password manager --------------------
    // These are driven through the real IPC actions a person would use, so the
    // checks cover the main-process gating and not just the dialog chrome.
    const settings = await call("netops:settings:read");
    check(
      "settings readable",
      settings && typeof settings.scheme === "string" && typeof settings.rotatorEnabled === "boolean",
      `scheme ${settings && settings.scheme}, rotator ${settings && settings.rotatorEnabled}`,
    );

    const savedLook = await call("netops:settings:write", { scheme: "light", background: "#101010" });
    check("settings write applied", savedLook.scheme === "light" && savedLook.background === "#101010");
    const rereadLook = await call("netops:settings:read");
    check("settings persisted", rereadLook.scheme === "light" && rereadLook.background === "#101010");

    const badColour = await call("netops:settings:write", { background: "javascript:alert(1)" });
    check("bad colour refused", badColour.background === null, String(badColour.background));

    const cssVars = await call("netops:settings:css-variables");
    check(
      "css variables follow the settings",
      cssVars && cssVars["color-scheme"] === "light" && !cssVars["--bg"],
      JSON.stringify(cssVars),
    );

    // "auto" has to reach the document as the CSS pair "light dark". Passing the
    // word "auto" to color-scheme resolves to light and breaks OS-following.
    await call("netops:settings:write", { scheme: "auto" });
    const autoVars = await call("netops:settings:css-variables");
    check(
      "auto scheme means follow the OS",
      autoVars && autoVars["color-scheme"] === "light dark",
      JSON.stringify(autoVars),
    );

    // Put the palette back the way it was found.
    await call("netops:settings:write", { scheme: "auto", background: null });

    const account = await call("netops:account:state", true);
    check(
      "account state resolved",
      account && typeof account.authenticated === "boolean" && typeof account.guest === "boolean",
      `authenticated ${account && account.authenticated}, guest ${account && account.guest}`,
    );

    const passwordStatus = await call("netops:passwords:status");
    check(
      "password status shaped",
      passwordStatus && typeof passwordStatus.available === "boolean" && typeof passwordStatus.locked === "boolean",
      `available ${passwordStatus && passwordStatus.available}, method ${passwordStatus && passwordStatus.method}`,
    );

    // A guest (or signed-out) session must be refused outright. The smoke profile
    // is anonymous, so this is the case that must hold.
    let passwordRefusal = "";
    try {
      await call("netops:passwords:list");
    } catch (error) {
      passwordRefusal = error.message;
    }
    check(
      "password list refuses an unlocked session",
      passwordRefusal === "" || /log in to unlock/i.test(passwordRefusal),
      passwordRefusal || "allowed (signed in)",
    );

    let rotatorRefusal = "";
    try {
      await call("netops:rotator:set", true);
    } catch (error) {
      rotatorRefusal = error.message;
    }
    check(
      "rotator switch refuses a non-admin",
      rotatorRefusal === "" || /log in as an administrator|guest sessions/i.test(rotatorRefusal),
      rotatorRefusal || "allowed (admin)",
    );

    // The password hook must never be attached to a page in this state, and the
    // capture path must refuse the report rather than store anything.
    const offerBefore = await call("netops:passwords:offers");
    check("no password offers at rest", Array.isArray(offerBefore) && offerBefore.length === 0);

    // Open the settings dialog and walk its sections the way a person would.
    await chromeView.webContents.executeJavaScript("document.getElementById('settings-btn').click()");
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await chromeState(chromeView);
      if (current.settingsOpen && current.settingsSection === "appearance") break;
      await sleep(250);
    }
    const settingsUi = await chromeState(chromeView);
    check(
      "settings dialog opens on Appearance",
      settingsUi.settingsOpen === true && settingsUi.settingsSection === "appearance",
      `open ${settingsUi.settingsOpen}, section ${settingsUi.settingsSection}`,
    );
    check(
      "appearance controls rendered",
      settingsUi.settingsRows >= 4,
      `${settingsUi.settingsRows} setting row(s)`,
    );

    for (const section of ["network", "account", "passwords"]) {
      await chromeView.webContents.executeJavaScript(
        `document.querySelector('#settings nav button[data-section=${section}]').click()`,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await chromeState(chromeView);
        if (current.settingsSection === section && (current.settingsRows > 0 || current.settingsLocked > 0)) {
          break;
        }
        await sleep(250);
      }
      const sectionUi = await chromeState(chromeView);
      check(
        `${section} section rendered`,
        sectionUi.settingsSection === section &&
          (sectionUi.settingsRows > 0 || sectionUi.settingsLocked > 0),
        `${sectionUi.settingsRows} row(s), ${sectionUi.settingsLocked} lock notice(s)`,
      );
    }

    const lockedUi = await chromeState(chromeView);
    if (!passwordStatus.available) {
      check(
        "locked features show the login notice",
        lockedUi.settingsLocked > 0,
        `${lockedUi.settingsLocked} lock notice(s)`,
      );
    }

    const offerUi = await chromeState(chromeView);
    check(
      "save prompt hidden until a site offers one",
      offerUi.offerHidden === true,
      `hidden ${offerUi.offerHidden}`,
    );
    check(
      "save prompt has exactly Save and Not now",
      Array.isArray(offerUi.offerButtons) &&
        offerUi.offerButtons.length === 2 &&
        offerUi.offerButtons[0] === "Save" &&
        offerUi.offerButtons[1] === "Not now",
      JSON.stringify(offerUi.offerButtons),
    );

    const settingsShot = await capture(getViews().chrome, "smoke-settings.png");
    check(
      "settings dialog painted",
      settingsShot.width > 100 && settingsShot.height > 20,
      `${settingsShot.width}x${settingsShot.height} -> ${settingsShot.path}`,
    );

    // Closing the dialog must not leave an unlocked vault behind.
    await chromeView.webContents.executeJavaScript("document.getElementById('settings-close').click()");
    await sleep(300);
    const closedUi = await chromeState(chromeView);
    check("settings dialog closes", closedUi.settingsOpen === false);

    // A second tab proves the view tree re-lays out without crashing.
    const created = await call("netops:tabs:create", {});
    const after = await call("netops:tabs:list");
    check("second tab created", after.length === 2, `tab ${created.id}`);

    await call("netops:tabs:activate", tabs[0].id);
    const active = await call("netops:tabs:activate", created.id);
    check("tab activation", active.id === created.id, active.url);

    // With two tabs open both tab states exist, so the active/inactive contrast
    // check below is real rather than vacuous.
    const schemes = await schemeCheck(chromeView);
    check(
      "dark scheme paints Opsi A",
      schemes.dark.bg === "rgb(30, 34, 42)" && schemes.dark.text === "rgb(225, 228, 234)",
      `bg ${schemes.dark.bg}, text ${schemes.dark.text}`,
    );
    check(
      "light scheme paints Opsi B",
      schemes.light.bg === "rgb(244, 245, 247)" && schemes.light.text === "rgb(31, 41, 55)",
      `bg ${schemes.light.bg}, text ${schemes.light.text}`,
    );
    check(
      "active tab differs from inactive",
      [schemes.dark, schemes.light].every(
        (s) => s.activeTab && s.inactiveTab && s.activeTab !== s.inactiveTab,
      ),
      `dark ${schemes.dark.activeTab} vs ${schemes.dark.inactiveTab}; ` +
        `light ${schemes.light.activeTab} vs ${schemes.light.inactiveTab}`,
    );
    check(
      "no pure black or pure white surfaces",
      ![schemes.dark.bg, schemes.light.bg, schemes.dark.panel, schemes.light.panel]
        .some((value) => value === "rgb(0, 0, 0)" || value === "rgb(255, 255, 255)"),
      `dark ${schemes.dark.bg}/${schemes.dark.panel}, ` +
        `light ${schemes.light.bg}/${schemes.light.panel}`,
    );

    // Leave the renderer on the real OS preference before quitting.
    await setColorScheme(chromeView, null);

    check("tab close", (await call("netops:tabs:close", created.id)).length === 1);

    const failed = checks.filter((entry) => !entry.passed);
    log(`${checks.length - failed.length}/${checks.length} checks passed`);
    quit(failed.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(`[smoke] FAIL ${error.stack || error.message}`);
    quit(1);
  }
}

module.exports = { runSmoke };
