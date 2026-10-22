import { all, get, json, getSettings, run, tx } from "../db";
import { cachedRender } from "./cache";
import type { PageLayout, PageSeo, Template, CodeAsset } from "../../shared/types";
import { renderLayout, type RenderCtx, type NavItem } from "./widgets";
import { renderLiquid, escapeHtml as e, SafeHtml, liquidItem } from "./liquid";
import { getTypeByKey, itemForTemplate, mapItem, itemUrl } from "../content";
import { all as allRows } from "../db";
import { importMapTag } from "../react";
import { buildTailwind, classesFromHtml, classesFromSource, LAYER_ORDER } from "../tailwind";

export interface PageSnapshot {
  title: string;
  layout: PageLayout;
  seo: PageSeo;
  customCss: string;
  customJs: string;
  customHead: string;
  templateId: number | null;
}

interface PageRow {
  id: number;
  parent_id: number | null;
  title: string;
  slug: string;
  sort: number;
  is_home: number;
  show_in_nav: number;
  published: string | null;
}

export function computePaths(rows?: { id: number; parent_id: number | null; slug: string; is_home: number }[]) {
  const list = rows ?? all<PageRow>("SELECT id, parent_id, slug, is_home FROM pages");
  const byId = new Map(list.map((r) => [r.id, r]));
  const cache = new Map<number, string>();
  const pathOf = (id: number, depth = 0): string => {
    if (cache.has(id)) return cache.get(id)!;
    const r = byId.get(id);
    if (!r || depth > 20) return "/";
    const p = r.is_home && !r.parent_id ? "/" : (r.parent_id ? pathOf(r.parent_id, depth + 1).replace(/\/$/, "") : "") + "/" + r.slug;
    cache.set(id, p);
    return p;
  };
  for (const r of list) pathOf(r.id);
  return cache;
}

export function findPageByPath(path: string): PageRow | undefined {
  const rows = all<PageRow>("SELECT id, parent_id, title, slug, sort, is_home, show_in_nav, published FROM pages");
  const paths = computePaths(rows);
  const norm = path === "/" ? "/" : path.replace(/\/+$/, "").toLowerCase();
  for (const r of rows) if (paths.get(r.id)?.toLowerCase() === norm) return r;
  return undefined;
}

export function buildNav(activePath: string, includeDrafts = false): NavItem[] {
  const rows = all<PageRow>("SELECT id, parent_id, title, slug, sort, is_home, show_in_nav, published FROM pages ORDER BY sort, id");
  const paths = computePaths(rows);
  const visible = rows.filter((r) => r.show_in_nav && (includeDrafts || r.published));
  const make = (parent: number | null): NavItem[] =>
    visible
      .filter((r) => (r.parent_id ?? null) === parent)
      .map((r) => {
        const url = paths.get(r.id) ?? "/";
        const title = r.published && !includeDrafts ? (json<PageSnapshot>(r.published, {} as any).title ?? r.title) : r.title;
        return {
          id: r.id,
          title,
          url,
          parentId: r.parent_id,
          active: url === activePath || (url !== "/" && activePath.startsWith(url + "/")),
          children: make(r.id),
        };
      });
  return make(null);
}

function getTemplate(id: number | null): Template {
  const r = (id ? get("SELECT * FROM templates WHERE id = ?", id) : undefined) ?? get("SELECT * FROM templates ORDER BY is_default DESC, id LIMIT 1");
  if (!r) return { id: 0, name: "Blank", html: "{{ content }}", css: "", js: "", head: "", isDefault: true, updatedAt: "" };
  return { id: r.id, name: r.name, html: r.html, css: r.css, js: r.js, head: r.head, isDefault: !!r.is_default, updatedAt: r.updated_at };
}

function codeAssets(): CodeAsset[] {
  return allRows("SELECT * FROM code_assets WHERE enabled = 1 ORDER BY sort, id").map((r: any) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    location: r.location,
    content: r.content,
    enabled: !!r.enabled,
    sort: r.sort,
    updatedAt: r.updated_at,
  }));
}

