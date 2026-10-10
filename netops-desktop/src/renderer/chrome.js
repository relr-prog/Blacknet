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
const star = document.getElementById("star");
const zoomChip = document.getElementById("zoom");
const bookmarksbar = document.getElementById("bookmarksbar");
const findbar = document.getElementById("findbar");
const findInput = document.getElementById("find-input");
const findCount = document.getElementById("find-count");
const downloadsbar = document.getElementById("downloadsbar");
const downloadsList = document.getElementById("downloads-list");
const downloadsManage = document.getElementById("downloads-manage");

const buttons = {
  back: document.getElementById("back"),
  forward: document.getElementById("forward"),
  reload: document.getElementById("reload"),
  newtab: document.getElementById("newtab"),
  inspect: document.getElementById("inspect"),
  settings: document.getElementById("settings-btn"),
};

const state = { tabs: [], activeId: null, profile: undefined, bookmarks: [], downloads: [] };

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
    if (tab.crashed) element.classList.add("crashed");
    element.setAttribute("role", "tab");
    element.title = tab.url;
    // The strip is rebuilt from state after every broadcast, so a reorder takes
    // over the DOM while a drag is live and hands the final order back. The id
    // is what a pointerup reads back out of the strip.
    element.dataset.id = String(tab.id);

    if (tab.crashed) {
      // A renderer crash replaces the page with an explanation and leaves the tab
      // exactly where it was. Marking it here means the operator is told in the
      // tab strip rather than only on a page they have to switch to.
      const mark = document.createElement("span");
      mark.className = "crashmark";
      mark.textContent = "!";
      mark.title = "This tab crashed. Reload to try the page again.";
      element.append(mark);
    }

    if (tab.loading) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      element.append(spinner);
    }

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = tab.title || hostOf(tab.url);
    element.append(title);

    // The tracker count, with the reason in the tooltip. A bare number invites the
    // question "blocked what?", so the breakdown goes in the title rather than
    // only on a page nobody opens.
    const track = tab.telemetry || {};
    if ((track.trackers || tab.blocked) > 0) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(track.trackers || tab.blocked);
      const detail = (track.penalties || [])
        .map((item) => `${item.key} x${item.count}`)
        .join(", ");
      badge.title = detail
        ? `${track.trackers || tab.blocked} tracker(s) blocked on ${track.site || "this page"} - ${detail}`
        : `${track.trackers || tab.blocked} request(s) blocked by policy`;
      element.append(badge);
    }

    // The privacy grade only appears when it is not perfect. A permanent "100"
    // is noise that trains people to stop looking at it.
    if (typeof track.score === "number" && track.score < 100 && track.site) {
      const grade = document.createElement("span");
      grade.className = track.score < 50 ? "grade low" : "grade";
      grade.textContent = String(track.score);
      grade.title = `Privacy ${track.score}/100 (${track.grade})`;
      element.append(grade);
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

    element.addEventListener("click", () => {
      if (suppressClick) {
        suppressClick = false;
        return;
      }
      run(() => window.netops.tabs.activate(tab.id));
    });
    element.addEventListener("auxclick", (event) => {
      if (event.button === 1) run(() => window.netops.tabs.close(tab.id));
    });
    // A left press on the strip body (not the close button) can become a drag;
    // the moved tab cycles over the live DOM and the final order is committed on
    // release. A static press is just the click that activates the tab.
    element.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      if (event.target.classList.contains("close")) return;
      startTabDrag(event, element);
    });
    tabstrip.append(element);
  }
}

// --- tab drag reorder -------------------------------------------------------
// A division of labour with the main process: the strip moves the tab through
// the DOM while the pointer is down so the whole reorder is previewed live, and
// on release it hands the new left-to-right id order to netops:tabs:reorder,
// which is the only caller allowed to change the tab order. If nothing moved,
// this is a non-event and the click that follows activates the tab as usual.

let tabDrag = null; // { element, id, startX, active }
let suppressClick = false;

function startTabDrag(event, element) {
  tabDrag = { element, id: Number(element.dataset.id), startX: event.clientX, active: false };
  document.body.classList.add("tab-dragging");
}

function dropIndexFor(clientX) {
  const elements = [...tabstrip.children];
  for (let index = 0; index < elements.length; index += 1) {
    const box = elements[index].getBoundingClientRect();
    if (clientX < box.left + box.width / 2) return index;
  }
  return elements.length;
}

