// Built-in backup schedule: REEF_BACKUP_AT="03:15" (server local time; several times can be
// comma-separated). Each run is `scripts/backup.ts` in a child process, so the snapshot never
// blocks requests, and it honours REEF_BACKUP_DIR / REEF_BACKUP_KEEP / REEF_BACKUP_AFTER.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_DIR, logError } from "./log";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Parses "03:15, 15:15" into ["03:15", "15:15"]; invalid entries are reported and skipped. */
export function parseBackupTimes(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const out: string[] = [];
  for (const part of raw.split(",").map((x) => x.trim()).filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (m && Number(m[1]) < 24 && Number(m[2]) < 60) out.push(`${m[1].padStart(2, "0")}:${m[2]}`);
    else logError("backup", new Error(`REEF_BACKUP_AT has "${part}", which isn't a time like 03:15. It's been skipped.`), undefined, "warn");
  }
  return [...new Set(out)];
}

export const BACKUP_TIMES = parseBackupTimes(process.env.REEF_BACKUP_AT);
let running = false;
const ran = new Set<string>();

export function runBackupNow(): Promise<boolean> {
  if (running) return Promise.resolve(false);
  running = true;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/backup.ts"], { cwd: ROOT, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      running = false;
      logError("backup", e);
      resolve(false);
    });
    child.on("exit", (code) => {
      running = false;
      // the script logs and alerts its own failures; this only covers it dying before it could
      if (code === 0) console.log(`[backup] ${out.trim().split("\n")[0] ?? "done"}`);
      else if (code === null || code > 3) logError("backup", new Error(`The backup process stopped unexpectedly (${code ?? "killed"}): ${out.slice(-500)}`));
      resolve(code === 0);
    });
  });
}

export function startBackupSchedule() {
  if (!BACKUP_TIMES.length) return;
  console.log(`  Backups:  daily at ${BACKUP_TIMES.join(", ")} (server time)`);
  setInterval(() => {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const slot = `${d.toDateString()} ${hhmm}`;
    if (!BACKUP_TIMES.includes(hhmm) || ran.has(slot)) return;
    ran.add(slot);
    if (ran.size > 50) ran.delete(ran.values().next().value!);
    void runBackupNow();
  }, 20_000).unref();
}

export interface BackupStatus {
  time: string;
  ok: boolean;
  dir?: string;
  stage?: string;
  error?: string;
  offsite?: string;
  databaseBytes?: number;
  uploads?: number;
  uploadBytes?: number;
}

export function lastBackupStatus(): BackupStatus | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(LOG_DIR, "backup-status.json"), "utf8"));
  } catch {
    return null;
  }
}
