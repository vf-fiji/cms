// Error log and alerts. Deliberately does not import ./db, so tools like the backup
// script can use it without opening the database.
//
//   <data>/logs/errors-YYYY-MM-DD.jsonl   one JSON object per line, kept REEF_LOG_KEEP_DAYS (14)
//   REEF_ALERT_WEBHOOK                    POSTs {text, content, ...} for each new kind of error
//                                         (works with Slack, Teams workflows, Discord, or your own)
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const LOG_DIR = path.join(path.resolve(process.env.REEF_DATA_DIR ?? "./data"), "logs");
const KEEP_DAYS = Math.max(1, Number(process.env.REEF_LOG_KEEP_DAYS) || 14);
const PREFIX = "errors-";

export interface LogEntry {
  time: string;
  level: "error" | "warn";
  scope: string;
  message: string;
  stack?: string;
  meta?: Record<string, unknown>;
}

const day = (d = new Date()) => d.toISOString().slice(0, 10);
let lastPrune = "";

function prune() {
  const today = day();
  if (lastPrune === today) return;
  lastPrune = today;
  const cutoff = day(new Date(Date.now() - KEEP_DAYS * 86_400_000));
  for (const f of fs.readdirSync(LOG_DIR)) {
    const m = /^errors-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && m[1] < cutoff) fs.rmSync(path.join(LOG_DIR, f), { force: true });
  }
}

function write(entry: LogEntry) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(path.join(LOG_DIR, `${PREFIX}${entry.time.slice(0, 10)}.jsonl`), JSON.stringify(entry) + "\n");
    prune();
  } catch {
    // a full or read-only disk must never take the request down with it
  }
}

// ---------- alerts ----------
// The same error (scope + message) alerts at most once per ALERT_REPEAT_MS, and no more
// than ALERT_MAX_PER_HOUR alerts go out in total, so a broken page can't flood a channel.
const ALERT_REPEAT_MS = 15 * 60_000;
const ALERT_MAX_PER_HOUR = 20;
const lastAlert = new Map<string, number>();
let sentThisHour: number[] = [];
const pending = new Set<Promise<unknown>>();

function shouldAlert(key: string) {
  const t = Date.now();
  sentThisHour = sentThisHour.filter((x) => t - x < 3_600_000);
  if (sentThisHour.length >= ALERT_MAX_PER_HOUR) return false;
  if (t - (lastAlert.get(key) ?? 0) < ALERT_REPEAT_MS) return false;
  lastAlert.set(key, t);
  sentThisHour.push(t);
  if (lastAlert.size > 500) for (const [k, v] of lastAlert) if (t - v > ALERT_REPEAT_MS) lastAlert.delete(k);
  return true;
}

/** Sends an alert to REEF_ALERT_WEBHOOK, if set. Never throws. */
export function sendAlert(title: string, detail = "", extra: Record<string, unknown> = {}): Promise<void> {
  const url = process.env.REEF_ALERT_WEBHOOK;
  if (!url) return Promise.resolve();
  const site = process.env.REEF_PUBLIC_URL || os.hostname();
  const text = `Reef CMS (${site}): ${title}${detail ? `\n${detail.slice(0, 1500)}` : ""}`;
  const p = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, content: text.slice(0, 1900), site, title, detail, ...extra }),
    signal: AbortSignal.timeout(10_000),
  })
    .then((r) => {
      if (!r.ok) write({ time: new Date().toISOString(), level: "warn", scope: "alerts", message: `The alert webhook answered ${r.status}` });
    })
    .catch((e) => write({ time: new Date().toISOString(), level: "warn", scope: "alerts", message: `Couldn't reach the alert webhook: ${e?.message ?? e}` }))
    .finally(() => pending.delete(p));
  pending.add(p);
  return p;
}

/** Waits for alerts still being sent (used before the process exits). */
export async function flushAlerts(timeoutMs = 5_000) {
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
}

/**
 * Records an error: prints it, appends it to today's log file and, for errors,
 * sends an alert if a webhook is configured.
 */
export function logError(scope: string, err: unknown, meta?: Record<string, unknown>, level: LogEntry["level"] = "error") {
  const e = err as any;
  const message = String(e?.message ?? e ?? "Unknown error").slice(0, 2000);
  const entry: LogEntry = { time: new Date().toISOString(), level, scope, message };
  if (e?.stack) entry.stack = String(e.stack).slice(0, 8000);
  if (meta && Object.keys(meta).length) entry.meta = meta;
  (level === "error" ? console.error : console.warn)(`[${scope}] ${message}${meta ? ` ${JSON.stringify(meta)}` : ""}`, e?.stack && level === "error" ? `\n${e.stack}` : "");
  write(entry);
  if (level === "error" && shouldAlert(`${scope}|${message}`)) {
    const where = meta?.path ? ` (${meta.method ?? ""} ${meta.path})` : "";
    void sendAlert(`${scope} error${where}`, message, { level, scope });
  }
}

/** The newest log entries, newest first, from today's file and earlier ones as needed. */
export function recentErrors(limit = 100): LogEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(LOG_DIR).filter((f) => f.startsWith(PREFIX) && f.endsWith(".jsonl")).sort().reverse();
  } catch {
    return [];
  }
  const out: LogEntry[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(LOG_DIR, f), "utf8").split("\n").filter(Boolean).reverse();
    for (const l of lines) {
      try {
        out.push(JSON.parse(l));
      } catch {
        // a line cut short by a crash
      }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/** Catches errors nothing else handled. Unhandled rejections are logged; a thrown exception
 *  leaves the process in an unknown state, so it's logged, alerted and the process exits for
 *  Docker (or your process manager) to restart it. */
export function installProcessHandlers() {
  process.on("unhandledRejection", (reason) => logError("unhandled", reason));
  process.on("uncaughtException", (err) => {
    logError("crash", err);
    void flushAlerts().finally(() => process.exit(1));
  });
}