window.addEventListener("mousemove", (event) => {
  if (!tabDrag) return;
  if (!tabDrag.active) {
    if (Math.abs(event.clientX - tabDrag.startX) < 4) return;
    tabDrag.active = true;
    tabDrag.element.classList.add("dragging");
  }
  event.preventDefault();
  const elements = [...tabstrip.children];
  const current = elements.indexOf(tabDrag.element);
  const target = Math.min(dropIndexFor(event.clientX), elements.length - 1);
  if (current === target) return;
  tabstrip.removeChild(tabDrag.element);
  const anchor = elements[target];
  if (anchor && anchor !== tabDrag.element) tabstrip.insertBefore(tabDrag.element, anchor);
  else tabstrip.append(tabDrag.element);
});

window.addEventListener("mouseup", () => {
  if (!tabDrag) return;
  const drag = tabDrag;
  tabDrag = null;
  document.body.classList.remove("tab-dragging");
  drag.element.classList.remove("dragging");
  if (!drag.active) return;
  // The pointerup happens before the click that would otherwise activate the
  // destination tab. A reorder must not change what is in front.
  suppressClick = true;
  const ids = [...tabstrip.children].map((entry) => Number(entry.dataset.id));
  run(() => window.netops.tabs.reorder(ids));
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && tabDrag && tabDrag.active) {
    tabDrag = null;
    document.body.classList.remove("tab-dragging");
    renderTabs(); // give the strip back its pre-drag order
  }
});

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

  // The star: filled when the active page is bookmarked, disabled where there is
  // nothing to bookmark (a new tab, a local page). This mirrors Chrome.
  const bookmarkable = Boolean(active && /^https?:/i.test(active.url || ""));
  const marked = bookmarkable && state.bookmarks.some((item) => item.url === active.url);
  star.textContent = marked ? "★" : "☆";
  star.disabled = !bookmarkable;
  star.classList.toggle("on", marked);
  star.title = marked ? "Remove bookmark" : "Bookmark this tab";

  // The zoom chip is the size of the active tab's site; hidden at 100%, so its
  // presence alone says "this site is not the default size".
  renderZoom(active && active.zoom ? Math.round(active.zoom * 100) : 100);
}

// --- zoom -----------------------------------------------------------------
// Per-site zoom lives in the main process; this only shows the number and asks
// for a change. A value of 100 hides the chip.
function renderZoom(percent) {
  const value = Math.round(Number(percent) || 100);
  zoomChip.hidden = value === 100;
  zoomChip.textContent = `${value}%`;
  zoomChip.title = `Zoom ${value}% - click to reset (Ctrl+0)`;
}

// --- bookmarks bar --------------------------------------------------------
function renderBookmarks() {
  bookmarksbar.replaceChildren();
  bookmarksbar.hidden = state.bookmarks.length === 0;
  for (const item of state.bookmarks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bookmark";
    button.textContent = item.title || hostOf(item.url);
    // Two lines in the tooltip: what it is, and where it goes.
    button.title = `${item.title || item.url}\n${item.url}`;
    button.addEventListener("click", () =>
      run(() => window.netops.tabs.navigate(state.activeId, item.url)),
    );
    // Right-click removes it, the same intent as clicking a filled star. This
    // frame has no context menu, so the affordance is stated in the title.
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      run(async () => {
        const result = unwrap(await window.netops.bookmarks.remove(item.url));
        state.bookmarks = result.items;
        renderBookmarks();
        renderActive();
      });
    });
    bookmarksbar.append(button);
  }
  reportChromeHeight();
}

async function loadBookmarks() {
  try {
    state.bookmarks = unwrap(await window.netops.bookmarks.list());
  } catch {
    state.bookmarks = [];
  }
  renderBookmarks();
}

// --- find in page ---------------------------------------------------------
// The bar sits in the chrome frame, so the page below it moves down like it does
// for the bookmarks bar. The match count is not known when the search starts: it
// is pushed back on the netops:find event, and the count element just waits.
function hideFindBar() {
  if (findbar.hidden) return;
  findbar.hidden = true;
  findInput.value = "";
  findCount.textContent = "";
  findCount.classList.remove("empty");
  reportChromeHeight();
}

function closeFind() {
  const id = state.activeId;
  hideFindBar();
  run(() => window.netops.tabs.findStop(id), { silent: true });
}

function openFind() {
  if (findbar.hidden) {
    findbar.hidden = false;
    reportChromeHeight();
  }
  findInput.focus();
  findInput.select();
}

function runFind({ forward = true, findNext = true } = {}) {
  return run(() =>
    window.netops.tabs.find(state.activeId, findInput.value, { forward, findNext }),
  );
}

// --- downloads tray --------------------------------------------------------
// Rows the main process pushes at the end of every download change (a record
// starts, ticks, or ends). Active rows are always shown; finished rows stay
// until dismissed. Dismissing is chrome-local, so a hidden row never rushes
// back mid-save.
const snoozedDownloads = new Set();

