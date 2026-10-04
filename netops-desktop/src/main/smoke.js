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

// Settings and Privacy are a page of the shell in a tab now, so they are read
// from that tab's view rather than from the chrome frame. Counted across both
// halves because the page shows one of them at a time.
async function pageState(view) {
  return view.webContents.executeJavaScript(`(() => ({
    hash: location.hash,
    title: document.title,
    settingsVisible: !document.getElementById('settings').hidden,
    panelVisible: !document.getElementById('panel').hidden,
    section: document.querySelector('#settings nav button.active')?.dataset.section || null,
    view: document.querySelector('#panel nav button.active')?.dataset.view || null,
    rows: document.querySelectorAll('.setting').length,
    // The moved sections do not all build .setting rows - Account is a profile
    // plus a step-up button, Network is a toggle - so "did this section paint
    // anything at all" is the honest question.
    content: document.querySelectorAll('#settings button, #settings input, #settings ul, #settings li, #settings p, #settings .pill, #settings table tr').length,
    pills: document.querySelectorAll('.pill').length,
    tableRows: document.querySelectorAll('table tr').length,
    empty: document.querySelectorAll('.empty').length,
    locked: document.querySelectorAll('.locked').length,
    // The Account section's whole job is now the step-up, so the smoke asks for
    // those two buttons by name rather than by position.
    unlockButton: [...document.querySelectorAll('#settings button')]
      .some((b) => /unlock/i.test(b.textContent || '')),
    dashboardButton: [...document.querySelectorAll('#settings button')]
      .some((b) => /dashboard/i.test(b.textContent || '')),
    status: document.getElementById('status').textContent,
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
      panel: style('#settings'),
      activeTab: style('#tabstrip .tab.active'),
      inactiveTab: style('#tabstrip .tab:not(.active)'),
      // What the renderer itself believes, so a mismatch between the emulated
      // preference and what light-dark() resolved is visible rather than guessed.
      scheme: getComputedStyle(document.documentElement).colorScheme,
      prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
      bgVar: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || null,
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

    // --- local identity ------------------------------------------------------
    // There is no control plane any more, so nothing here should be waiting on a
    // server. This is the assertion that matters: no Python, no localhost API.
    const account = await call("netops:account:available");
    check(
      "local identity answers with no server",
      account && account.available === true && account.local === true && typeof account.name === "string",
      `identity ${account && account.name}`,
    );

    const vaultStatus = await call("netops:account:status");
    check(
      "vault reports locked until a step-up happens",
      vaultStatus && vaultStatus.available === true && vaultStatus.locked === true && vaultStatus.verified === false,
      `locked ${vaultStatus && vaultStatus.locked}, method ${vaultStatus && vaultStatus.method}`,
    );
    check(
      "status carries no session or guest fields",
      vaultStatus && !("guest" in vaultStatus) && !("authenticated" in vaultStatus),
    );

    // Load a real page through the tab's isolated session and prove it painted.
    // The window's own webContents paints nothing - every visible pixel belongs
    // to a child view - so each view is captured on its own. There is no control
    // plane to navigate to any more, so this uses a data URL: still a real
    // navigation through the tab session, with no server involved.
    const first = tabs[0].id;
    {
      const tabView = getViews().tab(first);
      await tabView.webContents.loadURL(
        "data:text/html,<title>Smoke</title><h1 id=marker>blacknet smoke page</h1>",
      );
      const url = tabView.webContents.getURL();
      check("a real page loaded through the tab session", url.startsWith("data:text/html"), url.slice(0, 40));

      // A blank page also produces a valid bitmap, so ask the page itself.
      const text = await tabView.webContents
        .executeJavaScript("document.body ? document.body.innerText.length : 0")
        .catch(() => 0);
      check("the loaded page has content", text > 10, `${text} characters of text`);

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
    check("address bar follows tab", ui.url.startsWith("data:text/html"), ui.url.slice(0, 48));
    // The top bar brand mark is a local file:// image: it only renders if the
    // request filter lets the shell's own assets through.
    check(
      "brand icon loaded",
      Boolean(ui.brand && ui.brand.w > 0 && ui.brand.h > 0),
      ui.brand ? `${ui.brand.w}x${ui.brand.h}` : "missing #brand",
    );

    // Privacy opens as a tab: exercises chrome.js, tabs.js, the bridge and the
    // C++ jar together.
    const tabsBeforePrivacy = (await call("netops:tabs:list")).length;
    await chromeView.webContents.executeJavaScript("document.getElementById('inspect').click()");
    let settingsTab = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const list = await call("netops:tabs:list");
      settingsTab = list.find((tab) => tab.internalPage === "settings") || null;
      if (settingsTab) break;
      await sleep(250);
    }
    check(
      "privacy opens a tab",
      Boolean(settingsTab),
      settingsTab ? `tab ${settingsTab.id} titled "${settingsTab.title}"` : "no settings tab",
    );
    check(
      "the privacy tab opened instead of a copy",
      (await call("netops:tabs:list")).length === tabsBeforePrivacy + 1,
      `${tabsBeforePrivacy} -> ${(await call("netops:tabs:list")).length}`,
    );

    const pageView = getViews().tab(settingsTab.id);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pageState(pageView);
      if (state.panelVisible && state.pills > 0) break;
      await sleep(250);
    }
    const cookieUi = await pageState(pageView);
    check(
      "privacy page opens on Cookies",
      cookieUi.panelVisible === true && cookieUi.view === "cookies",
      `panel ${cookieUi.panelVisible}, view ${cookieUi.view}, hash ${cookieUi.hash}`,
    );
    // An empty jar is a legitimate result: it must still render the summary and
    // say so, rather than leaving a blank page.
    check(
      "cookie report rendered",
      cookieUi.pills > 0 && (cookieUi.tableRows > 1 || cookieUi.empty === 1),
      `${cookieUi.pills} pill(s), ${cookieUi.tableRows} row(s), ${cookieUi.empty} empty notice(s)`,
    );

    // The cache view has real data, so it must produce actual table rows.
    await pageView.webContents.executeJavaScript(
      "document.querySelector('#panel nav button[data-view=cache]').click()",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pageState(pageView);
      if (state.view === "cache" && state.tableRows > 1) break;
      await sleep(250);
    }
    const cacheUi = await pageState(pageView);
    check(
      "cache table rendered",
      cacheUi.view === "cache" && cacheUi.tableRows > 1,
      `${cacheUi.tableRows} row(s) in the ${cacheUi.view} view`,
    );
    check(
      "the page records the view in the hash",
      cacheUi.hash === "#cache",
      `hash ${cacheUi.hash}`,
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

    // The rotator is a child process now, not a server route. Asking for status
    // while it is off must answer from local state rather than hang or throw, and
    // it must not claim to be live.
    const rotatorOff = await call("netops:rotator:status");
    check(
      "rotator status answers without a control plane",
      rotatorOff && rotatorOff.live === false && rotatorOff.rotatorEnabled === false,
      `state ${rotatorOff && rotatorOff.rotatorState}, detail ${rotatorOff && rotatorOff.rotatorDetail}`,
    );
    const rotatorRestarted = await call("netops:rotator:set", false);
    check(
      "rotator can be stopped idempotently",
      rotatorRestarted && rotatorRestarted.rotatorEnabled === false,
    );

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

    const profile = await call("netops:account:available");
    check(
      "local profile resolved",
      profile && profile.available === true && profile.local === true,
      `profile ${profile && profile.name}`,
    );
    check(
      "profile state carries no session fields",
      profile && !("authenticated" in profile) && !("isAdmin" in profile) && !("guest" in profile),
    );

    const passwordStatus = await call("netops:passwords:status");
    check(
      "password status shaped",
      passwordStatus && typeof passwordStatus.available === "boolean" && typeof passwordStatus.locked === "boolean",
      `available ${passwordStatus && passwordStatus.available}, method ${passwordStatus && passwordStatus.method}`,
    );

    // Reading a secret out of a locked vault must be refused. This is the check
    // that replaced the old "a guest cannot use the password manager" one: there
    // is no session to downgrade any more, so the step-up is the only thing
    // between a caller and a stored password, and it has to actually hold. The
    // refusal text varies by platform and by whether a terminal is installed, so
    // the assertion is simply that it refused and no secret came back.
    let revealRefusal = "";
    let revealed = null;
    try {
      revealed = await call("netops:passwords:reveal", "0".repeat(32));
    } catch (error) {
      revealRefusal = error.message;
    }
    check(
      "a locked vault refuses to reveal",
      revealRefusal !== "" && revealed === null,
      revealRefusal || "ALLOWED - the vault opened with no step-up",
    );
    check(
      "no secret is ever returned while locked",
      revealed === null || revealed.password === undefined,
    );

    // The rotator switch used to be admin-only over HTTP. It is a local preference
    // now, so it must succeed here rather than refusing a role that no longer
    // exists - and it must not leave a gateway running if it fails.
    let rotatorError = "";
    try {
      await call("netops:rotator:set", false);
    } catch (error) {
      rotatorError = error.message;
    }
    check("rotator switch is a local preference, not an admin action", rotatorError === "", rotatorError);

    // The password hook must never be attached to a page in this state, and the
    // capture path must refuse the report rather than store anything.
    const offerBefore = await call("netops:passwords:offers");
    check("no password offers at rest", Array.isArray(offerBefore) && offerBefore.length === 0);

    // Settings opens the same page: the tab Privacy already made, focused and
    // moved across to Appearance rather than stacked into a second copy.
    const tabsBeforeSettings = (await call("netops:tabs:list")).length;
    await chromeView.webContents.executeJavaScript("document.getElementById('settings-btn').click()");
    let focused = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const list = await call("netops:tabs:list");
      const found = list.find((tab) => tab.internalPage === "settings") || null;
      if (found && found.id === settingsTab.id && list.length === tabsBeforeSettings) {
        focused = found;
        break;
      }
      await sleep(250);
    }
    check(
      "settings reuses the tab privacy opened",
      Boolean(focused),
      focused
        ? `tab ${focused.id}`
        : `${tabsBeforeSettings} -> ${(await call("netops:tabs:list")).length} tab(s)`,
    );

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pageState(pageView);
      if (state.settingsVisible && state.section === "appearance") break;
      await sleep(250);
    }
    const settingsUi = await pageState(pageView);
    check(
      "settings page opens on Appearance",
      settingsUi.settingsVisible === true && settingsUi.section === "appearance",
      `visible ${settingsUi.settingsVisible}, section ${settingsUi.section}`,
    );
    check(
      "appearance controls rendered",
      settingsUi.rows >= 4,
      `${settingsUi.rows} setting row(s)`,
    );

    for (const section of ["network", "account", "passwords"]) {
      await pageView.webContents.executeJavaScript(
        `document.querySelector('#settings nav button[data-section=${section}]').click()`,
      );
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const current = await pageState(pageView);
        if (current.section === section && (current.rows > 0 || current.content > 0)) {
          break;
        }
        await sleep(250);
      }
      const sectionUi = await pageState(pageView);
      check(
        `${section} section rendered`,
        sectionUi.section === section && (sectionUi.rows > 0 || sectionUi.content > 0),
        `${sectionUi.rows} setting row(s), ${sectionUi.content} element(s)`,
      );
    }

    // The Account section used to be a login notice and a button to open a
    // dashboard. It is now a profile plus the step-up that actually opens the
    // vault, so that is what has to be on screen.
    await pageView.webContents.executeJavaScript(
      "document.querySelector('#settings nav button[data-section=account]').click()",
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = await pageState(pageView);
      if (current.section === "account") break;
      await sleep(250);
    }
    const accountUi = await pageState(pageView);
    check(
      "account section offers the step-up, not a login",
      accountUi.section === "account" && accountUi.unlockButton === true,
      `section ${accountUi.section}, unlock button ${accountUi.unlockButton}`,
    );
    check(
      "no dashboard button is left behind",
      accountUi.dashboardButton === false,
      `dashboard button present: ${accountUi.dashboardButton}`,
    );

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

    // The Settings tab must follow the day/night setting as well, since it links
    // the same stylesheet.
    const pageSchemes = await schemeCheck(pageView);
    check(
      "settings page follows the OS colour scheme",
      pageSchemes.dark.bg !== pageSchemes.light.bg,
      `dark ${pageSchemes.dark.bg} (prefersDark ${pageSchemes.dark.prefersDark}, ${pageSchemes.dark.scheme}), ` +
        `light ${pageSchemes.light.bg} (prefersDark ${pageSchemes.light.prefersDark}, ${pageSchemes.light.scheme})`,
    );

    const settingsShot = await capture(pageView, "smoke-settings.png");
    check(
      "settings page painted",
      settingsShot.width > 100 && settingsShot.height > 20,
      `${settingsShot.width}x${settingsShot.height} -> ${settingsShot.path}`,
    );

    // Closing the Settings tab must not leave an unlocked vault behind.
    await call("netops:tabs:close", settingsTab.id);
    await sleep(400);
    const afterClose = await call("netops:tabs:list");
    check(
      "settings tab closes",
      !afterClose.some((tab) => tab.internalPage === "settings"),
      `${afterClose.length} tab(s) left`,
    );

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
