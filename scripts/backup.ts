// Consistent backup of the VodaForge database and uploaded media. Safe while VodaForge is running.
//
//   npm run backup                       # into ./backups (or REEF_BACKUP_DIR)
//   npm run backup -- --out /mnt/backups --keep 14
//
// Each run creates backups/reef-backup-<timestamp>/ with reef.db, uploads/ and manifest.json.
// REEF_BACKUP_AFTER runs a command afterwards (e.g. rclone/aws s3 sync) with the new folder in
// $REEF_BACKUP_PATH, for an off-site copy. A failure is logged and sent to REEF_ALERT_WEBHOOK.
// See "Backups and restore" in README.md for restoring.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { createBackup } from "../server/backup";
import { LOG_DIR, flushAlerts, logError } from "../server/log";

const { values } = parseArgs({
  options: {
    out: { type: "string", short: "o" },
    keep: { type: "string", short: "k" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  console.log("Usage: npm run backup -- [--out <dir>] [--keep <n>]\n\n  --out   where to write backups (default REEF_BACKUP_DIR or ./backups)\n  --keep  keep only the newest n backups in that folder (default REEF_BACKUP_KEEP or all)");
  process.exit(0);
}

const dataDir = path.resolve(process.env.REEF_DATA_DIR ?? "./data");
const outDir = path.resolve(values.out ?? process.env.REEF_BACKUP_DIR ?? "./backups");
const keep = Number(values.keep ?? process.env.REEF_BACKUP_KEEP ?? 0);
if (!Number.isInteger(keep) || keep < 0) {
  console.error("--keep must be a whole number (0 keeps every backup).");
  process.exit(2);
}

/** Shown on Settings → System health, so a stopped backup job is noticed. */
function writeStatus(status: Record<string, unknown>) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOG_DIR, "backup-status.json"), JSON.stringify({ time: new Date().toISOString(), ...status }, null, 2));
  } catch {
    // reporting the status must not fail the backup
  }
}

async function fail(stage: string, e: unknown, code: number, extra: Record<string, unknown> = {}) {
  const message = (e as any)?.message ?? String(e);
  console.error(`${stage}: ${message}`);
  writeStatus({ ok: false, stage, error: message, ...extra });
  logError("backup", new Error(`${stage}: ${message}`));
  await flushAlerts();
  process.exit(code);
}

let r!: ReturnType<typeof createBackup>;
try {
  r = createBackup({ dataDir, outDir, keep });
} catch (e) {
  await fail("Backup failed", e, 1);
}
const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
console.log(`Backup written to ${r.dir}`);
console.log(`  database  ${mb(r.database.bytes)} (integrity ${r.database.integrity})`);
console.log(`  uploads   ${r.uploads.files} files, ${mb(r.uploads.bytes)}`);
if (r.removed.length) console.log(`  removed   ${r.removed.length} older backup(s): ${r.removed.join(", ")}`);

const summary = { dir: r.dir, databaseBytes: r.database.bytes, uploads: r.uploads.files, uploadBytes: r.uploads.bytes };
const after = process.env.REEF_BACKUP_AFTER?.trim();
if (after) {
  console.log(`  off-site  running REEF_BACKUP_AFTER`);
  const timeoutMs = (Number(process.env.REEF_BACKUP_AFTER_TIMEOUT_MINUTES) || 60) * 60_000;
  const done = spawnSync(after, { shell: true, stdio: "inherit", timeout: timeoutMs, env: { ...process.env, REEF_BACKUP_PATH: r.dir, REEF_BACKUP_NAME: path.basename(r.dir) } });
  if (done.error || done.status !== 0) {
    const why = done.error?.message ?? (done.signal ? `stopped by ${done.signal}` : `exited with code ${done.status}`);
    await fail("The backup was written, but the off-site copy (REEF_BACKUP_AFTER) failed", why, 3, summary);
  }
  console.log(`  off-site  done`);
}
writeStatus({ ok: true, ...summary, offsite: after ? "copied" : "not configured" });
