"use strict";

// Browser settings: appearance, browser colour and the IP rotator switch.
//
// Storage is local to the shell (<userData>/settings.json) rather than in the
// control plane's database, because these are per-machine browser preferences -
// the same person may run BlackNet with the IP rotator on one profile and off on
// another. Anything that is an *account* fact (role, guest) comes from
// account.js instead.
//
// Colours are stored as validated #rrggbb strings. The user may pick any colour,
// so validation has to be defensive: a bad value from a hand-edited file must
// fall back to the palette default rather than paint the UI black.

const { JsonStore } = require("./store");

const HEX = /^#[0-9a-f]{6}$/;

// One description of every setting: its type, its allowed values, its default and
// whether the settings UI may write it.
//
// This existed as a list of `if ("key" in values)` branches, which is fine right up
// until it is not. A key that was validated on write but not on read means a
// hand-edited or half-migrated settings.json paints the UI whatever it says; a key
// with no branch is silently dropped, so the write appears to work and nothing
// changes. Reads and writes now go through the same table, which is the only way
// both of those stay true as keys are added.
const SCHEMA = {
  // --- writable by the operator --------------------------------------------
  // "auto" follows prefers-color-scheme; "light" is Opsi B, "dark" is Opsi A.
  scheme: { type: "enum", values: ["auto", "light", "dark"], default: "auto" },
  // Chrome background override. null keeps the palette background.
  background: { type: "hex", default: null },
  // Accent used for focus rings, active tab rule, highlights.
  accent: { type: "hex", default: null },
  // Browser (page) surface theme name handed to the C++ theme store.
  pageTheme: { type: "text", maxLength: 40, default: "auto" },
  // Save-password prompts: ask before storing a detected credential.
  offerToSavePasswords: { type: "bool", default: true },
  // Show the toolbar gear.
  showSettingsButton: { type: "bool", default: true },
  // Reopen the previous tabs on launch. On by default, like every browser: losing
  // your tabs on quit is not a privacy feature, it is data loss. It stores URLs
  // and nothing else (see session.js), and this switch turns it off.
  restoreSession: { type: "bool", default: true },

  // --- written by the shell, not the operator --------------------------------
  // IP Rotator master switch: false means "direct connection", whatever the pool
  // says. The last known IP rotator state is remembered for display only. Not
  // writable: flipping the IP rotator is an action on the IP rotator service, not a
  // preference, and the UI must not be able to claim a proxy is on when it is off.
  ipRotatorEnabled: { type: "bool", default: false, writable: false },
  ipRotatorState: { type: "text", maxLength: 40, default: "unknown", writable: false },
  ipRotatorDetail: { type: "text", maxLength: 200, default: "", writable: false },
  ipRotatorAdminOnly: { type: "bool", default: false, writable: false },
};

const DEFAULTS = Object.fromEntries(
  Object.entries(SCHEMA).map(([key, spec]) => [key, spec.default]),
);

const WRITABLE = new Set(
  Object.entries(SCHEMA)
    .filter(([, spec]) => spec.writable !== false)
    .map(([key]) => key),
);

// --- coercion ----------------------------------------------------------------
//
// Every value that leaves this module passes through here, including values read
// back from disk. A bad value is replaced by the default rather than rejected: the
// operator did not ask for an invalid colour, and refusing to start the browser
// over one is a worse answer than falling back to the palette.

function coerce(spec, value) {
  switch (spec.type) {
    case "bool":
      // "false" as a string used to mean true, which is a preference quietly
      // inverted by whatever wrote it. Both spellings are accepted explicitly
      // rather than by truthiness.
      if (typeof value === "boolean") return value;
      if (value === "true") return true;
      if (value === "false") return false;
      return spec.default;
    case "enum":
      return spec.values.includes(value) ? value : spec.default;
    case "hex": {
      if (value === null || value === "") return null;
      if (typeof value !== "string") return spec.default;
      const trimmed = value.trim().toLowerCase();
      return HEX.test(trimmed) ? trimmed : spec.default;
    }
    case "text":
      if (typeof value !== "string") return spec.default;
      return value.slice(0, spec.maxLength);
    default:
      return spec.default;
  }
}