function renderDownloads() {
  const active = state.downloads.filter((item) => item.state === "active");
  const settled = state.downloads.filter(
    (item) => item.state !== "active" && !snoozedDownloads.has(item.id),
  );
  // Oldest first, and active rows are the ones that must not be pushed out.
  const shown = [...settled, ...active].slice(-6);
  downloadsList.replaceChildren();
  for (const item of shown) downloadsList.append(downloadChip(item));
  downloadsbar.hidden = shown.length === 0;
  reportChromeHeight();
}

function smallChipAction(label, title, onClick) {
  const buttonElement = document.createElement("button");
  buttonElement.type = "button";
  buttonElement.textContent = label;
  buttonElement.title = title;
  buttonElement.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return buttonElement;
}

function downloadChip(item) {
  const chip = document.createElement("div");
  chip.className = "dl-chip";

  const file = document.createElement("span");
  file.className = "dl-file";
  file.textContent = item.filename;
  file.title = item.savePath || item.filename;

  const badge = document.createElement("span");
  badge.className = `dl-state ${
    item.state === "completed" ? "ok" : item.state === "cancelled" || item.state === "interrupted" ? "failed" : "active"
  }`;
  if (item.state === "active") {
    const total = item.totalBytes;
    const percent = total > 0 ? Math.floor((Math.min(item.receivedBytes, total) * 100) / total) : 0;
    badge.textContent = `${percent}%`;
  } else if (item.state === "completed") {
    badge.textContent = "Done";
  } else if (item.state === "cancelled") {
    badge.textContent = "Cancelled";
  } else {
    badge.textContent = "Failed";
  }

  chip.append(file, badge);

  if (item.state === "active") {
    chip.append(
      smallChipAction("✕", "Cancel download", () =>
        run(() => window.netops.downloads.cancel(item.id), { silent: true }),
      ),
    );
  } else {
    chip.classList.add("done");
    chip.title = "Click to open";
    chip.addEventListener("click", () => {
      if (item.state === "completed") run(() => window.netops.downloads.open(item.id), { silent: true });
    });
    if (item.state === "completed") {
      chip.append(
        smallChipAction("folder", "Show in folder", () =>
          run(() => window.netops.downloads.show(item.id), { silent: true }),
        ),
      );
    }
    chip.append(
      smallChipAction("✕", "Dismiss", () => {
        snoozedDownloads.add(item.id);
        renderDownloads();
      }),
    );
  }
  return chip;
}

// The page below this frame starts where the frame ends, so the frame has to say
// how tall it is. It is the sum of the rows, which does not depend on the view's
// own height - so reporting cannot feed back into itself.
let reportedHeight = 0;
function reportChromeHeight() {
  const height =
    document.getElementById("tabrow").offsetHeight +
    document.getElementById("toolbar").offsetHeight +
    (bookmarksbar.hidden ? 0 : bookmarksbar.offsetHeight) +
    (findbar.hidden ? 0 : findbar.offsetHeight) +
    (downloadsbar.hidden ? 0 : downloadsbar.offsetHeight);
  if (!height || height === reportedHeight) return;
  reportedHeight = height;
  Promise.resolve(window.netops.chrome.setHeight(height)).catch(() => {});
}

function render() {
  renderTabs();
  renderActive();
  reportChromeHeight();
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
  const previous = state.activeId;
  state.tabs = payload.tabs;
  state.activeId = payload.activeId;
  render();

  // The find bar belongs to the page it was opened on. Switching tabs closes it,
  // and the highlight left behind on the tab being left is cleared on that tab.
  if (payload.activeId !== previous && !findbar.hidden) {
    run(() => window.netops.tabs.findStop(previous), { silent: true });
    hideFindBar();
  }

  const open = payload.tabs.some((tab) => tab.internalPage === "settings");
  if (settingsTabOpen && !open) {
    run(() => window.netops.passwords.lock(), { silent: true });
  }
  settingsTabOpen = open;
});

window.netops.subscribe("netops:find-open", () => openFind());

window.netops.subscribe("netops:find-close", () => {
  if (!findbar.hidden) closeFind();
});

window.netops.subscribe("netops:find", ({ tabId, activeMatchOrdinal, matches }) => {
  if (tabId !== state.activeId) return;
  findCount.textContent = matches === 0 ? "no matches" : `${activeMatchOrdinal}/${matches}`;
  findCount.classList.toggle("empty", matches === 0);
});

window.netops.subscribe("netops:zoom", ({ tabId, percent }) => {
  if (tabId !== state.activeId) return;
  renderZoom(percent);
});

window.netops.subscribe("netops:blocked", ({ url, reason }) => {
  setStatus(`blocked ${hostOf(url)} - ${reason}`, true);
});

