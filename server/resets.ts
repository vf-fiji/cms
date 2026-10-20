import crypto from "node:crypto";
import { db, get, run, tx, now } from "./db";
import { hashPassword } from "./auth";

// Self-service password reset tokens. Only a SHA-256 of each token is stored, a token
// works once, expires, and dies as soon as the user's password changes by any route
// (the row remembers a fingerprint of the password hash it was issued against).
db.exec(`
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_fingerprint TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
`);

export const RESET_TTL_MINUTES = Math.max(5, Number(process.env.REEF_RESET_TTL_MINUTES) || 60);
export const MIN_PASSWORD_LENGTH = 10;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** Issues a token for an active user, replacing any earlier unused ones. Returns the raw token (never stored). */
export function createResetToken(userId: number, ttlMinutes = RESET_TTL_MINUTES): string {
  const user = get<{ password_hash: string }>("SELECT password_hash FROM users WHERE id = ? AND active = 1", userId);
  if (!user) throw new Error("No active user with that id.");
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  tx(() => {
    run("DELETE FROM password_resets WHERE user_id = ? OR expires_at < ?", userId, now());
    run(
      "INSERT INTO password_resets(token_hash, user_id, password_fingerprint, expires_at, created_at) VALUES(?,?,?,?,?)",
      sha(token),
      userId,
      sha(user.password_hash),
      expires,
      now(),
    );
  });
  return token;
}

interface ValidReset {
  userId: number;
  email: string;
  name: string;
}

/** The user a token belongs to, if the token is unused, unexpired and the password hasn't changed since. */
export function findValidReset(token: unknown): ValidReset | null {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) return null;
  const row = get(
    `SELECT r.user_id, r.password_fingerprint, r.expires_at, u.email, u.name, u.password_hash
     FROM password_resets r JOIN users u ON u.id = r.user_id
     WHERE r.token_hash = ? AND r.used_at IS NULL AND u.active = 1`,
    sha(token),
  );
  if (!row || new Date(row.expires_at) <= new Date()) return null;
  if (row.password_fingerprint !== sha(row.password_hash)) return null;
  return { userId: row.user_id, email: row.email, name: row.name };
}

/**
 * Sets a new password with a token. Marks the token used, removes the user's other
 * tokens and signs them out everywhere. Returns null when the token isn't valid.
 */
export function resetPasswordWithToken(token: unknown, password: string): ValidReset | null {
  return tx(() => {
    const valid = findValidReset(token);
    if (!valid) return null;
    // The conditional update makes the token single-use even if two requests race.
    const claimed = run("UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL", now(), sha(token as string));
    if (claimed.changes !== 1) return null;
    run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), valid.userId);
    run("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", valid.userId);
    run("DELETE FROM sessions WHERE user_id = ?", valid.userId);
    return valid;
  });
}
