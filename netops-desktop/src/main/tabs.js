"use strict";

// Tab manager built on WebContentsView. Each tab is an isolated Electron
// session partition, so cookies, cache and storage are per profile; every
// request in every partition passes the C++ URL policy and tracker blocklist
// before Chromium is allowed to open a socket.

const { WebContentsView, session } = require("electron");
const path = require("path");

const { internalPage, RENDERER_DIR } = require("./internal-pages");

const CHROME_HEIGHT = 92;

// Schemes Chromium resolves internally; they never reach the network, so the
// URL policy has no opinion about them.
const NON_NETWORK_SCHEME = /^(about|data|blob|chrome|chrome-extension|devtools):/i;

// The shell's own UI files. These are the only file:// URLs allowed to load: the
// URL policy refuses file: everywhere else, and a remote page cannot reach these
// paths anyway (Chromium blocks file:// from http(s) on its own). internal-pages
// resolves the same directory and re-exports it.
// The shell also loads its own icon set from here (top bar brand mark).
const ASSETS_DIR = path.join(__dirname, "..", "..", "assets");
// The password-capture hook. This is the single, deliberate exception to the
// "no preload in a tab" rule below; it is loaded only when the password manager
// is actually available and exposes a single one-way report() function.
const PASSWORD_HOOK = path.join(__dirname, "..", "preload", "password-hook.js");
// The full bridge. Attached to the chrome view and to the internal pages below,
// and to nothing else.
const FULL_PRELOAD = path.join(__dirname, "..", "preload", "preload.js");

// Pages emit plenty of console noise that is not our problem and would train the
// operator to ignore the log. Only things that look like real faults are kept.
const BENIGN_CONSOLE = [
  /was preloaded using link preload but not used/i,
  /was preloaded using browser but not used/i,
  /\[Report Only\]/,
];

function isRealConsoleFault(level, message) {
  if (BENIGN_CONSOLE.some((pattern) => pattern.test(message))) return false;
  return level === undefined || level === "error" || (typeof level === "number" && level >= 2);
}

class TabManager {
  constructor({ window: win, native, config, log, send, captureEnabled }) {
    this.window = win;
    this.native = native;
    this.config = config;
    this.log = log || (() => {});
    // Injected so this class never has to know how the chrome view is built.
    this.send = send || null;
    // Injected by main.js so TabManager does not need to know about the password
  // manager. Returns false while the feature is unavailable (guest, signed out,
  // or switched off in settings).
  this.captureEnabled = typeof captureEnabled === "function" ? captureEnabled : () => false;
  this.tabs = new Map(); // id -> tab
    this.order = []; // tab ids, left to right
    this.activeId = null;
    this.nextId = 1;
    this.sessionBlockers = new Map(); // session -> handler ref
    this.downloadGuards = new Set(); // partitions already guarded
  }

  partitionFor(profile) {
    return `persist:netops-${profile || this.config.defaultProfile}`;
  }

  list() {
    return this.order.map((id) => this.describe(this.tabs.get(id)));
  }

  describe(tab) {
    if (!tab) return null;
    const wc = tab.view.webContents;
    return {
      id: tab.id,
      profile: tab.profile,
      title: tab.title,
      url: wc.getURL() || tab.pendingUrl || this.config.newTabUrl,
      loading: wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      blocked: tab.blockedCount,
      audioMuted: wc.isAudioMuted(),
      proxy: tab.proxy || null,
      // Set only for the shell's own pages, so the chrome can tell that closing
      // Settings is what should lock the vault again.
      internalPage: tab.internalPage || null,
    };
  }

  active() {
    return this.describe(this.tabs.get(this.activeId));
  }

  // The shell's own pages, so main can push the saved appearance to them: they
  // are separate documents from the chrome and do not inherit its CSS.
  internalViews() {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter((tab) => tab && tab.internalPage)
      .map((tab) => tab.view);
  }

  // Only the main process may touch a view, and only the smoke test asks for one.
  viewFor(id) {
    const tab = this.tabs.get(id);
    return tab ? tab.view : null;
  }

