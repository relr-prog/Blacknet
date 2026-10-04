"use strict";
/* netops dashboard: tiny vanilla-JS client for the JSON API. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = { user: null, setupRequired: false, authMode: "login", view: "monitor", timer: null };

/* ------------------------------------------------------------------ utils */
async function api(path, options = {}) {
  const opts = { method: "GET", credentials: "same-origin", ...options };
  if (opts.body && typeof opts.body !== "string") {
    opts.headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
    opts.body = JSON.stringify(opts.body);
  }
  const response = await fetch(path, opts);
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { detail: text.slice(0, 200) }; }
  if (!response.ok) {
    const detail = (data && (data.detail || data.error)) || `HTTP ${response.status}`;
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return data;
}

function toast(message, bad = false) {
  const node = $("#toast");
  node.textContent = message;
  node.classList.toggle("bad", bad);
  node.hidden = false;
  clearTimeout(node._timer);
  node._timer = setTimeout(() => { node.hidden = true; }, 4200);
}

function bytes(n) {
  if (!n && n !== 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = Number(n), i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function duration(seconds) {
  seconds = Math.max(0, Math.floor(seconds || 0));
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${seconds % 60}s`;
  return `${seconds}s`;
}

function stamp(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ------------------------------------------------------------------- auth */
function showGate() {
  $("#gate").hidden = false;
  $("#app").hidden = true;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
  $("#setup-banner").hidden = !state.setupRequired;
  // After first setup, only sign-in is shown. Guest access is always allowed from the gate.
  setAuthMode("login");
  $("#auth-form input[name=username]").focus();
}

async function boot() {
  try {
    const info = await api("/api/auth/state");
    state.setupRequired = info.setup_required;
    if (info.authenticated) { await enterApp(info.user); return; }
  } catch (err) { console.warn(err); }
  showGate();
}

function setAuthMode(mode) {
  state.authMode = mode;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.auth === mode));
  const submit = $("#auth-form button[type=submit]");
  const usernameLabel = $("#username-label");
  const passwordLabel = $("#password-label");
  const usernameInput = $("#auth-form input[name=username]");
  const passwordInput = $("#auth-form input[name=password]");

  if (mode === "guest") {
    submit.textContent = "Enter as guest";
    usernameLabel.hidden = true;
    passwordLabel.hidden = true;
    usernameInput.required = false;
    passwordInput.required = false;
    usernameInput.value = "";
    passwordInput.value = "";
  } else if (mode === "login") {
    submit.textContent = "Sign in";
    usernameLabel.hidden = false;
    passwordLabel.hidden = false;
    usernameInput.required = true;
    passwordInput.required = true;
    usernameInput.autocomplete = "username";
    passwordInput.autocomplete = "current-password";
    usernameInput.focus();
  } else if (mode === "signup") {
    submit.textContent = state.setupRequired ? "Create administrator" : "Create account";
    usernameLabel.hidden = false;
    passwordLabel.hidden = false;
    usernameInput.required = true;
    passwordInput.required = true;
    usernameInput.autocomplete = "username";
    passwordInput.autocomplete = "new-password";
    usernameInput.focus();
  }
}

async function enterApp(user) {
  state.user = user;
  $("#gate").hidden = true;
  $("#app").hidden = false;
  $("#whoami").textContent = `${user.username} · ${user.role}`;
  $("#host-name").textContent = "loading…";
  $$("[data-admin]").forEach((el) => { el.hidden = !user.role.includes("admin"); });
  await showView(state.view === "monitor" ? "monitor" : state.view);
  state.timer = setInterval(() => { if (state.view === "monitor") loadMonitor(); }, 5000);
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const error = $("#auth-error");
  error.hidden = true;
  try {
    if (state.authMode === "guest") {
      await api("/api/auth/guest", { method: "POST" });
      const info = await api("/api/auth/state");
      await enterApp(info.user);
      return;
    }
    const path = state.authMode === "login" ? "/api/auth/login" : "/api/auth/signup";
    const result = await api(path, { method: "POST", body: data });
    await enterApp(result.user);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
  }
});

$$(".tab").forEach((tab) => tab.addEventListener("click", () => setAuthMode(tab.dataset.auth)));
$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" });
  state.user = null;
  setAuthMode("login");
  showGate();
});

/* ----------------------------------------------------------------- routing */
async function showView(view) {
  state.view = view;
  $$("#nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((s) => { s.hidden = s.id !== `view-${view}`; });
  const loaders = {
    monitor: loadMonitor, rotator: loadRotator, lookup: async () => {},
    scanner: loadScannerPolicy, tools: loadTools, server: loadServices,
    audit: loadAudit, users: loadUsers,
  };
  try { await (loaders[view] || (async () => {}))(); } catch (err) { toast(err.message, true); }
}

$$("#nav button").forEach((button) =>
  button.addEventListener("click", () => showView(button.dataset.view)));

/* --------------------------------------------------------------- monitor */
async function loadMonitor() {
  const data = await api("/api/monitor/overview");
  const sys = data.system;
  $("#host-name").textContent = data.host.hostname;
  $("#stat-cpu").textContent = `${sys.cpu_percent.toFixed(1)}%`;
  $("#bar-cpu").style.width = `${Math.min(100, sys.cpu_percent)}%`;
  $("#stat-mem").textContent = `${sys.memory.percent.toFixed(1)}%`;
  $("#bar-mem").style.width = `${Math.min(100, sys.memory.percent)}%`;
  $("#stat-load").textContent =
    `load ${sys.load["1m"].toFixed(2)} ${sys.load["5m"].toFixed(2)} ${sys.load["15m"].toFixed(2)} · ${sys.process_count} procs`;
  const disk = (await api("/api/monitor/system")).disks.find((d) => d.mount === "/") ||
    (await api("/api/monitor/system")).disks[0];
  if (disk) {
    $("#stat-disk").textContent = `${disk.percent.toFixed(0)}%`;
    $("#bar-disk").style.width = `${Math.min(100, disk.percent)}%`;
  }
  $("#stat-uptime").textContent = duration(sys.uptime_seconds);
  const badge = $("#rotator-badge");
  badge.textContent = data.rotator.running ? "rotator: running" : "rotator: stopped";
  badge.className = `badge ${data.rotator.running ? "ok" : "bad"}`;
  $("#pool-summary").textContent = JSON.stringify(data.rotator.pool || data.rotator, null, 2);
}

async function loadMonitorExtras() {
  const data = await api("/api/monitor/system");
  $("#net-list").innerHTML = data.networks.map((n) =>
    `<div>${esc(n.name)} · ${esc(n.ipv4.join(", ") || "-")} · ↑${bytes(n.bytes_sent)} ↓${bytes(n.bytes_recv)}</div>`
  ).join("") || "—";
  $("#proc-table tbody").innerHTML = data.processes.slice(0, 12).map((p) =>
    `<tr><td class="mono">${p.pid}</td><td>${esc(p.name)}</td><td>${esc(p.user)}</td>
     <td class="num">${bytes(p.rss)}</td></tr>`).join("");
}

/* --------------------------------------------------------------- rotator */
async function loadRotator() {
  const data = await api("/api/rotator/status");
  $("#strategy").value = data.configured_strategy || data.strategy || "round_robin";
  $("#listeners").innerHTML = data.running
    ? Object.entries(data.listeners || {})
        .filter(([, v]) => v)
        .map(([k, v]) => `<div>${k}: ${esc(v)}</div>`).join("")
    : `<div class="bad">stopped${data.error ? " — " + esc(data.error) : ""}</div>`;
  const rows = (data.upstreams || []).map((u) => `
    <tr>
      <td class="mono">${esc(u.label)}</td>
      <td>${u.tier}</td>
      <td class="num">${u.healthy ? "healthy" : (u.quarantined_until ? "quarantined" : "unknown")}</td>
      <td class="num">${u.latency_ms ?? "—"} ms</td>
      <td class="mono">${esc(u.exit_ip || "—")}</td>
      <td class="num">${u.uses ?? 0}</td>
      <td class="num">${u.max_slots || "∞"}</td>
      <td data-admin>
        <button class="ghost" data-act="quarantine" data-id="${esc(u.id)}">quarantine</button>
        <button class="ghost" data-act="slots" data-id="${esc(u.id)}">slots</button>
        <button class="ghost" data-act="remove" data-id="${esc(u.id)}">remove</button>
      </td>
    </tr>`).join("");
  $("#upstream-table tbody").innerHTML = rows ||
    `<tr><td colspan="8" class="muted">pool is empty — add an upstream or restore the config pool</td></tr>`;
  $$("#upstream-table button[data-act]").forEach((button) => button.addEventListener("click", onUpstreamAction));
}

async function onUpstreamAction(event) {
  const { act, id } = event.currentTarget.dataset;
  try {
    if (act === "remove") {
      if (!confirm("Remove this upstream from the pool?")) return;
      await api(`/api/rotator/upstreams/${encodeURIComponent(id)}`, { method: "DELETE" });
    } else if (act === "quarantine") {
      const seconds = prompt("Quarantine for how many seconds?", "300");
      if (seconds === null) return;
      await api(`/api/rotator/upstreams/${encodeURIComponent(id)}/quarantine?seconds=${Number(seconds) || 300}`,
        { method: "POST" });
    } else if (act === "slots") {
      const slots = prompt("Max concurrent slots (0 = unlimited)", "0");
      if (slots === null) return;
      await api(`/api/rotator/upstreams/${encodeURIComponent(id)}/slots`,
        { method: "POST", body: { max_slots: Number(slots) || 0 } });
    }
    toast("done");
    loadRotator();
  } catch (err) { toast(err.message, true); }
}

$("#strategy").addEventListener("change", async (event) => {
  try {
    await api(`/api/rotator/strategy?strategy=${encodeURIComponent(event.target.value)}`, { method: "POST" });
    toast(`strategy: ${event.target.value}`);
  } catch (err) { toast(err.message, true); }
});

for (const [id, path] of [["#btn-start", "start"], ["#btn-stop", "stop"], ["#btn-restart", "restart"]]) {
  $(id).addEventListener("click", async () => {
    try { const r = await api(`/api/rotator/${path}`, { method: "POST" });
      toast(r.error ? `${path}: ${r.error}` : `rotator ${path} ok`, !r.ok); loadRotator();
    } catch (err) { toast(err.message, true); }
  });
}

$("#upstream-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    const result = await api("/api/rotator/upstreams", {
      method: "POST",
      body: {
        line: form.get("line"),
        tier: Number(form.get("tier") || 1),
        max_slots: 0,
      },
    });
    if (!result.ok) throw new Error(result.error || "rejected");
    event.target.reset();
    toast("upstream added");
    loadRotator();
  } catch (err) { toast(err.message, true); }
});

$("#btn-restore").addEventListener("click", async () => {
  try { await api("/api/rotator/upstreams/restore", { method: "POST" }); toast("config pool restored"); loadRotator(); }
  catch (err) { toast(err.message, true); }
});

$("#btn-probe").addEventListener("click", async () => {
  $("#btn-probe").disabled = true;
  try {
    const data = await api("/api/rotator/probe");
    $("#upstream-table tbody").parentElement; // keep table, refresh below
    toast(`${data.ok_count}/${data.results.length} upstreams answered with an exit IP`);
    loadRotator();
  } catch (err) { toast(err.message, true); } finally { $("#btn-probe").disabled = false; }
});

$("#btn-rotate-test").addEventListener("click", async () => {
  $("#btn-rotate-test").disabled = true;
  $("#rotate-out").textContent = "sending 6 requests…";
  try {
    const data = await api("/api/rotator/rotation-test?requests=6");
    $("#rotate-out").textContent =
      `${data.distinct_exit_ips} distinct exit IP(s), rotation ratio ${data.rotation_ratio}\n` +
      data.requests.map((r, i) =>
        `#${i + 1} ${r.ok ? `${r.exit_ip || "?"} ${r.country || ""} via ${r.upstream_id} (${r.ms}ms)` : `failed: ${r.error}`}`
      ).join("\n");
  } catch (err) { $("#rotate-out").textContent = err.message; } finally { $("#btn-rotate-test").disabled = false; }
});