function assetTag(a: CodeAsset) {
  if (a.kind === "css") return `<style data-asset="${e(a.name)}">\n${a.content}\n</style>`;
  if (a.kind === "js") return `<script data-asset="${e(a.name)}">\n${a.content}\n</script>`;
  return a.content;
}

const safeStyle = (css: string) => css.replace(/<\/style/gi, "<\\/style");
const safeScript = (js: string) => js.replace(/<\/script/gi, "<\\/script");

export interface DocInput {
  title: string;
  path: string;
  pageId: number | null;
  parentId: number | null;
  slug: string;
  seo: PageSeo;
  bodyHtml: string;
  templateId: number | null;
  customCss?: string;
  customJs?: string;
  customHead?: string;
  editor: boolean;
  ctx: RenderCtx;
  extra?: Record<string, unknown>;
}

export async function renderDocument(input: DocInput): Promise<string> {
  const site = input.ctx.site as any;
  const tpl = getTemplate(input.templateId);
  const allAssets = codeAssets();
  const assets = input.editor ? allAssets.filter((a) => a.kind !== "js") : allAssets;
  const pageVars = {
    id: input.pageId,
    title: input.title,
    path: input.path,
    slug: input.slug,
    seo: input.seo,
    ...input.extra,
  };
  const content = `<div id="reef-content" data-reef-root>${input.bodyHtml}</div>`;
  let body = await renderLiquid(tpl.html || "{{ content }}", {
    site,
    page: pageVars,
    nav: input.ctx.nav,
    content: new SafeHtml(content),
    year: new Date().getFullYear(),
    query: input.ctx.query,
  });
  if (!tpl.html.includes("content")) body += content;
  const footerText = await renderLiquid(String(site.footerText ?? ""), { site });
  body = body.replace("<!--reef:footer-->", footerText);

  // Tailwind: utilities for every class in the rendered page, plus classes that
  // only appear in browser-side code (React widgets, scripts)
  const tailwind = await buildTailwind(site, [
    ...classesFromHtml(body),
    ...classesFromHtml(`${tpl.head}${input.customHead ?? ""}`),
    ...input.ctx.sources.flatMap(classesFromSource),
    ...[tpl.js, input.customJs ?? "", ...allAssets.filter((a) => a.kind !== "css").map((a) => a.content), ...input.ctx.js.values()].flatMap(classesFromSource),
  ]);

  const metaTitle = input.seo.metaTitle || (input.path === "/" ? `${site.siteName}${site.tagline ? " — " + site.tagline : ""}` : `${input.title} | ${site.siteName}`);
  const desc = input.seo.metaDescription || site.defaultMetaDescription || "";
  const head = [
    `<meta charset="utf-8">`,
    `<style>${LAYER_ORDER}</style>`,
    // must precede any module script; always present in the editor so React blocks can be added live
    input.ctx.react || input.editor ? importMapTag() : "",
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${e(metaTitle)}</title>`,
    desc ? `<meta name="description" content="${e(desc)}">` : "",
    `<meta property="og:title" content="${e(input.seo.metaTitle || input.title)}">`,
    desc ? `<meta property="og:description" content="${e(desc)}">` : "",
    input.seo.ogImage ? `<meta property="og:image" content="${e(input.seo.ogImage)}">` : "",
    input.seo.canonical ? `<link rel="canonical" href="${e(input.seo.canonical)}">` : "",
    input.seo.noIndex || input.editor ? `<meta name="robots" content="noindex">` : "",
    site.favicon ? `<link rel="icon" href="${e(site.favicon)}">` : `<link rel="icon" type="image/png" href="/_reef/favicon.png">`,
    `<link rel="stylesheet" href="/_reef/site.css">`,
    `<style>:root{--rf-primary:${e(site.primaryColor || "#e60000")};--rf-accent:${e(site.accentColor || "#820000")}}</style>`,
    tailwind ? `<style data-tailwind>
${safeStyle(tailwind)}
</style>` : "",
    tpl.css ? `<style data-template="${e(tpl.name)}">\n${safeStyle(tpl.css)}\n</style>` : "",
    ...assets.filter((a) => a.location === "head").map(assetTag),
    tpl.head,
    input.editor ? "" : site.analyticsHead || "",
    input.customHead ?? "",
    ...[...input.ctx.css.entries()].map(([k, css]) => `<style data-widget="${e(k)}">\n${safeStyle(css)}\n</style>`),
    input.customCss ? `<style data-page-css>\n${safeStyle(input.customCss)}\n</style>` : "",
    input.editor ? `<link rel="stylesheet" href="/_reef/editor.css">` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const tail = [
    `<script src="/_reef/site.js" defer></script>`,
    tpl.js ? `<script data-template-js>\n${safeScript(tpl.js)}\n</script>` : "",
    ...assets.filter((a) => a.location === "body-end").map(assetTag),
    ...(input.editor ? [] : [...input.ctx.js.values()].map((js) => `<script>\n${safeScript(js)}\n</script>`)),
    !input.editor && input.customJs ? `<script data-page-js>\n${safeScript(input.customJs)}\n</script>` : "",
    ...[...input.ctx.modules.entries()].map(([id, code]) => `<script type="module" data-reef-mount="${e(id)}">\n${safeScript(code)}\n</script>`),
    input.editor ? `<script src="/_reef/editor.js"></script>` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `<!doctype html>\n<html lang="en">\n<head>\n${head}\n</head>\n<body class="rf-body page-${e(input.slug || "home")}${input.editor ? " rf-editing" : ""}">\n${body}\n${tail}\n</body>\n</html>`;
}

export function newCtx(path: string, editor: boolean, query: Record<string, string> = {}, page?: { id: number | null; title: string; parentId: number | null }): RenderCtx {
  return {
    editor,
    page: { id: page?.id ?? null, title: page?.title ?? "", parentId: page?.parentId ?? null, path },
    site: getSettings() as any,
    query,
    css: new Map(),
    js: new Map(),
    modules: new Map(),
    sources: [],
    react: false,
    nav: buildNav(path, editor),
  };
}

/** Render a page snapshot (draft or published). */
export async function renderPageSnapshot(
  page: { id: number; parentId: number | null; slug: string; path: string },
  snap: PageSnapshot,
  opts: { editor?: boolean; query?: Record<string, string> } = {},
) {
  const ctx = newCtx(page.path, !!opts.editor, opts.query ?? {}, { id: page.id, title: snap.title, parentId: page.parentId });
  const bodyHtml = await renderLayout(snap.layout, ctx);
  return renderDocument({
    title: snap.title,
    path: page.path,
    pageId: page.id,
    parentId: page.parentId,
    slug: page.slug,
    seo: snap.seo ?? {},
    bodyHtml,
    templateId: snap.templateId,
    customCss: snap.customCss,
    customJs: snap.customJs,
    customHead: snap.customHead,
    editor: !!opts.editor,
    ctx,
  });
}

export interface PageFragment {
  path: string;
  title: string;
  seo: PageSeo;
  html: string;
  css: string[];
  modules: { id: string; src: string }[];
}

/**
 * A published page's body for a headless front end that keeps its own frame
 * (header, footer, fonts). React widgets come back as module addresses for the
 * front end to load and mount with VodaForge's React runtime (/_reef/react.js).
 */
export async function renderFragment(path: string): Promise<PageFragment | null> {
  const page = findPageByPath(path);
  if (!page?.published) return null;
  const snap = json<PageSnapshot>(page.published, null as any);
  const canonical = computePaths().get(page.id) ?? path;
  const ctx = newCtx(canonical, false, {}, { id: page.id, title: snap.title, parentId: page.parent_id });
  const html = await renderLayout(snap.layout, ctx);
  // utilities only: the front end's own base styles stay in charge
  const tailwind = await buildTailwind({ ...(ctx.site as any), tailwindPreflight: false }, [...classesFromHtml(html), ...ctx.sources.flatMap(classesFromSource)]);
  const modules = [...ctx.modules.entries()].flatMap(([id, code]) => {
    const src = code.match(/from\s+"(\/_reef\/rw\/[0-9a-f]+\.js)"/)?.[1];
    return src ? [{ id, src }] : [];
  });
  return {
    path: canonical,
    title: snap.title,
    seo: snap.seo ?? {},
    html,
    css: [tailwind, ...ctx.css.values(), snap.customCss].filter(Boolean),
    modules,
  };
}

/** Public request handler result. Redirects and view counts run every time; the render itself is cached. */
export async function renderPublicPath(path: string, query: Record<string, string>): Promise<{ status: number; html?: string; redirect?: string; cached?: boolean }> {
  // redirects first
  const redirect = get<{ id: number; to_path: string; code: number }>("SELECT id, to_path, code FROM redirects WHERE from_path = ? COLLATE NOCASE", path.replace(/\/+$/, "") || "/");
  if (redirect) {
    run("UPDATE redirects SET hits = hits + 1 WHERE id = ?", redirect.id);
    return { status: redirect.code, redirect: redirect.to_path };
  }
  const result = await cachedRender(path, query, () => renderPath(path, query));
  if (result.status === 200) trackView(path);
  return result;
}

const queryString = (query: Record<string, string>) => {
  const s = new URLSearchParams(query as Record<string, string>).toString();
  return s ? `?${s}` : "";
};

async function renderPath(path: string, query: Record<string, string>): Promise<{ status: number; html?: string; redirect?: string }> {
  const page = findPageByPath(path);
  if (page?.published) {
    const snap = json<PageSnapshot>(page.published, null as any);
    const paths = computePaths();
    // one address per page (/About/ → /about), so views, caching and search engines agree
    const canonical = paths.get(page.id) ?? path;
    if (path !== canonical) return { status: 301, redirect: canonical + queryString(query) };
    const html = await renderPageSnapshot({ id: page.id, parentId: page.parent_id, slug: page.slug, path: paths.get(page.id) ?? path }, snap, { query });
    return { status: 200, html };
  }

  // content detail pages: /{prefix}/{slug}
  const m = path.match(/^\/(.+)\/([^/]+)\/?$/);
  if (m) {
    const types = all<any>("SELECT key, url_prefix FROM content_types WHERE has_detail_pages = 1");
    const t = types.find((x) => (x.url_prefix || x.key).replace(/^\/+|\/+$/g, "") === m[1]);
    if (t) {
      const type = getTypeByKey(t.key)!;
      const row = get("SELECT * FROM content_items WHERE type_id = ? AND slug = ? AND status = 'published'", type.id, decodeURIComponent(m[2]));
      if (row) {
        const canonical = itemUrl(type, row);
        if (path !== canonical) return { status: 301, redirect: canonical + queryString(query) };
        const html = await renderContentDetail(type.key, row, query, false);
        return { status: 200, html };
      }
    }
  }
  return { status: 404, html: await renderNotFound(path) };
}

export async function renderContentDetail(typeKey: string, row: any, query: Record<string, string>, editor: boolean) {
  const type = getTypeByKey(typeKey)!;
  const item = liquidItem(itemForTemplate(type, mapItem(row)));
  const url = itemUrl(type, item);
  const ctx = newCtx(url, editor, query, { id: null, title: item.title, parentId: null });
  // "related" gives templates something useful without extra code
  const related = all("SELECT * FROM content_items WHERE type_id = ? AND status = 'published' AND id != ? ORDER BY COALESCE(published_at, created_at) DESC LIMIT 3", type.id, row.id).map((r) =>
    liquidItem(itemForTemplate(type, mapItem(r))),
  );
  const bodyHtml = await renderLiquid(type.detailTemplate || DEFAULT_DETAIL_TEMPLATE, { item, related, type: { key: type.key, name: type.name, singular: type.singular }, site: ctx.site });
  return renderDocument({
    title: item.title,
    path: url,
    pageId: null,
    parentId: null,
    slug: item.slug,
    seo: { metaTitle: item.data.metaTitle, metaDescription: item.data.metaDescription || item.summary, ogImage: item.image },
    bodyHtml,
    templateId: null,
    editor,
    ctx,
    extra: { item },
  });
}

export const DEFAULT_DETAIL_TEMPLATE = `<article class="rf-article">
  <header class="rf-article-header">
    <a class="rf-back" href="javascript:history.back()">← Back</a>
    <time>{{ item.date | date: "%e %B %Y" }}</time>
    <h1>{{ item.title }}</h1>
    {% if item.summary %}<p class="rf-lead">{{ item.summary }}</p>{% endif %}
  </header>
  {% if item.image %}<img class="rf-article-image" src="{{ item.image }}" srcset="{{ item.image | srcset }}" sizes="(max-width: 800px) 100vw, 760px" alt="" fetchpriority="high">{% endif %}
  <div class="rf-article-body">{{ item.body }}</div>
  {% if item.tags.size > 0 %}<div class="rf-tags">{% for t in item.tags %}<span>{{ t }}</span>{% endfor %}</div>{% endif %}
</article>`;

async function renderNotFound(path: string) {
  const ctx = newCtx(path, false, {});
  return renderDocument({
    title: "Page not found",
    path,
    pageId: null,
    parentId: null,
    slug: "not-found",
    seo: { noIndex: true },
    bodyHtml: `<section class="rf-section rf-py-xl"><div class="rf-container rf-w-narrow rf-align-center"><div class="rf-eyebrow">404</div><h1>We couldn't find that page</h1><p class="rf-lead">It may have moved, or the link might be out of date.</p><p><a class="rf-btn rf-btn-primary rf-btn-md" href="/">Go to the homepage</a></p></div></section>`,
    templateId: null,
    editor: false,
    ctx,
  });
}

