import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

export const DATA_DIR = path.resolve(process.env.REEF_DATA_DIR ?? "./data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, "reef.db"));
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 4000;");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  permissions TEXT NOT NULL DEFAULT '[]',
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role_id INTEGER NOT NULL REFERENCES roles(id),
  active INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  html TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  js TEXT NOT NULL DEFAULT '',
  head TEXT NOT NULL DEFAULT '',
  is_default INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  show_in_nav INTEGER NOT NULL DEFAULT 1,
  is_home INTEGER NOT NULL DEFAULT 0,
  seo TEXT NOT NULL DEFAULT '{}',
  layout TEXT NOT NULL DEFAULT '{"sections":[]}',
  custom_css TEXT NOT NULL DEFAULT '',
  custom_js TEXT NOT NULL DEFAULT '',
  custom_head TEXT NOT NULL DEFAULT '',
  published TEXT,
  publish_at TEXT,
  published_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY,
  entity TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS revisions_entity ON revisions(entity, entity_id);
CREATE TABLE IF NOT EXISTS content_types (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  singular TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'FileText',
  color TEXT NOT NULL DEFAULT '#6366f1',
  description TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]',
  url_prefix TEXT NOT NULL DEFAULT '',
  has_detail_pages INTEGER NOT NULL DEFAULT 1,
  detail_template TEXT NOT NULL DEFAULT '',
  list_template TEXT NOT NULL DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS content_items (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES content_types(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'draft',
  tags TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  publish_at TEXT,
  published_at TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(type_id, slug)
);
CREATE TABLE IF NOT EXISTS media (
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL DEFAULT '',
  filename TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  width INTEGER,
  height INTEGER,
  alt TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS media_folders (
  name TEXT PRIMARY KEY
);
CREATE TABLE IF NOT EXISTS forms (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  fields TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS form_submissions (
  id INTEGER PRIMARY KEY,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  page_path TEXT,
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY,
  taxonomy TEXT NOT NULL,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  parent_id INTEGER REFERENCES terms(id) ON DELETE SET NULL,
  description TEXT NOT NULL DEFAULT '',
  UNIQUE(taxonomy, slug)
);
CREATE TABLE IF NOT EXISTS custom_widgets (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'Puzzle',
  category TEXT NOT NULL DEFAULT 'Custom',
  description TEXT NOT NULL DEFAULT '',
  fields TEXT NOT NULL DEFAULT '[]',
  template TEXT NOT NULL DEFAULT '',
  css TEXT NOT NULL DEFAULT '',
  js TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS code_assets (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT 'head',
  content TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS functions (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT 'ANY',
  event TEXT NOT NULL DEFAULT '',
  interval_minutes INTEGER NOT NULL DEFAULT 60,
  code TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  is_public INTEGER NOT NULL DEFAULT 1,
  last_run_at TEXT,
  last_status TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS function_logs (
  id INTEGER PRIMARY KEY,
  function_id INTEGER REFERENCES functions(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS redirects (
  id INTEGER PRIMARY KEY,
  from_path TEXT NOT NULL UNIQUE,
  to_path TEXT NOT NULL,
  code INTEGER NOT NULL DEFAULT 301,
  hits INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS page_views (
  day TEXT NOT NULL,
  path TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path)
);
`;
db.exec(SCHEMA);

// Additive migrations for databases created by earlier versions.
function addColumn(table: string, column: string, ddl: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}
addColumn("custom_widgets", "renderer", "TEXT NOT NULL DEFAULT 'liquid'");
addColumn("custom_widgets", "ssr", "INTEGER NOT NULL DEFAULT 1");
addColumn("media", "variants", "TEXT NOT NULL DEFAULT '[]'");
addColumn("media", "focal", "TEXT NOT NULL DEFAULT ''");
addColumn("users", "totp_secret", "TEXT");
addColumn("users", "totp_pending", "TEXT");
addColumn("users", "totp_enabled", "INTEGER NOT NULL DEFAULT 0");
addColumn("users", "totp_recovery", "TEXT NOT NULL DEFAULT '[]'");
addColumn("users", "totp_last_step", "INTEGER NOT NULL DEFAULT 0");

type Params = (string | number | bigint | null | Uint8Array)[];

export function all<T = any>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...(clean(params) as Params)) as T[];
}
export function get<T = any>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...(clean(params) as Params)) as T | undefined;
}
export function run(sql: string, ...params: any[]) {
  const r = db.prepare(sql).run(...(clean(params) as Params));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}
function clean(params: any[]) {
  return params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}

let txDepth = 0;
/** Re-entrant transaction: nested calls become savepoints. */
export function tx<T>(fn: () => T): T {
  const sp = `sp${txDepth}`;
  db.exec(txDepth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
  txDepth++;
  try {
    const out = fn();
    txDepth--;
    db.exec(txDepth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return out;
  } catch (e) {
    txDepth--;
    db.exec(txDepth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}`);
    throw e;
  }
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const now = () => new Date().toISOString();

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "untitled"
  );
}

// ---------- settings ----------
import type { SiteSettings } from "../shared/types";
export const DEFAULT_SETTINGS: SiteSettings = {
  siteName: "My Reef Site",
  tagline: "Built with Reef CMS",
  logo: "",
  favicon: "",
  primaryColor: "#e60000",
  accentColor: "#820000",
  footerText: "© {{ 'now' | date: '%Y' }} My Reef Site. All rights reserved.",
  robotsTxt: "User-agent: *\nAllow: /\n",
  sitemapEnabled: true,
  headlessApiEnabled: true,
  require2fa: false,
  defaultMetaDescription: "",
  socialLinks: [],
  analyticsHead: "",
  tailwindEnabled: true,
  tailwindPreflight: false,
  tailwindCss: `/* Customise Tailwind here. bg-primary and bg-accent already use your brand colours.
   Docs: https://tailwindcss.com/docs/theme */
@theme {
  /* --font-display: "Inter", sans-serif; */
  /* --color-ocean: #00b0ca; */
}

/* @utility card { @apply rounded-3xl bg-white p-8 shadow-xl; } */
`,
};

export function getSettings(): SiteSettings {
  const rows = all<{ key: string; value: string }>("SELECT key, value FROM settings");
  const s: any = { ...DEFAULT_SETTINGS };
  for (const r of rows) s[r.key] = json(r.value, null);
  return s;
}
export function saveSettings(patch: Partial<SiteSettings>) {
  tx(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue;
      run("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, JSON.stringify(v));
    }
  });
}

export function logActivity(userId: number | null, action: string, entity: string, entityId: number | null, label: string) {
  run("INSERT INTO activity(user_id, action, entity, entity_id, label, created_at) VALUES(?,?,?,?,?,?)", userId, action, entity, entityId, label, now());
}

export function saveRevision(entity: string, entityId: number, data: unknown, userId: number | null, note = "", createdAt = now()) {
  run("INSERT INTO revisions(entity, entity_id, data, note, user_id, created_at) VALUES(?,?,?,?,?,?)", entity, entityId, JSON.stringify(data), note, userId, createdAt);
  // keep the 50 most recent revisions per entity
  run(
    "DELETE FROM revisions WHERE entity = ? AND entity_id = ? AND id NOT IN (SELECT id FROM revisions WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 50)",
    entity,
    entityId,
    entity,
    entityId,
  );
}
