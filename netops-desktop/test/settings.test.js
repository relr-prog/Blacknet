// Settings: appearance, browser colour, rotator switch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Settings, normaliseHex } = require("../src/main/settings");

function tempSettings(core = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-settings-"));
  return new Settings({ userDataPath: dir, core });
}

test("defaults are the agreed palette choices", () => {
  const settings = tempSettings();
  assert.equal(settings.get("scheme"), "auto");
  assert.equal(settings.get("background"), null, "null keeps the palette background");
  assert.equal(settings.get("accent"), null);
  assert.equal(settings.get("rotatorEnabled"), false);
  assert.equal(settings.get("offerToSavePasswords"), true);
});

test("scheme accepts only auto/light/dark", () => {
  const settings = tempSettings();
  assert.equal(settings.patch({ scheme: "light" }).scheme, "light");
  assert.equal(settings.patch({ scheme: "dark" }).scheme, "dark");
  assert.equal(settings.patch({ scheme: "sepia" }).scheme, "auto");
  assert.equal(settings.patch({ scheme: 42 }).scheme, "auto");
});

test("background and accent are validated as #rrggbb", () => {
  const settings = tempSettings();
  assert.equal(settings.patch({ background: "#123456" }).background, "#123456");
  assert.equal(settings.patch({ accent: "  #ABCDEF " }).accent, "#abcdef");
  assert.equal(settings.patch({ background: "red" }).background, null);
  assert.equal(settings.patch({ background: "#12345" }).background, null);
  assert.equal(settings.patch({ accent: "javascript:alert(1)" }).accent, null);

  assert.equal(normaliseHex("#0d9488", null), "#0d9488");
  assert.equal(normaliseHex(null, "#fff"), "#fff");
});

test("an empty string clears a colour back to the palette default", () => {
  const settings = tempSettings();
  settings.patch({ background: "#123456" });
  assert.equal(settings.patch({ background: "" }).background, null);
});

test("a hand-edited file with junk falls back to defaults, not to garbage", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-settings-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ scheme: "neon", background: "url(javascript:x)", accent: 12 }),
  );
  const settings = new Settings({ userDataPath: dir });
  assert.equal(settings.get("scheme"), "auto");
  assert.equal(settings.get("background"), null);
  assert.equal(settings.get("accent"), null);
});

test("rotatorEnabled cannot be flipped through patch()", () => {
  const settings = tempSettings();
  assert.equal(settings.patch({ rotatorEnabled: true }).rotatorEnabled, false);
});

test("rotator state is recorded from the service, not from the UI", () => {
  const settings = tempSettings();
  const after = settings.setRotatorState({
    enabled: true,
    state: "running",
    detail: "3 upstreams",
  });
  assert.equal(after.rotatorEnabled, true);
  assert.equal(after.rotatorState, "running");
  assert.equal(after.rotatorDetail, "3 upstreams");

  const reloaded = new Settings({ userDataPath: settings.store.file.replace("/settings.json", "") });
  assert.equal(reloaded.get("rotatorEnabled"), true);
});

test("details are length-capped so a chatty service cannot bloat the file", () => {
  const settings = tempSettings();
  const after = settings.setRotatorState({ state: "x".repeat(80), detail: "y".repeat(900) });
  assert.equal(after.rotatorState.length, 40);
  assert.equal(after.rotatorDetail.length, 200);
});

test("css variables only appear when a colour is actually set", () => {
  const settings = tempSettings();
  // "auto" must become the CSS pair "light dark": handing color-scheme the word
  // "auto" resolves to light and pins the UI to the day palette.
  assert.deepEqual(settings.cssVariables(), { "color-scheme": "light dark" });

  settings.patch({ scheme: "dark" });
  assert.deepEqual(settings.cssVariables(), { "color-scheme": "dark" });

  settings.patch({ scheme: "light", background: "#101010", accent: "#569CD6" });
  assert.deepEqual(settings.cssVariables(), {
    "color-scheme": "light",
    "--bg": "#101010",
    "--accent": "#569cd6",
    "--accent-fill": "#569cd6",
  });

  settings.patch({ scheme: "auto", background: null, accent: null });
  assert.deepEqual(settings.cssVariables(), { "color-scheme": "light dark" });
});

test("patching pushes the theme into the native core", () => {
  const applied = [];
  const core = { applyTheme: (patch) => applied.push(patch) };
  const settings = tempSettings(core);

  settings.patch({ scheme: "dark", pageTheme: "paper" });
  assert.deepEqual(applied.at(-1), { name: "paper", mode: "dark" });
});

test("a theme the native core rejects does not break settings", () => {
  const core = {
    applyTheme: () => {
      throw new Error("theme colour must be a hex colour");
    },
  };
  const settings = tempSettings(core);
  assert.equal(settings.patch({ scheme: "light" }).scheme, "light");
});

test("subscribers are notified and can unsubscribe", () => {
  const settings = tempSettings();
  const seen = [];
  const off = settings.subscribe((values) => seen.push(values.scheme));

  settings.patch({ scheme: "dark" });
  settings.setRotatorState({ enabled: true, state: "running" });
  off();
  settings.patch({ scheme: "light" });

  assert.deepEqual(seen, ["dark", "dark"], "one notify per mutation, none after off()");
});

test("a throwing subscriber does not stop the others", () => {
  const settings = tempSettings();
  const seen = [];
  settings.subscribe(() => {
    throw new Error("bad listener");
  });
  settings.subscribe((values) => seen.push(values.scheme));
  settings.patch({ scheme: "light" });
  assert.deepEqual(seen, ["light"]);
});