$("#btn-burp").addEventListener("click", async () => {
  try {
    const data = await api("/api/rotator/export/burp");
    $("#burp-out").textContent =
      `lines for Burp upstream list (${data.count}):\n${data.proxy_list_lines.join("\n") || "(none)"}\n\n` +
      data.burp_steps.map((s, i) => `${i + 1}. ${s}`).join("\n");
  } catch (err) { toast(err.message, true); }
});

/* --------------------------------------------------------------- lookups */
$("#lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ip = new FormData(event.target).get("ip");
  $("#lookup-out").textContent = "looking up…";
  try {
    $("#lookup-out").textContent = JSON.stringify(await api(`/api/ip/lookup?ip=${encodeURIComponent(ip)}`), null, 2);
  } catch (err) { $("#lookup-out").textContent = err.message; }
});

$$("[data-egress]").forEach((button) => button.addEventListener("click", async () => {
  $("#egress-out").textContent = "asking…";
  try {
    const data = await api(`/api/ip/egress?via=${button.dataset.egress}`);
    $("#egress-out").textContent = JSON.stringify(data, null, 2);
  } catch (err) { $("#egress-out").textContent = err.message; }
}));

$("#rdap-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const ip = new FormData(event.target).get("ip");
  $("#rdap-out").textContent = "querying RDAP…";
  try { $("#rdap-out").textContent = JSON.stringify(await api(`/api/ip/rdap?ip=${encodeURIComponent(ip)}`), null, 2); }
  catch (err) { $("#rdap-out").textContent = err.message; }
});