// Normalises a whole settings object. Unknown keys are dropped: nothing in this
// file is read from the network, but a stray key from an older build should not
// outlive the version that wrote it.
function coerceAll(raw) {
  const out = {};
  for (const [key, spec] of Object.entries(SCHEMA)) {
    out[key] = coerce(spec, raw[key]);
  }
  return out;
}

// The standalone helper keeps its own contract - "give me a fallback for anything
// unusable", including null - because callers use it to fill a colour in. The
// schema above is the opposite in one respect: null means "no override", which is
// a value in its own right for these two keys.
function normaliseHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  return HEX.test(trimmed) ? trimmed : fallback;
}

function normaliseScheme(value) {
  return coerce(SCHEMA.scheme, value);
}

class Settings {
  #store;
  #listeners = new Set();
  #core;

  constructor({ userDataPath, core = null }) {
    this.#store = new JsonStore(`${userDataPath}/settings.json`, DEFAULTS);
    this.#core = core;
  }

  get store() {
    return this.#store;
  }

  // --- reads ---------------------------------------------------------------
  all() {
    return coerceAll(this.#store.all());
  }

  get(key) {
    return this.all()[key];
  }

  // --- writes --------------------------------------------------------------
  // patch() is the only mutator: it validates, persists, applies and notifies, so
  // no caller can leave the UI and the persisted state disagreeing.
  //
  // Keys the schema does not know are ignored rather than written, and keys marked
  // not-writable are ignored even when named. Both cases used to be invisible:
  // the UI would show a changed value and nothing would happen.
  patch(values) {
    const next = coerceAll(this.#store.all());

    for (const key of Object.keys(values || {})) {
      if (!WRITABLE.has(key)) continue;
      next[key] = coerce(SCHEMA[key], values[key]);
    }

    this.#store.patch(next);
    this.#apply();
    this.#notify();
    return this.all();
  }

  setIPRotatorState({ enabled, state, detail = "", adminOnly = false }) {
    this.#store.patch(
      coerceAll({
        ...this.#store.all(),
        ipRotatorEnabled: enabled,
        ipRotatorState: state,
        ipRotatorDetail: detail,
        ipRotatorAdminOnly: adminOnly,
      }),
    );
    this.#notify();
    return this.all();
  }

  // --- apply ---------------------------------------------------------------
  // Turn preferences into the three things that actually paint: the chrome's CSS
  // custom properties, the window background, and the C++ page theme.
  #apply() {
    const values = this.all();

    if (this.#core) {
      try {
        this.#core.applyTheme({ name: values.pageTheme, mode: values.scheme });
      } catch {
        // A rejected theme must never stop the settings UI from working.
      }
    }
    return values;
  }

  // The chrome renderer asks for these; kept here so there is one definition of
  // "what should the toolbar look like".
  cssVariables() {
    const values = this.all();
    // "auto" is our own vocabulary, not CSS: color-scheme needs the pair
    // "light dark" to mean "follow the OS". Handing it "auto" resolves to light
    // and silently pins the whole UI to the day palette.
    const scheme =
      values.scheme === "light" || values.scheme === "dark" ? values.scheme : "light dark";
    const vars = { "color-scheme": scheme };
    if (values.background) vars["--bg"] = values.background;
    if (values.accent) {
      vars["--accent"] = values.accent;
      vars["--accent-fill"] = values.accent;
    }
    return vars;
  }

  // --- change notification --------------------------------------------------
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #notify() {
    const snapshot = this.all();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch {
        /* one bad listener must not stop the others */
      }
    }
  }
}

module.exports = { Settings, SCHEMA, DEFAULTS, normaliseHex, normaliseScheme, coerceAll, HEX };