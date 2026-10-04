"use strict";

// Browser settings: appearance, browser colour and the rotator switch.
//
// Storage is local to the shell (<userData>/settings.json) rather than in the
// control plane's database, because these are per-machine browser preferences -
// the same person may run BlackNet with the rotator on one profile and off on
// another. Anything that is an *account* fact (role, guest) comes from
// account.js instead.
//
// Colours are stored as validated #rrggbb strings. The user may pick any colour,
// so validation has to be defensive: a bad value from a hand-edited file must
// fall back to the palette default rather than paint the UI black.

const { JsonStore } = require("./store");

const HEX = /^#[0-9a-f]{6}$/;

const DEFAULTS = {
  // "auto" follows prefers-color-scheme; "light" is Opsi B, "dark" is Opsi A.
  scheme: "auto",
  // Chrome background override. null keeps the palette background.
  background: null,
  // Accent used for focus rings, active tab rule, highlights.
  accent: null,
  // Browser (page) surface theme name handed to the C++ theme store.
  pageTheme: "auto",
  // Rotator master switch: false means "direct connection", whatever the pool
  // says. The last known rotator state is remembered for display only.
  rotatorEnabled: false,
  rotatorState: "unknown",
  rotatorDetail: "",
  rotatorAdminOnly: false,
  // Save-password prompts: ask before storing a detected credential.
  offerToSavePasswords: true,
  // Show the toolbar gear.
  showSettingsButton: true,
};

function normaliseHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim().toLowerCase();
  return HEX.test(trimmed) ? trimmed : fallback;
}

function normaliseScheme(value) {
  return ["auto", "light", "dark"].includes(value) ? value : DEFAULTS.scheme;
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
    const raw = this.#store.all();
    return {
      ...raw,
      scheme: normaliseScheme(raw.scheme),
      background: normaliseHex(raw.background, DEFAULTS.background),
      accent: normaliseHex(raw.accent, DEFAULTS.accent),
    };
  }

  get(key) {
    return this.all()[key];
  }

  // --- writes --------------------------------------------------------------
  // patch() is the only mutator: it validates, persists, applies and notifies, so
  // no caller can leave the UI and the persisted state disagreeing.
  patch(values) {
    const next = { ...this.#store.all() };

    if ("scheme" in values) next.scheme = normaliseScheme(values.scheme);
    if ("background" in values) {
      next.background =
        values.background === null || values.background === ""
          ? null
          : normaliseHex(values.background, DEFAULTS.background);
    }
    if ("accent" in values) {
      next.accent =
        values.accent === null || values.accent === ""
          ? null
          : normaliseHex(values.accent, DEFAULTS.accent);
    }
    if ("pageTheme" in values && typeof values.pageTheme === "string") {
      next.pageTheme = values.pageTheme.slice(0, 40);
    }
    if ("offerToSavePasswords" in values) {
      next.offerToSavePasswords = Boolean(values.offerToSavePasswords);
    }
    if ("showSettingsButton" in values) {
      next.showSettingsButton = Boolean(values.showSettingsButton);
    }
    // rotatorEnabled is deliberately not settable here: flipping the rotator is
    // an action on the rotator service, not a preference write. Use
    // setRotatorState() once the service has confirmed the change.

    this.#store.patch(next);
    this.#apply();
    this.#notify();
    return this.all();
  }

  setRotatorState({ enabled, state, detail = "", adminOnly = false }) {
    this.#store.patch({
      rotatorEnabled: Boolean(enabled),
      rotatorState: String(state || "unknown").slice(0, 40),
      rotatorDetail: String(detail || "").slice(0, 200),
      rotatorAdminOnly: Boolean(adminOnly),
    });
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

module.exports = { Settings, DEFAULTS, normaliseHex, normaliseScheme, HEX };