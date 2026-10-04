"use strict";

// Chrome UI: tab strip, address bar and the privacy panel. It runs in an
// isolated context and can only do what preload.js exposes.

const tabstrip = document.getElementById("tabstrip");
const urlInput = document.getElementById("url");
const statusLine = document.getElementById("status");
const lockIcon = document.getElementById("lock");
const audioIcon = document.getElementById("audio");

const buttons = {
  back: document.getElementById("back"),
  forward: document.getElementById("forward"),
  reload: document.getElementById("reload"),
  newtab: document.getElementById("newtab"),
  inspect: document.getElementById("inspect"),
};

const panel = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
const panelTitle = document.getElementById("panel-title");

const state = { tabs: [], activeId: null, profile: undefined };

// --- helpers --------------------------------------------------------------
function unwrap(result) {
  if (!result || result.ok !== true) {
    throw new Error((result && result.error) || "request failed");
  }
  return result.data;
}

function setStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("error", Boolean(isError));
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// --- tab strip ------------------------------------------------------------
function renderTabs() {
  tabstrip.replaceChildren();

  for (const tab of state.tabs) {
    const element = document.createElement("div");
    element.className = tab.id === state.activeId ? "tab active" : "tab";
    element.setAttribute("role", "tab");
    element.title = tab.url;

    if (tab.loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      element.append(spinner);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || hostOf(tab.url);
    element.append(title);

    if (tab.blocked > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(tab.blocked);
      badge.title = `${tab.blocked} request(s) blocked by policy`;
      element.append(badge);
    }

    const close = document.createElement("button");
    close.className = "close";
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close tab";
    close.addEventListener("click", async (event) => {
      event.stopPropagation();
      await run(() => window.netops.tabs.close(tab.id));
    });
    element.append(close);

    element.addEventListener("click", () => run(() => window.netops.tabs.activate(tab.id)));
    element.addEventListener("auxclick", (event) => {
      if (event.button === 1) run(() => window.netops.tabs.close(tab.id));
    });
    tabstrip.append(element);
  }
}

function renderActive() {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  buttons.back.disabled = !active || !active.canGoBack;
  buttons.forward.disabled = !active || !active.canGoForward;
  buttons.reload.textContent = active && active.loading ? "✕" : "↻";

  if (document.activeElement !== urlInput) {
    urlInput.value = active ? active.url : "";
  }

  const secure = active && (active.url.startsWith("https://") || active.url.startsWith("about:"));
  lockIcon.textContent = secure ? "🔒" : "⚠";
  lockIcon.title = secure ? "https or local" : "insecure: plain http";

  if (active && active.proxy) {
    setStatus(`proxy ${active.proxy}`);
  } else if (active) {
    setStatus("");
  }
}

function render() {
  renderTabs();
  renderActive();
}

async function run(action, { silent = false } = {}) {
  try {
    const data = await action();
    if (!silent) setStatus("");
    return data;
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
}

// --- events from the main process ----------------------------------------
window.netops.subscribe("netops:tabs", (payload) => {
  state.tabs = payload.tabs;
  state.activeId = payload.activeId;
  render();
});

window.netops.subscribe("netops:blocked", ({ url, reason }) => {
  setStatus(`blocked ${hostOf(url)} - ${reason}`, true);
});

window.netops.subscribe("netops:load-failed", ({ description }) => {
  setStatus(`load failed: ${description}`, true);
});

window.netops.subscribe("netops:download", ({ filename }) => {
  setStatus(`download blocked: ${filename}`, true);
});

// --- toolbar --------------------------------------------------------------
buttons.back.addEventListener("click", () =>
  run(() => window.netops.tabs.go(state.activeId, -1)),
);
buttons.forward.addEventListener("click", () =>
  run(() => window.netops.tabs.go(state.activeId, 1)),
);
buttons.reload.addEventListener("click", () => {
  const active = state.tabs.find((tab) => tab.id === state.activeId);
  return run(() =>
    active && active.loading
      ? window.netops.tabs.stop(state.activeId)
      : window.netops.tabs.reload(state.activeId, false),
  );
});
buttons.newtab.addEventListener("click", () => run(() => window.netops.tabs.create({})));

// --- settings dialog ------------------------------------------------------
const settingsDialog = document.getElementById("settings");
const settingsBody = document.getElementById("settings-body");
const settingsTitle = document.getElementById("settings-title");

// The rotator switch is admin-only and the account panel is hidden from guests,
// so both are resolved from one place rather than re-derived in each renderer.
const session = { state: null, gate: null };

async function refreshSession(force = false) {
  try {
    const value = unwrap(await window.netops.account.available());
    if (force) {
      session.state = unwrap(await window.netops.account.state(true));
    } else {
      session.state = value;
    }
    session.gate = value.gate;
  } catch (error) {
    session.state = { authenticated: false, guest: false, isAdmin: false };
    session.gate = { unlocked: false, message: error.message };
  }
  return session.state;
}

function row(labelText, control, hint) {
  const wrapper = document.createElement("div");
  wrapper.className = "setting";

  const text = document.createElement("div");
  text.className = "setting-label";
  const name = document.createElement("strong");
  name.textContent = labelText;
  text.append(name);
  if (hint) {
    const small = document.createElement("span");
    small.className = "hint";
    small.textContent = hint;
    text.append(small);
  }

  wrapper.append(text, control);
  return wrapper;
}

function labelled(text, tag, attributes = {}) {
  const label = document.createElement("label");
  label.className = "field";
  label.append(document.createTextNode(text));
  const input = document.createElement(tag);
  Object.assign(input, attributes);
  label.append(input);
  return { label, input };
}

async function writeSettings(patch) {
  const values = unwrap(await window.netops.settings.write(patch));
  applyAppearance(values);
  return values;
}

// The saved colours are pushed in from main; this mirrors them onto the root
// element so the chrome's own CSS picks them up immediately.
function applyAppearance(values) {
  const root = document.documentElement;
  for (const name of ["--bg", "--accent", "--accent-fill"]) root.style.removeProperty(name);
  // "auto" is our vocabulary, not CSS. color-scheme needs "light dark" to follow
  // the OS; setting "auto" here pins the UI to the light palette instead.
  root.style.colorScheme =
    values.scheme === "light" || values.scheme === "dark" ? values.scheme : "light dark";
  root.dataset.theme = values.scheme || "auto";
  if (values.background) root.style.setProperty("--bg", values.background);
  if (values.accent) {
    root.style.setProperty("--accent", values.accent);
    root.style.setProperty("--accent-fill", values.accent);
  }
}

async function renderAppearance() {
  const values = unwrap(await window.netops.settings.read());
  settingsBody.replaceChildren();

  const scheme = labelled("Theme", "select", { id: "set-scheme" });
  for (const [value, label] of [
    ["auto", "Match the system"],
    ["dark", "Dark (Opsi A)"],
    ["light", "Light (Opsi B)"],
  ]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    scheme.input.append(option);
  }
  scheme.input.value = values.scheme;
  scheme.input.addEventListener("change", () =>
    run(() => writeSettings({ scheme: scheme.input.value })),
  );
  settingsBody.append(row("Theme", scheme.label, "Applies to the toolbar, tabs and pages."));

  const background = labelled("Browser background", "input", {
    id: "set-background",
    type: "color",
  });
  background.input.value = values.background || defaultBackground(values.scheme);
  background.input.addEventListener("change", () =>
    run(() => writeSettings({ background: background.input.value })),
  );
  settingsBody.append(row("Browser background", background.label, "Chrome and page backdrop."));

  const reset = document.createElement("button");
  reset.type = "button";
  reset.textContent = "Use the palette background";
  reset.addEventListener("click", () =>
    run(() => writeSettings({ background: null, accent: null })),
  );
  settingsBody.append(row("Palette colours", reset, "Restore the Opsi A / B defaults."));

  const accent = labelled("Accent", "input", { id: "set-accent", type: "color" });
  accent.input.value = values.accent || "#569cd6";
  accent.input.addEventListener("change", () =>
    run(() => writeSettings({ accent: accent.input.value })),
  );
  settingsBody.append(row("Accent colour", accent.label, "Focus rings and highlights."));

  const offer = labelled("Offer to save passwords", "input", {
    id: "set-offer",
    type: "checkbox",
  });
  offer.input.checked = values.offerToSavePasswords !== false;
  offer.input.addEventListener("change", () =>
    run(() => writeSettings({ offerToSavePasswords: offer.input.checked })),
  );
  settingsBody.append(
    row("Ask before saving", offer.label, "Prompt when a page submits a new login."),
  );
}

function defaultBackground(scheme) {
  if (scheme === "light") return "#f4f5f7";
  return scheme === "dark" ? "#1e222a" : "#1e222a";
}

async function renderNetwork() {
  settingsBody.replaceChildren();
  const live = window.netops.rotator
    ? unwrap(await window.netops.rotator.status())
    : { rotatorEnabled: false, rotatorDetail: "", live: false };

  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.id = "set-rotator";
  toggle.checked = Boolean(live.rotatorEnabled);
  const toggleLabel = document.createElement("label");
  toggleLabel.className = "field";
  toggleLabel.append(toggle, document.createTextNode("Use the proxy rotator"));

  const mayChange =
    session.state && session.state.authenticated === true && session.state.isAdmin === true;

  toggle.addEventListener("change", async () => {
    if (!mayChange) {
      toggle.checked = !toggle.checked;
      setStatus(
        session.state && session.state.guest
          ? "Please log in to unlock this feature"
          : "An administrator account is required to change the rotator",
        true,
      );
      return;
    }
    await run(async () => {
      const updated = unwrap(await window.netops.rotator.set(toggle.checked));
      toggle.checked = Boolean(updated.rotatorEnabled);
      setStatus(updated.rotatorEnabled ? "Rotator on" : "Rotator off");
    });
  });

  settingsBody.append(
    row(
      "Rotator",
      toggleLabel,
      mayChange
        ? "Traffic is sent through the configured upstreams."
        : "An administrator account is required to change this.",
    ),
  );

  const detail = document.createElement("p");
  detail.className = "mono";
  detail.textContent = live.rotatorDetail || (live.live ? "no detail" : "control plane offline");
  settingsBody.append(detail);
}

async function renderAccount() {
  settingsBody.replaceChildren();
  await refreshSession(true);

  const gate = session.gate || { unlocked: false };
  if (!gate.unlocked) {
    const notice = document.createElement("p");
    notice.className = "locked";
    notice.textContent = "Please log in to unlock this feature.";
    settingsBody.append(notice);

    const open = document.createElement("button");
    open.type = "button";
    open.textContent = "Open the dashboard";
    open.addEventListener("click", () => run(() => window.netops.account.openDashboard()));
    settingsBody.append(open);
    return;
  }

  const state = session.state || {};
  // Built with textContent, not innerHTML: a username is data, and pasting one
  // into markup would be the wrong place to trust it.
  const who = document.createElement("p");
  const name = document.createElement("span");
  name.className = "pill ok";
  name.textContent = String(state.username || "");
  const role = document.createElement("span");
  role.className = "pill";
  role.textContent = String(state.role || "");
  who.append(name, document.createTextNode(" "), role);
  settingsBody.append(who);

  const notes = [
    "Signed-in sessions can manage saved passwords.",
    "Guest sessions stay read-only and never see the account or password tools.",
  ];
  const list = document.createElement("ul");
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.append(item);
  }
  settingsBody.append(list);

  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open the dashboard";
  open.addEventListener("click", () => run(() => window.netops.account.openDashboard()));
  settingsBody.append(open);
}

async function renderPasswords() {
  settingsBody.replaceChildren();
  await refreshSession();
  const status = unwrap(await window.netops.passwords.status());

  if (!status.available) {
    const notice = document.createElement("p");
    notice.className = "locked";
    notice.textContent = "Please log in to unlock this feature.";
    settingsBody.append(notice);
    return;
  }

  const availability = unwrap(await window.netops.passwords.reauthAvailable());
  const methodLabel =
    availability.method === "windows-hello"
      ? "Windows Hello"
      : availability.method === "touch-id"
        ? "Touch ID"
        : availability.terminal
          ? `sudo in ${availability.terminal.split("/").pop()}`
          : "sudo";

  const summary = document.createElement("p");
  summary.innerHTML =
    `<span class="pill">${status.count} saved</span> ` +
    `<span class="pill ${status.locked ? "bad" : "ok"}">${status.locked ? "locked" : "unlocked"}</span> ` +
    `<span class="pill">${methodLabel}</span>`;
  settingsBody.append(summary);

  const unlock = document.createElement("button");
  unlock.type = "button";
  unlock.textContent = status.locked ? `Unlock with ${methodLabel}` : "Lock now";
  unlock.addEventListener("click", async () => {
    await run(async () => {
      if (status.locked) {
        // Ask first, then authenticate. Deciding from reauthAvailable() rather
        // than from a failed attempt matters because the failed attempt is what
        // used to throw before the inline prompt was ever shown, leaving a Linux
        // box with no terminal emulator unable to unlock at all.
        if (availability.inline) {
          promptInlinePassword();
          return;
        }
        unwrap(await window.netops.passwords.reauth({}));
      } else {
        unwrap(await window.netops.passwords.lock());
      }
      await renderPasswords();
    });
  });
  settingsBody.append(unlock);

  const entries = unwrap(await window.netops.passwords.list());
  const list = document.createElement("div");
  list.className = "credential-list";

  for (const entry of entries) {
    const card = document.createElement("div");
    card.className = "credential";

    const who = document.createElement("div");
    who.textContent = `${entry.username || "(no username)"} - ${entry.origin}`;
    const secret = document.createElement("span");
    secret.className = "secret";
    secret.textContent = "••••••••";

    // Reveal and copy both re-authenticate first. With no terminal emulator the
    // sudo password has to be typed here, so ask for it before the step-up rather
    // than letting the request fail with "no terminal emulator was found".
    const stepUpOptions = async () => {
      const availability = unwrap(await window.netops.passwords.reauthAvailable());
      if (!availability || !availability.inline) return {};
      const answer = window.prompt("BlackNet needs your sudo password to unlock the vault.");
      if (answer === null) throw new Error("authentication was cancelled");
      return { password: answer };
    };

    const reveal = document.createElement("button");
    reveal.type = "button";
    reveal.textContent = "Reveal";
    reveal.addEventListener("click", async () => {
      await run(async () => {
        const result = unwrap(await window.netops.passwords.reveal(entry.id, await stepUpOptions()));
        secret.textContent = result.password;
        reveal.textContent = "Hide";
        reveal.onclick = () => {
          secret.textContent = "••••••••";
          reveal.textContent = "Reveal";
          reveal.onclick = null;
        };
      });
    });

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy";
    copy.addEventListener("click", () =>
      run(async () => {
        unwrap(await window.netops.passwords.copy(entry.id, await stepUpOptions()));
        setStatus("Password copied");
      }),
    );

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.addEventListener("click", async () => {
      await run(async () => {
        unwrap(await window.netops.passwords.remove(entry.id));
        await renderPasswords();
      });
    });

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(reveal, copy, remove);
    card.append(who, secret, actions);
    list.append(card);
  }

  if (entries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No saved passwords yet.";
    list.append(empty);
  }
  settingsBody.append(list);

  const verify = document.createElement("button");
  verify.type = "button";
  verify.textContent = "Check every entry";
  verify.addEventListener("click", () =>
    run(async () => {
      const results = unwrap(await window.netops.passwords.verifyAll());
      const bad = results.filter((entry) => !entry.ok);
      setStatus(
        bad.length === 0
          ? `${results.length} entries verified`
          : `${bad.length} of ${results.length} entries failed`,
        bad.length > 0,
      );
    }),
  );
  settingsBody.append(verify);
}

// No terminal emulator and no Hello: the only way left is an in-app prompt. The
// password is passed straight to the main process and never stored.
function promptInlinePassword() {
  const answer = window.prompt("BlackNet needs your sudo password to unlock the vault.");
  if (answer === null) return;
  run(async () => {
    unwrap(await window.netops.passwords.reauth({ password: answer }));
    await renderPasswords();
  });
}

const settingsViews = {
  appearance: renderAppearance,
  network: renderNetwork,
  account: renderAccount,
  passwords: renderPasswords,
};

settingsDialog.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.id === "settings-close") {
    // Do not leave an unlocked vault behind a closed panel.
    await run(() => window.netops.passwords.lock(), { silent: true });
    settingsDialog.close();
    return;
  }
  const section = target.dataset.section;
  if (!section || !settingsViews[section]) return;

  for (const button of settingsDialog.querySelectorAll("nav button")) {
    button.classList.toggle("active", button === target);
  }
  settingsTitle.textContent = target.textContent;
  try {
    await settingsViews[section]();
  } catch (error) {
    settingsBody.replaceChildren(document.createTextNode(error.message));
  }
});

