import { Router, type Request } from "express";
import crypto from "node:crypto";
import { all, get, run, json, now, getSettings, saveSettings, logActivity, tx, slugify } from "../db";
import {
  createSession,
  destroySession,
  verifyPassword,
  hashPassword,
  requireAuth,
  requirePerm,
  HttpError,
  can,
  checkThrottle,
  recordFailure,
  clearFailures,
  clientKey,
  revokeOtherSessions,
  PER_ACCOUNT,
} from "../auth";
import { str, int, idParam, notFound } from "../http";
import { ALL_PERMISSIONS, type Permission, type Role, type User } from "../../shared/types";
import { computePaths, flushViews } from "../render/site";
import { checkTailwindInput } from "../tailwind";
import QRCode from "qrcode";
import { newSecret, otpauthUrl, verifyTotp, newRecoveryCodes, useRecoveryCode } from "../totp";
import { logError, recentErrors, sendAlert } from "../log";
import { BACKUP_TIMES, lastBackupStatus, runBackupNow } from "../backup-schedule";

// Password accepted, second factor pending: short-lived, in-memory tickets.
const challenges = new Map<string, { userId: number; expires: number; attempts: number }>();
function newChallenge(userId: number) {
  for (const [k, v] of challenges) if (v.expires < Date.now()) challenges.delete(k);
  const ticket = crypto.randomBytes(24).toString("base64url");
  challenges.set(ticket, { userId, expires: Date.now() + 5 * 60_000, attempts: 0 });
  return ticket;
}

/** Accepts an authenticator code (not reused) or a recovery code. */
function checkSecondFactor(user: any, code: string): "totp" | "recovery" | null {
  const step = user.totp_secret ? verifyTotp(user.totp_secret, code) : null;
  if (step !== null && step > (user.totp_last_step ?? 0)) {
    run("UPDATE users SET totp_last_step = ? WHERE id = ?", step, user.id);
    return "totp";
  }
  const remaining = useRecoveryCode(json<string[]>(user.totp_recovery, []), code);
  if (remaining) {
    run("UPDATE users SET totp_recovery = ? WHERE id = ?", JSON.stringify(remaining), user.id);
    return "recovery";
  }
  return null;
}

export const core = Router();

// ---------- auth ----------
core.post("/auth/login", (req, res) => {
  const email = str(req.body?.email, "Email", { required: true, max: 200 }).toLowerCase();
  const password = String(req.body?.password ?? "");
  const throttleKey = `${clientKey(req)}|${email}`;
  const accountKey = `account|${email}`;
  checkThrottle(throttleKey);
  checkThrottle(accountKey, PER_ACCOUNT, "failed sign-ins for this account");
  const user = get("SELECT * FROM users WHERE email = ?", email);
  if (!user || !user.active || !verifyPassword(password, user.password_hash)) {
    recordFailure(throttleKey);
    if (recordFailure(accountKey, PER_ACCOUNT) && user) logError("auth", new Error(`Sign-in to ${email} is paused for 15 minutes after ${PER_ACCOUNT.max} wrong passwords.`), { ip: req.ip });
    throw new HttpError(401, "That email and password don't match. Check them and try again.");
  }
  clearFailures(throttleKey);
  if (user.totp_enabled) return res.json({ twoFactor: true, ticket: newChallenge(user.id) });
  createSession(res, user.id);
  logActivity(user.id, "signed in", "user", user.id, user.name);
  res.json({ ok: true });
});

