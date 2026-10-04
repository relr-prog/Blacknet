// Password capture: a hostile page's report must be harmless.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const { PasswordWatcher, validOrigin, isPrivateHost } = require("../src/main/passwordWatcher");

function harness({ authenticated = true, guest = false, enabled = true } = {}) {
  const offers = [];
  const sent = [];
  const manager = {
    offer(entry) {
      offers.push(entry);
      return `offer-${offers.length}`;
    },
  };
  const watcher = new PasswordWatcher({
    manager,
    settings: { get: (key) => (key === "offerToSavePasswords" ? enabled : undefined) },
    account: { current: { authenticated, guest } },
    send: (channel, payload) => sent.push({ channel, payload }),
  });
  const tabs = [{ id: 7, url: "https://example.com/login" }];
  return { watcher, offers, sent, tabs };
}

const report = { origin: "https://example.com", url: "https://example.com/login", username: "rel", password: "hunter2" };

test("a genuine report raises one offer and notifies the chrome", async () => {
  const { watcher, offers, sent } = harness();
  const result = await watcher.handle(report, [{ id: 7, url: "https://example.com/login" }]);

  assert.equal(result.accepted, true);
  assert.equal(offers.length, 1);
  assert.equal(offers[0].password, "hunter2");

  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netops:password-offer");
  assert.equal(sent[0].payload.question, "Do you wanna to save this password?");
  assert.deepEqual(sent[0].payload.actions, ["save", "not-now"]);
  assert.equal(sent[0].payload.tabId, 7);
  assert.equal("password" in sent[0].payload, false, "the prompt must not carry the secret");
});

test("a page cannot claim to be a site the user is not looking at", async () => {
  const { watcher, offers } = harness();
  const result = await watcher.handle({ ...report, origin: "https://bank.example" }, [
    { id: 7, url: "https://example.com/login" },
  ]);

  assert.equal(result.accepted, false);
  assert.match(result.reason, /does not match any tab/);
  assert.equal(offers.length, 0);
});

test("local and private addresses are never captured", async () => {
  const { watcher } = harness();
  for (const host of [
    "http://localhost:8080",
    "http://127.0.0.1",
    "http://192.168.1.1",
    "http://10.0.0.1",
    "http://172.16.0.1",
    "http://172.31.255.1",
    "http://169.254.1.1",
    "http://router.local",
    "http://box.internal",
    "http://[::1]:3000",
    "http://[fd00::1]",
    "http://[fe80::1]",
  ]) {
    assert.equal(validOrigin(host), false, `accepted ${host}`);
    const result = await watcher.handle({ ...report, origin: host }, [{ id: 1, url: host }]);
    assert.equal(result.accepted, false, `offered for ${host}`);
  }
});

test("just outside the private ranges is still capturable", () => {
  // 172.15/172.32 are public, so refusing them would be a false negative in the
  // other direction: a real site must not be blocked.
  assert.equal(isPrivateHost("172.15.0.1"), false);
  assert.equal(isPrivateHost("172.32.0.1"), false);
  assert.equal(isPrivateHost("192.169.1.1"), false);
  assert.equal(isPrivateHost("11.0.0.1"), false);
  assert.equal(isPrivateHost("example.com"), false);
  assert.equal(isPrivateHost("notlocalhost.example"), false);
});

test("only http and https are considered", () => {
  assert.equal(validOrigin("http://example.com"), true);
  assert.equal(validOrigin("https://example.com"), true);
  assert.equal(validOrigin("file:///etc/passwd"), false);
  assert.equal(validOrigin("javascript:alert(1)"), false);
  assert.equal(validOrigin("data:text/html,x"), false);
  assert.equal(validOrigin("chrome://settings"), false);
  assert.equal(validOrigin("not a url"), false);
  assert.equal(validOrigin(""), false);
});

test("a guest session captures nothing", async () => {
  const { watcher, offers } = harness({ guest: true });
  const result = await watcher.handle(report, [{ id: 7, url: "https://example.com/login" }]);
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "disabled");
  assert.equal(offers.length, 0);
});

test("a signed-out session captures nothing", async () => {
  const { watcher } = harness({ authenticated: false });
  const result = await watcher.handle(report, [{ id: 7, url: "https://example.com/login" }]);
  assert.equal(result.reason, "disabled");
});

test("turning the feature off in settings captures nothing", async () => {
  const { watcher, offers } = harness({ enabled: false });
  const result = await watcher.handle(report, [{ id: 7, url: "https://example.com/login" }]);
  assert.equal(result.reason, "disabled");
  assert.equal(offers.length, 0);
});

test("the same site and user is offered only once until it is forgotten", async () => {
  const { watcher, offers } = harness();
  const tabs = [{ id: 7, url: "https://example.com/login" }];

  assert.equal((await watcher.handle(report, tabs)).accepted, true);
  const second = await watcher.handle(report, tabs);
  assert.equal(second.accepted, false);
  assert.match(second.reason, /already offered/);
  assert.equal(offers.length, 1);

  watcher.forget("https://example.com", "rel");
  assert.equal((await watcher.handle(report, tabs)).accepted, true);
  assert.equal(offers.length, 2);
});

test("a loop of submissions cannot flood the queue", async () => {
  const { watcher } = harness();
  const tabs = [{ id: 7, url: "https://example.com/login" }];
  let accepted = 0;
  for (let index = 0; index < 30; index += 1) {
    // A distinct username each time, so dedupe cannot be what stops it.
    const result = await watcher.handle({ ...report, username: `user${index}` }, tabs);
    if (result.accepted) accepted += 1;
  }
  assert.ok(accepted <= 5, `accepted ${accepted} offers before throttling`);
});

test("a report with no password is refused", async () => {
  const { watcher } = harness();
  const result = await watcher.handle({ ...report, password: "" }, [
    { id: 7, url: "https://example.com/login" },
  ]);
  assert.equal(result.reason, "no password");
});

test("a malformed payload is refused", async () => {
  const { watcher } = harness();
  for (const payload of [null, undefined, "string", 42, []]) {
    const result = await watcher.handle(payload, [{ id: 7, url: "https://example.com/login" }]);
    assert.equal(result.accepted, false);
  }
});

test("an oversized field is truncated rather than refused", async () => {
  const { watcher, offers } = harness();
  await watcher.handle(
    {
      ...report,
      username: "u".repeat(5000),
      password: "p".repeat(5000),
      url: `https://example.com/${"a".repeat(5000)}`,
    },
    [{ id: 7, url: "https://example.com/login" }],
  );

  assert.equal(offers.length, 1);
  assert.equal(offers[0].username.length, 200);
  assert.equal(offers[0].password.length, 512);
  assert.equal(offers[0].url.length, 300);
});

test("no tabs at all means no capture", async () => {
  const { watcher, offers } = harness();
  const result = await watcher.handle(report, []);
  assert.equal(result.accepted, false);
  assert.equal(offers.length, 0);
});

test("reset clears the dedupe memory", async () => {
  const { watcher, offers } = harness();
  const tabs = [{ id: 7, url: "https://example.com/login" }];
  await watcher.handle(report, tabs);
  watcher.reset();
  assert.equal((await watcher.handle(report, tabs)).accepted, true);
  assert.equal(offers.length, 2);
});