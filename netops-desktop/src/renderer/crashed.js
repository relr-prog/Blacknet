"use strict";

// Fills in the crash details the main process passed as query parameters.

const params = new URLSearchParams(window.location.search);
document.getElementById("reason").textContent = params.get("reason") || "unknown";
document.getElementById("code").textContent = params.get("code") || "-";
document.title = `Crashed (${params.get("reason") || "unknown"})`;