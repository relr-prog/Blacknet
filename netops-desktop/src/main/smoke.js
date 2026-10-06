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
    // anything at all" is the honest question. Scoped to #settings-body rather
    // than #settings, because the section nav lives inside #settings too: a
    // selector broad enough to match those buttons counts the navigation as
    // content and an empty body passes as rendered.
    content: document.querySelectorAll('#settings-body button, #settings-body input, #settings-body ul, #settings-body li, #settings-body p, #settings-body .pill, #settings-body table tr').length,
    // Scoped to the panel, because "did the privacy half paint anything" is a
    // different question from the same question about the settings half - and a
    // wait that watches the wrong half reports ready before anything is there.
    panelContent: document.querySelectorAll('#panel p, #panel .pill, #panel table tr, #panel button, #panel pre').length,
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

// Reads what a crashed tab is actually showing. The crash page is rendered by a
// script of its own, so its text is the only honest evidence that the page works
// rather than merely loading.
async function crashPageText(view) {
  try {
    return await view.webContents.executeJavaScript("document.body.innerText");
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
}

// Reads what a Settings/Privacy tab is actually showing. The page builds itself
// from IPC replies, so the text is the only honest evidence that a view rendered
// rather than a hash that changed. Scoped to the active half, because the panel
// ends with the shell log and a log line can contain any word at all - including
// whatever the check is looking for.
async function settingsText(view, selector = "document.body") {
  try {
    return await view.webContents.executeJavaScript(`${selector}.innerText`);
  } catch (error) {
    return `unreadable: ${error.message}`;
  }
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

async function runSmoke({ handlers, BrowserWindow, app, getViews, quit }) {
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

    // Tracker telemetry. Read through the same bridge the page panel uses, so a
    // broken wiring shows up here rather than as an empty panel.
    const report = await call("netops:privacy:report");
    check("privacy report returned", typeof report.score === "number", `score ${report.score}`);
    check("privacy score in range", report.score >= 0 && report.score <= 100, `${report.score}`);
    check("privacy grade present", typeof report.grade === "string", report.grade);
    // The smoke page is a data: URL, so it legitimately makes no network request
    // and there is no site to name. What must hold either way is that the report
    // is self-consistent: a named site, or a clean empty one, never both.
    check(
      "report is self-consistent",
      report.site === null
        ? report.sites.length === 0 && report.score === 100 && report.blocked === 0
        : typeof report.site === "string" && report.sites.length > 0,
      `site ${String(report.site)}, ${report.sites.length} listed`,
    );
    check(
      "report accounts for every site it lists",
      report.sites.every((row) => typeof row.host === "string" && typeof row.score === "number"),
      `${report.sites.length} sites`,
    );
    check("report holds no full URLs", !/https?:\/\//.test(JSON.stringify(report.sites)));

    const dump = await call("netops:privacy:export");
    check("privacy export returned", typeof dump.totals === "object", `version ${dump.version}`);
    check("export holds no full URLs", !/https?:\/\//.test(JSON.stringify(dump)));

// End-to-end: a page that really tries to phone home, through the real request
    // filter. The tracker is https, so it passes the cleartext policy and is then
    // refused by the blocklist on the URL string alone - before any socket, DNS or
    // network exists. That makes this a genuine test of the real path rather than
    // a self-fulfilling one, without needing a server.
    const probeTab = tabs[0];
    const probePage = "data:text/html;charset=utf-8,"
      + encodeURIComponent(
        "<!doctype html><title>Tracker probe</title><h1>probe</h1>"
          + '<img src="https://www.google-analytics.com/collect?v=1">'
          + '<img src="https://www.doubleclick.net/pixel.gif">',
      );
    // Loaded straight onto the view, because navigate() refuses data: URLs by
    // policy and that policy is not what is under test here. Everything below the
    // renderer still applies: the request filter sees these subresources.
    await getViews().tab(probeTab.id).webContents.loadURL(probePage);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const live = await call("netops:privacy:report", probeTab.id);
      if (live.blocked > 0) break;
      await sleep(200);
    }
    const live = await call("netops:privacy:report", probeTab.id);
    check("a real page's requests are counted", live.requests > 0, `${live.requests} requests`);
    check("a real tracker attempt is blocked", live.blocked >= 2, `${live.blocked} blocked`);
    check(
      "each blocked tracker is named in the report",
      live.sites.filter((row) => row.blocked > 0).length >= 2,
      live.sites.filter((row) => row.blocked > 0).map((row) => row.host).join(" "),
    );
    check(
      "a page with no origin claims no third-party status",
      live.sites.every((row) => row.thirdParty === 0),
      live.sites.map((row) => `${row.host}:tp${row.thirdParty}`).join(" "),
    );
    check(
      "no full URL survived into the report",
      !/https?:\/\/|v=1/.test(JSON.stringify(live)),
    );
    // This page is a data: URL, so it has no site of its own to be graded. The
    // trackers are then the whole story and the score has to reflect them -
    // a document with no origin that phones home twice is not excellent.
    check(
      "a page with no origin is graded on what it actually did",
      Number.isInteger(live.score) && live.score < 100 && live.score > 0,
      `${String(live.site)} scored ${live.score} (${live.grade})`,
    );
    check(
      "the score's reasons are reported with it",
      live.penalties.length > 0 && live.penalties.every((p) => p.count > 0),
      JSON.stringify(live.penalties),
    );

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
      if (state.panelVisible && state.panelContent > 0) break;
      await sleep(250);
    }
    const reportUi = await pageState(pageView);
    check(
      "privacy page opens on the Report",
      reportUi.panelVisible === true && reportUi.view === "report",
      `panel ${reportUi.panelVisible}, view ${reportUi.view}, hash ${reportUi.hash}`,
    );
    // The report must say something even with nothing to report, or the panel
    // looks broken rather than clean. panelContent, not content: the report
    // lives in #panel, and the settings metric reads the settings body - which
    // is empty here, and whose nav buttons used to make this pass no matter
    // what the panel showed.
    check(
      "report panel renders content",
      reportUi.panelContent > 0,
      `${reportUi.panelContent} element(s)`,
    );

    // The egress view, with the gateway stopped - which is the state the smoke
    // runs in. The claim being tested is that it says so: "0 upstreams" and "not
    // configured" are different statements, and neither is "your traffic is
    // rotating".
    await pageView.webContents.executeJavaScript(
      `document.querySelector('#panel nav button[data-view="service"]').click()`,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pageState(pageView);
      if (state.view === "service" && state.panelContent > 0) break;
      await sleep(250);
    }
    const serviceUi = await pageState(pageView);
    const serviceText = await settingsText(
      pageView,
      "document.getElementById('panel')",
    );
    check(
      "the egress view renders and admits the gateway is not running",
      serviceUi.view === "service"
        && serviceUi.panelContent > 0
        && /not running|no healthy|not identified|unknown|stopped/i.test(serviceText),
      serviceText.replace(/\s+/g, " ").slice(0, 80),
    );
    check(
      "no exit IP is shown while the gateway is down",
      !/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/.test(
        serviceText.replace(/127\.0\.0\.1|0\.0\.0\.0/g, ""),
      ),
      "and no rotation claim is made",
    );

    // Now the same view with the gateway actually running. The pool ships with
    // documentation addresses, so nothing behind it can be healthy - which makes
    // this the honest case to test: a listening gateway with no working upstreams
    // must not read as a working proxy.
    const started = await call("netops:rotator:set", true);
    let gateway = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      gateway = await call("netops:rotator:status");
      if (gateway && gateway.live) break;
      await sleep(400);
    }
    if (started && gateway && gateway.live) {
      await call("netops:tabs:internal", "settings", { view: "service" });
      await sleep(1200);
      const runningText = await settingsText(
        pageView,
        "document.getElementById('panel')",
      );
      check(
        "a running gateway with no healthy upstreams does not claim rotation",
        /No healthy upstreams|Exit IPs not identified/i.test(runningText)
          && !/Rotating across/i.test(runningText),
        runningText.replace(/\s+/g, " ").slice(0, 90),
      );
    } else {
      check(
        "the gateway starts",
        false,
        `state ${gateway && gateway.rotatorState}, detail ${gateway && gateway.rotatorDetail}`,
      );
    }
    await call("netops:rotator:set", false);
    await pageView.webContents.executeJavaScript(
      `document.querySelector('#panel nav button[data-view="report"]').click()`,
    );

    // The other privacy panels still have to be reachable behind it.
    await pageView.webContents.executeJavaScript(
      `document.querySelector('#panel nav button[data-view="cookies"]').click()`,
    );
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const state = await pageState(pageView);
      if (state.view === "cookies" && state.pills > 0) break;
      await sleep(250);
    }
    const cookieUi = await pageState(pageView);
    check(
      "cookies panel still reachable",
      cookieUi.panelVisible === true && cookieUi.view === "cookies" && cookieUi.pills > 0,
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
      // Both conditions, not just the section: the step-up button is painted
      // after the vault status reply comes back, so stopping on the active
      // section alone read the DOM before the button existed. That raced, and
      // reported "unlock button false" on a page that was about to be correct.
      if (current.section === "account" && current.unlockButton === true) break;
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

    // A create() on a refused URL must undo itself. navigate() refuses before it
    // loads anything, but by then #createTab has already registered the view -
    // so without a rollback the strip keeps a blank tab and the session file
    // keeps an entry for a page that never opened. With every entry refused,
    // close()'s empty branch plus main.js's own fallback would stack two blanks.
    const sessionFile = path.join(app.getPath("userData"), "session.json");
    const tabsBeforeRefusal = await call("netops:tabs:list");
    const entriesBeforeRefusal = JSON.parse(fs.readFileSync(sessionFile, "utf8")).tabs.length;
    let createRefusal = "";
    try {
      await call("netops:tabs:create", { url: "file:///etc/passwd" });
    } catch (error) {
      createRefusal = error.message;
    }
    const tabsAfterRefusal = await call("netops:tabs:list");
    const entriesAfterRefusal = JSON.parse(fs.readFileSync(sessionFile, "utf8")).tabs.length;
    check("create on a refused URL is refused", /not allowed/.test(createRefusal), createRefusal);
    check(
      "a refused create leaves no blank tab",
      tabsAfterRefusal.length === tabsBeforeRefusal.length,
      `${tabsBeforeRefusal.length} -> ${tabsAfterRefusal.length} tab(s)`,
    );
    check(
      "a refused create writes no session entry",
      entriesAfterRefusal === entriesBeforeRefusal,
      `${entriesBeforeRefusal} -> ${entriesAfterRefusal} entry(ies)`,
    );

    // Session restore, checked against the file the next launch will read. This
    // is the whole feature: the tabs you had open are the tabs you get back.
    // A crash mid-write is the interesting failure, which is why this reads the
    // real file rather than an in-memory snapshot.
    // Session restore, checked against the file the next launch will read - which is
    // the whole feature. A tab on a reserved TLD is used on purpose: it is
    // recorded without resolving anything, and about:blank or a data: URL would
    // not be recorded at all, because neither is a page worth reopening.
    const restorable = await call("netops:tabs:create", {
      url: "https://blacknet-smoke.invalid/",
    });
    const savedRaw = fs.readFileSync(sessionFile, "utf8");
    const saved = JSON.parse(savedRaw);
    const urls = Array.isArray(saved.tabs) ? saved.tabs.map((entry) => entry.url) : [];
    check(
      "the open tabs were written for the next launch",
      urls.includes("https://blacknet-smoke.invalid/"),
      `${urls.length} tab(s) saved`,
    );
    check(
      "nothing but URLs and profiles is saved",
      !savedRaw.includes("cookies")
        && !savedRaw.includes("tracker")
        && Object.keys(saved.tabs[0] || {}).every((key) => ["slot", "url", "profile"].includes(key)),
      "no page content in the session file",
    );
    check(
      "forgetting the saved session clears the file",
      (await call("netops:session:clear")).cleared === true
        && JSON.parse(fs.readFileSync(sessionFile, "utf8")).tabs.length === 0,
    );
    await call("netops:tabs:close", restorable.id);

    // A crashed tab must not look normal, and reloading it must go back to the
    // page rather than reloading the crash page - the loop the operator cannot
    // get out of.
    const crashedTab = await call("netops:tabs:create");
    getViews()
      .tab(crashedTab.id)
      .webContents.forcefullyCrashRenderer();
    await sleep(800);
    const crashedEntry = (await call("netops:tabs:list")).find(
      (tab) => tab.id === crashedTab.id,
    );
    check(
      "a crashed tab is marked as crashed rather than left looking normal",
      Boolean(crashedEntry && crashedEntry.crashed),
      crashedEntry ? `crashed=${crashedEntry.crashed}` : "tab gone",
    );
    await call("netops:tabs:reload", crashedTab.id);
    await sleep(800);
    const afterReload = (await call("netops:tabs:list")).find(
      (tab) => tab.id === crashedTab.id,
    );
    check(
      "reloading a crashed tab returns to the page, not the crash page",
      Boolean(afterReload)
        && afterReload.crashed === false
        && !String(afterReload.url).includes("crashed.html"),
      afterReload ? `url ${String(afterReload.url).slice(0, 70)}` : "tab gone",
    );
    // The crash page must actually render its own detail. Its Content-Security-Policy
    // once forbade scripts, so the page loaded and then silently showed
    // "unknown" for a crash the shell knew the reason for.
    const crashProbe = await call("netops:tabs:create");
    getViews()
      .tab(crashProbe.id)
      .webContents.forcefullyCrashRenderer();
    await sleep(900);
    // Read the reason and exit code the shell actually recorded, and require the
    // page to show those exact values. An earlier version of this check asserted
    // the literal 11, which was the exit code Electron 32's Chromium happened to
    // produce for a forced crash; Chromium 152 reports 5 for the same call, so
    // the check was really testing a number from a dependency rather than the
    // page. Comparing against the shell's own record keeps it honest across
    // upgrades and would still catch a page that renders its placeholders.
    const crashState = (await call("netops:tabs:list")).find(
      (entry) => entry.id === crashProbe.id,
    );
    const crashDetail = await crashPageText(getViews().tab(crashProbe.id));
    const recordedReason = String((crashState && crashState.crashReason) || "crashed");
    const recordedCode = String((crashState && crashState.crashExitCode) ?? "");
    check(
      "the crash page shows the reason and exit code",
      /crashed/.test(crashDetail) &&
        crashDetail.includes(recordedReason) &&
        recordedCode !== "" &&
        crashDetail.includes(recordedCode) &&
        !/\bunknown\b/.test(crashDetail),
      `recorded ${recordedReason}/${recordedCode}, page shows ${crashDetail.replace(/\s+/g, " ").slice(0, 70)}`,
    );

    // Maximizing must carry the chrome and the page with it. Electron emits
    // "resize" before the new content size is committed, so a synchronous layout
    // handler used the pre-maximize width and left the tab strip short of the
    // window edge. Nothing checked this before: the chrome view's bounds are
    // compared against the window's real content size in both directions.
    if (win.isMaximizable()) {
      // describe() carries no active flag and there is no IPC for it, so the
      // active tab is identified the way the layout itself expresses it: the
      // one view that has been given a width.
      const openTabs = await call("netops:tabs:list");
      const activeTabId =
        openTabs.find((tab) => (getViews().tab(tab.id)?.getBounds().width || 0) > 0)?.id ??
        openTabs[0]?.id;
      const measure = async () => {
        // Give the deferred layout its tick plus the follow-up pass.
        await sleep(400);
        const [contentWidth, contentHeight] = win.getContentSize();
        const chrome = getViews().chrome.getBounds();
        const tabView = activeTabId ? getViews().tab(activeTabId) : null;
        const tabBounds = tabView ? tabView.getBounds() : null;
        return { contentWidth, contentHeight, chrome, tabBounds };
      };

      win.maximize();
      const maximized = await measure();
      check(
        "maximizing resizes the top bar to the window",
        maximized.chrome.width === maximized.contentWidth && maximized.contentWidth > 0,
        `chrome ${maximized.chrome.width} vs content ${maximized.contentWidth}`,
      );
      check(
        "maximizing resizes the page below the top bar",
        Boolean(maximized.tabBounds) &&
          maximized.tabBounds.width === maximized.contentWidth &&
          maximized.tabBounds.height === Math.max(0, maximized.contentHeight - maximized.chrome.height),
        maximized.tabBounds
          ? `page ${maximized.tabBounds.width}x${maximized.tabBounds.height}, chrome height ${maximized.chrome.height}`
          : "no active tab view",
      );

      win.unmaximize();
      const restored = await measure();
      check(
        "unmaximizing shrinks the top bar back",
        restored.chrome.width === restored.contentWidth,
        `chrome ${restored.chrome.width} vs content ${restored.contentWidth}`,
      );

      // Put the window back the way the rest of the suite expects it.
      win.setSize(1280, 860);
      await sleep(400);
    }

    const failed = checks.filter((entry) => !entry.passed);
    log(`${checks.length - failed.length}/${checks.length} checks passed`);
    quit(failed.length === 0 ? 0 : 1);
  } catch (error) {
    console.error(`[smoke] FAIL ${error.stack || error.message}`);
    quit(1);
  }
}

module.exports = { runSmoke };