document.getElementById("settings-btn").addEventListener("click", async () => {
  if (settingsDialog.open) {
    settingsDialog.close();
    return;
  }
  await refreshSession();
  settingsDialog.show();
  try {
    await renderAppearance();
  } catch (error) {
    settingsBody.replaceChildren(document.createTextNode(error.message));
  }
});

// --- save-password prompt ---------------------------------------------------
const offer = document.getElementById("offer");
const offerSite = document.getElementById("offer-site");
let currentOffer = null;

window.netops.subscribe("netops:password-offer", (payload) => {
  currentOffer = payload;
  offerSite.textContent = `${payload.username || "no username"} - ${payload.origin}`;
  offer.hidden = false;
});

async function answerOffer(save) {
  if (!currentOffer) return;
  const id = currentOffer.id;
  const options = { save };

  // On a box with no terminal emulator there is no other way to create the vault
  // key, so ask for the sudo password up front rather than letting the save fail
  // with "no terminal emulator was found" after the operator already clicked Save.
  if (save) {
    try {
      const availability = unwrap(await window.netops.passwords.reauthAvailable());
      if (availability && availability.inline) {
        const answer = window.prompt("BlackNet needs your sudo password to create the vault key.");
        if (answer === null) return;
        options.sudoPassword = answer;
      }
    } catch {
      // Availability is advisory here; let the save itself report any problem.
    }
  }

  currentOffer = null;
  offer.hidden = true;
  await run(async () => {
    unwrap(await window.netops.passwords.answerOffer(id, options));
    setStatus(save ? "Password saved" : "");
  });
}