core.post("/auth/login/2fa", (req, res) => {
  const ticket = String(req.body?.ticket ?? "");
  const c = challenges.get(ticket);
  if (!c || c.expires < Date.now()) {
    challenges.delete(ticket);
    throw new HttpError(401, "That sign-in took too long. Enter your email and password again.");
  }
  const throttleKey = `${clientKey(req)}|2fa|${c.userId}`;
  const accountKey = `account2fa|${c.userId}`;
  checkThrottle(throttleKey);
  checkThrottle(accountKey, PER_ACCOUNT, "wrong codes for this account");
  const user = get("SELECT * FROM users WHERE id = ? AND active = 1", c.userId);
  const how = user ? checkSecondFactor(user, String(req.body?.code ?? "")) : null;
  if (!how) {
    recordFailure(throttleKey);
    // someone has this person's password and is guessing codes: worth telling an administrator
    if (recordFailure(accountKey, PER_ACCOUNT)) logError("auth", new Error(`Two-factor sign-in for ${user?.email ?? `user ${c.userId}`} is paused for 15 minutes after ${PER_ACCOUNT.max} wrong codes. Their password may be known to someone else.`), { ip: req.ip });
    if (++c.attempts >= 5) challenges.delete(ticket);
    throw new HttpError(401, c.attempts >= 5 ? "Too many wrong codes. Enter your email and password again." : "That code isn't right. Check your authenticator app and try again.");
  }
  challenges.delete(ticket);
  clearFailures(throttleKey);
  createSession(res, user.id);
  logActivity(user.id, how === "recovery" ? "signed in with a recovery code" : "signed in", "user", user.id, user.name);
  const left = how === "recovery" ? json<string[]>(get("SELECT totp_recovery FROM users WHERE id = ?", user.id).totp_recovery, []).length : null;
  res.json({ ok: true, recoveryCodesLeft: left });
});

core.post("/auth/logout", (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});

core.get("/auth/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { csrf, ...user } = req.user;
  res.json({ user, csrf });
});

core.use(requireAuth);

// When Settings require two-factor sign-in, people without it can only set it up.
const OPEN_WITHOUT_2FA = new Set(["/auth/me", "/auth/logout", "/auth/2fa/setup", "/auth/2fa/enable", "/auth/2fa/status"]);
core.use((req, _res, next) => {
  if (!req.user || req.user.twoFactorEnabled || OPEN_WITHOUT_2FA.has(req.path) || (req.method === "GET" && req.path === "/settings")) return next();
  if (getSettings().require2fa) return next(new HttpError(403, "Set up two-factor sign-in to continue.", { needs2fa: true }));
  next();
});

// ---------- two-factor sign-in ----------
core.post("/auth/2fa/setup", async (req, res) => {
  const u = get("SELECT totp_enabled FROM users WHERE id = ?", req.user!.id);
  if (u.totp_enabled) throw new HttpError(400, "Two-factor sign-in is already on.");
  const secret = newSecret();
  run("UPDATE users SET totp_pending = ? WHERE id = ?", secret, req.user!.id);
  const url = otpauthUrl(secret, req.user!.email, getSettings().siteName || "VodaForge");
  res.json({ secret, otpauthUrl: url, qr: await QRCode.toDataURL(url, { margin: 1, width: 220 }) });
});

core.post("/auth/2fa/enable", (req, res) => {
  const u = get("SELECT totp_pending FROM users WHERE id = ?", req.user!.id);
  if (!u.totp_pending) throw new HttpError(400, "Start the setup again.");
  const step = verifyTotp(u.totp_pending, String(req.body?.code ?? ""));
  if (step === null) throw new HttpError(400, "That code isn't right. Make sure your phone's clock is set automatically, then try the newest code.");
  const { codes, hashes } = newRecoveryCodes();
  run("UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = 1, totp_recovery = ?, totp_last_step = ? WHERE id = ?", JSON.stringify(hashes), step, req.user!.id);
  revokeOtherSessions(req, req.user!.id); // other sessions were made without the second factor
  logActivity(req.user!.id, "turned on two-factor sign-in", "user", req.user!.id, req.user!.name);
  res.json({ recoveryCodes: codes });
});

