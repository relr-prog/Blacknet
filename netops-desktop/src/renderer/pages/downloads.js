"use strict";

// Downloads page: the full list the tray shows a slice of. It lives in a tab
// like Settings, so it has the preload bridge; what it reads is records only,
// and the two filesystem actions (open, reveal) are the operator's choice.

const list = document.getElementById("list");
const empty = document.getElementById("empty");
const count = document.getElementById("count");
const clearAll = document.getElementById("clear-all");
const statusLine = document.getElementById("status");

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

function formatBytes(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = n;
  let unit = -1;
  do {
    size /= 1024;
    unit += 1;
  } while (size >= 1024 && unit < units.length - 1);
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unit]}`;
}

const STATE_LABEL = {
  active: "Downloading",
  completed: "Complete",
  cancelled: "Cancelled",
  interrupted: "Failed",
};

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
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

function render(items) {
  const rows = items;
  count.textContent = rows.length === 1 ? "1 item" : `${rows.length} items`;
  clearAll.hidden = rows.length === 0;
  empty.hidden = rows.length !== 0;

  list.replaceChildren();
  for (const item of rows) {
    list.append(row(item));
  }
}

function row(item) {
  const element = document.createElement("article");
  element.className = `download ${item.state}`;
  element.dataset.id = item.id;

  const main = document.createElement("div");
  main.className = "dl-main";

  const title = document.createElement("div");
  title.className = "dl-title";
  const name = document.createElement("span");
  name.className = "dl-name";
  name.textContent = item.filename;
  name.title = item.savePath || item.filename;
  const badge = document.createElement("span");
  badge.className = `badge ${item.state}`;
  badge.textContent = STATE_LABEL[item.state] || item.state;
  title.append(name, badge);
  main.append(title);

  const meta = document.createElement("div");
  meta.className = "dl-meta";
  if (item.state === "active") {
    const total = item.totalBytes;
    const received = item.receivedBytes;
    const percent = total > 0 ? Math.min(100, Math.floor((received * 100) / total)) : null;
    meta.textContent = percent !== null
      ? `${formatBytes(received)} of ${formatBytes(total)} · ${percent}%`
      : `${formatBytes(received)} so far`;
    const track = document.createElement("div");
    track.className = "track";
    const fill = document.createElement("div");
    fill.className = "fill";
    fill.style.width = `${percent ?? 0}%`;
    track.append(fill);
    main.append(track);
  } else {
    const size = item.totalBytes > 0 ? formatBytes(item.totalBytes) : "";
    const when = new Date(item.endedAt || item.startedAt).toLocaleString();
    meta.textContent = [size, hostOf(item.url), when].filter(Boolean).join(" · ");
  }
  main.append(meta);
  element.append(main);

  const actions = document.createElement("div");
  actions.className = "dl-actions";
  if (item.state === "active") {
    actions.append(button("Cancel", () => cancel(item)));
  }
  if (item.state === "completed") {
    actions.append(button("Open", () => open(rowOf(item))));
    actions.append(button("Show in folder", () => show(item)));
  }
  actions.append(button("Remove", () => remove(item)));
  element.append(actions);

  return element;
}

function rowOf(item) {
  return item.savePath ? { ...item, savePath: item.savePath } : item;
}

function button(label, onClick) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.addEventListener("click", onClick);
  return element;
}

function cancel(item) {
  run(() => window.netops.downloads.cancel(item.id), { silent: true });
}

function open(item) {
  run(() => window.netops.downloads.open(item.id), { silent: true });
}

function show(item) {
  run(() => window.netops.downloads.show(item.id), { silent: true });
}

function remove(item) {
  run(() => window.netops.downloads.remove(item.id), { silent: true });
}

async function refresh() {
  const items = unwrap(await window.netops.downloads.list());
  render(items);
}

clearAll.addEventListener("click", () =>
  run(async () => {
    unwrap(await window.netops.downloads.clear());
    return refresh();
  }),
);

// The tray and this page live on the same event: a download starting, ticking or
// ending re-renders both. Reading the list again would race the event that is
// delivering it.
window.netops.subscribe("netops:downloads", ({ downloads }) => render(downloads));

refresh().catch(() => render([]));