/* --------------------------------------------------------------- scanner */
async function loadScannerPolicy() {
  const data = await api("/api/monitor/overview");
  const policy = data.scanner;
  $("#scan-policy").textContent =
    `policy: ${policy.allowed_targets.join(", ") || "no targets"} · nmap ${policy.nmap_installed ? "available" : "missing"}`;
  $("#scan-policy").className = `badge ${policy.allowed_targets.length ? "ok" : "bad"}`;
}

$("#scan-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  $("#scan-out").textContent = "scanning…";
  try {
    const data = await api("/api/scan/ports", {
      method: "POST",
      body: {
        target: form.get("target"),
        ports: form.get("ports"),
        engine: form.get("engine"),
      },
    });
    $("#scan-out").textContent =
      `${data.target} (${data.resolved}) · ${data.engine} · ${data.duration}s · ${data.open_count} open, ${data.closed_count} closed\n` +
      (data.open_ports.map((p) => `  ${p.port}/tcp  ${p.service}`).join("\n") || "  no open ports") +
      (data.errors.length ? `\nerrors: ${data.errors.join("; ")}` : "");
  } catch (err) { $("#scan-out").textContent = err.message; }
});

/* ----------------------------------------------------------------- tools */
const TOOL_LABELS = {
  dns: "DNS lookup", ping: "Ping", traceroute: "Traceroute", whois: "Whois",
  tls: "TLS certificate", headers: "HTTP headers", hash: "Hash & entropy",
};
const TOOL_DEFAULTS = {
  dns: { host: "example.com", record: "A" },
  ping: { host: "127.0.0.1", count: 4 },
  traceroute: { host: "127.0.0.1", max_hops: 12 },
  whois: { query: "8.8.8.8" },
  tls: { host: "example.com", port: 443 },
  headers: { url: "https://example.com" },
  hash: { data: "hunter2", algorithm: "sha256" },
};

