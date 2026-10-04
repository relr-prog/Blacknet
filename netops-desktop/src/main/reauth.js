"use strict";

// Step-up authentication: prove the operator is present before BlackNet will
// hand back a stored password.
//
// What each platform can actually prove matters here, so the design is honest
// about it:
//
//   Windows  Windows Hello (UserConsentVerifier) is a *presence* check. It
//            deliberately returns no secret, so it cannot be turned into a
//            decryption key. It gates the unlock; the key at rest stays wrapped
//            by DPAPI under the user account.
//   Linux    No Hello. We run a small helper inside a real terminal. The
//            operator types the sudo password into the terminal, the helper
//            proves it with `sudo -S -k true`, and root then reads the vault key
//            out of a root-only file. The sudo password never reaches this
//            process - only the key does, and only after the proof succeeded.
//            With no terminal emulator installed we fall back to an in-app
//            prompt, which is worse for the operator but is the only option.
//
// The helper is a plain user-owned script invoked by the terminal: it needs no
// privileged install, and it is the sudo call inside it that actually gates the
// key read. Everything is injectable so the tests can drive Windows, a terminal
// and the inline fallback without a Windows host or a real sudo.

const { execFile, spawn } = require("child_process");
const crypto = require("crypto");

const KEY_PATH = "/var/lib/blacknet/vault.key";
const DEFAULT_TIMEOUT_MS = 60000;

const HELPER_SOURCE = `#!/usr/bin/env python3
"""BlackNet step-up helper.

Verifies a sudo password, then lets root read the vault key. The password is
read with getpass and piped straight into sudo; it is never printed, logged or
returned.

Usage: blacknet-reauth <nonce> [--result <path>] [install <keyfile>]

Without "install" it proves the password and prints the existing key. With it,
it first writes the key file given on the command line, which is how the very
first save creates one without the password ever leaving this terminal. The
key file lives in a 0700 directory and is deleted afterwards.

A terminal emulator owns the pty, so whatever the helper prints here is never
seen by the process that launched the emulator. The proof and the key are
therefore also written to the file given by --result, which the caller reads
once we exit. stdout is kept for the direct-spawn case and for debugging.
"""
import base64
import binascii
import getpass
import json
import os
import subprocess
import sys

KEY_PATH = "${KEY_PATH}"
KEY_BYTES = 32

NONCE = ""
RESULT_PATH = ""


def emit_result(payload):
    """Hand the proof and key back through a file, not the terminal.

    Written to a temp name and renamed so the caller can never read a partial
    write, and created 0600 inside a 0700 directory it already owns. Both the
    success and the failure case are reported, otherwise a rejected password
    would surface as the useless "no usable proof".
    """
    if not RESULT_PATH:
        return
    payload["nonce"] = NONCE
    tmp = RESULT_PATH + ".partial"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            handle.write(json.dumps(payload) + "\\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, RESULT_PATH)
    except OSError:
        # The caller falls back to stdout, so losing the file is not fatal.
        try:
            os.unlink(tmp)
        except OSError:
            pass


def fail(message):
    emit_result({"ok": False, "error": message})
    print(message, file=sys.stderr)
    raise SystemExit(1)


def sudo(args, password=None, stdin=""):
    """Run a command under sudo.

    password=None means "the timestamp is already valid" (-n, never prompt).
    Passing the password sends it once on stdin for -S; every later call in the
    same run uses -n instead, so the password is typed exactly once.
    """
    command = ["sudo", "-S", "-k"] if password is not None else ["sudo", "-n"]
    return subprocess.run(
        command + args,
        input=(password + "\\n" if password is not None else "") + stdin,
        text=True,
        capture_output=True,
    )


def read_key_file(path):
    """Accepts either raw 32 bytes or base64 text, returns raw bytes."""
    with open(path, "rb") as handle:
        blob = handle.read()
    if len(blob) == KEY_BYTES:
        return blob
    try:
        decoded = base64.b64decode(blob.strip(), validate=True)
    except (binascii.Error, ValueError):
        decoded = b""
    if len(decoded) != KEY_BYTES:
        fail("the staged key is not 32 bytes")
    return decoded


def install_key(key, password):
    # The first call carries the password and opens the sudo timestamp; the rest
    # run under it. Chaining the payload onto the password line would be fragile:
    # with no tty, getpass reads the whole piped buffer and swallows it.
    parent = os.path.dirname(KEY_PATH)
    if sudo(["mkdir", "-p", parent], password).returncode != 0:
        fail("could not create " + parent)
    payload = base64.b64encode(key).decode() + "\\n"
    if sudo(["tee", KEY_PATH], None, stdin=payload).returncode != 0:
        fail("could not write the vault key")
    for args in (["chmod", "600", KEY_PATH], ["chown", "root:root", KEY_PATH]):
        if sudo(args).returncode != 0:
            fail("could not secure " + KEY_PATH)


def read_installed_key():
    read = sudo(["cat", KEY_PATH])
    if read.returncode != 0:
        return None
    try:
        key = base64.b64decode(read.stdout.strip(), validate=True)
    except (binascii.Error, ValueError):
        fail("the vault key is unreadable")
    if len(key) != KEY_BYTES:
        fail("the vault key is the wrong length")
    return key


def main():
    global NONCE, RESULT_PATH

    args = sys.argv[1:]
    if not args:
        fail("usage: blacknet-reauth <nonce> [--result <path>] [install <keyfile>]")

    NONCE = args[0]
    if len(NONCE) != 32:
        fail("usage: blacknet-reauth <nonce> [--result <path>] [install <keyfile>]")
    rest = args[1:]

    if rest[:1] == ["--result"]:
        if len(rest) < 2:
            fail("--result needs a path")
        RESULT_PATH = rest[1]
        rest = rest[2:]

    staged = ""
    if len(rest) == 2 and rest[0] == "install":
        staged = rest[1]
    elif rest:
        fail("usage: blacknet-reauth <nonce> [--result <path>] [install <keyfile>]")

    password = getpass.getpass("BlackNet - sudo password: ")
    if sudo(["true"], password).returncode != 0:
        fail("sudo rejected the password")

    try:
        # An existing key always wins. Replacing it would make every password
        # already in the vault permanently unreadable, so a staged key is only
        # ever installed when there is nothing there yet.
        key = read_installed_key()
        if key is None:
            if not staged:
                fail("no vault key yet: save a password once to create it")
            key = read_key_file(staged)
            install_key(key, password)

        # The nonce is echoed so the shell can bind this proof to the request it
        # made, instead of accepting any old proof lying around.
        encoded = base64.b64encode(key).decode()
        emit_result({"ok": True, "key_id": "sudo", "key_b64": encoded})
        print("BLACKNET-PROOF:" + NONCE)
        print("BLACKNET-KEY:" + encoded)
    finally:
        if staged:
            try:
                os.remove(staged)
            except OSError:
                pass


if __name__ == "__main__":
    main()
`;

