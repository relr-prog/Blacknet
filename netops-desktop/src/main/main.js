"use strict";

// netops desktop shell.
//
// Layout: the window's contentView owns two kinds of child view - the chrome
// (renderer/chrome.html, loaded once) and one WebContentsView per browser tab.
// The chrome talks to the main process only through the preload bridge, so a
// page can never reach the native addon, the filesystem or the control plane.

const { app, BrowserWindow, WebContentsView, ipcMain, Menu, shell } = require("electron");
const fs = require("fs");
const path = require("path");

const config = require("./config");
const { createActions } = require("./actions");
const { PythonService } = require("./service");
const { Native, native: addon } = require("./native");
const { TabManager, CHROME_HEIGHT } = require("./tabs");
const { Settings } = require("./settings");
const { Account } = require("./account");
const { Reauth } = require("./reauth");
const { PasswordManager } = require("./credentials");
const { PasswordWatcher } = require("./passwordWatcher");

const logLines = [];
// How often the shell re-checks the session cookie. The dashboard can change the
// session in another tab, and a stale "guest" state would wrongly hide features
// the user just unlocked (or show ones they lost).
const ACCOUNT_POLL_MS = 20000;
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
let service = null;
let core = null;
let settings = null;
let account = null;
let reauth = null;
let passwords = null;
let watcher = null;
let rotatorEndpoint = null;

function readOverrides(userDataPath) {
  const overridePath = path.join(userDataPath, "browser.json");
  try {
    return JSON.parse(fs.readFileSync(overridePath, "utf8"));
  } catch {
    return {};
  }
}

function sendToChrome(channel, payload) {
  if (chromeView && !chromeView.webContents.isDestroyed()) {
    chromeView.webContents.send(channel, payload);
  }
}

// The password hook is only worth loading in a tab when the manager is usable, so
// capture stays a live check rather than a value baked in at startup: the user
// may log in or switch the feature off without restarting the browser.
function captureEnabled() {
  if (!passwords || !settings || !account) return false;
  if (settings.get("offerToSavePasswords") === false) return false;
  const state = account.current;
  return Boolean(state && state.authenticated === true && state.guest !== true);
}

function buildFeatureModules(userData, browserConfig, port) {
  settings = new Settings({ userDataPath: userData, core });
  rotatorEndpoint = `http://127.0.0.1:${port}`;

  account = new Account({ endpoint: rotatorEndpoint });
  reauth = new Reauth();
  passwords = new PasswordManager({
    vault: { dir: path.join(userData, "vault") },
    account,
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
    account,
    send: sendToChrome,
  });
  passwords.onOfferResolved(() => watcher.reset());

  // Settings changes have to reach two places: the chrome's own document (a
  // separate view with its own CSS) and the C++ page theme. Settings#patch
  // already did the native side and notifies here.
  settings.subscribe((values) => {
    applyAppearanceToChrome();
    sendToChrome("netops:settings", values);
  });

  // Keep the shell's idea of the session current without the UI having to poll:
  // the dashboard can log in or out in another tab at any time.
  setInterval(() => {
    if (!tabs) return;
    tabs
      .sessionCookies()
      .then((cookies) => account.state(cookies, { force: true }))
      .then((state) => sendToChrome("netops:account", state))
      .catch(() => {});
  }, ACCOUNT_POLL_MS);

  log(`features: vault ${path.join(userData, "vault")}, re-auth ${reauth.method()}`);
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

  buildFeatureModules(userData, browserConfig, Number(process.env.NETOPS_PORT || 8787));

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
  });
  registerIpc();
  attachPasswordHook();

  // Paint the chrome with the saved appearance before it asks for anything.
  applyAppearanceToChrome();

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

  // Learn who is signed in *before* the first tab exists. captureEnabled() is read
  // when a tab's preload is chosen, and an account that has not been fetched yet
  // reads as signed out - which would leave the startup tab without the hook.
  try {
    account.state(await tabs.sessionCookies(), { force: true });
  } catch (error) {
    log(`account refresh before first tab failed: ${error.message}`);
  }

  await tabs.create({ active: true });

  win.on("resize", () => {
    layoutChrome();
    tabs.resize();
  });

  win.on("closed", () => {
    win = null;
  });
}

function layoutChrome() {
  if (!chromeView || !win) return;
  const [width] = win.getContentSize();
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT });
}

// The chrome is a separate view with its own document, so the saved colours are
// pushed to it as CSS custom properties and applied on its root element.
function applyAppearanceToChrome() {
  if (!chromeView || chromeView.webContents.isDestroyed() || !settings) return;
  chromeView.webContents
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
      service,
      settings,
      account,
      passwords,
      rotatorEndpoint,
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

// A second instance would fight over the same profile partitions and the same
// control-plane port, so hand the launch back to the running window.
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
    service = new PythonService({ port: Number(process.env.NETOPS_PORT || 8787), log });
    // Do not block the window on Python: the shell is usable without it.
    service.start().catch((error) => log(`service: ${error.message}`));
    await createWindow();
    buildMenu();

    if (process.argv.includes("--smoke")) {
      const { runSmoke } = require("./smoke");
      await runSmoke({
        handlers: ipcHandlers,
        BrowserWindow,
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

  // Quitting must actually stop Python, and neither `before-quit` nor app.exit()
// waits for an async handler - app.exit() skips before-quit entirely. So hold the
// quit event, stop the service, then exit for real. Without this every run leaves
// an orphaned uvicorn holding the port.
let quitting = false;
let exitCode = 0;

function quit(code = 0) {
  exitCode = code;
  app.quit();
}

app.on("before-quit", (event) => {
  if (quitting || !service || !service.child) return;
  event.preventDefault();
  service
    .stop()
    .catch((error) => log(`service: ${error.message}`))
    .finally(() => {
      quitting = true;
      app.exit(exitCode);
    });
});
}
