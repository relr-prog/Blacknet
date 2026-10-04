"use strict";

// The shell's own pages that open in a tab.
//
// The name is looked up in this table and is never joined into a path, so no
// caller - a renderer, a preload, or anything else on the far side of the IPC
// boundary - can name a file that is not listed here. A tab that shows one of
// these pages is given the full preload bridge, which is why the list is kept
// this small and this separate: adding a page is a deliberate act, and adding a
// path that is not ours would hand a renderer the control plane.

const path = require("path");

const RENDERER_DIR = path.join(__dirname, "..", "renderer");

const INTERNAL_PAGES = {
  settings: { file: "pages/settings.html", title: "Settings & Privacy" },
};

// Returns { file, title } for a known name, or null for anything else.
function internalPage(name) {
  if (typeof name !== "string" || !Object.hasOwn(INTERNAL_PAGES, name)) return null;

  const page = INTERNAL_PAGES[name];
  const file = path.resolve(RENDERER_DIR, page.file);
  // The table is ours, so this cannot fire today. It is here because the cost of
  // a future entry escaping the renderer directory is the whole preload bridge.
  if (!file.startsWith(RENDERER_DIR + path.sep)) return null;

  return { file, title: page.title };
}

module.exports = { INTERNAL_PAGES, internalPage, RENDERER_DIR };