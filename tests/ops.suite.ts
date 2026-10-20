import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { TEST_DATA_DIR } from "./env";
import { ADMIN, Client, startServer, TINY_PNG, type TestServer } from "./helpers";
import { db, get, run, now, UPLOAD_DIR } from "../server/db";
import { hashPassword, verifyPassword } from "../server/auth";
import { createResetToken, findValidReset, resetPasswordWithToken } from "../server/resets";
import { createBackup, listBackups } from "../server/backup";
import { createLimiter } from "../server/ratelimit";
import { parseTrustProxy } from "../server/http";

const CMS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- reset tokens (in-process) ----------

describe("password reset tokens", () => {
  let userId: number;
  before(() => {
    run("INSERT OR IGNORE INTO roles(id, name, permissions) VALUES(1, 'Administrator', '[]')");
    userId = run("INSERT INTO users(email, name, password_hash, role_id, created_at) VALUES(?,?,?,?,?)", "reset@test.local", "Rae", hashPassword("old-password-123"), 1, now()).lastId;
  });

  it("stores only a hash of the token", () => {
    const token = createResetToken(userId);
    assert.ok(token.length >= 40);
    const rows = db.prepare("SELECT * FROM password_resets").all() as any[];
    assert.ok(rows.length >= 1);
    assert.ok(!JSON.stringify(rows).includes(token));
  });

  it("resets the password once, then refuses the same token", () => {
    const token = createResetToken(userId);
    run("INSERT INTO sessions(token_hash, user_id, csrf, expires_at) VALUES('s1', ?, 'c', ?)", userId, new Date(Date.now() + 864e5).toISOString());
    assert.equal(findValidReset(token)?.email, "reset@test.local");
    assert.equal(resetPasswordWithToken(token, "new-password-456")?.userId, userId);
    const u = get("SELECT password_hash FROM users WHERE id = ?", userId);
    assert.ok(verifyPassword("new-password-456", u.password_hash));
    assert.equal(get("SELECT COUNT(*) n FROM sessions WHERE user_id = ?", userId).n, 0, "signs the user out everywhere");
    assert.equal(findValidReset(token), null);
    assert.equal(resetPasswordWithToken(token, "third-password-789"), null);
    assert.ok(verifyPassword("new-password-456", get("SELECT password_hash FROM users WHERE id = ?", userId).password_hash));
  });

  it("expires", () => {
    const token = createResetToken(userId, -1);
    assert.equal(findValidReset(token), null);
    assert.equal(resetPasswordWithToken(token, "whatever-password"), null);
  });

  it("invalidates older tokens when a new one is issued", () => {
    const first = createResetToken(userId);
    const second = createResetToken(userId);
    assert.equal(findValidReset(first), null);
    assert.ok(findValidReset(second));
  });

  it("dies when the password is changed some other way", () => {
    const token = createResetToken(userId);
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword("changed-by-admin-1"), userId);
    assert.equal(findValidReset(token), null);
  });

  it("ignores deactivated accounts and junk tokens", () => {
    const token = createResetToken(userId);
    run("UPDATE users SET active = 0 WHERE id = ?", userId);
    assert.equal(findValidReset(token), null);
    run("UPDATE users SET active = 1 WHERE id = ?", userId);
    for (const junk of [undefined, null, 42, "", "short", "x".repeat(500), { token }]) assert.equal(findValidReset(junk), null);
  });
});

// ---------- backups (in-process) ----------

describe("createBackup", () => {
  it("writes a consistent database snapshot, the uploads and a manifest", () => {
    fs.writeFileSync(path.join(UPLOAD_DIR, "backup-me.png"), TINY_PNG);
    run("INSERT INTO kv(key, value) VALUES('backup-marker', '\"yes\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    const out = tmp("reef-bk-");
    const r = createBackup({ dataDir: TEST_DATA_DIR, outDir: out });
    assert.equal(r.database.integrity, "ok");
    assert.ok(path.basename(r.dir).startsWith("reef-backup-"));
    assert.ok(fs.readFileSync(path.join(r.dir, "uploads", "backup-me.png")).equals(TINY_PNG));
    assert.ok(r.uploads.files >= 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(r.dir, "manifest.json"), "utf8"));
    assert.equal(manifest.database.integrity, "ok");
    const copy = new DatabaseSync(path.join(r.dir, "reef.db"), { readOnly: true });
    assert.equal((copy.prepare("SELECT value FROM kv WHERE key = 'backup-marker'").get() as any)?.value, '"yes"');
    copy.close();
    assert.deepEqual(fs.readdirSync(out).filter((n) => n.endsWith(".partial")), []);
  });

  it("keeps only the newest N backups when asked", () => {
    const out = tmp("reef-bk-keep-");
    const made = [1, 2, 3].map(() => createBackup({ dataDir: TEST_DATA_DIR, outDir: out, keep: 2 }).dir);
    assert.deepEqual(listBackups(out), made.slice(1).map((d) => path.basename(d)));
  });

  it("explains a missing database", () => {
    assert.throws(() => createBackup({ dataDir: tmp("reef-empty-"), outDir: tmp("reef-bk-") }), /No Reef database/);
  });
});