document.getElementById("offer-save").addEventListener("click", () => answerOffer(true));
document.getElementById("offer-skip").addEventListener("click", () => answerOffer(false));

window.netops.subscribe("netops:account", () => {
  // Re-render the account view if it is the one on screen: the session can change
  // in another tab while this dialog is open.
  if (!settingsDialog.open) return;
  const active = settingsDialog.querySelector("nav button.active");
  if (active && active.dataset.section === "account") refreshSession().then(renderAccount);
});

document.getElementById("toolbar").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = urlInput.value.trim();
  if (!target) return;
  await run(() => window.netops.tabs.navigate(state.activeId, target));
});

// --- privacy panel --------------------------------------------------------
function table(rows, columns) {
  if (rows.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Nothing to show.";
    return empty;
  }

  const element = document.createElement("table");
  const head = document.createElement("tr");
  for (const [label] of columns) {
    const cell = document.createElement("th");
    cell.textContent = label;
    head.append(cell);
  }
  element.append(head);

  for (const row of rows) {
    const line = document.createElement("tr");
    for (const [, render] of columns) {
      const cell = document.createElement("td");
      const value = render(row);
      if (value instanceof Node) cell.append(value);
      else cell.textContent = String(value);
      line.append(cell);
    }
    element.append(line);
  }
  return element;
}

