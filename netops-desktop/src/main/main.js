"use strict";

// netops desktop shell.
//
// Layout: the window's contentView owns two kinds of child view - the chrome
// (renderer/chrome.html, loaded once) and one WebContentsView per browser tab.
// The chrome talks to the main process only through the preload bridge, so a
// page can never reach the native addon, the filesystem or the control plane.

const { app, BrowserWindow, WebContentsView, clipboard, ipcMain, Menu, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const { createActions } = require("./actions");
const { Native, native: addon } = require("./native");
const { TabManager, CHROME_HEIGHT } = require("./tabs");
const { Session } = require("./session");
const { Settings } = require("./settings");
const { Identity } = require("./identity");
const { Reauth } = require("./reauth");
const { PasswordManager } = require("./credentials");
const { PasswordWatcher } = require("./passwordWatcher");
const { RotatorService } = require("./rotator");

const logLines = [];
// How often the shell re-checks the session cookie. The dashboard can change the
// session in another tab, and a stale "guest" state would wrongly hide features
// the user just unlocked (or show ones they lost).
function log(message) {
  const line = `${new Date().toISOString()} ${message}`;
  logLines.push(line);
  if (logLines.length > 500) logLines.shift();
  console.log(line);
}

// The smoke test drives these instead of reaching into ipcMain internals.
global.__netopsLogs = logLines;
const ipcHandlers = new Map();

let win = null;
let chromeView = null;
let tabs = null;
let core = null;
let settings = null;
let identity = null;
let reauth = null;
let passwords = null;
let watcher = null;
let rotator = null;
let sessionStore = null;

// The shape the password manager expects for copying. It used to hang off the
// Python service, which meant a clipboard write - the one thing a user absolutely
// must be able to do - was unavailable whenever that service was down.
//
// Every method is async because Electron 44 made the clipboard asynchronous to
// match navigator.clipboard, and then removed the sync helpers around it
// (writeHTML, readBuffer, availableFormats, and the rest). Nothing may assume a
// copy has landed by the time this returns: credentials.copy() awaits the write
// before reporting copied: true, so a failed clipboard cannot look like a
// successful copy.
const clipboardBridge = {
  writeText: async (text) => clipboard.writeText(String(text)),
  readText: async () => clipboard.readText(),
};

function readOverrides(userDataPath) {
  const overridePath = path.join(userDataPath, "browser.json");
  try {
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  } catch {
    return {};
  }
}

function sendToChrome(channel, payload) {
  if (!chromeView || chromeView.webContents.isDestroyed()) return;
  try {
    chromeView.webContents.send(channel, payload);
  } catch {
    // isDestroyed() is false while the renderer is gone but the view object is
    // still around, and send() throws then. That happens exactly when the shell
    // is recovering from a crash, and a broadcast that throws inside an event
    // handler turns one dead tab into a loop.
  }
}

// The password hook is only worth loading in a tab when the manager is usable, so
// capture stays a live check rather than a value baked in at startup: the vault
// can be locked at any moment without restarting the browser.
function captureEnabled() {
  if (!passwords || !settings) return false;
  if (settings.get("offerToSavePasswords") === false) return false;
  if (!identity || !identity.current()) return false;
  // Nothing can be stored until the vault can be opened, and opening it needs a
  // step-up. Capturing anyway would queue offers that cannot be saved.
  return passwords.status().verified;
}

function buildFeatureModules(userData, browserConfig) {
  settings = new Settings({ userDataPath: userData, core });
  // The gateway is its own process now, supervised directly by the shell. It is
  // deliberately not routed through the control plane: a browser should not need
  // a second language runtime and a localhost web server to switch a proxy on.
  rotator = new RotatorService({ log });

  identity = new Identity({ userDataPath: userData, log });
  const profile = identity.ensure();
  reauth = new Reauth();
  passwords = new PasswordManager({
    vault: { dir: path.join(userData, "vault") },
    identity,
    reauth,
// On Linux the key is only reachable through sudo, so it arrives from the step-up
  // helper and never rests anywhere between checks. Returning null rather than
  // throwing lets PasswordManager decide between "ask again" and "create one",
  // which is the difference between a first save working and not.
  keyProvider: async () => {
    const verified = reauth.verified;
    const key = verified && verified.key;
    return key && key.length === 32 ? key : null;
  },
  });
  watcher = new PasswordWatcher({
    manager: passwords,
    settings,
    identity,
    send: sendToChrome,
  });
  passwords.onOfferResolved(() => watcher.reset());

  // Settings changes have to reach two places: the chrome's own document (a
  // separate view with its own CSS) and the C++ page theme. Settings#patch
  // already did the native side and notifies here.
  settings.subscribe((values) => {
    applyAppearance();
    sendToChrome("netops:settings", values);
  });

  log(`features: vault ${path.join(userData, "vault")}, re-auth ${reauth.method()}`);
  log(`identity: ${profile.name}`);
  void browserConfig;
}

// A report from a tab's password hook. The payload is untrusted; watcher.handle
// does the validation and decides whether anything is offered.
//
// Registered once. createWindow can run more than once (macOS re-activate), and a
// second ipcMain.on for the same channel would offer every captured password
// twice.
let passwordHookAttached = false;

function attachPasswordHook() {
  if (passwordHookAttached) return;
  passwordHookAttached = true;

  ipcMain.on("netops:password-detected", (_event, payload) => {
    if (!watcher || !tabs) return;
    watcher
      .handle(payload, tabs.tabOrigins())
      .then((result) => {
        if (!result.accepted) log(`password capture declined: ${result.reason}`);
      })
      .catch((error) => log(`password capture failed: ${error.message}`));
  });
}

async function createWindow() {
  const userData = app.getPath("userData");
  const browserConfig = config.load(userData, readOverrides(userData));

  core = new Native(browserConfig);
  if (browserConfig.poolTiers && browserConfig.poolTiers.length) {
    core.configurePool(browserConfig.poolTiers);
    log(`proxy pool: ${JSON.stringify(core.pool.stats())}`);
  }
  log(`native ${addon.version} ready, ${core.blocklist.size()} block rules`);

  buildFeatureModules(userData, browserConfig);

  win = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: "#1e222a",
    title: "BlackNet",
    // WSLg/GNOME want a raster icon for the taskbar and title bar; the .ico is
    // kept alongside for Windows hosts.
    icon: path.join(__dirname, "..", "..", "assets", "icons", "blacknet-512.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The tab manager needs the window, and the chrome needs working IPC
  // handlers, so both come before chrome.html is loaded - otherwise the
  // renderer's first invokes race an empty handler table.
  tabs = new TabManager({
    window: win,
    native: core,
    config: browserConfig,
    log,
    captureEnabled,
    send: sendToChrome,
    rotator,
  });
  // Written as tabs are created and navigated, and read once here on launch. It is
  // handed to the tab manager rather than managed here so there is a single place
  // that knows when a tab comes into being.
  sessionStore = new Session({
    userDataPath: userData,
    log,
    enabled: settings.get("restoreSession") !== false,
  });
  tabs.sessionStore = sessionStore;
  registerIpc();
  attachPasswordHook();

  // Paint the chrome with the saved appearance before it asks for anything.
  applyAppearance();

  // Chrome owns the top strip; the browser views sit underneath it.
  chromeView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  chromeView.setBackgroundColor("#1e222a");
  // A silent renderer failure looks exactly like "the feature does not exist",
  // so surface its console output in the shell log.
  chromeView.webContents.on("console-message", (...args) => {
    // Electron changed this signature mid-32: (event, level, message, line,
    // sourceId) became (event, {level, message, lineNumber, sourceId}), and the
    // level turned into a string ("error" | "warning" | "info").
    const details = typeof args[1] === "object" && args[1] !== null ? args[1] : null;
    const level = details ? details.level : args[1];
    const message = details ? details.message : args[2];
    const line = details ? details.lineNumber : args[3];
    const source = details ? details.sourceId : args[4];
    const severe =
      level === undefined ||
      level === "error" ||
      (typeof level === "number" && level >= 2);
    if (severe && !/was preloaded using/.test(String(message))) {
      log(`[chrome] ${message} (${source}:${line})`);
    }
  });
  chromeView.webContents.on("preload-error", (_event, file, error) => {
    log(`[chrome] preload failed ${file}: ${error.message}`);
  });
  await chromeView.webContents.loadFile(path.join(__dirname, "..", "renderer", "chrome.html"));

  win.contentView.addChildView(chromeView);
  layoutChrome();

  // The vault decides whether the password hook is loaded, and captureEnabled()
  // reads a fresh verification rather than a cached session, so there is nothing
  // to prefetch here: the startup tab simply has no hook until the operator
  // presents a step-up, which is the correct state for a locked vault.

  // Reopening the previous session is tried first, and the blank startup tab is
  // the fallback. A restore with nothing in it and a restore that could not open
  // anything both land on the same page, so the operator never gets a blank
  // frame with no explanation.
  const restored = tabs.restore();
  if (!restored.opened) {
    await tabs.create({ active: true });
  }

  // Electron emits "resize" before the new content size is committed: read
  // inside the handler, getContentSize() still returns the *old* width. Laying
  // out synchronously therefore leaves the chrome at the pre-resize size, and
  // maximizing visibly stops the tab strip short of the window edge. Every
  // event that can change the geometry funnels through one coalesged layout
  // that runs after the new size has landed.
  for (const event of [
    "resize",
    "maximize",
    "unmaximize",
    "restore",
    "enter-full-screen",
    "leave-full-screen",
    "enter-html-full-screen",
    "leave-html-full-screen",
  ]) {
    win.on(event, scheduleLayout);
  }

  win.on("closed", () => {
    win = null;
  });
}

let layoutQueued = false;
function scheduleLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  setTimeout(() => {
    layoutQueued = false;
    layoutNow();
    // A window manager that animates the resize commits geometry across frames,
    // so one follow-up pass settles it without sleeping on a fixed delay.
    setTimeout(layoutNow, 60);
  }, 0);
}

function layoutNow() {
  if (!win || win.isDestroyed()) return;
  layoutChrome();
  if (tabs) tabs.resize();
}

function layoutChrome() {
  if (!chromeView || !win || win.isDestroyed()) return;
  const [width] = win.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
}

// The chrome and the Settings page are separate documents with their own CSS, so
// the saved colours are pushed to whichever of them currently exist. Neither
// inherits anything from the other.
function applyAppearance() {
  applyAppearanceTo(chromeView);
  if (!tabs) return;
  for (const view of tabs.internalViews()) applyAppearanceTo(view);
}

function applyAppearanceTo(view) {
  if (!view || view.webContents.isDestroyed() || !settings) return;
  view.webContents
    .executeJavaScript(
      `(${appearanceScript.toString()})(${JSON.stringify({
        ...settings.cssVariables(),
        theme: settings.get("scheme"),
      })})`,
      true,
    )
    .catch((error) => log(`appearance not applied: ${error.message}`));
}

function appearanceScript(vars) {
  const root = document.documentElement;
  // Remove the overrides we previously set before applying the current ones.
  for (const name of ["--bg", "--bg-raised", "--accent", "--accent-fill"]) {
    root.style.removeProperty(name);
  }
  // vars["color-scheme"] is already CSS-valid ("light", "dark" or "light dark").
  root.style.colorScheme = vars["color-scheme"] || "light dark";
  root.dataset.theme = vars.theme || "auto";
  if (vars["--bg"]) root.style.setProperty("--bg", vars["--bg"]);
  if (vars["--accent"]) root.style.setProperty("--accent", vars["--accent"]);
  if (vars["--accent-fill"]) root.style.setProperty("--accent-fill", vars["--accent-fill"]);
  return root.dataset.theme;
}

function registerIpc() {
  const actions = {
    ...createActions({
      core,
      tabs,
clipboard: clipboardBridge,
      settings,
      identity,
      passwords,
      rotator,
      sessionStore,
    }),
    "netops:open-external": async (url) => {
      // Only ever hand http(s) to the OS browser; never file: or a custom
      // scheme that could launch a local helper.
      const parsed = core.resolve(url);
      if (parsed.scheme !== "http" && parsed.scheme !== "https") {
        throw new Error(`refusing to open ${parsed.scheme} externally`);
      }
      await shell.openExternal(parsed.url);
      return parsed.url;
    },
  };

  ipcHandlers.clear();
  for (const [channel, fn] of Object.entries(actions)) {
    const wrapped = async (_event, ...args) => {
      try {
        return { ok: true, data: await fn(...args) };
      } catch (error) {
        return { ok: false, error: error.message };
      }
    };

    // The window can be recreated (macOS activate), and ipcMain.handle throws on
    // a second registration of the same channel.
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, wrapped);
    ipcHandlers.set(channel, (async (...args) => wrapped(null, ...args)));
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "Browser",
      submenu: [
        {
          label: "New tab",
          accelerator: "CmdOrCtrl+T",
          click: () => tabs.create({ active: true }),
        },
        {
          label: "Close tab",
          accelerator: "CmdOrCtrl+W",
          click: () => tabs.close(),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// A second instance would fight over the same profile partitions, the same
// settings file and the same proxy ports, so hand the launch back to the running
// window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === "win32") {
      try { app.setAppUserModelId("com.blacknet.desktop"); } catch (e) {}
    }
    try { app.setName("BlackNet"); } catch (e) {}
    // No Python, no control plane, no localhost server. The shell is the product:
    // settings, the vault, the pool and the gateway are all native or child
    // processes the browser supervises itself.
    await createWindow();
    buildMenu();

    // Restore the rotator preference from the last run. The window is already
    // usable by now, so a slow gateway start never delays first paint.
    if (settings.get("rotatorEnabled")) {
      rotator
        .start()
        .then((state) => {
          settings.setRotatorState({
            enabled: state === "running",
            state,
            detail: rotator.status().detail,
            adminOnly: false,
          });
          tabs.refreshProxy();
        })
        .catch((error) => log(`rotator: ${error.message}`));
    }

    if (process.argv.includes("--smoke")) {
      const { runSmoke } = require("./smoke");
      await runSmoke({
        handlers: ipcHandlers,
        BrowserWindow,
        app,
        getViews: () => ({ chrome: chromeView, tab: (id) => tabs.viewFor(id) }),
        quit,
      });
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

// Quitting must actually stop the proxy gateway, and neither `before-quit` nor
  // app.exit() waits for an async handler - app.exit() skips before-quit entirely.
  // So hold the quit event, stop the child, then exit for real. Without this every
  // run leaves a gateway still bound to 8888.
let quitting = false;
let exitCode = 0;

function quit(code = 0) {
  exitCode = code;
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitting || !rotator || !rotator.child) return;
  event.preventDefault();
  rotator
    .stop()
    .catch((error) => log(`rotator: ${error.message}`))
    .finally(() => {
      quitting = true;
      app.exit(exitCode);
    });
});
}