core.post("/auth/2fa/disable", (req, res) => {
  const u = get("SELECT password_hash FROM users WHERE id = ?", req.user!.id);
  if (!verifyPassword(String(req.body?.password ?? ""), u.password_hash)) throw new HttpError(400, "Your password is incorrect.");
  if (getSettings().require2fa) throw new HttpError(400, "Two-factor sign-in is required on this site, so it can't be turned off.");
  run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_recovery = '[]', totp_last_step = 0 WHERE id = ?", req.user!.id);
  logActivity(req.user!.id, "turned off two-factor sign-in", "user", req.user!.id, req.user!.name);
  res.json({ ok: true });
});

core.post("/auth/2fa/recovery-codes", (req, res) => {
  const u = get("SELECT password_hash, totp_enabled FROM users WHERE id = ?", req.user!.id);
  if (!u.totp_enabled) throw new HttpError(400, "Turn on two-factor sign-in first.");
  if (!verifyPassword(String(req.body?.password ?? ""), u.password_hash)) throw new HttpError(400, "Your password is incorrect.");
  const { codes, hashes } = newRecoveryCodes();
  run("UPDATE users SET totp_recovery = ? WHERE id = ?", JSON.stringify(hashes), req.user!.id);
  res.json({ recoveryCodes: codes });
});

core.get("/auth/2fa/status", (req, res) => {
  const u = get("SELECT totp_enabled, totp_recovery FROM users WHERE id = ?", req.user!.id);
  res.json({ enabled: !!u.totp_enabled, recoveryCodesLeft: json<string[]>(u.totp_recovery, []).length, required: getSettings().require2fa });
});

core.post("/auth/password", (req, res) => {
  const current = String(req.body?.current ?? "");
  const next = String(req.body?.next ?? "");
  const row = get("SELECT password_hash FROM users WHERE id = ?", req.user!.id);
  if (!verifyPassword(current, row.password_hash)) throw new HttpError(400, "Your current password is incorrect.");
  if (next.length < 10) throw new HttpError(400, "Choose a new password with at least 10 characters.");
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(next), req.user!.id);
  revokeOtherSessions(req, req.user!.id); // anyone signed in with the old password is signed out
  logActivity(req.user!.id, "changed their password", "user", req.user!.id, req.user!.name);
  res.json({ ok: true });
});

