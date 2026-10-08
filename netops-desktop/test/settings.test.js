// Settings: appearance, browser colour, IP rotator switch.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Settings, SCHEMA, DEFAULTS, normaliseHex } = require("../src/main/settings");

function tempSettings(core = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-settings-"));
  return new Settings({ userDataPath: dir, core });
}

test("defaults are the agreed palette choices", () => {
  const settings = tempSettings();
  assert.equal(settings.get("scheme"), "auto");
  assert.equal(settings.get("background"), null, "null keeps the palette background");
  assert.equal(settings.get("accent"), null);
  assert.equal(settings.get("ipRotatorEnabled"), false);
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

test("ipRotatorEnabled cannot be flipped through patch()", () => {
  const settings = tempSettings();
  assert.equal(settings.patch({ ipRotatorEnabled: true }).ipRotatorEnabled, false);
});

test("IP rotator state is recorded from the service, not from the UI", () => {
  const settings = tempSettings();
  const after = settings.setIPRotatorState({
    enabled: true,
    state: "running",
    detail: "3 upstreams",
  });
  assert.equal(after.ipRotatorEnabled, true);
  assert.equal(after.ipRotatorState, "running");
  assert.equal(after.ipRotatorDetail, "3 upstreams");

  const reloaded = new Settings({ userDataPath: settings.store.file.replace("/settings.json", "") });
  assert.equal(reloaded.get("ipRotatorEnabled"), true);
});

test("details are length-capped so a chatty service cannot bloat the file", () => {
  const settings = tempSettings();
  const after = settings.setIPRotatorState({ state: "x".repeat(80), detail: "y".repeat(900) });
  assert.equal(after.ipRotatorState.length, 40);
  assert.equal(after.ipRotatorDetail.length, 200);
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
  settings.setIPRotatorState({ enabled: true, state: "running" });
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

// --- the schema --------------------------------------------------------------
//
// Settings are described in one table and every read and write goes through it.
// The cases worth pinning are the ones where the old branch-per-key version
// quietly disagreed with itself: a value invalid on disk but never re-checked, a
// key the UI sent that nothing handled, and the IP rotator switch being writable
// from the settings panel.

test("every setting is described, and every description has a default", () => {
  const values = tempSettings().all();
  for (const [key, spec] of Object.entries(SCHEMA)) {
    assert.ok(spec.type, `${key} needs a type`);
    assert.ok(key in values, `${key} must be readable`);
    assert.ok(
      Object.hasOwn(spec, "default"),
      `${key} needs a default, or a corrupt file decides it`,
    );
  }
  assert.deepEqual(
    Object.keys(values).sort(),
    Object.keys(SCHEMA).sort(),
    "a setting with no schema entry would never be validated",
  );
});

test("a value that is invalid on disk is fixed on read, not only on write", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-settings-"));
  fs.writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({
      scheme: "ultraviolet",
      background: "#12345",
      showSettingsButton: "no",
      ipRotatorDetail: 12345,
      somethingRemoved: "from an older build",
    }),
  );
  const values = new Settings({ userDataPath: dir }).all();
  assert.equal(values.scheme, "auto");
  assert.equal(values.background, null);
  assert.equal(values.showSettingsButton, true, "an unreadable flag falls back to its default");
  assert.equal(values.ipRotatorDetail, "");
  assert.equal(
    Object.hasOwn(values, "somethingRemoved"),
    false,
    "a key no version reads should not outlive the version that wrote it",
  );
});

test('"false" as a string means false, not a truthy surprise', () => {
  // Boolean("false") is true, so the string form used to switch the setting the
  // wrong way - the one case where the UI and the file would disagree about what
  // the operator asked for.
  const settings = tempSettings();
  settings.patch({ showSettingsButton: true });
  assert.equal(settings.patch({ showSettingsButton: "false" }).showSettingsButton, false);
  assert.equal(settings.patch({ restoreSession: "false" }).restoreSession, false);
  assert.equal(settings.patch({ restoreSession: "true" }).restoreSession, true);
});

test("an unknown key in a patch is ignored rather than written", () => {
  const settings = tempSettings();
  const updated = settings.patch({ notASetting: "value", scheme: "dark" });
  assert.equal(updated.scheme, "dark", "the real key still applies");
  assert.equal(Object.hasOwn(updated, "notASetting"), false);
  assert.equal(
    Object.hasOwn(JSON.parse(fs.readFileSync(settings.store.file, "utf8")), "notASetting"),
    false,
    "and it does not reach the file either",
  );
});

test("the settings UI cannot claim the IP rotator is on", () => {
  // ipRotatorEnabled is written only by the IP rotator service reporting what it
  // actually did. A patch from a renderer that set it would paint a green "proxy
  // on" over a browser that is not proxying anything.
  const settings = tempSettings();
  settings.setIPRotatorState({ enabled: false, state: "stopped" });
  const updated = settings.patch({ ipRotatorEnabled: true, ipRotatorState: "running" });
  assert.equal(updated.ipRotatorEnabled, false);
  assert.equal(updated.ipRotatorState, "stopped");

  // The service path still works, because that is the one that knows.
  assert.equal(
    settings.setIPRotatorState({ enabled: true, state: "running" }).ipRotatorEnabled,
    true,
  );
});

test("an over-long detail string is truncated rather than stored whole", () => {
  const settings = tempSettings();
  const updated = settings.setIPRotatorState({
    enabled: true,
    state: "running",
    detail: "x".repeat(5000),
  });
  assert.equal(updated.ipRotatorDetail.length, 200);
});

test("every writable key survives a patch that sets it", () => {
  // A key added to the schema with no UI control is a dead setting. This at least
  // makes it a stored, readable one, and fails loudly when the table and the
  // defaults drift apart.
  const settings = tempSettings();
  const sample = {
    bool: false,
    enum: "dark",
    hex: "#0d9488",
    text: "custom",
  };
  for (const [key, spec] of Object.entries(SCHEMA)) {
    if (spec.writable === false) continue;
    const value = spec.type === "enum" ? spec.values[spec.values.length - 1] : sample[spec.type];
    assert.notEqual(
      settings.patch({ [key]: value })[key],
      DEFAULTS[key],
      `${key} did not take the value it was given`,
    );
  }
});