// ---------- small helpers ----------

describe("rate limiter and proxy settings", () => {
  it("allows max hits per window, then reports the wait", () => {
    const l = createLimiter(2, 60_000);
    assert.equal(l.hit("a"), 0);
    assert.equal(l.hit("a"), 0);
    assert.ok(l.hit("a") > 0);
    assert.equal(l.hit("b"), 0, "keys are independent");
  });

  it("treats 0 as no limit", () => {
    const l = createLimiter(0, 60_000);
    for (let i = 0; i < 100; i++) assert.equal(l.hit("a"), 0);
  });

  it("parses REEF_TRUST_PROXY", () => {
    assert.equal(parseTrustProxy(undefined), "loopback");
    assert.equal(parseTrustProxy(""), "loopback");
    assert.equal(parseTrustProxy("true"), true);
    assert.equal(parseTrustProxy("false"), false);
    assert.equal(parseTrustProxy("1"), 1);
    assert.equal(parseTrustProxy("loopback, 10.0.0.0/8"), "loopback, 10.0.0.0/8");
  });
});

// ---------- over HTTP: forgot/reset, rate limits, backup CLI and restore ----------

/** A tiny SMTP server that accepts everything and keeps the messages. */
function fakeSmtp(): Promise<{ port: number; messages: string[]; close: () => void }> {
  const messages: string[] = [];
  const srv = net.createServer((sock) => {
    let buf = "";
    let inData = false;
    sock.write("220 test ESMTP\r\n");
    sock.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          messages.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          inData = false;
          sock.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") sock.write("250-test\r\n250 8BITMIME\r\n");
        else if (cmd === "DATA") {
          inData = true;
          sock.write("354 go ahead\r\n");
        } else if (cmd === "QUIT") sock.end("221 bye\r\n");
        else sock.write("250 OK\r\n");
      }
    });
    sock.on("error", () => {});
  });
  return new Promise((resolve) =>
    srv.listen(0, "127.0.0.1", () => resolve({ port: (srv.address() as net.AddressInfo).port, messages, close: () => srv.close() })),
  );
}

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await wait(50);
  }
}

