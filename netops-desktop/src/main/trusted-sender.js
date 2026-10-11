"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

// Only top-level documents shipped inside the local renderer directory may
// invoke privileged IPC handlers. Remote tabs must never gain authority merely
// because a preload or navigation mistake exposes the bridge.
function isTrustedUiSender(event, rendererDir) {
  if (!event || !event.senderFrame || !event.sender) return false;
  if (event.senderFrame !== event.sender.mainFrame) return false;

  let url;
  let filePath;
  try {
    url = new URL(event.senderFrame.url);
    if (url.protocol !== "file:" || url.hostname || url.username || url.password) return false;
    filePath = path.resolve(fileURLToPath(url));
  } catch {
    return false;
  }

  const root = path.resolve(rendererDir);
  const relative = path.relative(root, filePath);
  return relative !== "" && relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

module.exports = { isTrustedUiSender };
