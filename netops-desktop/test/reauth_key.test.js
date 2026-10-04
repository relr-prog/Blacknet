"use strict";
// Proves the key-file format and the decoder agree, on both sides of the
// boundary: Reauth.decodeKeyFile in JS and the helper's base64 decode in Python.
// This is the bug that made the first save look corrupt: the helper used to
// base64-encode text that was already base64, yielding 44 bytes instead of 32.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { test } = require("node:test");

const { decodeKeyFile, HELPER_SOURCE, KEY_PATH, Reauth } = require("../src/main/reauth");

// The helper comes from the module export, not from re-parsing the source: the
// export is what a terminal actually receives, so its string escapes are already
// resolved. Re-reading the raw template instead silently keeps "\\n" doubled,
// which writes a literal backslash-n into the key file and looks like corruption.
// KEY_PATH is interpolated in the export, so it is repointed by substitution.
function helperSource(keyPath) {
  return HELPER_SOURCE.split(KEY_PATH).join(keyPath);
}

test("decodeKeyFile reads the base64 form the helper writes", () => {
  const key = crypto.randomBytes(32);
  const decoded = decodeKeyFile(`${key.toString("base64")}\n`);
  assert.deepEqual(decoded, key);
});

test("decodeKeyFile tolerates raw 32 bytes", () => {
  const key = crypto.randomBytes(32);
  assert.deepEqual(decodeKeyFile(key), key);
});

test("decodeKeyFile rejects a double-encoded key instead of returning garbage", () => {
  const key = crypto.randomBytes(32);
  const doubleEncoded = Buffer.from(key.toString("base64")).toString("base64");
  assert.equal(doubleEncoded.length, 60);
  assert.equal(decodeKeyFile(doubleEncoded), null);
});

test("decodeKeyFile rejects wrong lengths", () => {
  assert.equal(decodeKeyFile(""), null);
  assert.equal(decodeKeyFile("c2hvcnQ="), null);
});

// Runs the shipped helper as a real process, with a fake `sudo` first on PATH and
// KEY_PATH repointed at a temp file. That covers main(), the argv handling, the
// nonce echo, the install path and the key emit without needing a root account.
// This is where the old double-encoding bug lived: the helper used to re-encode
// the already-base64 file, so the key came back 44 bytes and the vault refused
// to open. Asserting on real output is what catches that.
function harnessResultBin(dir) {
  return path.join(dir, "bin");
}

