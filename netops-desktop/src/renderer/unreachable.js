"use strict";

// Fills in the refusal the main process passed as a query parameter, and makes
// Reload retry the address rather than this file. Everything the page shows
// comes from the address itself: it has no bridge, so it cannot ask the shell
// why the name was refused, and nothing it does can reach the network on its
// own.

const params = new URLSearchParams(window.location.search);
const target = params.get("url") || "";
const host = hostOf(target);

document.getElementById("reason").textContent = host
  ? `${host}'s server IP address could not be found.`
  : "The server address could not be found.";
// The name, not a phrase: a tab whose title is a sentence cannot be told apart
// from the others in the strip.
if (host) document.title = host;

document.getElementById("reload").addEventListener("click", () => {
  // Back through the shell's own loader, so this navigation is refused exactly
  // the way the first one was and the tab returns to this explanation instead
  // of to a blank frame. location.reload() would only reload this file, which
  // would leave the operator pressing Reload and seeing nothing happen.
  if (target) window.location.href = target;
  else window.location.reload();
});

// The host, without the parts of the address that are not the host: scheme,
// credentials, port, path, trailing dot, letter case. Read back from the
// address rather than passed as a second value that could disagree with it.
function hostOf(value) {
  let text = typeof value === "string" ? value.trim() : "";
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/\//, "");
  text = text.split(/[/?#]/)[0];
  const at = text.lastIndexOf("@");
  if (at >= 0) text = text.slice(at + 1);
  if (text.startsWith("[")) {
    const close = text.indexOf("]");
    text = close > 0 ? text.slice(1, close) : "";
  } else {
    text = text.replace(/:\d+$/, "");
  }
  return text.replace(/\.$/, "").toLowerCase();
}