async function loadTools() {
  const data = await api("/api/tools");
  $("#tool-grid").innerHTML = data.tools.map((tool) => {
    const defaults = TOOL_DEFAULTS[tool.name] || {};
    const fields = tool.args.map((arg) => `
      <label>${arg}<input data-arg="${esc(arg)}" value="${esc(defaults[arg] ?? "")}"></label>`).join("");
    return `<div class="card tool-card">
      <h3>${esc(TOOL_LABELS[tool.name] || tool.name)}
        <span class="badge ${tool.available ? "ok" : "bad"}">${tool.available ? "ready" : "not installed"}</span></h3>
      <div class="tool-form">${fields}</div>
      <button class="ghost" data-tool="${esc(tool.name)}">Run</button>
      <pre class="pre" data-out="${esc(tool.name)}"></pre>
    </div>`;
  }).join("");
  $$("#tool-grid button[data-tool]").forEach((button) =>
    button.addEventListener("click", async () => {
      const name = button.dataset.tool;
      const card = button.closest(".tool-card");
      const body = {};
      $$("[data-arg]", card).forEach((input) => {
        let value = input.value;
        if (/^(count|max_hops|port)$/.test(input.dataset.arg)) value = Number(value);
        body[input.dataset.arg] = value;
      });
      const out = $("[data-out]", card);
      out.textContent = "running…";
      try {
        const result = await api(`/api/tools/${name}`, { method: "POST", body });
        out.textContent = JSON.stringify(result.result, null, 2);
      } catch (err) { out.textContent = err.message; }
    }));
}