async function renderCookies() {
  panelBody.replaceChildren(document.createTextNode("Reading cookie store..."));
  const report = unwrap(await window.netops.privacy.cookies(state.profile));

  const summary = document.createElement("p");
  summary.innerHTML =
    `<span class="pill">${report.count} total</span> ` +
    `<span class="pill">${report.sessionCookies} session</span> ` +
    `<span class="pill">${report.thirdParty} third-party</span> ` +
    `<span class="pill">${report.secure} secure</span>`;
  panelBody.replaceChildren(summary);

  // Values are never sent across: the C++ jar redacts before serialising.
  panelBody.append(
    table(report.cookies, [
      ["name", (cookie) => cookie.name],
      ["domain", (cookie) => cookie.domain],
      ["value", (cookie) => `${cookie.valuePreview} (${cookie.size}B)`],
      [
        "flags",
        (cookie) =>
          [
            cookie.session && "session",
            cookie.secure && "secure",
            cookie.httpOnly && "httpOnly",
            cookie.sameSite && cookie.sameSite !== "unspecified" && cookie.sameSite,
          ]
            .filter(Boolean)
            .join(", ") || "-",
      ],
    ]),
  );

  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear all cookies in this profile";
  clear.addEventListener("click", async () => {
    unwrap(await window.netops.privacy.clearCookies(state.profile));
    await renderCookies();
  });
  panelBody.append(clear);
}