core.put("/auth/profile", (req, res) => {
  const name = str(req.body?.name, "Name", { required: true, max: 120 });
  run("UPDATE users SET name = ? WHERE id = ?", name, req.user!.id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
core.get("/dashboard", (_req, res) => {
  flushViews();
  const count = (sql: string, ...p: any[]) => get<{ n: number }>(sql, ...p)?.n ?? 0;
  const days: { day: string; views: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    days.push({ day: d, views: count("SELECT COALESCE(SUM(views),0) n FROM page_views WHERE day = ?", d) });
  }
  const subsByDay: { day: string; count: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    subsByDay.push({ day: d, count: count("SELECT COUNT(*) n FROM form_submissions WHERE substr(created_at,1,10) = ?", d) });
  }
  const paths = computePaths();
  res.json({
    stats: {
      pages: count("SELECT COUNT(*) n FROM pages"),
      livePages: count("SELECT COUNT(*) n FROM pages WHERE published IS NOT NULL"),
      items: count("SELECT COUNT(*) n FROM content_items"),
      liveItems: count("SELECT COUNT(*) n FROM content_items WHERE status = 'published'"),
      media: count("SELECT COUNT(*) n FROM media"),
      mediaBytes: count("SELECT COALESCE(SUM(size),0) n FROM media"),
      submissions: count("SELECT COUNT(*) n FROM form_submissions"),
      unread: count("SELECT COUNT(*) n FROM form_submissions WHERE is_read = 0"),
      functions: count("SELECT COUNT(*) n FROM functions WHERE enabled = 1"),
      views14: days.reduce((a, d) => a + d.views, 0),
    },
    views: days,
    submissionsByDay: subsByDay,
    topPages: all("SELECT path, SUM(views) views FROM page_views WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 5", days[0].day),
    review: [
      ...all("SELECT id, title, updated_at FROM pages WHERE status = 'review' ORDER BY updated_at DESC LIMIT 10").map((r) => ({ kind: "page", id: r.id, title: r.title, updatedAt: r.updated_at })),
      ...all(
        "SELECT i.id, i.title, i.updated_at, t.key, t.singular FROM content_items i JOIN content_types t ON t.id = i.type_id WHERE i.status = 'review' ORDER BY i.updated_at DESC LIMIT 10",
      ).map((r) => ({ kind: "item", id: r.id, title: r.title, updatedAt: r.updated_at, typeKey: r.key, typeName: r.singular })),
    ],
    drafts: all("SELECT id, title, updated_at, published IS NOT NULL AS live FROM pages WHERE status = 'draft' OR (published IS NOT NULL AND published_at < updated_at) ORDER BY updated_at DESC LIMIT 6").map((r) => ({
      id: r.id,
      title: r.title,
      updatedAt: r.updated_at,
      live: !!r.live,
      path: paths.get(r.id),
    })),
    recentSubmissions: all(
      "SELECT s.id, s.data, s.created_at, s.is_read, f.name, f.id form_id FROM form_submissions s JOIN forms f ON f.id = s.form_id ORDER BY s.id DESC LIMIT 6",
    ).map((r) => ({ id: r.id, formId: r.form_id, formName: r.name, data: json(r.data, {}), createdAt: r.created_at, isRead: !!r.is_read })),
    activity: activityRows(12),
  });
});

function activityRows(limit: number, offset = 0) {
  return all(
    "SELECT a.*, u.name user_name FROM activity a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT ? OFFSET ?",
    limit,
    offset,
  ).map((r) => ({ id: r.id, userName: r.user_name, action: r.action, entity: r.entity, entityId: r.entity_id, label: r.label, createdAt: r.created_at }));
}

core.get("/activity", (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  res.json({ items: activityRows(limit, offset), total: get("SELECT COUNT(*) n FROM activity")!.n });
});

// ---------- global search (command palette) ----------
core.get("/search", (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) return res.json({ results: [] });
  const like = `%${q.replace(/[%_]/g, "")}%`;
  const paths = computePaths();
  const results = [
    ...all("SELECT id, title FROM pages WHERE title LIKE ? OR slug LIKE ? LIMIT 8", like, like).map((r) => ({
      kind: "page",
      id: r.id,
      title: r.title,
      subtitle: paths.get(r.id),
      href: `/pages/${r.id}`,
    })),
    ...all(
      "SELECT i.id, i.title, t.key, t.singular FROM content_items i JOIN content_types t ON t.id = i.type_id WHERE i.title LIKE ? OR i.data LIKE ? ORDER BY i.updated_at DESC LIMIT 10",
      like,
      like,
    ).map((r) => ({ kind: "item", id: r.id, title: r.title, subtitle: r.singular, href: `/content/${r.key}/${r.id}` })),
    ...all("SELECT id, original_name, title FROM media WHERE original_name LIKE ? OR title LIKE ? OR alt LIKE ? LIMIT 6", like, like, like).map((r) => ({
      kind: "media",
      id: r.id,
      title: r.title || r.original_name,
      subtitle: "Media",
      href: `/media?focus=${r.id}`,
    })),
    ...all("SELECT id, name FROM forms WHERE name LIKE ? LIMIT 4", like).map((r) => ({ kind: "form", id: r.id, title: r.name, subtitle: "Form", href: `/forms/${r.id}` })),
    ...all("SELECT id, name, kind FROM functions WHERE name LIKE ? OR code LIKE ? LIMIT 4", like, like).map((r) => ({
      kind: "code",
      id: r.id,
      title: r.name,
      subtitle: `Server ${r.kind}`,
      href: `/code?fn=${r.id}`,
    })),
  ];
  res.json({ results });
});

// ---------- settings ----------
core.get("/settings", (_req, res) => res.json(getSettings()));
core.put("/settings", requirePerm("settings.manage"), async (req, res) => {
  const body = { ...(req.body ?? {}) };
  for (const k of ["tailwindEnabled", "tailwindPreflight", "sitemapEnabled", "headlessApiEnabled", "require2fa"]) if (k in body) body[k] = !!body[k];
  if (body.require2fa && !getSettings().require2fa && !req.user!.twoFactorEnabled) throw new HttpError(400, "Turn on two-factor sign-in for your own account first (Account → Two-factor sign-in), so you can't lock yourself out.");
  if ("tailwindCss" in body && typeof body.tailwindCss !== "string") throw new HttpError(400, "Tailwind CSS must be text.");
  if ("importMap" in body) {
    const map = body.importMap;
    const ok =
      map && typeof map === "object" && !Array.isArray(map) &&
      Object.entries(map).every(([k, v]) => /^[@a-z0-9][\w@./-]{0,99}$/i.test(k) && typeof v === "string" && /^(https?:\/\/|\/)[^\s"'<>]{1,500}$/.test(v));
    if (!ok) throw new HttpError(400, "Import map entries need a package name and an http(s) or site-relative address.");
  }
  const current = getSettings();
  const next = { ...current, ...body };
  if (next.tailwindEnabled && (next.tailwindCss !== current.tailwindCss || next.tailwindPreflight !== current.tailwindPreflight)) {
    try {
      await checkTailwindInput(next);
    } catch (e: any) {
      throw new HttpError(400, e.message);
    }
  }
  saveSettings(body);
  logActivity(req.user!.id, "updated", "settings", null, "Site settings");
  res.json(getSettings());
});

// ---------- system health ----------
core.get("/system/health", requirePerm("settings.manage"), (_req, res) => {
  res.json({
    errors: recentErrors(100),
    backup: lastBackupStatus(),
    backupSchedule: BACKUP_TIMES,
    offsiteConfigured: !!process.env.REEF_BACKUP_AFTER?.trim(),
    alertsConfigured: !!process.env.REEF_ALERT_WEBHOOK,
    uptimeSeconds: Math.round(process.uptime()),
    node: process.version,
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  });
});
core.post("/system/test-alert", requirePerm("settings.manage"), async (req, res) => {
  if (!process.env.REEF_ALERT_WEBHOOK) throw new HttpError(400, "Alerts aren't set up. Set REEF_ALERT_WEBHOOK on the server first.");
  await sendAlert("Test alert", `Sent from Settings → System health by ${req.user!.name}. If you can read this, alerts work.`, { level: "info" });
  res.json({ ok: true });
});
core.post("/system/backup", requirePerm("settings.manage"), async (req, res) => {
  logActivity(req.user!.id, "started", "backup", null, "Backup");
  const ok = await runBackupNow();
  const status = lastBackupStatus();
  if (!ok) throw new HttpError(500, status && !status.ok ? `${status.stage}: ${status.error}` : "A backup is already running, or it couldn't start. Check the error log.");
  res.json(status);
});

// ---------- redirects ----------
core.get("/redirects", (_req, res) =>
  res.json(all("SELECT * FROM redirects ORDER BY from_path").map((r) => ({ id: r.id, fromPath: r.from_path, toPath: r.to_path, code: r.code, hits: r.hits }))),
);
core.post("/redirects", requirePerm("settings.manage"), (req, res) => {
  let from = str(req.body?.fromPath, "From path", { required: true, max: 400 });
  if (!from.startsWith("/")) from = "/" + from;
  from = from.replace(/\/+$/, "") || "/";
  const to = str(req.body?.toPath, "Destination", { required: true, max: 1000 });
  const code = [301, 302, 307, 308].includes(Number(req.body?.code)) ? Number(req.body.code) : 301;
  if (get("SELECT 1 FROM redirects WHERE from_path = ?", from)) throw new HttpError(409, `A redirect from ${from} already exists.`);
  const r = run("INSERT INTO redirects(from_path, to_path, code) VALUES(?,?,?)", from, to, code);
  res.json({ id: r.lastId });
});
core.delete("/redirects/:id", requirePerm("settings.manage"), (req, res) => {
  run("DELETE FROM redirects WHERE id = ?", idParam(req.params.id));
  res.json({ ok: true });
});

// ---------- taxonomies ----------
core.get("/terms", (req, res) => {
  const taxonomy = req.query.taxonomy === "categories" ? "categories" : "tags";
  const rows = all("SELECT * FROM terms WHERE taxonomy = ? ORDER BY name COLLATE NOCASE", taxonomy);
  const usage = new Map<string, number>();
  for (const r of all(`SELECT lower(j.value) v, COUNT(*) n FROM content_items, json_each(content_items.${taxonomy}) j GROUP BY lower(j.value)`)) usage.set(r.v, r.n);
  res.json(rows.map((r) => ({ id: r.id, name: r.name, slug: r.slug, parentId: r.parent_id, description: r.description, count: usage.get(r.name.toLowerCase()) ?? 0 })));
});
core.post("/terms", requirePerm("content.edit"), (req, res) => {
  const taxonomy = req.body?.taxonomy === "categories" ? "categories" : "tags";
  const name = str(req.body?.name, "Name", { required: true, max: 80 });
  const slug = slugify(name);
  if (get("SELECT 1 FROM terms WHERE taxonomy = ? AND slug = ?", taxonomy, slug)) throw new HttpError(409, `“${name}” already exists.`);
  const r = run("INSERT INTO terms(taxonomy, name, slug, parent_id, description) VALUES(?,?,?,?,?)", taxonomy, name, slug, req.body?.parentId || null, str(req.body?.description, "Description", { max: 500 }));
  res.json({ id: r.lastId });
});
core.put("/terms/:id", requirePerm("content.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const old = get("SELECT * FROM terms WHERE id = ?", id) ?? notFound("Term");
  const name = str(req.body?.name, "Name", { required: true, max: 80 });
  tx(() => {
    run("UPDATE terms SET name = ?, slug = ?, parent_id = ?, description = ? WHERE id = ?", name, slugify(name), req.body?.parentId || null, str(req.body?.description, "Description", { max: 500 }), id);
    // rename on items too, so renaming a tag is painless
    if (old.name !== name) {
      const col = old.taxonomy === "categories" ? "categories" : "tags";
      for (const it of all(`SELECT id, ${col} v FROM content_items WHERE EXISTS (SELECT 1 FROM json_each(${col}) WHERE lower(value) = lower(?))`, old.name)) {
        const list = json<string[]>(it.v, []).map((t) => (t.toLowerCase() === old.name.toLowerCase() ? name : t));
        run(`UPDATE content_items SET ${col} = ? WHERE id = ?`, JSON.stringify(list), it.id);
      }
    }
  });
  res.json({ ok: true });
});
core.delete("/terms/:id", requirePerm("content.edit"), (req, res) => {
  run("DELETE FROM terms WHERE id = ?", idParam(req.params.id));
  res.json({ ok: true });
});

// ---------- users & roles ----------
function mapRole(r: any): Role {
  return { id: r.id, name: r.name, description: r.description, permissions: json(r.permissions, []), isSystem: !!r.is_system, userCount: r.user_count };
}
function mapUser(r: any): User {
  return { id: r.id, email: r.email, name: r.name, roleId: r.role_id, roleName: r.role_name, active: !!r.active, twoFactorEnabled: !!r.totp_enabled, lastLoginAt: r.last_login_at, createdAt: r.created_at };
}
const tempPassword = () => crypto.randomBytes(9).toString("base64url");

/** Stops someone with "users.manage" but not full access from granting, or taking over, more than they hold. */
function assertWithinOwnAccess(req: Request, perms: string[], what: string) {
  const mine = new Set(req.user!.permissions);
  const extra = perms.filter((p) => !mine.has(p as Permission));
  if (extra.length) throw new HttpError(403, `You can't ${what}, because it has permissions you don't have yourself (${extra.join(", ")}).`);
}
const rolePerms = (roleId: number): string[] => json(get("SELECT permissions FROM roles WHERE id = ?", roleId)?.permissions, []);
const userPerms = (userId: number): string[] => rolePerms(get("SELECT role_id FROM users WHERE id = ?", userId)?.role_id ?? 0);

core.get("/roles", (_req, res) =>
  res.json(all("SELECT r.*, (SELECT COUNT(*) FROM users u WHERE u.role_id = r.id) user_count FROM roles r ORDER BY r.id").map(mapRole)),
);
core.post("/roles", requirePerm("users.manage"), (req, res) => {
  const name = str(req.body?.name, "Role name", { required: true, max: 60 });
  const perms = (Array.isArray(req.body?.permissions) ? req.body.permissions : []).filter((p: string) => ALL_PERMISSIONS.some((a) => a.key === p));
  assertWithinOwnAccess(req, perms, "create this role");
  const r = run("INSERT INTO roles(name, description, permissions) VALUES(?,?,?)", name, str(req.body?.description, "Description", { max: 300 }), JSON.stringify(perms));
  logActivity(req.user!.id, "created", "role", r.lastId, name);
  res.json({ id: r.lastId });
});
core.put("/roles/:id", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const role = get("SELECT * FROM roles WHERE id = ?", id) ?? notFound("Role");
  let perms = (Array.isArray(req.body?.permissions) ? req.body.permissions : []).filter((p: string) => ALL_PERMISSIONS.some((a) => a.key === p));
  if (role.is_system && role.name === "Administrator") perms = ALL_PERMISSIONS.map((p) => p.key); // never lock everyone out
  assertWithinOwnAccess(req, [...perms, ...json<string[]>(role.permissions, [])], "change this role");
  run("UPDATE roles SET name = ?, description = ?, permissions = ? WHERE id = ?", role.is_system ? role.name : str(req.body?.name, "Role name", { required: true, max: 60 }), str(req.body?.description, "Description", { max: 300 }), JSON.stringify(perms), id);
  logActivity(req.user!.id, "updated", "role", id, role.name);
  res.json({ ok: true });
});
core.delete("/roles/:id", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const role = get("SELECT * FROM roles WHERE id = ?", id) ?? notFound("Role");
  if (role.is_system) throw new HttpError(400, "Built-in roles can't be deleted.");
  if (get("SELECT 1 FROM users WHERE role_id = ?", id)) throw new HttpError(400, "Move the users in this role to another role first.");
  run("DELETE FROM roles WHERE id = ?", id);
  res.json({ ok: true });
});

core.get("/users", requirePerm("users.manage"), (_req, res) =>
  res.json(all("SELECT u.*, r.name role_name FROM users u JOIN roles r ON r.id = u.role_id ORDER BY u.name").map(mapUser)),
);
core.post("/users", requirePerm("users.manage"), (req, res) => {
  const email = str(req.body?.email, "Email", { required: true, max: 200 }).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "Enter a valid email address.");
  const name = str(req.body?.name, "Name", { required: true, max: 120 });
  const roleId = int(req.body?.roleId, "Role");
  if (!get("SELECT 1 FROM roles WHERE id = ?", roleId)) throw new HttpError(400, "Choose a role.");
  assertWithinOwnAccess(req, rolePerms(roleId), "give someone this role");
  if (get("SELECT 1 FROM users WHERE email = ?", email)) throw new HttpError(409, "Someone with that email already has an account.");
  const password = tempPassword();
  const r = run("INSERT INTO users(email, name, password_hash, role_id, created_at) VALUES(?,?,?,?,?)", email, name, hashPassword(password), roleId, now());
  logActivity(req.user!.id, "invited", "user", r.lastId, name);
  res.json({ id: r.lastId, temporaryPassword: password });
});
core.put("/users/:id", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const u = get("SELECT * FROM users WHERE id = ?", id) ?? notFound("User");
  const roleId = int(req.body?.roleId ?? u.role_id, "Role");
  const active = req.body?.active === undefined ? !!u.active : !!req.body.active;
  if (id === req.user!.id && (!active || roleId !== u.role_id)) throw new HttpError(400, "You can't deactivate yourself or change your own role.");
  assertWithinOwnAccess(req, [...rolePerms(u.role_id), ...rolePerms(roleId)], "change this person's account");
  run("UPDATE users SET name = ?, role_id = ?, active = ? WHERE id = ?", str(req.body?.name ?? u.name, "Name", { required: true, max: 120 }), roleId, active, id);
  if (!active) run("DELETE FROM sessions WHERE user_id = ?", id);
  res.json({ ok: true });
});
core.post("/users/:id/reset-2fa", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const u = get("SELECT name FROM users WHERE id = ?", id) ?? notFound("User");
  assertWithinOwnAccess(req, userPerms(id), "reset this person's two-factor sign-in");
  run("UPDATE users SET totp_secret = NULL, totp_pending = NULL, totp_enabled = 0, totp_recovery = '[]', totp_last_step = 0 WHERE id = ?", id);
  run("DELETE FROM sessions WHERE user_id = ?", id);
  logActivity(req.user!.id, "reset two-factor sign-in for", "user", id, u.name);
  res.json({ ok: true });
});

