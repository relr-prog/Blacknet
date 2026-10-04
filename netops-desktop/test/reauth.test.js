// Step-up authentication. Both platforms are driven through injected
// executables so the tests never touch a real sudo, terminal or Windows Hello.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Reauth, HELPER_SOURCE, KEY_PATH } = require("../src/main/reauth");

// Records every call so a test can assert on the command line that was used.
function recorder(handler) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return handler ? handler(command, args, options) : { code: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

const KEY = Buffer.alloc(32, 7);
const HELPER_RE = /reauth-[0-9a-f]{12}\.py$/;

test("method follows the platform", () => {
  assert.equal(new Reauth({ platform: "win32" }).method(), "windows-hello");
  assert.equal(new Reauth({ platform: "darwin" }).method(), "touch-id");
  assert.equal(new Reauth({ platform: "linux" }).method(), "sudo-terminal");
});

test("Windows Hello success returns the DPAPI key id", async () => {
  const { calls, run } = recorder(() => ({ code: 0, stdout: "BLACKNET-HELLO:ok", stderr: "" }));
  const reauth = new Reauth({ platform: "win32", run });

  const result = await reauth.verify();
  assert.equal(result.ok, true);
  assert.equal(result.method, "windows-hello");
  assert.equal(result.keyId, "dpapi");
  assert.equal(calls[0].command, "powershell.exe");
  assert.match(calls[0].args.join(" "), /UserConsentVerifier/);
});

test("a cancelled Windows Hello check fails without throwing", async () => {
  const { run } = recorder(() => ({ code: 1, stdout: "", stderr: "cancelled by user" }));
  const reauth = new Reauth({ platform: "win32", run });

  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled by user/);
  assert.equal(reauth.verified, null);
});

test("asking for Hello on Linux is refused", async () => {
  const { run } = recorder();
  const reauth = new Reauth({ platform: "linux", run });
  const result = await reauth.verify({ method: "windows-hello" });
  assert.equal(result.ok, false);
  assert.match(result.error, /only available on Windows/);
});

test("a successful check is remembered and expires", async () => {
  const { run } = recorder(() => ({ code: 0, stdout: "BLACKNET-HELLO:ok" }));
  const reauth = new Reauth({ platform: "win32", run });

  assert.throws(() => reauth.requireVerified(), /re-authenticate first/);
  await reauth.verify();
  assert.equal(reauth.requireVerified().method, "windows-hello");

  reauth.reset();
  assert.throws(() => reauth.requireVerified(), /re-authenticate first/);
});

// A terminal emulator owns the pty, so the helper reports through a nonce-bound
// result file rather than stdout. These stand-ins write that file and return empty
// stdout, which is what a real emulator does.
function resultWriter(command, args, report) {
  const flag = args.indexOf("--result");
  if (flag === -1) return null;
  const nonce = args[flag - 1];
  fs.writeFileSync(args[flag + 1], `${JSON.stringify(report(nonce))}\n`);
  return args[flag + 1];
}

test("sudo step-up opens a real terminal with the helper and a nonce", async () => {
  const written = [];
  const { calls, run } = recorder((command, args) => {
    if (command.endsWith("gnome-terminal")) {
      written.push(resultWriter(command, args, (nonce) => ({
        nonce,
        ok: true,
        key_id: "sudo",
        key_b64: KEY.toString("base64"),
      })));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "/usr/bin/gnome-terminal\n" };
  });
  const which = async (name) => (name === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null);

  const reauth = new Reauth({ platform: "linux", run, which });
  const result = await reauth.verify();

  assert.equal(result.ok, true);
  assert.equal(result.keyId, "sudo");
  assert.deepEqual(result.key, KEY);

  const terminalCall = calls.find((call) => call.command.endsWith("gnome-terminal"));
  assert.ok(terminalCall, "the terminal must be launched");
  const flag = terminalCall.args.indexOf("--result");
  assert.notEqual(flag, -1, "the helper must be told where to report back");
  const helper = terminalCall.args[flag - 2];
  assert.match(helper, HELPER_RE, "a uniquely named helper file is passed to the terminal");
  const script = fs.readFileSync(helper, "utf8");
  assert.equal(script, HELPER_SOURCE);
  assert.match(script, /"sudo", "-S", "-k"/, "sudo must be forced to re-prompt");
  assert.match(script, /getpass/, "the password must be prompted, not echoed");
  assert.equal(
    fs.existsSync(written[0]),
    false,
    "the report holds the key and must not be left on disk",
  );
});

