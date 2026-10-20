// Restores a backup made by `npm run backup`. Stop Reef first; it refuses otherwise.
//
//   npm run restore -- backups/reef-backup-<timestamp>
//
// Nothing is deleted: the current database and uploads move to data/pre-restore-<time>/.
// See "Backups and restore" in README.md.
import path from "node:path";
import { restoreBackup } from "../server/backup";

const arg = process.argv[2];
if (!arg || arg === "--help" || arg === "-h") {
  console.log("Usage: npm run restore -- <backup folder>\n\nStop Reef first. The current data is moved to <data>/pre-restore-<time>/, not deleted.");
  process.exit(arg ? 0 : 2);
}

const dataDir = path.resolve(process.env.REEF_DATA_DIR ?? "./data");
const backupDir = path.resolve(arg);

try {
  const r = restoreBackup({ backupDir, dataDir });
  console.log(`Restored ${backupDir}`);
  console.log(`  into      ${dataDir} (${r.uploads} uploaded files)`);
  if (r.previous) console.log(`  previous  data moved to ${r.previous}. Delete it once you're happy with the restore.`);
  console.log("Start Reef again to use the restored site.");
} catch (e: any) {
  console.error(`Restore failed: ${e?.message ?? e}`);
  process.exit(1);
}