function harness({ keyFile = null, sudoFails = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-helper-"));
  const keyPath = path.join(dir, "vault.key");

  const body = helperSource(keyPath);
  const script = path.join(dir, "helper.py");
  fs.writeFileSync(script, body, { mode: 0o700 });

  // A sudo stand-in that eats the sudo flags and the password line on stdin, the
  // way real `sudo -S` does, then runs the command for real. `chown` is faked
  // because handing the file to root is precisely the part we cannot do here;
  // everything else actually executes, so a broken tee or chmod still fails.
  const bin = path.join(harnessResultBin(dir), "sudo");
  fs.mkdirSync(path.dirname(bin), { mode: 0o700 });
  fs.writeFileSync(
    bin,
    [
      "#!/bin/sh",
      "reads=0",
      'while [ $# -gt 0 ]; do',
      'case "$1" in',
      "-S) reads=1; shift ;;",
      "-k|-n) shift ;;",
      "*) break ;;",
      "esac",
      "done",
      '[ "$reads" = 1 ] && IFS= read -r _pw',
      sudoFails ? 'echo "Sorry, try again." >&2\nexit 1' : "",
      'if [ "$1" = "chown" ]; then exit 0; fi',
      'exec "$@"',
      "",
    ]
      .filter(Boolean)
      .join("\n"),
    { mode: 0o700 },
  );

  if (keyFile) fs.writeFileSync(keyPath, keyFile);
  return { dir, keyPath, script };
}

function runHelper(harnessResult, argv, password = "hunter2") {
  // setsid detaches the controlling terminal so Python's getpass cannot open
  // /dev/tty and blocks; it falls back to reading stdin, which we supply.
  const env = { ...process.env, PATH: `${path.join(harnessResult.dir, "bin")}:${process.env.PATH}` };
  const timeout = 30000;
  try {
    return execFileSync("setsid", ["python3", harnessResult.script, ...argv], {
      encoding: "utf8",
      input: `${password}\n`,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
    });
  } catch (error) {
    if (error.killed || error.signal) throw new Error("the helper hung; getpass likely opened a tty");
    throw error;
  }
}

test("the helper returns the key it read as 32 bytes, not 44", () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness({ keyFile: `${key.toString("base64")}\n` });

  const out = runHelper(h, [nonce]);
  assert.match(out, new RegExp(`BLACKNET-PROOF:${nonce}`), "the nonce must be echoed back");

  const emitted = out.match(/BLACKNET-KEY:([A-Za-z0-9+/=]+)/);
  assert.ok(emitted, `expected a key line, got: ${JSON.stringify(out)}`);
  const bytes = Buffer.from(emitted[1], "base64");
  assert.equal(bytes.length, 32, "the emitted key must be exactly 32 bytes");
  assert.deepEqual(bytes, key, "and it must be the key that was in the file");

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("the helper installs the staged key and deletes the staging file", () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness();
  const key = crypto.randomBytes(32);
  const staged = path.join(h.dir, "staged.b64");
  fs.writeFileSync(staged, `${key.toString("base64")}\n`, { mode: 0o600 });

  const out = runHelper(h, [nonce, "install", staged]);

  assert.match(out, new RegExp(`BLACKNET-PROOF:${nonce}`));
  assert.ok(fs.existsSync(h.keyPath), "install should create the key file");
  const written = fs.readFileSync(h.keyPath, "utf8");
  assert.deepEqual(decodeKeyFile(written), key, `key file held: ${JSON.stringify(written)}`);
  assert.equal(fs.existsSync(staged), false, "the staged key must not be left behind");

  // A second run without "install" reads back exactly what the first one wrote,
  // which is the round trip that was broken before.
  const again = runHelper(h, [nonce]);
  const emitted = again.match(/BLACKNET-KEY:([A-Za-z0-9+/=]+)/);
  assert.deepEqual(Buffer.from(emitted[1], "base64"), key);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("an existing key is never overwritten by a staged one", () => {
  const original = crypto.randomBytes(32);
  const impostor = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness({ keyFile: `${original.toString("base64")}\n` });
  const staged = path.join(h.dir, "staged.b64");
  fs.writeFileSync(staged, `${impostor.toString("base64")}\n`, { mode: 0o600 });

  const out = runHelper(h, [nonce, "install", staged]);
  const emitted = out.match(/BLACKNET-KEY:([A-Za-z0-9+/=]+)/);
  assert.deepEqual(
    Buffer.from(emitted[1], "base64"),
    original,
    "the vault's own key must win, or every stored password becomes unreadable",
  );
  assert.deepEqual(decodeKeyFile(fs.readFileSync(h.keyPath, "utf8")), original);
  assert.equal(fs.existsSync(staged), false, "the staged key is still cleaned up");

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("the helper refuses when there is no key yet", () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness();
  assert.throws(() => runHelper(h, [nonce]), "reading a missing key file must fail");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("the helper rejects a short key instead of installing it", () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness();
  const staged = path.join(h.dir, "staged.b64");
  fs.writeFileSync(staged, `${crypto.randomBytes(16).toString("base64")}\n`);

  assert.throws(() => runHelper(h, [nonce, "install", staged]));
  assert.equal(fs.existsSync(h.keyPath), false, "a bad key must not reach the key file");

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("the helper needs a 32 character nonce", () => {
  const h = harness();
  assert.throws(() => runHelper(h, ["short"]));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

// --- the result file --------------------------------------------------------
//
// The reason this exists: `x-terminal-emulator -e python3 helper.py` gives the
// helper a pty the emulator owns. Nothing the helper prints reaches the process
// that launched the emulator, so a stdout-only protocol can never work on a real
// box. The helper therefore writes a nonce-bound JSON report to a private file,
// and success *and* failure both go through it - otherwise a rejected password
// would surface as the useless "no usable proof".

test("the helper writes a nonce-bound result file carrying the key", () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness({ keyFile: `${key.toString("base64")}\n` });
  const result = path.join(h.dir, "result.json");

  runHelper(h, [nonce, "--result", result]);

  const parsed = JSON.parse(fs.readFileSync(result, "utf8"));
  assert.equal(parsed.nonce, nonce, "the report must be bound to this request");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.key_id, "sudo");
  assert.deepEqual(Buffer.from(parsed.key_b64, "base64"), key);
  assert.equal(
    fs.statSync(result).mode & 0o777,
    0o600,
    "the report holds the key and must not be readable by other users",
  );

  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("the helper reports a rejected sudo password as itself, not as a missing proof", () => {
  const nonce = crypto.randomBytes(16).toString("hex");
  const h = harness({ sudoFails: true });
  const result = path.join(h.dir, "result.json");

  assert.throws(() => runHelper(h, [nonce, "--result", result]));

  const parsed = JSON.parse(fs.readFileSync(result, "utf8"));
  assert.equal(parsed.ok, false);
  assert.equal(parsed.nonce, nonce);
  assert.match(parsed.error, /sudo rejected the password/);

  fs.rmSync(h.dir, { recursive: true, force: true });
});

// Drives Reauth through its real terminal branch with a stand-in for the
// emulator. The stand-in deliberately returns empty stdout, which is exactly what
// a real terminal emulator does - so a passing test here means the file is the
// working channel rather than a lucky stdout passthrough.
function terminalHarness(report) {
  const seen = { resultPath: null, nonce: null };
  const run = async (_command, args) => {
    const flag = args.indexOf("--result");
    seen.resultPath = args[flag + 1];
    seen.nonce = args[flag - 1];
    const payload = typeof report === "function" ? report(seen.nonce) : report;
    if (payload) fs.writeFileSync(seen.resultPath, `${JSON.stringify(payload)}\n`);
    // No stdout, no stderr: the pty swallowed it.
    return { code: 0, stdout: "", stderr: "" };
  };
  const reauth = new Reauth({
    platform: "linux",
    run,
    which: async (command) => (command === "x-terminal-emulator" ? "/usr/bin/x-terminal-emulator" : null),
    timeoutMs: 5000,
  });
  return { reauth, seen };
}

test("a terminal that swallows stdout still completes the step-up via the result file", async () => {
  const key = crypto.randomBytes(32);
  const { reauth, seen } = terminalHarness((nonce) => ({
    nonce,
    ok: true,
    key_id: "sudo",
    key_b64: key.toString("base64"),
  }));

  const result = await reauth.verify();
  assert.equal(result.ok, true, `expected success, got ${JSON.stringify(result.error)}`);
  assert.equal(result.method, "sudo-terminal");
  assert.equal(result.keyId, "sudo");
  assert.deepEqual(result.key, key);
  assert.equal(fs.existsSync(seen.resultPath), false, "the report must not be left on disk");
});

test("a stale report from an earlier request is rejected", async () => {
  const { reauth } = terminalHarness("00000000000000000000000000000000");
  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /no usable proof/);
});

test("a cancelled terminal reports failure instead of pretending to succeed", async () => {
  // The operator closed the window before typing anything: no report at all.
  const { reauth } = terminalHarness(null);
  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /terminal closed without reporting back/);
});

test("a helper failure surfaces its own message to the operator", async () => {
  const { reauth } = terminalHarness((nonce) => ({
    nonce,
    ok: false,
    error: "sudo rejected the password",
  }));
  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.equal(result.error, "sudo rejected the password");
});

test("a report carrying a truncated key is refused", async () => {
  const { reauth } = terminalHarness((nonce) => ({
    nonce,
    ok: true,
    key_b64: crypto.randomBytes(8).toString("base64"),
  }));
  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /wrong length/);
});