async function renderCache() {
  const report = unwrap(await window.netops.privacy.cache(state.profile));
  panelBody.replaceChildren();
  const summary = document.createElement("p");
  summary.innerHTML =
    `<span class="pill">${report.files} files</span> ` +
    `<span class="pill">${report.cacheBytes} cache bytes</span> ` +
    `<span class="pill">${report.totalBytes} bytes total</span>`;
  panelBody.append(summary);
  panelBody.append(
    table(report.largestCacheFiles, [
      ["file", (row) => row.path],
      ["bytes", (row) => row.bytes],
    ]),
  );

  const clear = document.createElement("button");
  clear.type = "button";
  clear.textContent = "Clear profile cache";
  clear.addEventListener("click", async () => {
    unwrap(await window.netops.privacy.clearCache(state.profile));
    await renderCache();
  });
  panelBody.append(clear);
}

async function renderPool() {
  const stats = unwrap(await window.netops.pool.stats());
  const upstreams = unwrap(await window.netops.pool.upstreams());
  panelBody.replaceChildren();

  const summary = document.createElement("p");
  summary.innerHTML =
    `<span class="pill ${stats.upstreams ? "ok" : "bad"}">${stats.upstreams} upstreams</span> ` +
    `<span class="pill">${stats.tiers} tiers</span> ` +
    `<span class="pill ${stats.healthy ? "ok" : "bad"}">${stats.healthy} healthy</span> ` +
    `<span class="pill">${stats.requests} requests</span> ` +
    `<span class="pill">${stats.failures} failures</span>`;
  panelBody.append(summary);
  panelBody.append(
    table(upstreams, [
      ["upstream", (row) => row.display],
      ["kind", (row) => row.kind],
      ["health", (row) => row.health],
      ["ok", (row) => `${Math.round(row.successRate * 100)}%`],
      ["last error", (row) => row.lastError || "-"],
    ]),
  );
}

