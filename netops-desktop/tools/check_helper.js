"use strict";
// Extracts HELPER_SOURCE from reauth.js and checks that it is valid Python.
// Reads the module export rather than re-parsing the source, so the string
// escapes are the ones a terminal would actually receive.
// Run with: node tools/check_helper.js
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { HELPER_SOURCE } = require("../src/main/reauth");

const target = path.join(os.tmpdir(), `blacknet-helper-${process.pid}.py`);
fs.writeFileSync(target, HELPER_SOURCE, { mode: 0o700 });

try {
  execFileSync("python3", ["-m", "py_compile", target], { stdio: "pipe" });
  console.log("helper python syntax ok");
} catch (error) {
  console.error("helper python syntax FAILED");
  console.error(String(error.stderr || error.message));
  process.exit(1);
} finally {
  fs.rmSync(target, { force: true });
  fs.rmSync(`${target}c`, { force: true });
  try {
    fs.rmSync(path.join(os.tmpdir(), "__pycache__"), { recursive: true, force: true });
  } catch {
    /* nothing cached */
  }
}