describe("over HTTP", () => {
  let server: TestServer;
  let smtp: Awaited<ReturnType<typeof fakeSmtp>>;
  let password = ADMIN.password;
  // The body is quoted-printable: soft line breaks are "=\r\n" and "=" itself is "=3D".
  const decode = (msg: string) => msg.replace(/=\r\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
  const tokenFrom = (msg: string) => decode(msg).match(/reset-password#token=([A-Za-z0-9_-]+)/)?.[1];

  before(async () => {
    smtp = await fakeSmtp();
    server = await startServer({
      env: {
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: String(smtp.port),
        SMTP_FROM: "Reef Test <reef@test.local>",
        REEF_RATE_LIMIT_FORMS: "3",
        REEF_RATE_LIMIT_FN: "4",
        REEF_RATE_LIMIT_RESET: "50",
      },
    });
  });
  after(async () => {
    await server?.stop();
    smtp?.close();
  });

  it("logs which email transport is active", () => {
    assert.match(server.output(), /Email:\s+SMTP 127\.0\.0\.1:/);
  });

  it("answers the same way for unknown emails and sends nothing", async () => {
    const c = new Client(server.url);
    const unknown = await c.post("/api/auth/forgot", { email: "nobody@test.local" });
    assert.equal(unknown.status, 200);
    await wait(300);
    assert.equal(smtp.messages.length, 0);
    const bad = await c.post("/api/auth/forgot", { email: "not-an-email" });
    assert.equal(bad.status, 400);
  });

  it("emails a single-use link that resets the password and signs out other sessions", async () => {
    const other = new Client(server.url);
    await other.login(ADMIN.email, password);

    const c = new Client(server.url);
    const r = await c.post("/api/auth/forgot", { email: ADMIN.email.toUpperCase() });
    assert.equal(r.status, 200);
    assert.equal(r.body.message, (await c.post("/api/auth/forgot", { email: "nobody@test.local" })).body.message, "same message as for unknown accounts");

    const msg = await waitFor(() => smtp.messages.find((m) => tokenFrom(m)));
    assert.match(msg, /To: admin@test\.local/i);
    assert.ok(decode(msg).includes(`${server.url}/admin/reset-password#token=`), "link uses REEF_PUBLIC_URL");
    const token = tokenFrom(msg)!;

    assert.deepEqual((await c.post("/api/auth/reset/check", { token })).body, { valid: true, email: ADMIN.email });
    assert.equal((await c.post("/api/auth/reset/check", { token: "x".repeat(43) })).body.valid, false);

    const weak = await c.post("/api/auth/reset", { token, password: "short" });
    assert.equal(weak.status, 400);
    assert.match(weak.body.error, /at least 10/);

    const done = await c.post("/api/auth/reset", { token, password: "a-brand-new-password-1" });
    assert.equal(done.status, 200);
    password = "a-brand-new-password-1";

    const again = await c.post("/api/auth/reset", { token, password: "yet-another-password-2" });
    assert.equal(again.status, 400);
    assert.match(again.body.error, /expired or was already used/);
    assert.equal((await c.post("/api/auth/reset/check", { token })).body.valid, false);

    assert.equal((await other.get("/api/pages")).status, 401, "existing sessions are signed out");
    assert.equal((await new Client(server.url).post("/api/auth/login", { email: ADMIN.email, password: ADMIN.password })).status, 401, "old password no longer works");
    await new Client(server.url).login(ADMIN.email, password);
  });

  it("limits reset requests per email address", async () => {
    const c = new Client(server.url);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await c.post("/api/auth/forgot", { email: "limited@test.local" })).status);
    assert.deepEqual(statuses, [200, 200, 200, 429]);
  });

  it("rate-limits public form submissions", async () => {
    const submit = (accept: string) =>
      fetch(`${server.url}/api/public/forms/contact/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: accept },
        body: JSON.stringify({ name: "Ana", email: "ana@example.com", message: "Hello", consent: "yes" }),
      });
    for (let i = 0; i < 3; i++) assert.equal((await submit("application/json")).status, 200);
    const limited = await submit("application/json");
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.match((await limited.json()).error, /wait a minute/);
    const html = await submit("text/html");
    assert.equal(html.status, 429);
    assert.match(html.headers.get("content-type") ?? "", /html/);
  });

  it("rate-limits /api/fn endpoints", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${server.url}/api/fn/headlines?limit=1`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 429]);
  });

  it("counts each visitor separately behind a trusted proxy", async () => {
    // The test client is on loopback, which REEF_TRUST_PROXY trusts by default, like a local nginx.
    const call = (ip: string) => fetch(`${server.url}/api/fn/headlines?limit=1`, { headers: { "X-Forwarded-For": ip } });
    for (let i = 0; i < 4; i++) assert.equal((await call("203.0.113.7")).status, 200);
    assert.equal((await call("203.0.113.7")).status, 429);
    assert.equal((await call("203.0.113.8")).status, 200, "another visitor isn't blocked");
  });

  // Each submission comes from its own address so the form rate limit above doesn't apply.
  let visitor = 0;
  const submitForm = (key: string, body: Record<string, unknown>) =>
    fetch(`${server.url}/api/public/forms/${key}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Forwarded-For": `198.51.100.${++visitor}` },
      body: JSON.stringify(body),
    });
  /** Header lines of a raw message (folded lines unfolded). */
  const headersOf = (msg: string) => msg.slice(0, msg.indexOf("\r\n\r\n")).replace(/\r\n[ \t]+/g, " ").split("\r\n");

  it("checks notification email addresses when a form is saved", async () => {
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, password);
    const form = (await admin.post("/api/forms", { name: "Notify Check" })).body;
    const save = (notifyEmail: string) => admin.put(`/api/forms/${form.id}`, { settings: { ...form.settings, notifyEmail } });

    const ok = await save(" Coach@Test.local, scout@test.local;coach@test.local ");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.settings.notifyEmail, "coach@test.local, scout@test.local", "trimmed, lower-cased, de-duplicated");
    assert.equal((await save("")).body.settings.notifyEmail, "");

    for (const bad of [
      "not-an-email",
      "team@test.local\r\nBcc: evil@test.local",
      "team@test.local\nSubject: hi",
      "Team <team@test.local>",
      '"x" team@test.local',
      "team@test.local evil@test.local",
      Array.from({ length: 11 }, (_, i) => `p${i}@test.local`).join(","),
    ]) {
      const r = await save(bad);
      assert.equal(r.status, 400, JSON.stringify(bad));
    }
    assert.equal((await admin.get(`/api/forms/${form.id}`)).body.settings.notifyEmail, "", "bad values aren't stored");
  });

  it("emails each response to the notification addresses without injecting headers", async () => {
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, password);
    const form = (await admin.post("/api/forms", { name: "Tryouts" })).body;
    const saved = await admin.put(`/api/forms/${form.id}`, {
      name: "Tryouts\r\nBcc: evil@test.local",
      settings: { ...form.settings, notifyEmail: "coach@test.local, scout@test.local" },
    });
    assert.equal(saved.status, 200);

    const before = smtp.messages.length;
    const r = await submitForm(form.key, { name: "Ana\r\nBcc: evil@test.local", email: "ana@example.com", message: "Line one\nLine two", _page: "/join-us" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).ok, true);

    const msg = await waitFor(() => smtp.messages.slice(before).find((m) => /Subject: New response: Tryouts/.test(m)));
    const headers = headersOf(msg);
    assert.ok(headers.some((h) => /^To: coach@test\.local, scout@test\.local$/i.test(h)), headers.join("\n"));
    assert.ok(headers.includes("Subject: New response: Tryouts Bcc: evil@test.local"), "the form name stays inside the subject");
    assert.ok(!headers.some((h) => /^bcc:/i.test(h)), "no injected Bcc header");

    const body = decode(msg).replace(/\r\n/g, "\n");
    assert.match(body, /Form: Tryouts/);
    assert.match(body, /Page: \/join-us/);
    assert.match(body, /Name:\n {2}Ana\n {2}Bcc: evil@test\.local/, "values are in the body, indented");
    assert.match(body, /Email:\n {2}ana@example\.com/);
    assert.match(body, /Message:\n {2}Line one\n {2}Line two/);
    assert.ok(body.includes(`${server.url}/admin/forms/${form.id}?tab=responses`), "links to the inbox using REEF_PUBLIC_URL");

    const subs = await admin.get(`/api/forms/${form.id}/submissions`);
    assert.equal(subs.body.length, 1, "the response is stored too");
  });

  it("emails responses of forms that don't store them, and sends nothing without an address", async () => {
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, password);
    const form = (await admin.post("/api/forms", { name: "Email Only" })).body;
    await admin.put(`/api/forms/${form.id}`, { settings: { ...form.settings, storeSubmissions: false, notifyEmail: "office@test.local" } });
    const before = smtp.messages.length;
    assert.equal((await submitForm(form.key, { name: "Bo", email: "bo@example.com", message: "Hi" })).status, 200);
    const msg = await waitFor(() => smtp.messages.slice(before).find((m) => m.includes("Subject: New response: Email Only")));
    assert.match(decode(msg), /only copy/);
    assert.equal((await admin.get(`/api/forms/${form.id}/submissions`)).body.length, 0);

    const quiet = (await admin.post("/api/forms", { name: "No Notify" })).body;
    const count = smtp.messages.length;
    assert.equal((await submitForm(quiet.key, { name: "Cy", email: "cy@example.com", message: "Hi" })).status, 200);
    assert.equal((await submitForm(form.key, { name: "Bo", email: "bo@example.com", message: "Hi", _hp: "bot" })).status, 200);
    await wait(300);
    assert.equal(smtp.messages.length, count, "no email without a notification address or for honeypot hits");
  });

  /** Runs an npm script the way README.md documents it. */
  const npmRun = (args: string, dataDir: string) =>
    new Promise<{ code: number | null; log: string }>((resolve) => {
      let log = "";
      const child = spawn(`npm run ${args}`, { cwd: CMS_ROOT, env: { ...process.env, REEF_DATA_DIR: dataDir }, shell: true });
      child.stdout.on("data", (d) => (log += d));
      child.stderr.on("data", (d) => (log += d));
      child.on("exit", (code) => resolve({ code, log }));
    });

  it("backs up a running site with npm run backup, and npm run restore brings it back", async () => {
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, password);
    const page = await admin.post("/api/pages", { title: "Backed Up Page", starter: "blank" });
    assert.equal(page.status, 200);
    const fd = new FormData();
    fd.append("files", new Blob([TINY_PNG], { type: "image/png" }), "restore-me.png");
    const up = await admin.request("POST", "/api/media", undefined, { raw: fd });
    assert.equal(up.status, 200);
    const mediaUrl: string = up.body.items[0].url;

    // Backup against the live server's data folder
    const out = tmp("reef-cli-bk-");
    const backup = await npmRun(`backup --silent -- --out "${out}"`, server.dataDir);
    assert.equal(backup.code, 0, backup.log);
    assert.match(backup.log, /Backup written to .*reef-backup-/);
    assert.match(backup.log, /integrity ok/);
    const backupDir = path.join(out, listBackups(out)[0]);

    // Another site is running on the folder we restore into: restore must refuse.
    const target = tmp("reef-restore-target-");
    const other = await startServer({ dataDir: target });
    const refused = await npmRun(`restore --silent -- "${backupDir}"`, target);
    assert.notEqual(refused.code, 0);
    assert.match(refused.log, /still running/);
    await other.stop();

    const restored = await npmRun(`restore --silent -- "${backupDir}"`, target);
    assert.equal(restored.code, 0, restored.log);
    const aside = fs.readdirSync(target).filter((n) => n.startsWith("pre-restore-"));
    assert.equal(aside.length, 1, "the replaced site is kept, not deleted");
    assert.ok(fs.existsSync(path.join(target, aside[0], "reef.db")));

    const second = await startServer({ dataDir: target });
    try {
      const c = new Client(second.url);
      await c.login(ADMIN.email, password); // the reset password, from the backup
      const pages = await c.get("/api/pages");
      assert.ok(JSON.stringify(pages.body).includes("Backed Up Page"));
      const media = await fetch(second.url + mediaUrl);
      assert.equal(media.status, 200);
      assert.ok(Buffer.from(await media.arrayBuffer()).equals(TINY_PNG));
    } finally {
      await second.stop();
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });
});

describe("form notification email failures", () => {
  let server: TestServer;
  let smtp: net.Server;

  before(async () => {
    // Slow to answer, then refuses the message.
    smtp = net.createServer((sock) => {
      sock.on("error", () => {});
      setTimeout(() => {
        sock.write("220 slow ESMTP\r\n");
        sock.on("data", (chunk) => {
          const cmd = chunk.toString("utf8").slice(0, 4).toUpperCase();
          if (cmd === "EHLO" || cmd === "HELO") sock.write("250 slow\r\n");
          else if (cmd === "QUIT") sock.end("221 bye\r\n");
          else sock.write("550 mailbox unavailable\r\n");
        });
      }, 1500);
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    server = await startServer({ env: { SMTP_HOST: "127.0.0.1", SMTP_PORT: String((smtp.address() as net.AddressInfo).port) } });
  });
  after(async () => {
    await server?.stop();
    smtp?.close();
  });

  it("never fails or slows down a submission, and logs the failure", async () => {
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
    const form = (await admin.post("/api/forms", { name: "Flaky Mail" })).body;
    await admin.put(`/api/forms/${form.id}`, { settings: { ...form.settings, notifyEmail: "office@test.local" } });

    const started = Date.now();
    const r = await fetch(`${server.url}/api/public/forms/${form.key}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ name: "Di", email: "di@example.com", message: "Hello" }),
    });
    assert.equal(r.status, 200);
    assert.ok(Date.now() - started < 1000, "the response doesn't wait for the mail server");
    assert.equal((await admin.get(`/api/forms/${form.id}/submissions`)).body.length, 1);
    await waitFor(() => (/\[forms\] Couldn't email the response to “flaky-mail”/.test(server.output()) ? true : undefined));
  });
});
