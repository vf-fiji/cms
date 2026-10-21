import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

// Online backups and offline restores. Deliberately does not import ./db: these tools
// must not run migrations or seed data, and backups open the live database read-only.

export interface BackupOptions {
  /** The VodaForge data folder (holds reef.db and uploads/). */
  dataDir: string;
  /** Where backup folders are created. */
  outDir: string;
  /** Keep only the newest N backups in outDir (0 = keep all). */
  keep?: number;
}

export interface BackupResult {
  dir: string;
  database: { file: string; bytes: number; integrity: string };
  uploads: { files: number; bytes: number };
  removed: string[];
}

const PREFIX = "reef-backup-";

export function createBackup({ dataDir, outDir, keep = 0 }: BackupOptions): BackupResult {
  const source = path.join(dataDir, "reef.db");
  if (!fs.existsSync(source)) throw new Error(`No VodaForge database at ${source}. Set REEF_DATA_DIR to your data folder.`);
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let name = `${PREFIX}${stamp}`;
  for (let i = 2; fs.existsSync(path.join(outDir, name)); i++) name = `${PREFIX}${stamp}-${i}`;
  const finalDir = path.join(outDir, name);
  const workDir = `${finalDir}.partial`;
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir);

  try {
    // 1. Database: VACUUM INTO writes a consistent, compacted snapshot while VodaForge keeps running.
    const dbFile = path.join(workDir, "reef.db");
    const live = new DatabaseSync(source, { readOnly: true });
    try {
      live.exec("PRAGMA busy_timeout = 10000");
      live.prepare("VACUUM INTO ?").run(dbFile);
    } finally {
      live.close();
    }
    const copy = new DatabaseSync(dbFile, { readOnly: true });
    let integrity: string;
    try {
      integrity = String((copy.prepare("PRAGMA integrity_check").get() as any)?.integrity_check);
    } finally {
      copy.close();
    }
    if (integrity !== "ok") throw new Error(`The backup copy failed its integrity check: ${integrity}`);

    // 2. Uploads, copied after the snapshot so every file the snapshot refers to is included.
    const uploadsSrc = path.join(dataDir, "uploads");
    const uploads = { files: 0, bytes: 0 };
    if (fs.existsSync(uploadsSrc)) {
      fs.cpSync(uploadsSrc, path.join(workDir, "uploads"), { recursive: true, preserveTimestamps: true });
      for (const f of walk(path.join(workDir, "uploads"))) {
        uploads.files++;
        uploads.bytes += fs.statSync(f).size;
      }
    } else fs.mkdirSync(path.join(workDir, "uploads"));

    const database = { file: "reef.db", bytes: fs.statSync(dbFile).size, integrity };
    fs.writeFileSync(
      path.join(workDir, "manifest.json"),
      JSON.stringify({ app: "reef-cms", createdAt: new Date().toISOString(), source: path.resolve(dataDir), database, uploads }, null, 2) + "\n",
    );
    fs.renameSync(workDir, finalDir);

    return { dir: finalDir, database, uploads, removed: keep > 0 ? prune(outDir, keep) : [] };
  } catch (e) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
}

/** Completed backups in outDir, oldest first. */
export function listBackups(outDir: string): string[] {
  if (!fs.existsSync(outDir)) return [];
  return fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(PREFIX) && !d.name.endsWith(".partial") && fs.existsSync(path.join(outDir, d.name, "manifest.json")))
    .map((d) => d.name)
    .sort();
}

/**
 * True while another process (a running VodaForge) has the database open. A WAL-mode
 * connection holds a shared lock for its whole life, so an exclusive lock fails.
 */
export function isDatabaseInUse(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  const probe = new DatabaseSync(file);
  try {
    probe.exec("PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    return false;
  } catch (e: any) {
    if (/locked|busy/i.test(String(e?.message))) return true;
    throw e;
  } finally {
    probe.close();
  }
}

export interface RestoreResult {
  /** Where the replaced database and uploads were moved (null if there was nothing to replace). */
  previous: string | null;
  uploads: number;
}

/**
 * Replaces the database and uploads in dataDir with a backup. Refuses while VodaForge is
 * running. Nothing is deleted: the current files are moved to dataDir/pre-restore-<time>/.
 */
export function restoreBackup({ backupDir, dataDir }: { backupDir: string; dataDir: string }): RestoreResult {
  const source = path.join(backupDir, "reef.db");
  if (!fs.existsSync(path.join(backupDir, "manifest.json")) || !fs.existsSync(source)) {
    throw new Error(`${backupDir} isn't a complete VodaForge backup (it needs reef.db and manifest.json).`);
  }
  const check = new DatabaseSync(source, { readOnly: true });
  try {
    const integrity = String((check.prepare("PRAGMA integrity_check").get() as any)?.integrity_check);
    if (integrity !== "ok") throw new Error(`The backup's database failed its integrity check: ${integrity}`);
  } finally {
    check.close();
  }

  const live = path.join(dataDir, "reef.db");
  if (isDatabaseInUse(live)) throw new Error("VodaForge is still running and using this database. Stop it, then run the restore again.");

  fs.mkdirSync(dataDir, { recursive: true });
  const replaced = ["reef.db", "reef.db-wal", "reef.db-shm", "uploads"].filter((n) => fs.existsSync(path.join(dataDir, n)));
  const previous = replaced.length ? path.join(dataDir, `pre-restore-${new Date().toISOString().replace(/[:.]/g, "-")}`) : null;
  if (previous) {
    fs.mkdirSync(previous);
    for (const n of replaced) fs.renameSync(path.join(dataDir, n), path.join(previous, n));
  }
  try {
    fs.copyFileSync(source, live);
    const uploads = path.join(backupDir, "uploads");
    if (fs.existsSync(uploads)) fs.cpSync(uploads, path.join(dataDir, "uploads"), { recursive: true, preserveTimestamps: true });
    else fs.mkdirSync(path.join(dataDir, "uploads"));
  } catch (e) {
    // Put everything back the way it was.
    if (previous) {
      for (const n of ["reef.db", "uploads"]) if (fs.existsSync(path.join(dataDir, n))) fs.renameSync(path.join(dataDir, n), path.join(previous, `failed-restore-${n}`));
      for (const n of replaced) fs.renameSync(path.join(previous, n), path.join(dataDir, n));
    }
    throw e;
  }
  return { previous, uploads: [...walk(path.join(dataDir, "uploads"))].length };
}

function prune(outDir: string, keep: number): string[] {
  const old = listBackups(outDir).slice(0, -keep);
  for (const name of old) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  return old;
}

function* walk(dir: string): Generator<string> {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile()) yield p;
  }
}
