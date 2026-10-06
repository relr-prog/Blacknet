"use strict";

// Settings & Privacy. This is an internal page rendered in a tab, not part of
// the chrome frame: preload.js is attached to this page only because tabs.js
// builds it for a fixed, local file. A tab that loads remote content still gets
// no preload at all.

const settingsBody = document.getElementById("settings-body");
const panelBody = document.getElementById("panel-body");
const panelTitle = document.getElementById("panel-title");
const statusLine = document.getElementById("status");

const settings = document.getElementById("settings");
const panel = document.getElementById("panel");

const session = { state: null, gate: null };

// The cookie and cache views act on a profile. The chrome used the active tab's
// profile; these are whole-browser settings rather than per-tab ones, so this
// page addresses the default profile. actions.js falls back to it when the
// value is undefined.
const state = { profile: undefined };
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

async function refreshSession(force = false) {
  // There is no session to refresh any more: this is a local read, so both
  // branches collapse into the same call and `force` only exists to keep the
  // call sites readable.
  try {
    const value = unwrap(await window.netops.account.available());
    session.state = value;
    session.gate = value.gate || { unlocked: true, locked: false, reason: "", message: "" };
  } catch (error) {
    session.state = { available: false, name: "", local: true };
    session.gate = { unlocked: true, locked: false, reason: "", message: error.message };
  }
  return session.state;
}

// Fills a container with one status pill per [className, text] pair. Built with
// textContent on purpose: these values come back from the native jar and the
// control plane, and a count is still data, not markup.
function pillRow(container, pills) {
  for (const [className, text] of pills) {
    const pill = document.createElement("span");
    pill.className = className;
    pill.textContent = text;
    container.append(pill, document.createTextNode(" "));
  }
  return container;
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

  const restore = labelled("Reopen tabs on start", "input", {
    id: "set-restore",
    type: "checkbox",
  });
  restore.input.checked = values.restoreSession !== false;
  restore.input.addEventListener("change", () =>
    run(() => writeSettings({ restoreSession: restore.input.checked })),
  );
  settingsBody.append(
    row(
      "Reopen previous tabs",
      restore.label,
      "Stores the URLs you had open, locally. Nothing else, and no history.",
    ),
  );

  const forget = document.createElement("button");
  forget.type = "button";
  forget.textContent = "Forget saved tabs";
  forget.addEventListener("click", () =>
    run(async () => {
      unwrap(await window.netops.session.clear());
      await showSection("appearance");
    }),
  );
  settingsBody.append(row("Saved session", forget, "Clears it without turning restore off."));
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

  toggle.addEventListener("change", async () => {
    // No administrator role is involved any more. The gateway is a child process
    // this browser started, and the switch is a local preference: the operator
    // already owns the machine, so the extra gate was the dashboard's rule leaking
    // into a desktop control it has nothing to do with.
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
      "Traffic is sent through the configured upstreams.",
    ),
  );

  const detail = document.createElement("p");
  detail.className = "mono";
  detail.textContent = live.rotatorDetail || (live.live ? "no detail" : "gateway not running");
  settingsBody.append(detail);
}

async function renderAccount() {
  settingsBody.replaceChildren();
  await refreshSession(true);

  const state = session.state || {};
  const status = unwrap(await window.netops.account.status());

  // There is no sign-in step here and nothing to sign in to. This section names
  // the local profile and offers the step-up, because the step-up is the thing
  // that actually opens the vault.
  const who = document.createElement("p");
  const name = document.createElement("span");
  name.className = "pill ok";
  // Built with textContent, not innerHTML: a profile name is data, and pasting
  // one into markup would be the wrong place to trust it.
  name.textContent = String(state.name || "Local");
  const kind = document.createElement("span");
  kind.className = "pill";
  kind.textContent = "local profile";
  who.append(name, document.createTextNode(" "), kind);
  settingsBody.append(who);

  const rename = document.createElement("div");
  rename.className = "row";
  const label = document.createElement("label");
  label.textContent = "Profile name";
  const input = document.createElement("input");
  input.type = "text";
  input.maxLength = 60;
  input.value = String(state.name || "");
  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Rename";
  save.addEventListener("click", () => run(async () => {
    await window.netops.account.rename(input.value);
    await refreshSession(true);
    return renderAccount();
  }));
  rename.append(label, input, save);
  settingsBody.append(rename);

  const unlock = document.createElement("button");
  unlock.type = "button";
  unlock.textContent = status.verified ? "Unlock the vault" : "Unlock the vault now";
  unlock.addEventListener("click", () => run(async () => {
    await window.netops.account.unlock({});
    await refreshSession(true);
    return renderAccount();
  }));
  settingsBody.append(unlock);

  const notes = [
    "This browser has one local profile and no password.",
    "Saved passwords are unlocked with a system check (Windows Hello, Touch ID, or your sudo password), not by signing in.",
    "The profile name is a label. It grants nothing and protects nothing.",
  ];
  const list = document.createElement("ul");
  for (const note of notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.append(item);
  }
  settingsBody.append(list);
}

