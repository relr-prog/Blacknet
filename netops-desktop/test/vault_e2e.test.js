// End-to-end for the Linux vault path, with the real Reauth, PasswordManager and
// Vault wired together.
//
// Every other password test stubs reauth out, which is why a whole class of
// breakage survived: the key was dropped between verify() and the key provider,
// the key file was never created, and a save could never complete. Here the only
// fake is the `sudo` binary itself, emulated in JS, so the key genuinely gets
// generated, installed, read back and used to open the vault.
//
// What this cannot prove: that a real sudo accepts a real password, and that
// /var/lib/blacknet is writable. That needs a desktop session.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { Reauth, KEY_PATH, decodeKeyFile } = require("../src/main/reauth");
const { PasswordManager } = require("../src/main/credentials");

const ENTRY = { origin: "https://example.com/login", username: "rel4ever", password: "hunter2" };

// Stands in for sudo. Keyed on the argv shape the code actually uses:
//   sudo -S -k true / mkdir -p DIR   -> authenticates, password on stdin
//   sudo -n tee PATH                  -> writes stdin to PATH
//   sudo -n chmod / chown / cat PATH  -> acts on PATH
function sudoEmulator({ keyPath }) {
  const calls = [];
  const run = async (command, args, options = {}) => {
    const input = options.input || "";
    calls.push({ command, args, input });

    if (command !== "sudo") {
      return { code: 127, stdout: "", stderr: `${command}: not found` };
    }

    const rest = args
      .filter((arg) => !["-S", "-k", "-n"].includes(arg))
      // Never touch the real /var/lib/blacknet: repoint every path at the temp file.
      .map((arg) => arg.split(KEY_PATH).join(keyPath));
    const [subcommand, ...restArgs] = rest;

    // -S means sudo reads the password off stdin and caches the timestamp.
    if (args.includes("-S")) {
      if (!input.startsWith("secret-sudo\n")) {
        return { code: 1, stdout: "", stderr: "Sorry, try again.\nsudo: 1 incorrect password attempt" };
      }
    }

    if (subcommand === "true") return { code: 0, stdout: "", stderr: "" };
    if (subcommand === "mkdir") return { code: 0, stdout: "", stderr: "" };
    if (subcommand === "chmod" || subcommand === "chown") return { code: 0, stdout: "", stderr: "" };

    if (subcommand === "tee") {
      fs.writeFileSync(restArgs[0], input, { mode: 0o600 });
      return { code: 0, stdout: input, stderr: "" };
    }
    if (subcommand === "cat") {
      const target = restArgs[0];
      if (!fs.existsSync(target)) return { code: 1, stdout: "", stderr: `cat: ${target}: No such file` };
      return { code: 0, stdout: fs.readFileSync(target, "utf8"), stderr: "" };
    }

    return { code: 1, stdout: "", stderr: `unsupported: ${rest.join(" ")}` };
  };
  return { run, calls };
}

function harness({ password = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "blacknet-e2e-"));
  const keyPath = path.join(root, "vault.key");
  const { run, calls } = sudoEmulator({ keyPath });

  const reauth = new Reauth({
    platform: "linux",
    run,
    // No terminal emulator, so this exercises the inline sudo path.
    which: async () => null,
  });

  const manager = new PasswordManager({
    vault: { dir: path.join(root, "vault") },
    account: { current: { authenticated: true, guest: false, isAdmin: true, username: "rel4ever" } },
    reauth,
    keyProvider: null,
  });

  return { manager, reauth, calls, keyPath, root, password };
}

test("save creates the key file, then lock and reveal round-trips the password", async () => {
  const { manager, keyPath, root } = harness();

  // No terminal emulator here, so the first save goes through the inline sudo
  // fallback: the renderer collects the password and passes it as sudoPassword.
  const saved = await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });

  assert.match(saved.id, /^[0-9a-f]{32}$/);
  assert.ok(fs.existsSync(keyPath), "the first save must create the OS-protected key file");
  assert.equal(manager.status().locked, false);

  manager.lock();
  assert.equal(manager.status().locked, true, "locking drops the key from memory");

  // A fresh process-equivalent: same manager, but nothing unlocked. This is the
  // step that used to throw "the vault key is only available right after
  // authentication" because verify() discarded the key it had just read.
  const revealed = await manager.reveal(saved.id, { password: "secret-sudo" });
  assert.equal(revealed.password, "hunter2");
  assert.equal(revealed.origin, ENTRY.origin);
  assert.equal(revealed.verifiedWith, "sudo-terminal");

  fs.rmSync(root, { recursive: true, force: true });
});

