import crypto from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { get, run, json, now } from "./db";
import type { Permission } from "../shared/types";

const SESSION_COOKIE = "reef_session";
const SESSION_DAYS = 7;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, saltB64, hashB64] = stored.split("$");
  if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export interface AuthUser {
  id: number;
  email: string;
  name: string;
  roleId: number;
  roleName: string;
  permissions: Permission[];
  twoFactorEnabled: boolean;
  csrf: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

export function createSession(res: Response, userId: number) {
  const token = crypto.randomBytes(32).toString("base64url");
  const csrf = crypto.randomBytes(18).toString("base64url");
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5);
  run("INSERT INTO sessions(token_hash, user_id, csrf, expires_at) VALUES(?,?,?,?)", sha(token), userId, csrf, expires.toISOString());
  run("UPDATE users SET last_login_at = ? WHERE id = ?", now(), userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires,
    path: "/",
  });
}

export function destroySession(req: Request, res: Response) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) run("DELETE FROM sessions WHERE token_hash = ?", sha(token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

/** Attaches req.user when a valid session cookie is present. */
export function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) {
    const row = get<any>(
      `SELECT u.id, u.email, u.name, u.role_id, u.totp_enabled, r.name AS role_name, r.permissions, s.csrf, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id JOIN roles r ON r.id = u.role_id
       WHERE s.token_hash = ? AND u.active = 1`,
      sha(token),
    );
    if (row && new Date(row.expires_at) > new Date()) {
      req.user = {
        id: row.id,
        email: row.email,
        name: row.name,
        roleId: row.role_id,
        roleName: row.role_name,
        permissions: json(row.permissions, []),
        twoFactorEnabled: !!row.totp_enabled,
        csrf: row.csrf,
      };
    }
  }
  next();
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "Your session has ended. Please sign in again."));
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    if (req.headers["x-csrf-token"] !== req.user.csrf) {
      return next(new HttpError(403, "This request could not be verified. Refresh the page and try again."));
    }
  }
  next();
}

export function can(req: Request, perm: Permission) {
  return !!req.user?.permissions.includes(perm);
}

export function requirePerm(...perms: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, "Please sign in."));
    if (!perms.some((p) => req.user!.permissions.includes(p))) {
      return next(new HttpError(403, "Your role doesn't allow this. Ask an administrator for access."));
    }
    next();
  };
}

// In-memory sign-in throttle. Callers check two keys: one per client address (5 tries a minute)
// and one per account (10 tries in 15 minutes), so guesses can't be spread across many addresses.
const attempts = new Map<string, { count: number; until: number }>();
export const PER_CLIENT = { max: 5, windowMs: 60_000 };
export const PER_ACCOUNT = { max: 10, windowMs: 15 * 60_000 };

export function checkThrottle(key: string, limit = PER_CLIENT, what = "attempts") {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= limit.max) {
    const secs = Math.ceil((a.until - Date.now()) / 1000);
    throw new HttpError(429, `Too many ${what}. Try again in ${secs > 90 ? `${Math.ceil(secs / 60)} minutes` : `${secs} seconds`}.`);
  }
}
/** Returns true when this failure reached the limit (so the caller can raise an alert once). */
export function recordFailure(key: string, limit = PER_CLIENT): boolean {
  const t = Date.now();
  if (attempts.size > 20_000) for (const [k, v] of attempts) if (v.until < t) attempts.delete(k);
  if (attempts.size > 50_000) attempts.clear(); // under a flood of made-up emails, forget rather than grow
  const a = attempts.get(key);
  if (!a || a.until < t) {
    attempts.set(key, { count: 1, until: t + limit.windowMs });
    return limit.max === 1;
  }
  a.count++;
  return a.count === limit.max;
}
export function clearFailures(key: string) {
  attempts.delete(key);
}
/** The client address for throttling: IPv6 clients usually control a whole /64, so count it as one. */
export function clientKey(req: Request) {
  const ip = String(req.ip ?? "");
  if (!ip.includes(":") || ip.startsWith("::ffff:")) return ip.replace(/^::ffff:/, "");
  return `${ip.split(":").slice(0, 4).join(":")}::/64`;
}

/** Signs a user out everywhere except the session making this request. */
export function revokeOtherSessions(req: Request, userId: number) {
  const token = readCookie(req, SESSION_COOKIE);
  run("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?", userId, token ? sha(token) : "");
}