const TERMINALS = [
  ["gnome-terminal", ["--"]],
  ["konsole", ["-e"]],
  ["xfce4-terminal", ["-e"]],
  ["alacritty", ["-e"]],
  ["kitty", ["-e"]],
  ["x-terminal-emulator", ["-e"]],
  ["xterm", ["-e"]],
];

class Reauth {
  #platform;
  #run;
  #which;
  #timeoutMs;
  #helperPath;
  #verified = null;

  constructor({ platform = process.platform, run, which, timeoutMs = DEFAULT_TIMEOUT_MS, helperPath = null } = {}) {
    this.#platform = platform;
    this.#run = run || defaultRun;
    this.#which = which || defaultWhich;
    this.#timeoutMs = timeoutMs;
    this.#helperPath = helperPath;
  }

  get platform() {
    return this.#platform;
  }

  // True only while a successful check is still fresh; every caller that touches
  // a secret must consult this first.
  get verified() {
    return this.#verified;
  }

  // Writes the key into the private 0700 helper directory so the terminal can
  // install it without the password ever crossing back to us. The helper deletes
  // it when it is done, and #sudoTerminal unlinks it again afterwards.
  stageKeyFile(key) {
    if (!(key instanceof Buffer) || key.length !== 32) {
      throw new Error("vault key must be 32 bytes");
    }
    const file = require("path").join(this.#helperDir(), `key-${crypto.randomBytes(6).toString("hex")}.b64`);
    require("fs").writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600 });
    return file;
  }

  #helperDir() {
    const dir = require("path").join(require("os").tmpdir(), "blacknet-reauth");
    require("fs").mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  // Where the helper leaves the proof and the key. A terminal emulator owns the
  // pty, so this file - not the emulator's stdout - is the only channel that
  // survives a real `x-terminal-emulator -e ...` launch.
  resultPath() {
    return require("path").join(this.#helperDir(), `result-${crypto.randomBytes(6).toString("hex")}.json`);
  }

  // Reads the helper's report, if it wrote one. Returns null when there is no
  // file so the caller can fall back to parsing stdout.
  async #readResult(path, nonce) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      let raw = null;
      try {
        raw = require("fs").readFileSync(path, "utf8");
      } catch {
        /* not written yet */
      }

      if (raw) {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { ok: false, error: "the helper wrote an unreadable result" };
        }
        // The nonce binds this report to the request we just made, so a stale
        // file from an earlier run can never be mistaken for a fresh proof.
        if (!parsed || parsed.nonce !== nonce) {
          return { ok: false, error: "the helper returned no usable proof" };
        }
        if (!parsed.ok) {
          return { ok: false, error: String(parsed.error || "the terminal helper failed") };
        }
        const bytes = Buffer.from(String(parsed.key_b64 || ""), "base64");
        if (bytes.length !== 32) return { ok: false, error: "the vault key is the wrong length" };
        return { ok: true, keyId: String(parsed.key_id || "sudo"), key: bytes };
      }

      // The terminal exited before we were called, so the helper's atomic
      // rename has almost certainly landed; poll briefly rather than block.
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return null;
  }

  method() {
    if (this.#platform === "win32") return "windows-hello";
    if (this.#platform === "darwin") return "touch-id";
    return "sudo-terminal";
  }

  // The helper is written on demand into userData, mode 0700. Not installed
  // system-wide: it needs no privileges of its own.
  helperScript() {
    if (this.#helperPath) return this.#helperPath;
    const file = require("path").join(this.#helperDir(), `reauth-${crypto.randomBytes(6).toString("hex")}.py`);
    require("fs").writeFileSync(file, HELPER_SOURCE, { mode: 0o700 });
    this.#helperPath = file;
    return file;
  }

  async terminal() {
    for (const [command, argv] of TERMINALS) {
      const found = await this.#which(command);
      if (found) return { command: found, argv };
    }
    return { command: null, argv: [] };
  }

  async available() {
    if (this.#platform === "win32" || this.#platform === "darwin") {
      return { available: true, method: this.method(), terminal: null, inline: false };
    }
    const terminal = await this.terminal();
    return {
      available: true,
      method: "sudo-terminal",
      terminal: terminal.command || null,
      inline: !terminal.command,
    };
  }

  #deadline() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    return { signal: controller.signal, release: () => clearTimeout(timer) };
  }

  // Never throws: a failed check is a normal outcome the UI renders.
  //
  // The sudo paths hand back key material, and it is kept on #verified rather
  // than thrown away: the key provider reads it from here for as long as the
  // verification is fresh. It is wiped by reset() and by the expiry check in
  // requireVerified(), so it cannot outlive the unlock it belongs to.
  async verify({ method, password, stageKey = null } = {}) {
    const chosen = method || this.method();
    let result;
    if (chosen === "windows-hello") result = await this.#hello();
    else if (chosen === "touch-id") result = await this.#touchId();
    else if (chosen === "sudo-terminal") result = await this.#sudoTerminal({ password, stageKey });
    else result = { ok: false, error: `unknown re-auth method: ${chosen}` };

    this.#verified = result.ok
      ? {
          method: chosen,
          keyId: result.keyId || null,
          key: result.key || null,
          at: Date.now(),
          expiresAt: Date.now() + 120000,
        }
      : null;
    return { ...result, method: chosen };
  }

  requireVerified() {
    if (!this.#verified) throw new Error("re-authenticate first");
    if (this.#verified.expiresAt < Date.now()) {
      this.#verified = null;
      throw new Error("the unlock expired, authenticate again");
    }
    return this.#verified;
  }

  reset() {
    // Wipe the key bytes before dropping the reference. The Buffer is not shared
    // anywhere else, so zeroing it here means a stale copy cannot be recovered
    // from a heap snapshot after the vault has been locked.
    if (this.#verified && this.#verified.key) this.#verified.key.fill(0);
    this.#verified = null;
  }

  async #hello() {
    if (this.#platform !== "win32") {
      return { ok: false, error: "Windows Hello is only available on Windows" };
    }
    const script = [
      "[void][Windows.Security.Credentials.UI.UserConsentVerifier,Windows.Security.Credentials.UI,ContentType=WindowsRuntime]",
      "$r=[Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('BlackNet','Unlock your saved passwords')",
      "$a=[System.WindowsRuntimeSystemExtensions]::AsTask($r)",
      "if($a.Result -eq 0){'BLACKNET-HELLO:ok'}else{'BLACKNET-HELLO:denied';exit 1}",
    ].join("; ");
    return this.#exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], (out, code, err) =>
      /BLACKNET-HELLO:ok/.test(out)
        ? { ok: true, keyId: "dpapi" }
        : { ok: false, error: err.trim() || "Windows Hello was cancelled" },
    );
  }

  async #touchId() {
    return this.#exec(
      "/usr/bin/osascript",
      ["-e", 'do shell script "exit 0" with administrator privileges'],
      (out, code, err) =>
        code === 0 ? { ok: true, keyId: "keychain" } : { ok: false, error: err.trim() || "cancelled" },
    );
  }

  // Terminal when one exists, inline sudo when it does not. Both paths end with
  // the same root key read, so the shell only ever sees key material.
  //
  // `stageKey` is set on the very first save: the terminal has the password, not
  // us, so the helper is the only thing that can create the root-owned file.
  async #sudoTerminal({ password, stageKey = null } = {}) {
    if (typeof password === "string" && password.length > 0) return this.#sudoInline(password, { stageKey });
    if (this.#platform === "win32") {
      return { ok: false, error: "sudo step-up is not available on Windows" };
    }

    const terminal = await this.terminal();
    if (!terminal.command) {
      return {
        ok: false,
        inline: true,
        error: "no terminal emulator was found - confirm with the in-app prompt",
      };
    }

    const nonce = crypto.randomBytes(16).toString("hex");
    const helper = this.helperScript();
    const staged = stageKey ? this.stageKeyFile(stageKey) : null;
    const resultPath = this.resultPath();
    const argv = [
      ...terminal.argv,
      "python3",
      helper,
      nonce,
      "--result",
      resultPath,
      ...(staged ? ["install", staged] : []),
    ];

    // The judge is deliberately null here: with a real terminal emulator the
    // stdout belongs to the pty, so it says nothing about the outcome. stdout
    // parsing is kept only as a fallback for emulators that do pass it through.
    const stdout = await this.#exec(terminal.command, argv, null);
    const reported = await this.#readResult(resultPath, nonce);

    for (const file of [staged, resultPath]) {
      if (!file) continue;
      // The helper cleans up after itself, but a cancelled terminal may not have
      // run far enough to get there, and the result file is ours to remove.
      try {
        require("fs").unlinkSync(file);
      } catch {
        /* already gone */
      }
    }

    if (reported) return reported;

    // No report. If the terminal itself failed to start or died loudly, say why
    // rather than blaming the missing report - a missing binary is not the
    // operator's fault and telling them to use the in-app prompt would be wrong.
    if (stdout.ok === false) {
      return { ok: false, error: String(stdout.error || "").trim() || "the terminal helper did not complete" };
    }

    // It ran and exited cleanly but never wrote a report: the operator closed
    // the window before typing anything.
    return {
      ok: false,
      error: "the terminal closed without reporting back - try the in-app prompt",
    };
  }

  // No terminal: the UI collects the password in a native dialog and we verify it
  // with sudo directly. In-memory only, never persisted, never logged.
  async #sudoInline(password, { stageKey = null } = {}) {
    const verified = await this.#exec("sudo", ["-S", "-k", "true"], null, { input: `${password}\n` });
    if (verified.code !== 0) {
      return {
        ok: false,
        error: verified.stderr.trim().split("\n").pop() || "sudo rejected the password",
      };
    }

    // sudo is authenticated for this timestamp, so the rest of the calls below
    // do not re-prompt. That is why the password is still nowhere near them.
    if (stageKey) await this.installKey(stageKey, { authenticated: true });

    const read = await this.#exec("sudo", ["-n", "cat", KEY_PATH], null);
    if (read.code !== 0) {
      return { ok: false, error: "no vault key yet: save a password once to create it" };
    }
    const key = decodeKeyFile(read.stdout);
    if (!key) return { ok: false, error: "the vault key is the wrong length" };
    return { ok: true, keyId: "sudo", sudoVerified: true, key };
  }

  // First save has to create the root-owned key file. Called only after verify()
  // succeeded, so the operator has just proven they hold the sudo password.
  //
  // `authenticated: true` means the caller already opened a sudo timestamp, so
  // every step runs with -n and the password is never sent again. Otherwise the
  // first step authenticates with -S -k (forcing a fresh check) and the rest ride
  // the timestamp. Exactly one password transmission either way: the payload is
  // written on its own stdin rather than chained behind the password line, which
  // is fragile because getpass can swallow a whole piped buffer.
  async installKey(key, { password, authenticated = false } = {}) {
    if (!(key instanceof Buffer) || key.length !== 32) {
      throw new Error("vault key must be 32 bytes");
    }
    const dir = KEY_PATH.slice(0, KEY_PATH.lastIndexOf("/"));
    const payload = `${key.toString("base64")}\n`;

    if (!authenticated) {
      const mkdir = await this.#exec("sudo", ["-S", "-k", "mkdir", "-p", dir], null, { input: `${password || ""}\n` });
      if (mkdir.code !== 0) {
        throw new Error(String(mkdir.stderr || "").trim() || `failed to install the vault key (${mkdir.code})`);
      }
    } else {
      const exists = await this.#exec("sudo", ["-n", "mkdir", "-p", dir], null);
      if (exists.code !== 0) {
        throw new Error(String(exists.stderr || "").trim() || `failed to install the vault key (${exists.code})`);
      }
    }

    const steps = [
      ["sudo", ["-n", "tee", KEY_PATH], payload],
      ["sudo", ["-n", "chmod", "600", KEY_PATH], ""],
      ["sudo", ["-n", "chown", "root:root", KEY_PATH], ""],
    ];
    for (const [command, args, input] of steps) {
      const { code, stderr } = await this.#exec(command, args, null, { input });
      if (code !== 0) {
        throw new Error(String(stderr || "").trim() || `failed to install the vault key (${code})`);
      }
    }
    return { ok: true, path: KEY_PATH };
  }

  async #exec(command, args, judge, { input = "" } = {}) {
    const { signal, release } = this.#deadline();
    try {
      const result = await this.#run(command, args, {
        input,
        signal,
        timeoutMs: this.#timeoutMs,
      });
      const code = result.code;
      const stdout = String(result.stdout || "");
      const stderr = String(result.stderr || "");
      if (judge) {
        return { ...judge(stdout, code, stderr), code, stdout, stderr };
      }
      if (code === 0) return { ok: true, code: 0, stdout, stderr };
      return {
        ok: false,
        code,
        stderr,
        error: stderr.trim().split("\n").pop() || `exit ${code}`,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    } finally {
      release();
    }
  }
}

function defaultRun(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    if (options.signal) {
      options.signal.addEventListener("abort", () => child.kill("SIGKILL"));
    }
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.write(options.input || "");
    child.stdin.end();
  });
}

function defaultWhich(command) {
  return new Promise((resolve) => {
    execFile("which", [command], (error, stdout) => {
      const first = String(stdout || "").trim().split("\n")[0];
      resolve(error ? null : first || null);
    });
  });
}

// The key file holds base64 text. Accept raw bytes too, so a hand-placed key
// still works, but never re-encode: double-encoding turns 32 bytes into 44 and
// the vault then fails to open with a misleading "wrong length".
function decodeKeyFile(stdout) {
  const blob = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout || "").trim());
  if (blob.length === 32) return blob;
  const decoded = Buffer.from(blob.toString("utf8").trim(), "base64");
  return decoded.length === 32 ? decoded : null;
}

module.exports = { Reauth, HELPER_SOURCE, KEY_PATH, TERMINALS, decodeKeyFile };