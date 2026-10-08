"use strict";

// Whether a name is one this browser will not open, decided in one place.
//
// The refusal happens before anything is built or asked. Chromium would
// otherwise send the name to every configured resolver and report "not
// resolved" - a request the tab should not make, and an answer that is wrong
// anyway, because the name can resolve perfectly well on the open internet. So
// the check runs ahead of the URL policy, ahead of the request, and ahead of the
// address bar's own load, and the tab is shown one fixed explanation instead of
// an error code the operator would have to decode.
//
// Main process only. Nothing here is registered on the IPC action map, so a
// renderer or a page can never ask for the rule - it only ever sees the
// explanation the main process chose to show.

// Returns the normalized host when input names a host in that family, else null.
// Everything that is presentation rather than identity is removed first: a
// scheme, credentials, a port, a path, a trailing dot, and letter case.
function onionHost(input) {
  if (typeof input !== "string") return null;
  let value = input.trim();
  if (!value) return null;

  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  if (value.startsWith("//")) value = value.slice(2); // scheme-relative
  if (!value) return null;

  // Path, query and fragment are not part of the host, so
  // "https://example.onion/img" and "example.com/x.onion" are decided on the
  // host alone rather than on where the string happens to end.
  const pathAt = value.search(/[/?#]/);
  if (pathAt >= 0) value = value.slice(0, pathAt);
  if (!value) return null;

  // Credentials belong to the URL, not to the host: "example.onion@evil.test"
  // is a visit to evil.test, and must not be read as anything else.
  const at = value.lastIndexOf("@");
  if (at >= 0) value = value.slice(at + 1);
  if (!value) return null;

  if (value.startsWith("[")) {
    // An IPv6 literal can hold a colon and still not carry a port.
    const close = value.indexOf("]");
    if (close < 0) return null;
    value = value.slice(1, close);
  } else {
    const colon = value.lastIndexOf(":");
    if (colon >= 0 && /^\d+$/.test(value.slice(colon + 1))) value = value.slice(0, colon);
  }

  value = value.replace(/\.$/, "").toLowerCase(); // "Example.ONION." is the same name
  if (!/^[a-z0-9-]+\.onion$/.test(value)) return null;
  return value;
}

module.exports = { onionHost };