test("a proof for a different nonce is rejected", async () => {
  const { run } = recorder((command, args) => {
    if (command.endsWith("xterm")) {
      // A stale report from an earlier request, with its own old nonce.
      resultWriter(command, args, () => ({
        nonce: "deadbeef",
        ok: true,
        key_b64: KEY.toString("base64"),
      }));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "/usr/bin/xterm" };
  });
  const which = async (name) => (name === "xterm" ? "/usr/bin/xterm" : null);
  const reauth = new Reauth({ platform: "linux", run, which });

  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /no usable proof/);
});

test("a proof without a 32-byte key is rejected", async () => {
  const { run } = recorder((command, args) => {
    if (command.endsWith("xterm")) {
      resultWriter(command, args, (nonce) => ({
        nonce,
        ok: true,
        key_b64: Buffer.alloc(4).toString("base64"),
      }));
      return { code: 0, stdout: "", stderr: "" };
    }
    return { code: 0, stdout: "/usr/bin/xterm" };
  });
  const which = async (name) => (name === "xterm" ? "/usr/bin/xterm" : null);
  const reauth = new Reauth({ platform: "linux", run, which });

  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /wrong length/);
});

test("no terminal emulator falls back to the in-app prompt", async () => {
  const { run } = recorder();
  const which = async () => null;
  const reauth = new Reauth({ platform: "linux", run, which });

  const availability = await reauth.available();
  assert.equal(availability.inline, true);
  assert.equal(availability.terminal, null);

  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.equal(result.inline, true);
  assert.match(result.error, /no terminal emulator/);
});

test("the inline path verifies once with sudo -S -k and then reads the key with -n", async () => {
  const key = Buffer.alloc(32, 7);
  const { calls, run } = recorder((command, args) => {
    if (args.includes("cat")) return { code: 0, stdout: `${key.toString("base64")}\n`, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });

  const result = await reauth.verify({ password: "hunter2" });

  assert.equal(result.ok, true);
  assert.equal(result.sudoVerified, true);
  assert.deepEqual(result.key, key, "the inline path has to hand back a usable key");
  assert.deepEqual(calls[0].args, ["-S", "-k", "true"]);
  assert.equal(calls[0].input, "hunter2\n");

  // The password is typed once. Reading the key rides the sudo timestamp, so it
  // must not carry the password again.
  assert.deepEqual(calls[1].args, ["-n", "cat", KEY_PATH]);
  assert.equal(calls[1].input, "");
  assert.equal(calls.filter((call) => call.input.includes("hunter2")).length, 1);
});

test("the inline path reports a missing key file instead of pretending to work", async () => {
  const { run } = recorder((command, args) => {
    if (args.includes("cat")) return { code: 1, stdout: "", stderr: "sudo: cat: no such file" };
    return { code: 0, stdout: "", stderr: "" };
  });
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });

  const result = await reauth.verify({ password: "hunter2" });
  assert.equal(result.ok, false);
  assert.match(result.error, /no vault key yet/);
});

test("a wrong sudo password reports the failure", async () => {
  const { run } = recorder(() => ({ code: 1, stdout: "", stderr: "Sorry, try again.\nsudo: 1 incorrect password attempt" }));
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });

  const result = await reauth.verify({ password: "wrong" });
  assert.equal(result.ok, false);
  assert.match(result.error, /incorrect password attempt/);
});

