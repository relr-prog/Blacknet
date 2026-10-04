"use strict";

// Audio availability probe.
//
// Chromium fails silently when it has no output device: the page plays, the tab
// says it is audible, and nothing comes out. On WSL that is the normal state
// unless libpulse is installed - ALSA's library is present but /dev/snd has no
// PCM devices, and WSLg's PulseAudio server is unreachable without libpulse.so.0.
//
// This is a diagnostic, not a fix: it tells the chrome to say "no audio device"
// instead of leaving the operator wondering.

const fs = require("fs");
const net = require("net");
const path = require("path");

const LIBRARY_PATHS = [
  "/lib/x86_64-linux-gnu/libpulse.so.0",
  "/usr/lib/x86_64-linux-gnu/libpulse.so.0",
  "/lib/aarch64-linux-gnu/libpulse.so.0",
  "/usr/lib/libpulse.so.0",
  "/usr/local/lib/libpulse.so.0",
];

// PULSE_SERVER looks like "unix:/run/user/1000/pulse" or a bare path.
function pulseSocketPath() {
  const server = process.env.PULSE_SERVER || "";
  if (!server) return null;
  const withoutScheme = server.replace(/^[a-z]+:/, "");
  return withoutScheme.startsWith("/") ? withoutScheme : null;
}

function alsaDevices() {
  // /proc/asound only exists when ALSA has a real card to talk to.
  return fs.existsSync("/proc/asound/cards");
}

function connect(socketPath, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    const finish = (reachable) => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function detectAudio() {
  const socketPath = pulseSocketPath();
  const library = LIBRARY_PATHS.find((candidate) => fs.existsSync(candidate)) || null;

  if (!socketPath) {
    return {
      available: false,
      reason: "PULSE_SERVER is not set, so there is no PulseAudio to route audio to",
      library: Boolean(library),
      server: null,
    };
  }

  if (!library) {
    return {
      available: false,
      reason: `libpulse.so.0 is missing, so Chromium cannot use ${socketPath}`,
      library: false,
      server: socketPath,
    };
  }

  const reachable = await connect(socketPath);
  if (!reachable) {
    return {
      available: false,
      reason: `nothing is listening on ${socketPath}`,
      library: true,
      server: socketPath,
    };
  }

  return {
    available: true,
    reason: alsaDevices() ? "pulseaudio reachable" : "pulseaudio reachable (no alsa hardware)",
    library: true,
    server: socketPath,
  };
}

// Windows/macOS hosts, and any Linux with real hardware, need no probe.
function hostProbablyHasAudio() {
  if (process.platform !== "linux") return true;
  return fs.existsSync("/proc/asound/cards") || Boolean(pulseSocketPath());
}

module.exports = { detectAudio, hostProbablyHasAudio, pulseSocketPath, LIBRARY_PATHS };