test("the key file is created once and reused, never rewritten", async () => {
  const { manager, keyPath, calls, root } = harness();

  await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });
  const first = fs.readFileSync(keyPath, "utf8");
  const teesAfterFirst = calls.filter((call) => call.args.includes("tee")).length;

  await manager.save({ ...ENTRY, password: "rotated" });
  const second = fs.readFileSync(keyPath, "utf8");

  assert.equal(first, second, "an existing key must survive later saves");
  assert.equal(
    teesAfterFirst,
    calls.filter((call) => call.args.includes("tee")).length,
    "the key file is only written when there is nothing there",
  );
  assert.equal((await manager.reveal(manager.list()[0].id)).password, "rotated");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a wrong sudo password cannot open the vault", async () => {
  const { manager, root } = harness();

  await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });
  manager.lock();

  await assert.rejects(
    () => manager.reveal(manager.list()[0].id, { password: "wrong" }),
    /incorrect password attempt/,
  );
  assert.equal(manager.status().locked, true);

  fs.rmSync(root, { recursive: true, force: true });
});

test("the sudo password is transmitted exactly once per install", async () => {
  const { manager, calls, root } = harness();

  await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });

  const withPassword = calls.filter((call) => call.input.includes("secret-sudo"));
  assert.equal(withPassword.length, 1, `expected one authenticated call, saw ${withPassword.length}`);
  assert.deepEqual(
    withPassword[0].args,
    ["-S", "-k", "true"],
    "the password should be spent on the verification itself",
  );

  // Installing the key rides the timestamp the verification just opened.
  const installs = calls.filter((call) => call.args.includes("tee") || call.args.includes("mkdir"));
  assert.ok(installs.length >= 2, "the key should still be created");
  for (const call of installs) {
    assert.ok(call.args.includes("-n"), `install step should be non-interactive: ${call.args.join(" ")}`);
  }
  // No later call may repeat the password: the tee carries the payload alone.
  for (const call of calls.filter((entry) => entry.args.includes("tee"))) {
    assert.doesNotMatch(call.input, /secret-sudo/, "the key payload must not be chained to the password");
    assert.equal(
      decodeKeyFile(call.input)?.length,
      32,
      "the tee payload should be exactly the 32 byte key",
    );
  }

  fs.rmSync(root, { recursive: true, force: true });
});

test("the whole thing survives a simulated restart: same key, same records", async () => {
  const { manager, keyPath, root } = harness();

  const saved = await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });
  const installedKey = fs.readFileSync(keyPath, "utf8");

  // A brand new manager and reauth, sharing only the on-disk key file. This is
  // what actually happens when the app is closed and reopened.
  const { run } = sudoEmulator({ keyPath });
  const restarted = new PasswordManager({
    vault: { dir: path.join(root, "vault") },
    account: { current: { authenticated: true, guest: false, isAdmin: true, username: "rel4ever" } },
    reauth: new Reauth({ platform: "linux", run, which: async () => null }),
    keyProvider: null,
  });

  assert.equal(restarted.status().locked, true);
  const revealed = await restarted.reveal(saved.id, { password: "secret-sudo" });
  assert.equal(revealed.password, "hunter2");
  assert.equal(fs.readFileSync(keyPath, "utf8"), installedKey, "the key on disk is unchanged");

  fs.rmSync(root, { recursive: true, force: true });
});

test("a guest still cannot touch the vault even with a working key path", async () => {
  const { manager, root } = harness();
  await manager.save({ ...ENTRY, sudoPassword: "secret-sudo" });
  const listed = manager.list();
  assert.equal(listed.length, 1);

  // Same vault, but the session has become a guest. The records are still on disk
  // and the key is still readable by this user - only the session changed.
  const { run } = sudoEmulator({ keyPath: path.join(root, "vault.key") });
  const asGuest = new PasswordManager({
    vault: { dir: path.join(root, "vault") },
    account: { current: { authenticated: true, guest: true, isAdmin: false } },
    reauth: new Reauth({ platform: "linux", run, which: async () => null }),
    keyProvider: null,
  });

  assert.throws(() => asGuest.list(), /Please log in to unlock this feature.*guest/);
  await assert.rejects(() => asGuest.reveal(listed[0].id), /Please log in to unlock this feature.*guest/);
  await assert.rejects(
    () => asGuest.save({ ...ENTRY, sudoPassword: "secret-sudo" }),
    /Please log in to unlock this feature.*guest/,
  );

  fs.rmSync(root, { recursive: true, force: true });
});