test("sudo step-up is refused on Windows", async () => {
  const { run } = recorder();
  const reauth = new Reauth({ platform: "win32", run });
  const result = await reauth.verify({ method: "sudo-terminal" });
  assert.equal(result.ok, false);
  assert.match(result.error, /not available on Windows/);
});

test("an unknown method fails cleanly", async () => {
  const { run } = recorder();
  const reauth = new Reauth({ platform: "linux", run });
  const result = await reauth.verify({ method: "iris-scan" });
  assert.equal(result.ok, false);
  assert.match(result.error, /unknown re-auth method/);
});

test("a helper that does not run is reported, not thrown", async () => {
  const run = async () => {
    throw new Error("spawn gnome-terminal ENOENT");
  };
  const reauth = new Reauth({ platform: "linux", run, which: async () => "/usr/bin/gnome-terminal" });
  const result = await reauth.verify();
  assert.equal(result.ok, false);
  assert.match(result.error, /ENOENT/);
});

test("the helper is written 0700 and never reuses a previous file name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-helper-"));
  const one = new Reauth({ platform: "linux", which: async () => null, helperPath: null });
  const first = one.helperScript();
  const second = one.helperScript();
  assert.equal(first, second, "the same instance reuses its helper");
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
  const other = new Reauth({ platform: "linux", which: async () => null });
  assert.notEqual(other.helperScript(), first, "a fresh instance gets a fresh file");
});

test("installKey pipes the key through sudo tee, never a world-readable path", async () => {
  const { calls, run } = recorder(() => ({ code: 0, stdout: "", stderr: "" }));
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });

  const result = await reauth.installKey(KEY, { password: "pw" });
  assert.equal(result.ok, true);

  const flat = calls.map((call) => `${call.command} ${call.args.join(" ")}`);
  assert.ok(flat.some((line) => line.includes(`tee ${KEY_PATH}`)));
  assert.ok(flat.some((line) => line.includes(`chmod 600 ${KEY_PATH}`)));
  assert.ok(flat.some((line) => line.includes("chown root:root")));
  assert.ok(
    calls.every((call) => call.command === "sudo"),
    "no unprivileged step may carry the key",
  );

  const tee = calls.find((call) => call.args.includes("tee"));
  // The payload rides its own stdin, never chained behind the password line: a
  // single write with the password first would be one string that any reader of
  // the tee input sees, and it is needless since the timestamp is already open.
  assert.equal(tee.input, `${KEY.toString("base64")}\n`);
  assert.doesNotMatch(tee.input, /pw/);

  const withPassword = calls.filter((call) => call.input.includes("pw"));
  assert.equal(withPassword.length, 1, "the password must be transmitted exactly once");
  assert.deepEqual(withPassword[0].args, ["-S", "-k", "mkdir", "-p", KEY_PATH.slice(0, KEY_PATH.lastIndexOf("/"))]);
});

test("installKey rejects a key of the wrong size before touching sudo", async () => {
  const { run } = recorder();
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });
  await assert.rejects(() => reauth.installKey(Buffer.alloc(16)), /must be 32 bytes/);
});

test("a failed installKey step throws with the reason", async () => {
  let step = 0;
  const { run } = recorder(() => {
    step += 1;
    return step === 2 ? { code: 1, stdout: "", stderr: "sudo: a terminal is required" } : { code: 0 };
  });
  const reauth = new Reauth({ platform: "linux", run, which: async () => null });
  await assert.rejects(() => reauth.installKey(KEY), /a terminal is required/);
});

test("the helper never prints the password and stays quiet about it", () => {
  assert.doesNotMatch(HELPER_SOURCE, /print\(.*password/);
  assert.doesNotMatch(HELPER_SOURCE, /echo.*password/);
  assert.match(HELPER_SOURCE, /getpass\.getpass/);
});