window.netops.subscribe("netops:load-failed", ({ description }) => {
  setStatus(`load failed: ${description}`, true);
});

window.netops.subscribe("netops:downloads", ({ downloads }) => {
  state.downloads = downloads;
  renderDownloads();
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

star.addEventListener("click", () =>
  run(async () => {
    const active = state.tabs.find((tab) => tab.id === state.activeId);
    if (!active || !/^https?:/i.test(active.url || "")) return;
    const result = unwrap(
      await window.netops.bookmarks.toggle({ url: active.url, title: active.title }),
    );
    state.bookmarks = result.items;
    renderBookmarks();
    renderActive();
  }),
);

// Clicking the zoom number resets the site to 100%. The keyboard shortcuts for
// zoom in/out live below, next to the other chrome-focus shortcuts.
zoomChip.addEventListener("click", () =>
  run(async () => {
    const result = unwrap(await window.netops.tabs.zoom(state.activeId, "reset"));
    if (result) renderZoom(result.percent);
  }),
);

// Both of these open the same page; the view decides which half is on screen.
buttons.settings.addEventListener("click", () =>
  run(() => window.netops.tabs.internal("settings", { view: "appearance" })),
);
// The privacy button lands on the report: "what is tracking this page, and what
// grade does it get" is the question that button implies. Cookies and cache stay
// a click away for the jobs that need them.
buttons.inspect.addEventListener("click", () =>
  run(() => window.netops.tabs.internal("settings", { view: "report" })),
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

// --- find in page: controls ------------------------------------------------
// Typing restarts the search from the top of the page; Enter and the arrows step
// through the matches the search already found.
findInput.addEventListener("input", () => {
  if (!findInput.value) {
    findCount.textContent = "";
    findCount.classList.remove("empty");
  }
  runFind({ findNext: false });
});

findInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    runFind({ forward: !event.shiftKey, findNext: true });
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeFind();
  }
});

document.getElementById("find-next").addEventListener("click", () =>
  runFind({ forward: true, findNext: true }),
);
document.getElementById("find-prev").addEventListener("click", () =>
  runFind({ forward: false, findNext: true }),
);
document.getElementById("find-close").addEventListener("click", () => closeFind());

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
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") {
    // When the page has the keyboard this is caught in the main process and
    // delivered as netops:find-open; this branch covers the chrome's own focus.
    event.preventDefault();
    openFind();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "t") {
    // The keyboard layer answers the same shortcuts as the page-side branch in
    // tabs.js, so it never matters which half of the window holds the focus.
    event.preventDefault();
    run(() => window.netops.tabs.create({}));
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
    event.preventDefault();
    run(() => window.netops.tabs.close(state.activeId));
  } else if (event.ctrlKey && event.key === "Tab") {
    event.preventDefault();
    run(() => window.netops.tabs.cycle(event.shiftKey ? -1 : 1));
  } else if ((event.ctrlKey || event.metaKey) && /^[1-9]$/.test(event.key)) {
    // Ctrl+1..8 picks that tab in strip order; Ctrl+9 always goes to the last
    // one. Ctrl+0 is left alone: it is zoom-reset, not a tab pick.
    event.preventDefault();
    const target = state.tabs[Number(event.key) - 1] || state.tabs[state.tabs.length - 1];
    if (target) run(() => window.netops.tabs.activate(target.id));
  } else if ((event.ctrlKey || event.metaKey) && (event.key === "=" || event.key === "+" || event.key === "add")) {
    // The same zoom shortcuts as the page branch in tabs.js, for when the
    // chrome itself has the keyboard.
    event.preventDefault();
    run(async () => {
      const result = unwrap(await window.netops.tabs.zoom(state.activeId, "in"));
      if (result) renderZoom(result.percent);
    });
  } else if ((event.ctrlKey || event.metaKey) && event.key === "-") {
    event.preventDefault();
    run(async () => {
      const result = unwrap(await window.netops.tabs.zoom(state.activeId, "out"));
      if (result) renderZoom(result.percent);
    });
  } else if (event.key === "0" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    run(async () => {
      const result = unwrap(await window.netops.tabs.zoom(state.activeId, "reset"));
      if (result) renderZoom(result.percent);
    });
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
    event.preventDefault();
    run(() => window.netops.tabs.internal("downloads"));
  } else if (!typing && event.key === "F6") {
    event.preventDefault();
    run(() => window.netops.tabs.create({}));
  }
});

downloadsManage.addEventListener("click", () =>
  run(() => window.netops.tabs.internal("downloads")),
);

reportAudio().catch(() => {});
render();
loadBookmarks().catch(() => {});