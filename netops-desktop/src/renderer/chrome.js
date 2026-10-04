"use strict";

// Chrome UI: tab strip, address bar and the save-password prompt. It runs in an
// isolated context and can only do what preload.js exposes.
//
// Settings and Privacy are not here any more: they are a page of the shell shown
// in an ordinary tab (renderer/pages/settings.html). What is left is the part
// that has to sit over the browser itself.

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
  settings: document.getElementById("settings-btn"),
};

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
// Closing the Settings tab must lock the vault again, the way closing the old
// dialog did. The chrome only sees tab broadcasts, so the tab that carried the
// vault is watched here rather than from the page that is about to go away.
let settingsTabOpen = false;

window.netops.subscribe("netops:tabs", (payload) => {
  state.tabs = payload.tabs;
  state.activeId = payload.activeId;
  render();

  const open = payload.tabs.some((tab) => tab.internalPage === "settings");
  if (settingsTabOpen && !open) {
    run(() => window.netops.passwords.lock(), { silent: true });
  }
  settingsTabOpen = open;
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

// Both of these open the same page; the view decides which half is on screen.
buttons.settings.addEventListener("click", () =>
  run(() => window.netops.tabs.internal("settings", { view: "appearance" })),
);
buttons.inspect.addEventListener("click", () =>
  run(() => window.netops.tabs.internal("settings", { view: "cookies" })),
);

document.getElementById("toolbar").addEventListener("submit", async (event) => {
  event.preventDefault();
  const target = urlInput.value.trim();
  if (!target) return;
  await run(() => window.netops.tabs.navigate(state.activeId, target));
});

// --- save-password prompt ---------------------------------------------------
// This one stays in the chrome: it is an interruption tied to the page the
// person is looking at, not a place to go.
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

reportAudio().catch(() => {});
render();