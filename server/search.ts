// Full-text search over published pages and content items (SQLite FTS5).
// The index is rebuilt lazily: publishing anything marks it stale, and the
// next search rebuilds it. That stays fast for the sites Reef is meant for.
import { all, db, json } from "./db";
import { computePaths, type PageSnapshot } from "./render/site";
import { itemUrl, mapType } from "./content";
import type { PageLayout } from "../shared/types";

db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  kind UNINDEXED, ref UNINDEXED, url UNINDEXED, title, body,
  tokenize = 'porter unicode61 remove_diacritics 2'
)`);

let builtFor = "";
/**
 * A cheap fingerprint of everything that's public. It changes whenever a page
 * or item is published, edited, moved or removed, by any process or worker.
 */
function fingerprint(): string {
  const r = all<{ f: string }>(
    `SELECT (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(MAX(published_at), '') || ':' || IFNULL(group_concat(id || '.' || IFNULL(parent_id, 0) || '.' || slug || '.' || is_home || '.' || (published IS NOT NULL), ','), '') FROM pages)
       || '|' || (SELECT COUNT(*) || ':' || IFNULL(MAX(updated_at), '') || ':' || IFNULL(SUM(status = 'published'), 0) FROM content_items)
       || '|' || (SELECT IFNULL(group_concat(key || '.' || url_prefix || '.' || has_detail_pages, ','), '') FROM content_types) AS f`,
  );
  return r[0]?.f ?? "";
}

/** Forces a rebuild on the next search. */
export function markSearchDirty() {
  builtFor = "";
}

// prop keys that hold code, links or settings rather than readable text
const SKIP_KEYS = /^(_.*|url|link|href|src|image|images|avatar|bgImage|ctaUrl|cta2Url|secondUrl|code|css|js|props|template|style|color|bgColor|contentType|formKey|level|align|variant|size|ratio|height|columns|layout|sort|limit|width|gap|valign|source|direction|tag|category)$/;

function stripHtml(s: string) {
  return s
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(v: unknown, key = "", out: string[] = []): string[] {
  if (SKIP_KEYS.test(key)) return out;
  if (typeof v === "string") {
    if (v && !/^(https?:|mailto:|tel:|\/|#)/.test(v.trim())) out.push(stripHtml(v));
  } else if (Array.isArray(v)) v.forEach((x) => textOf(x, key, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) textOf(x, k, out);
  return out;
}

function layoutText(layout: PageLayout) {
  const parts: string[] = [];
  for (const s of layout.sections ?? []) for (const c of s.columns ?? []) for (const w of c.widgets ?? []) textOf(w.props, "", parts);
  return parts.join(" \n ");
}

export function rebuildSearchIndex() {
  const insert = db.prepare("INSERT INTO search_index(kind, ref, url, title, body) VALUES(?, ?, ?, ?, ?)");
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM search_index");
    const paths = computePaths();
    for (const p of all<any>("SELECT id, published FROM pages WHERE published IS NOT NULL")) {
      const snap = json<PageSnapshot>(p.published, null as any);
      if (!snap || snap.seo?.noIndex) continue;
      insert.run("page", String(p.id), paths.get(p.id) ?? "/", snap.title, [snap.seo?.metaDescription ?? "", layoutText(snap.layout)].join(" \n "));
    }
    for (const t of all<any>("SELECT * FROM content_types WHERE has_detail_pages = 1").map(mapType)) {
      const fields = t.fields.filter((f) => ["text", "textarea", "richtext", "tags"].includes(f.type));
      for (const it of all<any>("SELECT id, title, slug, data, tags FROM content_items WHERE type_id = ? AND status = 'published'", t.id)) {
        const data = json<Record<string, unknown>>(it.data, {});
        const body = [...fields.map((f) => data[f.key]).flatMap((v) => textOf(v)), ...json<string[]>(it.tags, [])].join(" \n ");
        insert.run(t.key, String(it.id), itemUrl(t, it), it.title, body);
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface SearchHit {
  kind: string;
  url: string;
  title: string;
  /** HTML: escaped text with matches wrapped in <mark> */
  snippet: string;
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Turns what someone typed into a safe FTS5 query: every word must match, the last as a prefix. */
export function toFtsQuery(q: string) {
  const words = q
    .toLowerCase()
    .replace(/["*^:(){}[\]]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/^(and|or|not|near)$/.test(w))
    .slice(0, 12);
  if (!words.length) return "";
  return words.map((w, i) => `"${w}"${i === words.length - 1 && w.length > 1 ? "*" : ""}`).join(" ");
}

export function search(q: string, limit = 10): SearchHit[] {
  const fts = toFtsQuery(q);
  if (!fts) return [];
  const f = fingerprint();
  if (f !== builtFor) {
    rebuildSearchIndex();
    builtFor = f;
  }
  const rows = all<{ kind: string; url: string; title: string; snip: string }>(
    // titles count ten times as much as body text
    `SELECT kind, url, title, snippet(search_index, 4, char(1), char(2), '…', 18) AS snip
     FROM search_index WHERE search_index MATCH ? ORDER BY bm25(search_index, 0, 0, 0, 10.0, 1.0) LIMIT ?`,
    fts,
    Math.max(1, Math.min(50, limit)),
  );
  return rows.map((r) => ({
    kind: r.kind,
    url: r.url,
    title: r.title,
    snippet: escapeHtml(r.snip ?? "").replace(/\u0001/g, "<mark>").replace(/\u0002/g, "</mark>"),
  }));
}
