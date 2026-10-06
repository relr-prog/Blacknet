"use strict";

// Tab manager built on WebContentsView. Each tab is an isolated Electron
// session partition, so cookies, cache and storage are per profile; every
// request in every partition passes the C++ URL policy and tracker blocklist
// before Chromium is allowed to open a socket.

const { WebContentsView, session } = require("electron");
const path = require("path");

const { internalPage, RENDERER_DIR } = require("./internal-pages");
const { Ledger, registrable, hostOf } = require("./ledger");

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
  constructor({ window: win, native, config, log, send, captureEnabled, rotator }) {
    this.window = win;
    this.native = native;
    this.config = config;
    this.log = log || (() => {});
    // Injected so this class never has to know how the chrome view is built.
    this.send = send || null;
    // Injected by main.js so TabManager does not need to know how the proxy
    // gateway is supervised. Only proxy() is used.
    this.rotator = rotator || null;
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
    // What each page actually asked for. In memory only, never persisted: a
    // tracker log that outlives the session is a browsing history.
    this.ledger = new Ledger();
    // webContents id -> tab id, so a request is charged to the tab that made it.
    // Sessions are shared per profile, so the profile alone is not enough.
    this.tabByContents = new Map();
    // webContents id -> the site that tab is currently showing, which is what
    // makes a request first- or third-party.
    this.siteByContents = new Map();
  }

  // --- tracker telemetry ----------------------------------------------------

  // The badge and the privacy report for one tab.
  telemetry(id) {
    return this.ledger.report(id === undefined ? this.activeId : id);
  }

  // Every tab's report, for the export.
  telemetryAll() {
    return this.ledger.export();
  }

  // A new top-level page starts a new accounting. Kept deliberately small: it
  // is the current page's trackers, not a running total for the session.
  #resetTelemetry(tab) {
    this.ledger.reset(tab.id);
    this.siteByContents.set(tab.view.webContents.id, registrable(hostOf(tab.view.webContents.getURL())));
  }

  #countBytes(tab, url, bytes) {
    if (bytes > 0) {
      const site = this.siteByContents.get(tab.view.webContents.id) || "";
      this.ledger.record(tab.id, { url, site, bytes });
    }
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
      // The page's tracker count and privacy grade. Lives on the tab because the
      // badge is drawn per tab and reading it must not be an IPC round trip.
      telemetry: this.ledger.glance(tab.id),
      // A crashed tab is showing the crash page, not the site it was on. The
      // chrome marks it, because a tab whose title changed by itself is not
      // something to leave for the operator to work out.
      crashed: Boolean(tab.crashed),
      // The reason and exit code Chromium reported, kept so the crash page and
      // any check on it show what actually happened instead of "unknown". These
      // are read-only diagnostics: no renderer can set them.
      crashReason: tab.crashReason || null,
      crashExitCode: tab.crashExitCode ?? null,
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
      const isMainFrame = details.resourceType === "mainFrame";
      if (reason) {
        this.#countBlocked(details.webContentsId, details.url, reason, isMainFrame);
        this.#emit("netops:blocked", { profile, url: details.url, reason });
        callback({ cancel: true });
        return;
      }
      // Allowed requests are counted too. A counter that only tallies refusals
      // cannot answer "did anything get through", which is the question a tracker
      // badge invites.
      this.#countAllowed(details.webContentsId, details.url, isMainFrame);
      callback({ cancel: false });
    };
    targetSession.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, handler);
    this.sessionBlockers.set(targetSession, handler);

    // Size for the data footprint. content-length is absent for chunked and
    // compressed responses, so this undercounts rather than guessing: a wrong
    // "KB transferred" figure would be worse than a conservative one.
    targetSession.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      const length = details.responseHeaders?.["content-length"];
      const bytes = Number.parseInt(Array.isArray(length) ? length[0] : length, 10);
      if (Number.isFinite(bytes) && bytes > 0) {
        this.#countBytes(details.webContentsId, details.url, bytes);
      }
      callback({ cancel: false });
    });
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

    // Loopback is allowed even though the URL policy blocks private ranges by
    // default: the proxy gateway the shell supervises lives there, and blocking it
    // would break the rotator from inside the browser that is using it.
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

  // Resolves the tab behind a request. A session is shared by every tab on the same
  // profile, so keying on the profile would charge tab 1's trackers to tab 2.
  #tabFor(contentsId) {
    if (contentsId === undefined || contentsId === null) return null;
    const id = this.tabByContents.get(contentsId);
    if (id === undefined) return null;
    return this.tabs.get(id) || null;
  }

  #countBlocked(contentsId, url, reason, isMainFrame) {
    const tab = this.#tabFor(contentsId);
    if (!tab) return;
    this.#beginPage(tab, url, isMainFrame);
    tab.blockedCount += 1;
    const site = this.siteByContents.get(tab.view.webContents.id) || "";
    // The rule name is what makes the count actionable, so it is pulled out of
    // the verdict text rather than stored as an opaque reason.
    const rule = /tracker rule ([^(]+)/.exec(reason);
    this.ledger.record(tab.id, {
      url,
      site,
      blocked: true,
      rule: rule ? rule[1].trim() : reason,
      mainFrame: isMainFrame,
    });
    this.#emit("netops:telemetry", this.telemetry(tab.id));
  }

  #countAllowed(contentsId, url, isMainFrame) {
    const tab = this.#tabFor(contentsId);
    if (!tab) return;
    this.#beginPage(tab, url, isMainFrame);
    const site = this.siteByContents.get(tab.view.webContents.id) || "";
    const insecure = /^http:\/\//i.test(String(url));
    if (!this.ledger.record(tab.id, { url, site, insecure, mainFrame: isMainFrame })) return;
    // Not on every allowed request: that would be one IPC message per asset on
    // every page load, which is exactly the cost a privacy browser cannot afford.
    if (tab.blockedCount > 0) this.#emit("netops:telemetry", this.telemetry(tab.id));
  }

  // A new top-level document starts a new accounting. Done here rather than on
  // did-navigate because this is the only place the document's own URL is known:
  // waiting for the commit would attribute the document to the previous page, and
  // resetting after it would throw away the subresources already counted.
  #beginPage(tab, url, isMainFrame) {
    if (!isMainFrame) return;
    this.ledger.reset(tab.id);
    this.siteByContents.set(tab.view.webContents.id, registrable(hostOf(url)));
  }

  // Events go to the chrome view, which is its own WebContents - not to the
  // window's webContents, which paints nothing and hosts no UI.
  #emit(channel, payload) {
    if (this.send) this.send(channel, payload);
  }

  // record: false is the restore path. A restored tab already has a slot in the
  // file it came from, so recording it as a new one first would append a copy
  // on top of the entry it is reopening and leave both behind - the file then
  // doubled on every launch, 2 tabs becoming 2, 4, 8, 16.
  create({ profile, url, active = true, record = true } = {}) {
    // The capture hook is attached here instead of unconditionally, so a browser
    // that is not capturing passwords keeps exactly the old security posture:
    // no preload at all in a page that loads untrusted content.
    const tab = this.#createTab({ profile, active, preload: this.captureEnabled() ? PASSWORD_HOOK : undefined });
    try {
      this.navigate(tab.id, url || this.config.newTabUrl);
    } catch (error) {
      // navigate() refuses a URL before it loads anything, and by then
      // #createTab has already registered the view. Leaving it behind would put
      // a blank tab in the strip for a session entry that never opened - and if
      // every entry failed, close()'s "no tabs left" branch would open a
      // replacement on top of the fallback main.js opens for itself.
      this.#discard(tab);
      throw error;
    }
    if (record && this.sessionStore) this.sessionStore.record(this.describe(tab));
    return this.describe(tab);
  }

  // Reopens the tabs that were open last time.
  //
  // The interesting case is the partial one. A single dead entry should not cost
  // the operator the other nine tabs, and silently returning fewer tabs than
  // yesterday - with no count and no reason - is how a browser becomes something
  // people stop trusting. So the skipped ones are counted and logged, and a URL
  // the current policy refuses is skipped rather than forced through.
  restore() {
    if (!this.sessionStore) return { opened: 0, skipped: 0 };
    const entries = this.sessionStore.all();
    if (!entries.length) return { opened: 0, skipped: 0 };

    const focus = this.sessionStore.focusSlot();
    let opened = 0;
    let skipped = 0;

    for (const entry of entries) {
      try {
        // Opened without recording: the entry is already in the file at
        // entry.slot, and recording it first is what used to duplicate it.
        const tab = this.create({
          profile: entry.profile,
          url: entry.url,
          active: false,
          record: false,
        });
        // Claimed rather than appended, so focus and slot ordering survive.
        // claim() only fails when the slot is genuinely gone, and an open tab
        // that gets dropped over bookkeeping is worse than one extra entry.
        if (!this.sessionStore.claim(tab.id, entry.slot)) {
          this.sessionStore.record(tab);
        }
        opened += 1;
      } catch (error) {
        skipped += 1;
        this.log(`session: could not reopen ${entry.url}: ${error.message}`);
      }
    }

    if (opened) {
      // Focus the tab that was in front last time. A session that cannot say which
      // one that was still lands somewhere sensible rather than on nothing.
      const wanted = focus === null
        ? null
        : [...this.tabs.values()].find(
            (tab) => this.sessionStore.restoredSlotFor(tab.id) === focus,
          );
      this.activate((wanted && wanted.id) || this.order[0]);
      this.log(`session: restored ${opened} tab(s)${skipped ? `, skipped ${skipped}` : ""}`);
    }

    return { opened, skipped };
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
    let reused = false;
    for (const id of this.order) {
      const existing = this.tabs.get(id);
      if (existing && existing.internalPage === name) {
        tab = existing;
        reused = true;
        break;
      }
    }

    if (!tab) {
      tab = this.#createTab({ active, preload: FULL_PRELOAD, pageTheme: false });
      tab.internalPage = name;
      tab.title = page.title;
      // Deliberately not recorded in the session. These are the shell's own pages
      // and they reopen by name, not by file path; storing a file:// URL that only
      // means something inside this installation would be a session entry that can
      // never be honoured.
    }
    tab.pendingUrl = path.basename(page.file, ".html");
    if (active) this.activate(tab.id);
    this.#broadcast();

    await tab.view.webContents.loadFile(page.file, hash ? { hash } : undefined).catch((error) => {
      // Closing a tab tears its view down mid-load; that is not a load failure.
      if (!this.tabs.has(tab.id)) return;
      this.log(`tab ${tab.id} internal page failed: ${error.message}`);
    });

    // Reusing a tab needs an explicit reload. loadFile() to the URL and hash the
    // tab is already showing is a same-document navigation: the page keeps its
    // DOM, its script never re-runs, and it goes on displaying whatever it read
    // last time. That is how a Settings tab opened before the proxy started goes
    // on reading "Service stopped" once it is running. Chromium 32 reloaded here
    // anyway; Chromium 152 (Electron 44) honours the standard and does not, so
    // this is a real behaviour change rather than a test artefact.
    if (reused) {
      // webContents.reload() returns void, not a promise: chaining .catch() on it
      // throws a TypeError that looks like an IPC failure. Waiting for
      // did-finish-load keeps the promise this method returns honest - a caller
      // that awaits openInternalPage gets a page that has finished rendering,
      // not one mid-reload with an empty panel.
      const wc = tab.view.webContents;
      if (!wc.isDestroyed()) {
        const settled = new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000);
          wc.once("did-finish-load", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        wc.reload();
        await settled;
      }
    }
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

  // Undoes a create() that failed after the view was registered.
  //
  // close() is deliberately not reused: it forgets the session slot, so the tab
  // would be erased from the next launch rather than retried, and it opens a
  // replacement whenever the last tab goes, which would stack a blank tab next
  // to the one main.js already opens as its fallback.
  #discard(tab) {
    if (!tab || !tab.view) return;
    const contentsId = tab.view.webContents.id;
    if (this.window && !this.window.isDestroyed()) {
      this.window.contentView.removeChildView(tab.view);
    }
    tab.view.webContents.close();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();
    this.tabByContents.delete(contentsId);
    this.siteByContents.delete(contentsId);
    this.ledger.reset(tab.id);
    this.tabs.delete(tab.id);
    this.order = this.order.filter((candidate) => candidate !== tab.id);
    if (this.activeId === tab.id) this.activeId = this.order[0] || null;
    this.#layout();
    this.#broadcast();
  }

  #wireTab(tab) {
    const wc = tab.view.webContents;
    this.tabByContents.set(wc.id, tab.id);

    wc.on("page-title-updated", (_event, title) => {
      tab.title = title || tab.title;
      this.#broadcast();
    });
    wc.on("did-start-loading", () => this.#broadcast());
    wc.on("did-stop-loading", () => this.#broadcast());
    wc.on("did-navigate", (_event, url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        // The ledger is reset by the request filter, which sees the document
        // request itself. This only keeps the known site current, for the window
        // between the request and the commit.
        this.siteByContents.set(wc.id, registrable(hostOf(url)));
        this.#broadcast();
      }
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
    // Kept before the crash page replaces the document, and used by reload() to
    // put the operator back where they were.
    tab.crashedUrl = tab.view.webContents.getURL() || tab.pendingUrl || null;
    // Recorded on the tab so describe() can report what Chromium said, rather
    // than the page having to be scraped to find out.
    tab.crashReason = details.reason || "crashed";
    tab.crashExitCode = details.exitCode ?? null;
    tab.title = "Crashed";
    this.#emit("netops:crashed", {
      tabId: tab.id,
      reason: details.reason,
      exitCode: details.exitCode,
      url: tab.crashedUrl,
    });
    this.#showCrashPage(tab, details);
    this.#broadcast();
  }

  // A load started in the same tick as the crash is routinely aborted (ERR_ABORTED)
  // because the old process is still going away. Retried once after a beat rather
  // than given up on: the alternative is a tab left showing a dead page, which is
  // indistinguishable from the crash itself and gives the operator nothing.
  //
  // The retry checks that the tab is still crashed first. It can arrive after the
  // operator has already pressed Reload, and putting the crash page back on top of
  // a page that has just recovered is worse than never showing it.
  #showCrashPage(tab, details, attempt = 0) {
    const wc = tab.view.webContents;
    if (!this.tabs.has(tab.id) || wc.isDestroyed()) return;
    if (!tab.crashed) return;
    wc.loadFile(RENDERER_DIR + "/crashed.html", {
      query: { reason: details.reason, code: String(details.exitCode) },
    }).catch((error) => {
      if (attempt === 0 && /ERR_ABORTED|aborted/i.test(error.message || "")) {
        setTimeout(() => this.#showCrashPage(tab, details, 1), 150);
        return;
      }
      this.log(`tab ${tab.id} crash page failed: ${error.message}`);
    });
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
  // resulting host:port and every tab in the profile shares it. When the rotating
  // gateway is up it wins, because it is the thing that actually changes the exit
  // IP per request rather than per profile.
  #applyProxy(tab) {
    const gateway = this.rotator ? this.rotator.proxy() : null;
    let rules = gateway;
    if (!rules) {
      const upstream = this.native.pickUpstream(tab.profile);
      if (!upstream) {
        tab.proxy = null;
        return;
      }
      const protocol = upstream.kind === "socks5" ? "socks5" : "http";
      rules = `${protocol}://${upstream.host}:${upstream.port}`;
    }
    const tabSession = this.#partitionSession(tab.profile);
    tabSession
      .setProxy({ proxyRules: rules })
      .then(() => {
        tab.proxy = rules;
        this.#broadcast();
      })
      .catch((error) => this.log(`proxy: ${error.message}`));
  }

  // Called when the rotator is switched on or off: every tab has to be told a
  // new proxy, not just the ones created after the change.
  refreshProxy() {
    for (const tab of this.tabs.values()) this.#applyProxy(tab);
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
    // Recorded from the resolved URL, not the typed text: the address bar can hold
    // half-finished input, and a session file full of typos is a session file that
    // reopens onto error pages.
    if (this.sessionStore) this.sessionStore.navigate({ ...this.describe(tab), url: parsed.url });
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
    // A crashed tab is showing the crash page, so reloading would reload the crash
    // page - and the operator would be pressing Reload forever. The URL they
    // actually wanted is kept for exactly this moment.
    if (tab.crashed) {
      tab.crashed = false;
      const back = tab.crashedUrl;
      tab.crashedUrl = null;
      tab.crashReason = null;
      tab.crashExitCode = null;
      if (back) {
        this.log(`tab ${tab.id} reloading after crash: ${back}`);
        return this.navigate(tab.id, back);
      }
      tab.view.webContents.reloadIgnoringCache(hard);
      return this.describe(tab);
    }
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
    if (this.sessionStore) this.sessionStore.setActive(id);
    this.#layout();
    this.#broadcast();
    return this.active();
  }

  close(id) {
    const tab = this.tabs.get(id || this.activeId);
    if (!tab) return null;

    // The maps are keyed by a webContents id, which Chromium reuses once the
    // view is gone. Leaving an entry behind would charge a later tab's requests
    // to a closed one.
    const contentsId = tab.view.webContents.id;
    this.window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.destroy();
    this.tabByContents.delete(contentsId);
    this.siteByContents.delete(contentsId);
    this.ledger.reset(id);
    this.tabs.delete(id);
    if (this.sessionStore) this.sessionStore.forget(id);
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
    // The layout pass is deferred, so the window can be gone by the time it
    // runs; getContentSize() on a destroyed window throws.
    if (!this.window || this.window.isDestroyed()) return;
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
  // This used to answer "who is signed in" for the shell, which needed the
  // partition the page was actually using because the shell had no session of its
  // own. There is no session to answer for any more - the vault is unlocked by a
  // step-up, not by a cookie - so it is now just the privacy report's input.
  // Returning the raw jar is safe because this stays in the main process; only
  // derived counts and domains cross to the renderer.
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