// A browser that is silently mute is worse than one that says so: check once at
// startup and put the reason in the toolbar.
async function reportAudio() {
  try {
    const audio = unwrap(await window.netops.audio());
    if (audio.available) {
      audioIcon.hidden = true;
      return;
    }
    audioIcon.hidden = false;
    audioIcon.textContent = "🔇";
    audioIcon.title = `No audio output - ${audio.reason}`;
  } catch (error) {
    audioIcon.hidden = false;
    audioIcon.title = `Audio status unknown: ${error.message}`;
  }
}

async function renderService() {
  const status = unwrap(await window.netops.service());
  panelBody.replaceChildren();
  const pill = status.state === "running" ? "ok" : "bad";
  panelBody.innerHTML =
    `<p><span class="pill ${pill}">${status.state}</span> ${status.detail}</p>` +
    (status.endpoint ? `<p class="mono">${status.endpoint}</p>` : "");

  const logs = unwrap(await window.netops.logs());
  const pre = document.createElement("pre");
  pre.className = "mono";
  pre.textContent = logs.slice(-40).join("\n");
  panelBody.append(pre);
}

const views = {
  cookies: renderCookies,
  cache: renderCache,
  pool: renderPool,
  service: renderService,
};

document.getElementById("panel").addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;

  if (target.id === "panel-close") {
    panel.close();
    return;
  }
  const view = target.dataset.view;
  if (!view || !views[view]) return;

  for (const button of panel.querySelectorAll("nav button")) {
    button.classList.toggle("active", button === target);
  }
  panelTitle.textContent = target.textContent;
  try {
    await views[view]();
  } catch (error) {
    panelBody.replaceChildren(document.createTextNode(error.message));
  }
});

buttons.inspect.addEventListener("click", async () => {
  if (panel.open) {
    panel.close();
    return;
  }
  panel.show();
  try {
    await renderCookies();
  } catch (error) {
    panelBody.replaceChildren(document.createTextNode(error.message));
  }
});

// --- keyboard -------------------------------------------------------------
window.addEventListener("keydown", (event) => {
  const typing = document.activeElement === urlInput;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
    event.preventDefault();
    urlInput.focus();
    urlInput.select();
  } else if (!typing && event.key === "F6") {
    event.preventDefault();
    run(() => window.netops.tabs.create({}));
  }
});

renderService().catch(() => {});
reportAudio().catch(() => {});
render();