async function renderPasswords() {
  settingsBody.replaceChildren();
  await refreshSession();
  const status = unwrap(await window.netops.passwords.status());

  if (!status.available) {
    const notice = document.createElement("p");
    notice.className = "locked";
    notice.textContent = "No local profile owns this vault yet.";
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
pillRow(summary, [
    ["pill", `${status.count} saved`],
    [`pill ${status.locked ? "bad" : "ok"}`, status.locked ? "locked" : "unlocked"],
    ["pill", methodLabel],
  ]);
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

function promptInlinePassword() {
  const answer = window.prompt("BlackNet needs your sudo password to unlock the vault.");
  if (answer === null) return;
  run(async () => {
    unwrap(await window.netops.passwords.reauth({ password: answer }));
    await renderPasswords();
  });
}

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
  pillRow(summary, [
    ["pill", `${report.count} total`],
    ["pill", `${report.sessionCookies} session`],
    ["pill", `${report.thirdParty} third-party`],
    ["pill", `${report.secure} secure`],
  ]);
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

// The tracker counter, the privacy grade, and the data footprint for the page
// currently open. Read-only and in memory: it describes this page, not a history.
async function renderReport() {
  panelBody.replaceChildren(document.createTextNode("Reading the current page..."));
  const report = unwrap(await window.netops.privacy.report());

  if (!report.site) {
    const empty = document.createElement("p");
    empty.textContent = "No page has made a request yet.";
    panelBody.replaceChildren(empty);
    return;
  }

  const headline = document.createElement("div");
  headline.className = "score-head";
  const grade = document.createElement("span");
  grade.className = report.score < 50 ? "score low" : "score";
  grade.textContent = String(report.score);
  const label = document.createElement("div");
  const site = document.createElement("strong");
  site.textContent = report.site;
  const gradeText = document.createElement("div");
  gradeText.className = "muted";
  gradeText.textContent = `privacy grade: ${report.grade}`;
  label.append(site, gradeText);
  headline.append(grade, label);
  panelBody.replaceChildren(headline);

  panelBody.append(
    pillRow(document.createElement("p"), [
      ["pill", `${report.trackers} tracker(s) blocked`],
      ["pill", `${report.requests} requests`],
      ["pill", `${Math.round(report.bytes / 1024)} KB`],
    ]),
  );

  // The score is never presented on its own. A number with no reasons is a vibe,
  // and a bad grade you cannot act on is worse than no grade.
  if (report.penalties.length) {
    const why = document.createElement("p");
    why.className = "muted";
    why.textContent = report.penalties
      .map((item) => `${item.key} x${item.count}`)
      .join(", ");
    panelBody.append(why);
  }

  panelBody.append(
    table(report.sites, [
      ["host", (row) => row.host],
      ["requests", (row) => row.requests],
      ["blocked", (row) => row.blocked],
      ["third-party", (row) => row.thirdParty],
      ["score", (row) => `${row.score} (${row.grade})`],
    ]),
  );

  const save = document.createElement("button");
  save.type = "button";
  save.textContent = "Export report as JSON";
  save.addEventListener("click", () => {
    // Hosts and counts only: no URLs, no query strings. The export is meant to
    // be shareable, and a full request log is not something to hand around.
    const blob = new Blob([JSON.stringify(unwrap(window.netops.privacy.export()), null, 2)], {
      type: "application/json",
    });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "blacknet-privacy-report.json";
    link.click();
    URL.revokeObjectURL(link.href);
  });
  panelBody.append(save);
}

async function renderCache() {
  const report = unwrap(await window.netops.privacy.cache(state.profile));
  panelBody.replaceChildren();
  const summary = document.createElement("p");
pillRow(summary, [
    ["pill", `${report.files} files`],
    ["pill", `${report.cacheBytes} cache bytes`],
    ["pill", `${report.totalBytes} bytes total`],
  ]);
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
  pillRow(summary, [
    [`pill ${stats.upstreams ? "ok" : "bad"}`, `${stats.upstreams} upstreams`],
    ["pill", `${stats.tiers} tiers`],
    [`pill ${stats.healthy ? "ok" : "bad"}`, `${stats.healthy} healthy`],
    ["pill", `${stats.requests} requests`],
    ["pill", `${stats.failures} failures`],
  ]);
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

// The proxy gateway. It used to be called "Service" and showed the Python control
// plane, which no longer exists - this panel now reports the one child process
// the shell actually supervises.
async function renderService() {
  const status = unwrap(await window.netops.rotator.status());
  panelBody.replaceChildren();

  const pill = status.rotatorState === "running" ? "ok" : "bad";
  const headline = document.createElement("p");
  const statePill = document.createElement("span");
  statePill.className = `pill ${pill}`;
  statePill.textContent = String(status.rotatorState || "stopped");
  headline.append(statePill, document.createTextNode(` ${status.rotatorDetail || ""}`));
  panelBody.append(headline);

  if (status.pool && status.pool.healthy) {
    const detail = document.createElement("p");
    detail.textContent =
      `${status.pool.healthy} healthy of ${status.pool.upstreams} upstreams` +
      (status.pool.strategy ? `, rotating by ${status.pool.strategy}` : "") +
      (status.pool.countries && status.pool.countries.length
        ? `, exits in ${status.pool.countries.join(", ")}`
        : "");
    panelBody.append(detail);
  }

  // The question this whole feature exists to answer: is the exit IP really
  // changing? Healthy upstreams are not the answer - they can all resolve to one
  // address - so this is stated from the exit IPs the gateway actually observed,
  // and the wording says so when that is not yet known.
  const verdict = (status.pool && status.pool.rotation) || null;
  if (verdict) {
    const headline = document.createElement("p");
    const state = document.createElement("span");
    const wording = {
      rotating: ["ok", `Rotating across ${verdict.distinctExitIps} exit IPs`],
      "single-exit": ["bad", "One exit IP - not rotating"],
      unknown: ["", "Exit IPs not identified yet"],
      down: ["bad", "No healthy upstreams"],
      unconfigured: ["bad", "No upstreams configured"],
    }[verdict.verdict] || ["", verdict.verdict];
    state.className = `pill ${wording[0]}`;
    state.textContent = wording[1];
    headline.append(state);
    panelBody.append(headline);

    if (verdict.verdict === "single-exit") {
      const why = document.createElement("p");
      why.className = "muted";
      why.textContent =
        `${verdict.healthy} upstream(s) are healthy but share a single exit address. `
        + "Traffic is proxied, but every request looks like it came from the same place.";
      panelBody.append(why);
    }

    // The per-upstream table. Credentials are not here: the gateway redacts them
    // before they reach the status port, and this view has no access to the pool
    // files that hold them.
    if (status.pool.list && status.pool.list.length) {
      panelBody.append(
        table(status.pool.list, [
          ["tier", (row) => row.tier],
          ["upstream", (row) => row.label],
          ["exit IP", (row) => row.exitIp || "-"],
          ["cc", (row) => row.country || "-"],
          ["ms", (row) => (row.latencyMs === null ? "-" : Math.round(row.latencyMs))],
          ["state", (row) => (row.healthy ? (row.inUse ? "in use" : "healthy") : "down")],
          ["errors", (row) => row.lastError || (row.fail ? String(row.fail) : "-")],
        ]),
      );
    }
  }

  const logs = unwrap(await window.netops.logs());
  const pre = document.createElement("pre");
  pre.className = "mono";
  pre.textContent = logs.slice(-40).join("\n");
  panelBody.append(pre);
}
// --- navigation -------------------------------------------------------------
// The chrome showed two dialogs. Here both are the same page, so the current
// half is expressed in the hash. replaceState is used instead of assigning
// location.hash so that recording the view does not fire hashchange and render
// everything a second time.

const sectionViews = {
  appearance: renderAppearance,
  network: renderNetwork,
  account: renderAccount,
  passwords: renderPasswords,
};

const panelViews = {
  report: renderReport,
  cookies: renderCookies,
  cache: renderCache,
  pool: renderPool,
  service: renderService,
};

function showPrivacy(view, label) {
  const target = Object.hasOwn(panelViews, view) ? view : "report";
  settings.hidden = true;
  panel.hidden = false;
  for (const button of panel.querySelectorAll("nav button")) {
    button.classList.toggle("active", button.dataset.view === target);
  }
  panelTitle.textContent = label || "Privacy";
  panelBody.replaceChildren();
  history.replaceState(null, "", `#${target}`);
  return panelViews[target]().catch((error) => {
    panelBody.replaceChildren(document.createTextNode(error.message));
  });
}

function showSection(section, label) {
  if (section === "privacy") return showPrivacy("report", "Privacy");
  const target = Object.hasOwn(sectionViews, section) ? section : "appearance";
  panel.hidden = true;
  settings.hidden = false;
  for (const button of settings.querySelectorAll("nav button")) {
    button.classList.toggle("active", button.dataset.section === target);
  }
  settingsBody.replaceChildren();
  history.replaceState(null, "", `#${target}`);
  return sectionViews[target]().catch((error) => {
    settingsBody.replaceChildren(document.createTextNode(error.message));
  });
}

// The hash names a view on either half of the page, so both have to be
// reachable from it: the toolbar opens Privacy straight onto #cookies.
function open(view) {
  if (Object.hasOwn(panelViews, view)) return showPrivacy(view);
  return showSection(view);
}

settings.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const section = target.dataset.section;
  if (!section) return;
  showSection(section, target.textContent).catch(() => {});
});

panel.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement)) return;
  const view = target.dataset.view;
  if (!view) return;
  showPrivacy(view, target.textContent).catch(() => {});
});

window.addEventListener("hashchange", () => {
  open(location.hash.slice(1)).catch(() => {});
});

// Opening this page with no hash lands on Appearance, as the dialog did.
open(location.hash.slice(1) || "appearance").catch(() => {});

// The chrome has the saved colours pushed to it from main. This page is a
// separate document and inherits nothing, so it pulls them in for itself.
run(async () => applyAppearance(unwrap(await window.netops.settings.read())));