/* --------------------------------------------------------------- server */
async function loadServices() {
  const data = await api("/api/server/services");
  $("#service-table tbody").innerHTML = data.services.map((s) => `
    <tr>
      <td class="mono">${esc(s.unit)}</td>
      <td class="${s.running ? "ok" : "muted"}">${esc(s.active_state || "unknown")}${esc(s.sub_state || "")}</td>
      <td class="mono">${s.main_pid ?? "—"}</td>
      <td>${s.error ? `<span class="bad">${esc(s.error)}</span>` : "—"}</td>
      <td>
        <button class="ghost" data-unit="${esc(s.unit)}" data-op="start">start</button>
        <button class="ghost" data-unit="${esc(s.unit)}" data-op="restart">restart</button>
        <button class="ghost" data-unit="${esc(s.unit)}" data-op="stop">stop</button>
      </td>
    </tr>`).join("") || `<tr><td colspan="5" class="muted">no services allowlisted</td></tr>`;
  $$("#service-table button[data-unit]").forEach((button) => button.addEventListener("click", async () => {
    try {
      const result = await api("/api/server/services", {
        method: "POST",
        body: { unit: button.dataset.unit, action: button.dataset.op },
      });
      toast(result.ok ? `${button.dataset.unit} ${button.dataset.op} ok` : (result.error || "failed"), !result.ok);
      loadServices();
    } catch (err) { toast(err.message, true); }
  }));
}

$("#btn-services").addEventListener("click", () => loadServices().catch((e) => toast(e.message, true)));

$("#journal-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const unit = form.get("unit") || "";
  try {
    const data = await api(
      `/api/server/journal?lines=${Number(form.get("lines") || 80)}` + (unit ? `&unit=${encodeURIComponent(unit)}` : ""));
    $("#journal-out").textContent = data.error ? data.error : data.lines.join("\n");
  } catch (err) { $("#journal-out").textContent = err.message; }
});

/* ---------------------------------------------------------------- audit */
async function loadAudit() {
  const mine = $("#audit-mine").checked ? "&mine=true" : "";
  const data = await api(`/api/monitor/audit?limit=100${mine}`);
  $("#audit-table tbody").innerHTML = data.entries.map((e) => `
    <tr>
      <td class="mono small">${esc(stamp(e.ts))}</td>
      <td>${esc(e.username)}</td>
      <td class="mono small">${esc(e.action)}</td>
      <td class="mono small">${esc(e.target || "—")}</td>
      <td class="${e.outcome === "ok" ? "ok" : "bad"}">${esc(e.outcome)}</td>
      <td class="small muted">${esc(e.detail || "")}</td>
    </tr>`).join("") || `<tr><td colspan="6" class="muted">no entries</td></tr>`;
}
$("#btn-audit").addEventListener("click", () => loadAudit().catch((e) => toast(e.message, true)));
$("#audit-mine").addEventListener("change", () => loadAudit().catch((e) => toast(e.message, true)));

/* ---------------------------------------------------------------- users */
async function loadUsers() {
  const data = await api("/api/auth/users");
  $("#user-table tbody").innerHTML = data.users.map((u) => `
    <tr>
      <td>${esc(u.username)}</td>
      <td>
        <select data-user="${u.id}" data-field="role">
          <option ${u.role === "admin" ? "selected" : ""}>admin</option>
          <option ${u.role === "operator" ? "selected" : ""}>operator</option>
        </select>
      </td>
      <td>${u.disabled ? '<span class="bad">disabled</span>' : "<span class='ok'>active</span>"}</td>
      <td class="mono small">${esc(stamp(u.last_login_at))}</td>
      <td class="num">${u.sessions}</td>
      <td><button class="ghost" data-user="${u.id}" data-field="toggle">${u.disabled ? "enable" : "disable"}</button></td>
    </tr>`).join("");
  $$("#user-table [data-field=role]").forEach((select) => select.addEventListener("change", async () => {
    try {
      await api(`/api/auth/users/${select.dataset.user}`,
        { method: "POST", body: { role: select.value } });
      toast("role updated"); loadUsers();
    } catch (err) { toast(err.message, true); }
  }));
  $$("#user-table button[data-field=toggle]").forEach((button) => button.addEventListener("click", async () => {
    try {
      await api(`/api/auth/users/${button.dataset.user}`, { method: "POST", body: { disabled: false } });
      toast("user updated"); loadUsers();
    } catch (err) { toast(err.message, true); }
  }));
}

/* ----------------------------------------------------------------- boot */
$("#refresh-monitor").addEventListener("click", () =>
  Promise.all([loadMonitor(), loadMonitorExtras()]).catch((e) => toast(e.message, true)));
setAuthMode("login");
boot();