  #partitionSession(profile) {
    return session.fromPartition(this.partitionFor(profile), { cache: true });
  }

  // Chromium must not open a socket to something the C++ policy rejects, and
  // third-party requests are dropped by the tracker list before they leave.
  #installBlocking(targetSession, profile) {
    if (this.sessionBlockers.has(targetSession)) return;
    const handler = (details, callback) => {
      const reason = this.#verdict(details.url, profile);
      if (reason) {
        this.#countBlocked(profile);
        this.#emit("netops:blocked", { profile, url: details.url, reason });
        callback({ cancel: true });
        return;
      }
      callback({ cancel: false });
    };
    targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, handler);
    this.sessionBlockers.set(targetSession, handler);
  }

  #isShellFile(url) {
    if (!url.startsWith("file://")) return false;
    let file;
    try {
      file = decodeURIComponent(new URL(url).pathname);
    } catch {
      return false;
    }
    return file.startsWith(RENDERER_DIR + path.sep)
      || file.startsWith(ASSETS_DIR + path.sep);
  }

#verdict(url, profile) {
    // Schemes that never open a socket, and the shell's own local UI files.
    if (!url || NON_NETWORK_SCHEME.test(url) || this.#isShellFile(url)) {
      return null;
    }

    let parsed;
    try {
      parsed = this.native.resolve(url);
    } catch (error) {
      return `url policy: ${error.message}`;
    }

    // The control plane itself is loopback: allow it even though the URL policy
    // blocks private ranges by default.
    if (parsed.host === "127.0.0.1" || parsed.host === "localhost" || parsed.host === "::1") {
      return null;
    }
    if (parsed.host.startsWith("[")) return null; // IPv6 literals are opt-in targets

    if (this.config.blockPrivateHosts) {
      const check = this.native.validateHost(parsed.host);
      if (!check.ok) return `host policy: ${check.error}`;
    }

    if (this.native.shouldBlockRequest(url)) {
      const verdict = this.native.verdictFor(url);
      return `tracker rule ${verdict.pattern} (${verdict.source})`;
    }
    return null;
  }

  #countBlocked(profile) {
    const tab = [...this.tabs.values()].find((candidate) => candidate.profile === profile);
    if (tab) tab.blockedCount += 1;
  }

  // Events go to the chrome view, which is its own WebContents - not to the
  // window's webContents, which paints nothing and hosts no UI.
  #emit(channel, payload) {
    if (this.send) this.send(channel, payload);
  }

  create({ profile, url, active = true } = {}) {
    // The capture hook is attached here instead of unconditionally, so a browser
    // that is not capturing passwords keeps exactly the old security posture:
    // no preload at all in a page that loads untrusted content.
    const tab = this.#createTab({ profile, active, preload: this.captureEnabled() ? PASSWORD_HOOK : undefined });
    this.navigate(tab.id, url || this.config.newTabUrl);
    return this.describe(tab);
  }

  // Settings and Privacy are local pages of the shell shown in an ordinary tab.
  // There is one tab per name: asking again focuses the tab that is already
  // there rather than stacking copies, and the requested view is re-applied so
  // the toolbar always lands on the same half.
  async openInternalPage(name, { active = true, view } = {}) {
    const page = internalPage(name);
    if (!page) throw new Error(`unknown internal page ${name}`);

    const hash = typeof view === "string" && view ? view.replace(/^#/, "") : "";

    let tab = null;
    for (const id of this.order) {
      const existing = this.tabs.get(id);
      if (existing && existing.internalPage === name) {
        tab = existing;
        break;
      }
    }

    if (!tab) {
      tab = this.#createTab({ active, preload: FULL_PRELOAD, pageTheme: false });
      tab.internalPage = name;
      tab.title = page.title;
    }
    tab.pendingUrl = path.basename(page.file, ".html");
    if (active) this.activate(tab.id);
    this.#broadcast();

    await tab.view.webContents.loadFile(page.file, hash ? { hash } : undefined).catch((error) => {
      // Closing a tab tears its view down mid-load; that is not a load failure.
      if (!this.tabs.has(tab.id)) return;
      this.log(`tab ${tab.id} internal page failed: ${error.message}`);
    });
    return this.describe(tab);
  }

  // Builds a tab view and registers it. preload is decided by the caller, which
  // is the single place the "no bridge in a page that loads untrusted content"
  // rule is applied.
  #createTab({ profile, active = true, preload, pageTheme = true }) {
    if (this.tabs.size >= this.config.maxTabs) {
      throw new Error(`tab limit reached (${this.config.maxTabs})`);
    }

    const id = this.nextId;
    this.nextId += 1;
    const tabProfile = profile || this.config.defaultProfile;
    const tabSession = this.#partitionSession(tabProfile);
    this.#installBlocking(tabSession, tabProfile);
    this.#applyPrivacy(tabSession);

    const view = new WebContentsView({
      webPreferences: {
        partition: this.partitionFor(tabProfile),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        // Nothing here loads untrusted content, so no preload is the safe
        // default for a normal tab. The chrome view is the only renderer that
        // always gets preload.js, and the password hook above is the one
        // deliberate exception, exposing a single report() call and only while
        // the password manager is switched on for a signed-in account.
        // Internal pages from the table above get the full bridge.
        preload,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    view.setBackgroundColor("#1e222a");

    const tab = {
      id,
      profile: tabProfile,
      session: tabSession,
      view,
      title: "New tab",
      pendingUrl: this.config.newTabUrl,
      blockedCount: 0,
      proxy: null,
      internalPage: null,
    };
    this.tabs.set(id, tab);
    this.order.push(id);

    this.window.contentView.addChildView(view);
    this.#wireTab(tab);
    this.#applyProxy(tab);
    // The page theme restyles content with !important rules. The shell's own
    // pages are not content: they follow palette.css and the saved appearance,
    // so they must not be handed the reading theme.
    if (pageTheme) this.#applyTheme(tab);

    if (active) this.activate(id);
    else this.#layout();

    this.#broadcast();
    return tab;
  }

  #wireTab(tab) {
    const wc = tab.view.webContents;

    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.#broadcast();
    });
    wc.on("did-start-loading", () => this.#broadcast());
    wc.on("did-stop-loading", () => this.#broadcast());
    wc.on("did-navigate", (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) this.#broadcast();
    });
    wc.on("did-navigate-in-page", (_event) => this.#broadcast());
    wc.on("page-favicon-updated", () => this.#broadcast());
    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return; // -3 is an aborted load
      tab.title = `Failed to load (${code})`;
      // The URL and code are the whole diagnosis, so they go to the log.
      this.log(`tab ${tab.id} load failed ${code} ${description}: ${url}`);
      this.#emit("netops:load-failed", { tabId: tab.id, code, description, url });
      this.#broadcast();
    });
    wc.on("render-process-gone", (_event, details) => {
      this.log(
        `tab ${tab.id} renderer gone: ${details.reason} (exit ${details.exitCode})`,
      );
      this.#recoverFromCrash(tab, details);
    });
    // A page's own JavaScript errors are the single most useful thing an operator
    // can be told about a tab, so they go to the shell log rather than vanishing.
    wc.on("console-message", (...args) => {
      const details = typeof args[1] === "object" && args[1] !== null ? args[1] : null;
      const level = details ? details.level : args[1];
      const message = details ? details.message : args[2];
      const source = details ? details.sourceId : args[4];
      if (isRealConsoleFault(level, message)) {
        this.log(`tab ${tab.id} console: ${message} (${source})`);
      }
    });
    wc.on("preload-error", (_event, file, error) => {
      this.log(`tab ${tab.id} preload failed ${file}: ${error.message}`);
    });
    wc.on("unresponsive", () => this.log(`tab ${tab.id} is unresponsive`));
    wc.on("responsive", () => this.log(`tab ${tab.id} recovered`));
    // Downloads are a classic exfiltration path: hand them to the shell, which
    // asks the operator first. One listener per partition, not per tab.
    if (!this.downloadGuards.has(tab.session)) {
      this.downloadGuards.add(tab.session);
      tab.session.on("will-download", (_session, item) => {
        this.#emit("netops:download", { filename: item.getFilename() });
        item.cancel();
      });
    }
  }

  // A crashed renderer must not take the window with it: keep the tab, replace
  // its content with an explanation, and let the operator decide what to do.
  // Closing the tab here used to close the last tab, which quit the whole app.
  #recoverFromCrash(tab, details) {
    tab.crashed = true;
    tab.title = "Crashed";
    this.#emit("netops:crashed", {
      tabId: tab.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    tab.view.webContents
      .loadFile(RENDERER_DIR + "/crashed.html", {
        query: { reason: details.reason, code: String(details.exitCode) },
      })
      .catch((error) => this.log(`tab ${tab.id} crash page failed: ${error.message}`));
    this.#broadcast();
  }

  // Permissions are opt-in, not opt-out.
  #applyPrivacy(targetSession) {
    const allowed = new Set(this.config.defaultPermissions || []);
    targetSession.setPermissionRequestHandler((_wc, requested, callback) => {
      callback(allowed.has(requested));
    });
    targetSession.setPermissionCheckHandler((_wc, requested) => allowed.has(requested));
  }

  // The C++ pool picks the upstream for this profile; Chromium is told the
  // resulting host:port and every tab in the profile shares it.
  #applyProxy(tab) {
    const upstream = this.native.pickUpstream(tab.profile);
    if (!upstream) {
      tab.proxy = null;
      return;
    }
    const tabSession = this.#partitionSession(tab.profile);
    const protocol = upstream.kind === "socks5" ? "socks5" : "http";
    tabSession
      .setProxy({ proxyRules: `${protocol}://${upstream.host}:${upstream.port}` })
      .then(() => {
        tab.proxy = `${protocol}://${upstream.host}:${upstream.port}`;
        this.#broadcast();
      })
      .catch((error) => this.log(`proxy: ${error.message}`));
  }

  #applyTheme(tab) {
    const css = this.native.theme && this.native.theme.css;
    if (!css) return;
    // Themes restyle the page itself, so the chrome and the page differ on
    // purpose: that is the product, not a bug.
    tab.view.webContents.insertCSS(css).catch(() => {});
  }

  // A fresh tab gets a real local page rather than about:blank: about:blank carries
