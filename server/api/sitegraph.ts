import { Router } from "express";
import { all, json } from "../db";
import { computePaths } from "../render/site";
import { itemUrl, mapType } from "../content";
import type { PageLayout, SiteGraph, SiteGraphEdge, SiteGraphNode } from "../../shared/types";

/** Walks every widget prop and yields string values that look like links. */
function* linkTargets(layout: PageLayout): Generator<string> {
  const URL_KEYS = /^(url|link|ctaUrl|cta2Url|secondUrl|href)$/;
  const visit = function* (v: unknown, key = ""): Generator<string> {
    if (typeof v === "string") {
      if (URL_KEYS.test(key)) yield v;
      // links inside rich text / code blocks
      for (const m of v.matchAll(/href\s*=\s*["']([^"']+)["']/g)) yield m[1];
    } else if (Array.isArray(v)) {
      for (const x of v) yield* visit(x, key);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) yield* visit(x, k);
    }
  };
  for (const s of layout.sections ?? []) for (const c of s.columns ?? []) for (const w of c.widgets ?? []) yield* visit(w.props);
}

function normalisePath(href: string): string | null {
  const h = href.trim();
  if (!h.startsWith("/") || h.startsWith("//")) return null; // external, anchors, mailto: …
  const p = h.split(/[?#]/)[0].replace(/\/+$/, "");
  return (p || "/").toLowerCase();
}

/**
 * The whole site as a graph: pages (with hierarchy and internal links), the
 * content types they list, a sample of each type's items, and embedded forms.
 */
export function buildSiteGraph(opts: { itemsPerType?: number } = {}): SiteGraph {
  const itemsPerType = opts.itemsPerType ?? 40;
  const nodes: SiteGraphNode[] = [];
  const edges: SiteGraphEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (source: string, target: string, kind: SiteGraphEdge["kind"]) => {
    if (source === target) return;
    const k = `${source}>${target}`;
    if (edgeKeys.has(k) || edgeKeys.has(`${target}>${source}`)) return;
    edgeKeys.add(k);
    edges.push({ source, target, kind });
  };

  const since = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const views = new Map(all<{ path: string; v: number }>("SELECT path, SUM(views) v FROM page_views WHERE day >= ? GROUP BY path", since).map((r) => [r.path.toLowerCase(), r.v]));

  // ---- pages ----
  const rows = all<any>("SELECT * FROM pages ORDER BY sort, id");
  const paths = computePaths(rows);
  const byPath = new Map<string, string>();
  const depthOf = (id: number, guard = 0): number => {
    const r = rows.find((x) => x.id === id);
    return r?.parent_id && guard < 30 ? 1 + depthOf(r.parent_id, guard + 1) : 0;
  };
  const layouts = new Map<number, PageLayout>();
  for (const r of rows) {
    const layout = json<PageLayout>(r.layout, { sections: [] });
    layouts.set(r.id, layout);
    const path = paths.get(r.id) ?? "/";
    const id = `page:${r.id}`;
    byPath.set(path.toLowerCase(), id);
    const widgets = (layout.sections ?? []).reduce((a, s) => a + s.columns.reduce((b, c) => b + c.widgets.length, 0), 0);
    nodes.push({
      id,
      kind: r.is_home ? "home" : "page",
      label: r.title,
      path,
      status: r.status,
      live: !!r.published,
      changesPending: !!r.published && !!r.published_at && r.published_at < r.updated_at,
      views: views.get(path.toLowerCase()) ?? 0,
      size: widgets,
      depth: r.is_home ? 0 : depthOf(r.id) + 1,
      href: `/pages/${r.id}`,
    });
  }
  const home = rows.find((r) => r.is_home);
  for (const r of rows) {
    if (r.parent_id) addEdge(`page:${r.parent_id}`, `page:${r.id}`, "child");
    else if (home && r.id !== home.id) addEdge(`page:${home.id}`, `page:${r.id}`, "child"); // top-level pages hang off the homepage
  }

  // ---- content types & items ----
  const types = all<any>("SELECT t.*, (SELECT COUNT(*) FROM content_items i WHERE i.type_id = t.id) item_count FROM content_types t ORDER BY t.sort").map(mapType);
  const typeIds = new Map(types.map((t) => [t.key, `type:${t.key}`]));
  for (const t of types) {
    nodes.push({ id: `type:${t.key}`, kind: "type", label: t.name, color: t.color, size: t.itemCount ?? 0, status: "published", live: true, depth: 2, href: `/content/${t.key}` });
    const items = all<any>("SELECT id, title, slug, status FROM content_items WHERE type_id = ? ORDER BY COALESCE(published_at, created_at) DESC LIMIT ?", t.id, itemsPerType);
    for (const it of items) {
      const url = t.hasDetailPages ? itemUrl(t, it) : undefined;
      nodes.push({ id: `item:${it.id}`, kind: "item", label: it.title, path: url, status: it.status, live: it.status === "published", depth: 3, href: `/content/${t.key}/${it.id}`, parent: `type:${t.key}` });
      addEdge(`type:${t.key}`, `item:${it.id}`, "item");
      if (url) byPath.set(url.toLowerCase(), `item:${it.id}`);
    }
  }

  // ---- forms ----
  const forms = all<any>("SELECT id, key, name, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = forms.id) subs FROM forms");
  const formIds = new Map(forms.map((f) => [f.key, `form:${f.id}`]));
  const usedForms = new Set<string>();

  // ---- what each page shows and links to ----
  for (const r of rows) {
    const from = `page:${r.id}`;
    const layout = layouts.get(r.id)!;
    for (const s of layout.sections ?? [])
      for (const c of s.columns ?? [])
        for (const w of c.widgets ?? []) {
          if (w.type === "contentList" && typeIds.has(w.props?.contentType)) addEdge(from, typeIds.get(w.props.contentType)!, "lists");
          if (w.type === "form" && formIds.has(w.props?.formKey)) {
            addEdge(from, formIds.get(w.props.formKey)!, "form");
            usedForms.add(w.props.formKey);
          }
        }
    for (const href of linkTargets(layout)) {
      const p = normalisePath(href);
      const to = p ? byPath.get(p) : undefined;
      if (to) addEdge(from, to, "link");
    }
  }
  for (const f of forms) {
    nodes.push({ id: `form:${f.id}`, kind: "form", label: f.name, status: "published", live: usedForms.has(f.key), size: f.subs, depth: 2, href: `/forms/${f.id}` });
  }

  const count = (k: SiteGraphNode["kind"]) => nodes.filter((n) => n.kind === k).length;
  return {
    nodes,
    edges,
    stats: {
      pages: count("page") + count("home"),
      types: count("type"),
      items: count("item"),
      forms: count("form"),
      links: edges.filter((e) => e.kind === "link").length,
      totalItems: types.reduce((a, t) => a + (t.itemCount ?? 0), 0),
    },
  };
}

export const sitegraph = Router();
sitegraph.get("/site-graph", (req, res) => {
  const per = Math.max(0, Math.min(200, Number(req.query.itemsPerType) || 40));
  res.json(buildSiteGraph({ itemsPerType: per }));
});
