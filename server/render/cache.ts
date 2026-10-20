// Public page cache. Rendered HTML is kept in memory and reused until anything it could
// depend on changes. SQLite triggers bump a single version number on every write to those
// tables, so edits show immediately, including writes made by function workers or another
// process. Pages that call server functions (the Liquid `fn` filter) are never cached, and
// REEF_PAGE_CACHE_SECONDS (default 300, 0 = off) bounds anything time-based like {{ "now" | date }}.
import { AsyncLocalStorage } from "node:async_hooks";
import { db, get } from "../db";

// What a public page is rendered from. Each entry is [table, columns whose updates matter],
// so counters like redirect hits or function run stats don't throw the cache away.
const SOURCES: [string, string | null][] = [
  // drafts autosave into layout/seo/custom_* without changing the public page
  ["pages", "parent_id, title, slug, sort, template_id, status, show_in_nav, is_home, published, published_at"],
  ["templates", null],
  ["content_types", null],
  ["content_items", null],
  ["media", null],
  ["forms", null],
  ["terms", null],
  ["custom_widgets", null],
  ["code_assets", null],
  ["settings", null],
  ["redirects", "from_path, to_path, code"],
  ["functions", "route, enabled, kind, code"],
  ["users", "name"], // author names on content
];

db.exec(`CREATE TABLE IF NOT EXISTS cache_version (id INTEGER PRIMARY KEY CHECK (id = 1), v INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO cache_version(id, v) VALUES (1, 0);`);
const tableCols = (t: string) => new Set((db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name));
for (const [table, cols] of SOURCES) {
  const have = tableCols(table);
  if (!have.size) continue;
  const watched = cols?.split(",").map((c) => c.trim()).filter((c) => have.has(c));
  const bump = "BEGIN UPDATE cache_version SET v = v + 1 WHERE id = 1; END";
  db.exec(`CREATE TRIGGER IF NOT EXISTS reef_cache_${table}_ins AFTER INSERT ON ${table} ${bump}`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS reef_cache_${table}_del AFTER DELETE ON ${table} ${bump}`);
  // UPDATE OF fires whenever a column is in the SET list, even unchanged, so compare values instead
  const changed = watched?.length ? ` WHEN ${watched.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(" OR ")}` : "";
  db.exec(`DROP TRIGGER IF EXISTS reef_cache_${table}_upd`);
  db.exec(`CREATE TRIGGER reef_cache_${table}_upd AFTER UPDATE ON ${table}${changed} ${bump}`);
}

const TTL_MS = Math.max(0, Number(process.env.REEF_PAGE_CACHE_SECONDS ?? 300)) * 1000;
const MAX_ENTRIES = 500;
const MAX_BYTES = 64 * 1024 * 1024;

interface Entry {
  status: number;
  html: string;
  version: number;
  expires: number;
}
const entries = new Map<string, Entry>();
let bytes = 0;
export const pageCacheStats = { hits: 0, misses: 0 };

const scope = new AsyncLocalStorage<{ cacheable: boolean }>();

/** Called by anything that makes a render depend on more than the database (e.g. server functions). */
export function markUncacheable() {
  const s = scope.getStore();
  if (s) s.cacheable = false;
}

export const cacheVersion = () => (get<{ v: number }>("SELECT v FROM cache_version WHERE id = 1")?.v ?? 0);

function keyFor(path: string, query: Record<string, string>) {
  const q = Object.keys(query)
    .sort()
    .map((k) => `${k}=${String(query[k])}`)
    .join("&");
  return q ? `${path}?${q}` : path;
}

function remove(key: string) {
  const old = entries.get(key);
  if (!old) return;
  bytes -= old.html.length;
  entries.delete(key);
}

/** Returns the cached render for this path and query, or renders it and caches the result if allowed. */
export async function cachedRender(
  path: string,
  query: Record<string, string>,
  render: () => Promise<{ status: number; html?: string; redirect?: string }>,
): Promise<{ status: number; html?: string; redirect?: string; cached?: boolean }> {
  if (!TTL_MS) return render();
  const key = keyFor(path, query);
  if (key.length > 1024) return render();
  const version = cacheVersion();
  const hit = entries.get(key);
  if (hit && hit.version === version && hit.expires > Date.now()) {
    // keep recently used pages at the end, so the oldest are evicted first
    entries.delete(key);
    entries.set(key, hit);
    pageCacheStats.hits++;
    return { status: hit.status, html: hit.html, cached: true };
  }
  pageCacheStats.misses++;
  const state = { cacheable: true };
  const result = await scope.run(state, render);
  // a write during the render could mean the result is already out of date
  if (state.cacheable && result.html !== undefined && !result.redirect && cacheVersion() === version) {
    remove(key);
    entries.set(key, { status: result.status, html: result.html, version, expires: Date.now() + TTL_MS });
    bytes += result.html.length;
    for (const k of entries.keys()) {
      if (entries.size <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
      remove(k);
    }
  }
  return result;
}

export function clearPageCache() {
  entries.clear();
  bytes = 0;
}