// Views are counted in memory and written every few seconds in one transaction, so a busy
// page doesn't cost a database write per visit. Readers call flushViews() first.
const pendingViews = new Map<string, number>();
const VIEW_KEY_LIMIT = 5000; // a flood of random URLs can't grow this without bound

function trackView(path: string) {
  const key = `${new Date().toISOString().slice(0, 10)}|${path.slice(0, 500)}`;
  if (pendingViews.size >= VIEW_KEY_LIMIT && !pendingViews.has(key)) flushViews();
  pendingViews.set(key, (pendingViews.get(key) ?? 0) + 1);
}

export function flushViews() {
  if (!pendingViews.size) return;
  const batch = [...pendingViews];
  pendingViews.clear();
  try {
    tx(() => {
      for (const [key, n] of batch) {
        const i = key.indexOf("|");
        run("INSERT INTO page_views(day, path, views) VALUES(?, ?, ?) ON CONFLICT(day, path) DO UPDATE SET views = views + excluded.views", key.slice(0, i), key.slice(i + 1), n);
      }
    });
  } catch {
    /* analytics must never break rendering */
  }
}
setInterval(flushViews, 5_000).unref();

export function sitemapXml(origin: string) {
  const rows = all<PageRow & { updated_at: string; seo: string }>("SELECT id, parent_id, slug, is_home, published, updated_at, seo FROM pages WHERE published IS NOT NULL");
  const paths = computePaths(all("SELECT id, parent_id, slug, is_home FROM pages"));
  const urls: string[] = [];
  for (const r of rows) {
    const snap = json<PageSnapshot>(r.published, null as any);
    if (snap?.seo?.noIndex) continue;
    urls.push(`<url><loc>${e(origin + (paths.get(r.id) ?? "/"))}</loc><lastmod>${(r.updated_at || "").slice(0, 10)}</lastmod></url>`);
  }
  const types = all<any>("SELECT * FROM content_types WHERE has_detail_pages = 1");
  for (const t of types) {
    const type = getTypeByKey(t.key)!;
    for (const it of all<any>("SELECT slug, updated_at FROM content_items WHERE type_id = ? AND status = 'published'", t.id)) {
      urls.push(`<url><loc>${e(origin + itemUrl(type, it))}</loc><lastmod>${(it.updated_at || "").slice(0, 10)}</lastmod></url>`);
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>`;
}