core.post("/users/:id/reset-password", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  get("SELECT 1 FROM users WHERE id = ?", id) ?? notFound("User");
  assertWithinOwnAccess(req, userPerms(id), "reset this person's password");
  const password = tempPassword();
  run("UPDATE users SET password_hash = ? WHERE id = ?", hashPassword(password), id);
  run("DELETE FROM sessions WHERE user_id = ?", id);
  res.json({ temporaryPassword: password });
});
core.delete("/users/:id", requirePerm("users.manage"), (req, res) => {
  const id = idParam(req.params.id);
  if (id === req.user!.id) throw new HttpError(400, "You can't delete your own account.");
  assertWithinOwnAccess(req, userPerms(id), "delete this person's account");
  run("DELETE FROM users WHERE id = ?", id);
  res.json({ ok: true });
});

// ---------- revisions (shared) ----------
// Developer code history is only visible to people who can edit that code
const REVISION_PERMS: Record<string, Permission> = { template: "templates.edit", widget: "code.edit", asset: "code.edit", function: "code.edit" };
function checkRevisionAccess(req: Parameters<typeof can>[0], entity: string) {
  const perm = REVISION_PERMS[entity];
  if (perm && !can(req, perm)) throw new HttpError(403, "Your role doesn't allow this. Ask an administrator for access.");
}
core.get("/revisions/:entity/:id", (req, res) => {
  checkRevisionAccess(req, req.params.entity);
  res.json(
    all(
      "SELECT r.id, r.entity, r.entity_id, r.note, r.created_at, u.name user_name FROM revisions r LEFT JOIN users u ON u.id = r.user_id WHERE r.entity = ? AND r.entity_id = ? ORDER BY r.id DESC LIMIT 50",
      req.params.entity,
      idParam(req.params.id),
    ).map((r) => ({ id: r.id, entity: r.entity, entityId: r.entity_id, note: r.note, userName: r.user_name, createdAt: r.created_at })),
  );
});
core.get("/revision/:revId", (req, res) => {
  const r = get("SELECT * FROM revisions WHERE id = ?", idParam(req.params.revId)) ?? notFound("Revision");
  checkRevisionAccess(req, r.entity);
  res.json({ id: r.id, data: json(r.data, {}), createdAt: r.created_at, note: r.note });
});