// no Content-Security-Policy, which makes Electron log a security warning on
// every single new tab.
  #loadNewTab(tab) {
    tab.title = "New tab";
    return tab.view.webContents.loadFile(RENDERER_DIR + "/newtab.html").catch((error) => {
      // Closing a tab tears its view down mid-load; that is not a failure.
      if (!this.tabs.has(tab.id)) return;
      this.log(`tab ${tab.id} new tab page failed: ${error.message}`);
    });
  }

  navigate(id, input) {
    const tab = this.tabs.get(id);
    if (!tab) throw new Error(`unknown tab ${id}`);

    const requested = input || this.config.newTabUrl;
    if (requested === "about:blank" || !requested) {
      this.#loadNewTab(tab);
      return this.describe(tab);
    }

    let target = requested;
    const looksLikeUrl = /^[a-z][a-z0-9+.-]*:|^\/\//i.test(requested) || requested.includes(".");
    if (!looksLikeUrl && this.config.searchUrl) {
      target = this.config.searchUrl.replace("%s", encodeURIComponent(requested));
    }

    // Same policy the request filter applies, so the address bar can never
    // reach a host or scheme the network layer would refuse anyway.
    const reason = this.#verdict(target, tab.profile);
    if (reason) throw new Error(reason);

    const parsed = this.native.resolve(target);
    tab.pendingUrl = parsed.url;
    tab.view.webContents.loadURL(parsed.url).catch((error) => {
      // Closing a tab tears its view down mid-load; that is not a load failure.
      if (!this.tabs.has(id)) return;
      this.log(`tab ${id}: ${error.message}`);
      this.#emit("netops:load-failed", { id, description: error.message });
    });
    return this.describe(tab);
  }

  go(id, delta) {
    const tab = this.tabs.get(id || this.activeId);
    if (!tab) return null;
    const history = tab.view.webContents.navigationHistory;
    if (delta < 0 && history.canGoBack()) history.goBack();
    if (delta > 0 && history.canGoForward()) history.goForward();
    return this.describe(tab);
  }

  reload(id, hard = false) {
    const tab = this.tabs.get(id || this.activeId);
    if (!tab) return null;
    tab.view.webContents.reloadIgnoringCache(hard);
    return this.describe(tab);
  }

  stop(id) {
    const tab = this.tabs.get(id || this.activeId);
    if (tab) tab.view.webContents.stop();
    return this.describe(tab);
  }

  setMuted(id, muted) {
    const tab = this.tabs.get(id || this.activeId);
    if (tab) tab.view.webContents.setAudioMuted(muted);
    return this.describe(tab);
  }

  activate(id) {
    if (!this.tabs.has(id)) return this.active();
    this.activeId = id;
    this.#layout();
    this.#broadcast();
    return this.active();
  }

  close(id) {
    const tab = this.tabs.get(id || this.activeId);
    if (!tab) return null;

    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();
    this.tabs.delete(id);
    this.order = this.order.filter((candidate) => candidate !== id);

    if (this.activeId === id) {
      this.activeId = this.order[Math.max(0, this.order.indexOf(id))] || null;
    }
    if (this.order.length === 0) this.create({ active: true });
    else this.#layout();
    this.#broadcast();
    return this.list();
  }

  #layout() {
    const [width, height] = this.window.getContentSize();
    for (const id of this.order) {
      const tab = this.tabs.get(id);
      if (!tab) continue;
      tab.view.setBounds(
        id === this.activeId
          ? { x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) }
          : { x: 0, y: 0, width: 0, height: 0 },
      );
    }
  }

  resize() {
    this.#layout();
  }

  // --- privacy reporting --------------------------------------------------
  // The active tab's own cookies, as Chromium sees them.
  //
  // The shell has no session of its own - it is a different process from the
  // dashboard - so "who is logged in" can only be answered from the partition the
  // page is actually using. Returning the raw jar is safe because this stays in
  // the main process; only the derived account state crosses to the renderer.
  async sessionCookies(profile) {
    const tab = this.tabs.get(this.activeId);
    const partition =
      (tab && tab.session && tab.session) ||
      this.#partitionSession(profile || this.config.defaultProfile);
    try {
      return await partition.cookies.get({});
    } catch {
      return [];
    }
  }

  // A short, honest description of the open tabs for the capture checks: origin
  // only, no history.
  tabOrigins() {
    return [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      url: tab.view && !tab.view.webContents.isDestroyed() ? tab.view.webContents.getURL() : "",
    }));
  }

  // Open (or focus) the control plane dashboard, which is where login, signup
  // and guest live.
  async openDashboard(url) {
    const target = url || this.#dashboardUrl();
    const tab = await this.create({ active: true });
    await this.navigate(tab.id, target);
    return tab;
  }

  // The control plane is local; its port comes from the service, not config.
  #dashboardUrl() {
    const port = Number(process.env.NETOPS_PORT || 8787);
    return `http://127.0.0.1:${port}/`;
  }

  async cookieReport(profile) {
    const targetSession = this.#partitionSession(profile || this.config.defaultProfile);
    const cookies = await targetSession.cookies.get({});
    const jar = this.native.jar(this.partitionFor(profile || this.config.defaultProfile));
    jar.ingest(
      cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        expires: cookie.expirationDate || -1,
      })),
    );
    return jar.report(Date.now() / 1000);
  }

  async clearCookies(profile, domain) {
    const targetSession = this.#partitionSession(profile || this.config.defaultProfile);
    if (!domain) {
      await targetSession.clearStorageData({ storages: ["cookies"] });
      return this.cookieReport(profile);
    }

    // Electron removes one cookie at a time, so walk the matches.
    const matches = await targetSession.cookies.get({ domain });
    for (const cookie of matches) {
      await targetSession.cookies.remove(cookie.url, cookie.name);
    }
    return this.cookieReport(profile);
  }

  async cacheReport(profile) {
    return this.#scanProfileCache(profile);
  }

  async clearCache(profile) {
    const targetSession = this.#partitionSession(profile || this.config.defaultProfile);
    await targetSession.clearCache();
    return this.#scanProfileCache(profile);
  }

  // Electron owns the partition directory layout, so ask the session where it
  // lives instead of guessing it and scanning the wrong tree.
  async #scanProfileCache(profile) {
    const partition = this.partitionFor(profile || this.config.defaultProfile);
    const targetSession = this.#partitionSession(profile || this.config.defaultProfile);
    const root = await targetSession.getStoragePath();
    return this.native.cacheFor(root || this.config.profileRoot).scan();
  }

  #broadcast() {
    this.#emit("netops:tabs", {
      tabs: this.list(),
      activeId: this.activeId,
      chromeHeight: CHROME_HEIGHT,
    });
  }

  broadcast() {
    this.#broadcast();
  }
}

module.exports = { TabManager, CHROME_HEIGHT };
