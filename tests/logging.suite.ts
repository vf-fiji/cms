import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_DATA_DIR } from "./env";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";
import { LOG_DIR, flushAlerts, logError, recentErrors } from "../server/log";
import { parseBackupTimes } from "../server/backup-schedule";

const CMS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** A local webhook that records what it receives. */
async function webhook() {
  const received: any[] = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      received.push(JSON.parse(body));
      res.end("ok");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(srv.address() as any).port}/hook`;
  return { url, received, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

function runScript(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    let out = "";
    const child = spawn(process.execPath, ["--import", "tsx", ...args], { cwd: CMS_ROOT, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

describe("error log", () => {
  let hook: Awaited<ReturnType<typeof webhook>>;
  before(async () => {
    hook = await webhook();
  });
  after(async () => {
    delete process.env.REEF_ALERT_WEBHOOK;
    await hook.close();
  });

  it("writes errors to a dated JSON-lines file under the data folder", () => {
    assert.equal(LOG_DIR, path.join(TEST_DATA_DIR, "logs"));
    logError("test", new Error("Disk on fire"), { path: "/x" });
    const file = path.join(LOG_DIR, `errors-${new Date().toISOString().slice(0, 10)}.jsonl`);
    const last = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").pop()!);
    assert.equal(last.scope, "test");
    assert.equal(last.message, "Disk on fire");
    assert.deepEqual(last.meta, { path: "/x" });
    assert.match(last.stack, /Disk on fire/);
    assert.equal(recentErrors(1)[0].message, "Disk on fire");
  });

  it("removes log files older than the retention period", () => {
    const old = path.join(LOG_DIR, "errors-2001-01-01.jsonl");
    fs.writeFileSync(old, "{}\n");
    // pruning runs once per day per process; a fresh process does it on its first write
    return runScript(["-e", 'import("./server/log.ts").then((m) => m.logError("t", new Error("x")))'], { REEF_DATA_DIR: TEST_DATA_DIR }).then(() => {
      assert.equal(fs.existsSync(old), false);
    });
  });

  it("alerts a webhook once per kind of error, not once per occurrence", async () => {
    process.env.REEF_ALERT_WEBHOOK = hook.url;
    logError("db", new Error("Database is locked"), { method: "GET", path: "/news" });
    logError("db", new Error("Database is locked"));
    logError("db", new Error("Database is locked"));
    logError("db", new Error("Something else"));
    logError("db", new Error("Only a warning"), undefined, "warn");
    await flushAlerts();
    assert.equal(hook.received.length, 2);
    assert.match(hook.received[0].text, /db error \(GET \/news\)\nDatabase is locked/);
    assert.equal(hook.received[0].content, hook.received[0].text, "Discord reads `content`");
    assert.match(hook.received[1].text, /Something else/);
  });

  it("parses backup times and skips bad ones", () => {
    assert.deepEqual(parseBackupTimes("3:15, 15:45,3:15"), ["03:15", "15:45"]);
    assert.deepEqual(parseBackupTimes("25:00, soon"), []);
    assert.deepEqual(parseBackupTimes(undefined), []);
  });
});

describe("backups with an off-site copy", () => {
  let hook: Awaited<ReturnType<typeof webhook>>;
  let server: TestServer;
  before(async () => {
    hook = await webhook();
    server = await startServer();
  });
  after(async () => {
    await server?.stop();
    await hook.close();
  });

  it("runs REEF_BACKUP_AFTER with the new folder and records success", async () => {
    const out = tmp("reef-bk-");
    const marker = path.join(out, "copied.txt");
    const r = await runScript(["scripts/backup.ts", "--out", out], {
      REEF_DATA_DIR: server.dataDir,
      REEF_BACKUP_AFTER: `node -e "require('fs').writeFileSync(process.argv[1], process.env.REEF_BACKUP_PATH)" "${marker}"`,
    });
    assert.equal(r.code, 0, r.out);
    const copied = fs.readFileSync(marker, "utf8");
    assert.match(path.basename(copied), /^reef-backup-/);
    assert.ok(fs.existsSync(path.join(copied, "manifest.json")));
    const status = JSON.parse(fs.readFileSync(path.join(server.dataDir, "logs", "backup-status.json"), "utf8"));
    assert.equal(status.ok, true);
    assert.equal(status.offsite, "copied");
  });

  it("alerts and records a failure when the off-site copy fails", async () => {
    const r = await runScript(["scripts/backup.ts", "--out", tmp("reef-bk-")], {
      REEF_DATA_DIR: server.dataDir,
      REEF_BACKUP_AFTER: `node -e "process.exit(4)"`,
      REEF_ALERT_WEBHOOK: hook.url,
    });
    assert.equal(r.code, 3, r.out);
    const status = JSON.parse(fs.readFileSync(path.join(server.dataDir, "logs", "backup-status.json"), "utf8"));
    assert.equal(status.ok, false);
    assert.match(status.stage, /off-site copy/);
    assert.equal(hook.received.length, 1);
    assert.match(hook.received[0].text, /backup error/);
  });

  it("shows backups and errors on the System health page, for settings managers only", async () => {
    assert.equal((await new Client(server.url).get("/api/system/health")).status, 401);
    const admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
    const h = await admin.get("/api/system/health");
    assert.equal(h.status, 200);
    assert.equal(h.body.backup.ok, false, "shows the failed backup from the previous test");
    assert.equal(h.body.alertsConfigured, false);
    assert.ok(h.body.errors.some((e: any) => e.scope === "backup"));
    const test = await admin.post("/api/system/test-alert");
    assert.equal(test.status, 400);
    assert.match(test.body.error, /REEF_ALERT_WEBHOOK/);
  });
});

describe("backup from the admin, with alerts configured", () => {
  let hook: Awaited<ReturnType<typeof webhook>>;
  let server: TestServer;
  let admin: Client;
  before(async () => {
    hook = await webhook();
    server = await startServer({ env: { REEF_ALERT_WEBHOOK: hook.url, REEF_BACKUP_DIR: tmp("reef-bk-"), REEF_BACKUP_AFTER: "" } });
    admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
  });
  after(async () => {
    await server?.stop();
    await hook.close();
  });

  it("backs up on demand", async () => {
    const r = await admin.post("/api/system/backup");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.ok, true);
    assert.equal(r.body.offsite, "not configured");
  });

  it("sends a test alert", async () => {
    const r = await admin.post("/api/system/test-alert");
    assert.equal(r.status, 200);
    assert.equal(hook.received.length, 1);
    assert.match(hook.received[0].text, /Test alert/);
  });
});
