// Consistent backup of the Reef database and uploaded media. Safe while Reef is running.
//
//   npm run backup                       # into ./backups (or REEF_BACKUP_DIR)
//   npm run backup -- --out /mnt/backups --keep 14
//
// Each run creates backups/reef-backup-<timestamp>/ with reef.db, uploads/ and manifest.json.
// See "Backups and restore" in README.md for restoring.
import path from "node:path";
import { parseArgs } from "node:util";
import { createBackup } from "../server/backup";

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

try {
  const r = createBackup({ dataDir, outDir, keep });
  const mb = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
  console.log(`Backup written to ${r.dir}`);
  console.log(`  database  ${mb(r.database.bytes)} (integrity ${r.database.integrity})`);
  console.log(`  uploads   ${r.uploads.files} files, ${mb(r.uploads.bytes)}`);
  if (r.removed.length) console.log(`  removed   ${r.removed.length} older backup(s): ${r.removed.join(", ")}`);
} catch (e: any) {
  console.error(`Backup failed: ${e?.message ?? e}`);
  process.exit(1);
}
