"use strict";

// Password-capture hook for *tab* views.
//
// This is the one place where the shell's earlier "no preload in a tab" rule is
// deliberately broken, so the rules are narrow on purpose:
//
//   * contextIsolation is on and sandbox is on. Page script cannot reach this
//     file's scope, its requires, or anything the bridge does not expose.
//   * the bridge exposes exactly one function: report(payload). It can neither
//     read a stored credential nor invoke any other privileged action.
//   * the payload is untrusted input. passwordWatcher re-validates the origin
//     against the tab's real URL and caps every field before it is stored.
//   * reporting only *offers* a credential. Nothing is written until the operator
//     presses Save, so a hostile page can at worst raise a prompt - and the
//     dedupe and rate limits stop it raising many.
//
// If the password manager is switched off, main.js simply never loads this file.

const { contextBridge, ipcRenderer } = require("electron");

const MAX_URL = 300;
const MAX_USER = 200;
const MAX_PASSWORD = 512;

// Only real navigations are interesting: about:blank, data: and blob: have no
// account to log into.
const NETWORK = /^https?:/i;

const USERNAME_HINTS = /^(user(name)?|login|email|e-mail|account|ident(ity)?|uid)$/i;

// The closest username-ish value the form offers, preferring the field right
// before the password and then the standard autocomplete values.
function findUsername(form, passwordField) {
  const fields = [...form.querySelectorAll("input")].filter((input) => {
    const type = (input.type || "text").toLowerCase();
    return type !== "password" && type !== "hidden" && type !== "submit" && type !== "button";
  });

  const byAutocomplete = fields.find((input) => /username|email/i.test(input.autocomplete || ""));
  if (byAutocomplete && byAutocomplete.value) return byAutocomplete.value;

  const index = passwordField ? [...form.elements].indexOf(passwordField) : -1;
  if (index > 0) {
    const before = [...form.elements]
      .slice(Math.max(0, index - 3), index)
      .reverse()
      .find((element) => element.tagName === "INPUT" && element.value);
    if (before) return before.value;
  }

  const byName = fields.find((input) => USERNAME_HINTS.test(input.name || input.id || ""));
  if (byName) return byName.value;

  const firstFilled = fields.find((input) => input.value);
  return firstFilled ? firstFilled.value : "";
}

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

function report(form, event) {
  let passwordField = null;
  try {
    passwordField = form.querySelector('input[type="password"]');
  } catch {
    return;
  }
  // A login form with two password fields is usually a "confirm your new
  // password" step; the first field is the one worth offering.
  if (!passwordField || !passwordField.value) return;

  const url = String(event && event.view && event.view.location ? event.view.location.href : "");
  if (!NETWORK.test(url)) return;

  ipcRenderer.send("netops:password-detected", {
    url: url.slice(0, MAX_URL),
    origin: originOf(url).slice(0, MAX_URL),
    username: String(findUsername(form, passwordField) || "").slice(0, MAX_USER),
    password: String(passwordField.value || "").slice(0, MAX_PASSWORD),
    // Sites that mint their own login form need a second chance; the main
    // process uses this to tell a genuine submission from a synthetic event.
    trusted: Boolean(event && event.isTrusted),
  });
}

function onSubmit(event) {
  const form = event.target;
  if (!form || form.tagName !== "FORM") return;
  report(form, event);
}

// Many sites never fire a real submit: they listen for a click on the button and
// post with fetch/XHR. Watching the button covers those without ever reading the
// values from a timer.
function onClick(event) {
  const element = event.target;
  if (!element || typeof element.closest !== "function") return;
  const button = element.closest('button, input[type="submit"], input[type="button"], [role="button"]');
  if (!button) return;
  const form = button.form || button.closest("form");
  if (!form) return;
  report(form, event);
}

document.addEventListener("submit", onSubmit, true);
document.addEventListener("click", onClick, true);

contextBridge.exposeInMainWorld("__blacknetPasswordHook", {
  version: 1,
  report: (payload) => ipcRenderer.send("netops:password-detected", payload || {}),
});