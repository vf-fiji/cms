// Import this FIRST in every suite: it points the database at a throwaway
// directory before any server module opens it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "reef-test-"));
process.env.REEF_DATA_DIR = TEST_DATA_DIR;

process.on("exit", () => {
  try {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  } catch {
    /* the SQLite file can still be locked on Windows; the OS temp cleaner will get it */
  }
});
