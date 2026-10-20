import { Router, type Request } from "express";
import { all, get, run, json, now, logActivity, saveRevision, slugify, tx } from "../db";
import { requirePerm, can, HttpError } from "../auth";
import { str, idParam, notFound } from "../http";
import { computePaths, renderPageSnapshot, type PageSnapshot } from "../render/site";
import type { Page, PageLayout } from "../../shared/types";
import { emit } from "../functions";
import { makeSection, makeWidget, getWidgetDef } from "../../shared/widgets";

export const pages = Router();

function snapshotOf(r: any): PageSnapshot {
  return {
    title: r.title,
    layout: json<PageLayout>(r.layout, { sections: [] }),
    seo: json(r.seo, {}),
    customCss: r.custom_css,
    customJs: r.custom_js,
    customHead: r.custom_head,
    templateId: r.template_id,
  };
}

function mapPage(r: any, paths: Map<number, string>): Page {
  const snap = snapshotOf(r);
  return {
    id: r.id,
    parentId: r.parent_id,
    title: r.title,
    slug: r.slug,
    path: paths.get(r.id) ?? "/",
    sort: r.sort,
    templateId: r.template_id,
    status: r.status,
    hasUnpublishedChanges: r.published ? JSON.stringify(snap) !== JSON.stringify(json(r.published, {})) : true,
    showInNav: !!r.show_in_nav,
    isHome: !!r.is_home,
    seo: snap.seo,
    layout: snap.layout,
    customCss: r.custom_css,
    customJs: r.custom_js,
    customHead: r.custom_head,
    publishAt: r.publish_at,
    publishedAt: r.published_at,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by_name ?? null,
  };
}

const PAGE_SELECT = "SELECT p.*, u.name updated_by_name FROM pages p LEFT JOIN users u ON u.id = p.updated_by";

function loadPage(id: number): Page {
  const r = get(`${PAGE_SELECT} WHERE p.id = ?`, id) ?? notFound("Page");
  return mapPage(r, computePaths());
}

function uniqueSlug(parentId: number | null, base: string, exceptId?: number) {
  let slug = base;
  for (let i = 2; ; i++) {
    const clash = get("SELECT id FROM pages WHERE COALESCE(parent_id, 0) = ? AND slug = ? AND id != ?", parentId ?? 0, slug, exceptId ?? 0);
    if (!clash) return slug;
    slug = `${base}-${i}`;
  }
}

pages.get("/pages", (_req, res) => {
  const paths = computePaths();
  const rows = all(`${PAGE_SELECT} ORDER BY p.sort, p.id`);
  res.json(
    rows.map((r) => {
      const { layout, customCss, customJs, customHead, ...rest } = mapPage(r, paths);
      return { ...rest, widgetCount: layout.sections.reduce((a, s) => a + s.columns.reduce((b, c) => b + c.widgets.length, 0), 0) };
    }),
  );
});

pages.get("/pages/:id", (req, res) => res.json(loadPage(idParam(req.params.id))));

const STARTERS: Record<string, () => PageLayout> = {
  blank: () => ({ sections: [] }),
  landing: () => ({
    sections: [
      makeSection([12], [[makeWidget("hero", getWidgetDef("hero")!.defaults)]]),
      makeSection([12], [[makeWidget("heading", { text: "Why it matters", level: "h2", align: "center", eyebrow: "Benefits" }), makeWidget("features", getWidgetDef("features")!.defaults)]]),
      makeSection([6, 6], [[makeWidget("heading", { text: "Tell your story", level: "h2" }), makeWidget("text", getWidgetDef("text")!.defaults), makeWidget("button", getWidgetDef("button")!.defaults)], [makeWidget("image", { src: "", rounded: true })]]),
    ],
  }),
  article: () => ({
    sections: [
      { ...makeSection([12], [[makeWidget("heading", { text: "Article title", level: "h1" }), makeWidget("text", { html: "<p class=\"lead\">An introductory paragraph that sets the scene.</p><p>Body copy goes here.</p>", size: "md" })]]), props: { width: "narrow", paddingY: "xl", background: "none", gap: "md", valign: "start" } },
    ],
  }),
  contact: () => ({
    sections: [
      makeSection([7, 5], [
        [makeWidget("heading", { text: "Get in touch", level: "h1" }), makeWidget("text", { html: "<p>We usually reply within one working day.</p>" }), makeWidget("form", { formKey: "contact" })],
        [makeWidget("map", { address: "Suva, Fiji", height: 420 })],
      ]),
    ],
  }),
};

pages.post("/pages", requirePerm("pages.edit"), (req, res) => {
  const title = str(req.body?.title, "Title", { required: true, max: 160 });
  const parentId = req.body?.parentId ? idParam(req.body.parentId) : null;
  if (parentId && !get("SELECT 1 FROM pages WHERE id = ?", parentId)) throw new HttpError(400, "The parent page no longer exists.");
  const slug = uniqueSlug(parentId, slugify(str(req.body?.slug, "URL") || title));
  const templateId = req.body?.templateId ? Number(req.body.templateId) : get("SELECT id FROM templates ORDER BY is_default DESC, id LIMIT 1")?.id ?? null;
  let layout: PageLayout = (STARTERS[req.body?.starter] ?? STARTERS.blank)();
  let extra: any = {};
  if (req.body?.copyFrom) {
    const src = get("SELECT * FROM pages WHERE id = ?", idParam(req.body.copyFrom)) ?? notFound("Source page");
    layout = json(src.layout, { sections: [] });
    extra = { seo: src.seo, css: src.custom_css, js: src.custom_js, head: src.custom_head };
  }
  const sort = (get("SELECT MAX(sort) m FROM pages WHERE COALESCE(parent_id,0) = ?", parentId ?? 0)?.m ?? 0) + 1;
  const r = run(
    "INSERT INTO pages(parent_id, title, slug, sort, template_id, layout, seo, custom_css, custom_js, custom_head, show_in_nav, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    parentId,
    title,
    slug,
    sort,
    templateId,
    JSON.stringify(layout),
    extra.seo ?? "{}",
    extra.css ?? "",
    extra.js ?? "",
    extra.head ?? "",
    req.body?.showInNav === false ? 0 : 1,
    now(),
    req.user!.id,
  );
  logActivity(req.user!.id, "created", "page", r.lastId, title);
  res.json(loadPage(r.lastId));
});

pages.put("/pages/:id", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT * FROM pages WHERE id = ?", id) ?? notFound("Page");
  const b = req.body ?? {};
  if (b.baseUpdatedAt && b.baseUpdatedAt !== row.updated_at && !b.force) {
    const by = get("SELECT name FROM users WHERE id = ?", row.updated_by)?.name ?? "Someone";
    throw new HttpError(409, `${by} saved this page after you opened it. Reload to see their changes, or overwrite them.`, { conflict: true });
  }
  const title = b.title !== undefined ? str(b.title, "Title", { required: true, max: 160 }) : row.title;
  const parentId = b.parentId !== undefined ? (b.parentId ? idParam(b.parentId) : null) : row.parent_id;
  if (parentId === id) throw new HttpError(400, "A page can't be its own parent.");
  // stop cycles: the new parent must not be a descendant
  if (parentId) {
    let cur: number | null = parentId;
    for (let guard = 0; cur && guard < 50; guard++) {
      if (cur === id) throw new HttpError(400, "A page can't be moved under one of its own sub-pages.");
      cur = get("SELECT parent_id FROM pages WHERE id = ?", cur)?.parent_id ?? null;
    }
  }
  const slug = b.slug !== undefined ? uniqueSlug(parentId, slugify(String(b.slug) || title), id) : row.slug;
  const layout = b.layout !== undefined ? JSON.stringify(b.layout) : row.layout;
  if (layout.length > 2_000_000) throw new HttpError(413, "This page is too large to save. Split it into smaller pages.");
  assertCodeUnchanged(req, row, b, layout);
  if (b.publishAt && b.publishAt !== row.publish_at && !can(req, "pages.publish")) throw new HttpError(403, "Scheduling a page to publish needs permission to publish pages. Send it for review instead.");
  if (row.published && (slug !== row.slug || parentId !== row.parent_id) && !can(req, "pages.publish")) {
    throw new HttpError(403, "This page is live, so moving it or changing its address needs permission to publish pages.");
  }
  // A live page keeps "published"; pending edits show via hasUnpublishedChanges.
  const status = row.status === "review" ? "review" : row.published ? "published" : "draft";
  const updatedAt = now();
  run(
    `UPDATE pages SET title=?, slug=?, parent_id=?, template_id=?, show_in_nav=?, seo=?, layout=?, custom_css=?, custom_js=?, custom_head=?, publish_at=?, status=?, updated_at=?, updated_by=? WHERE id=?`,
    title,
    slug,
    parentId,
    b.templateId !== undefined ? b.templateId || null : row.template_id,
    b.showInNav !== undefined ? !!b.showInNav : !!row.show_in_nav,
    b.seo !== undefined ? JSON.stringify(b.seo) : row.seo,
    layout,
    b.customCss ?? row.custom_css,
    b.customJs ?? row.custom_js,
    b.customHead ?? row.custom_head,
    b.publishAt !== undefined ? b.publishAt || null : row.publish_at,
    b.publishAt ? "scheduled" : status,
    updatedAt,
    req.user!.id,
    id,
  );
  // Revision on every save, but coalesce rapid autosaves (one per 2 minutes per user)
  const lastRev = get("SELECT created_at, user_id FROM revisions WHERE entity='page' AND entity_id=? ORDER BY id DESC LIMIT 1", id);
  if (!lastRev || lastRev.user_id !== req.user!.id || Date.now() - new Date(lastRev.created_at).getTime() > 120_000) {
    saveRevision("page", id, snapshotOf(get("SELECT * FROM pages WHERE id = ?", id)), req.user!.id, b.note || "Saved draft");
  }
  res.json(loadPage(id));
});

// Raw HTML/JS that runs in visitors' (and editors') browsers. Only people with "pages.code" may add or change it.
const CODE_WIDGETS = new Set(["html", "react"]);
function codeBlocks(layoutJson: string): string {
  const out: string[] = [];
  try {
    const l = JSON.parse(layoutJson);
    for (const s of l?.sections ?? []) for (const c of s?.columns ?? []) for (const w of c?.widgets ?? []) if (CODE_WIDGETS.has(w?.type)) out.push(JSON.stringify([w.type, w.props ?? {}]));
  } catch {
    // an unparseable layout has no code blocks
  }
  return out.sort().join("\n");
}
function assertCodeUnchanged(req: Request, row: any, b: any, layout: string) {
  if (can(req, "pages.code")) return;
  const changed =
    (b.customHead !== undefined && b.customHead !== row.custom_head) ||
    (b.customJs !== undefined && b.customJs !== row.custom_js) ||
    codeBlocks(layout) !== codeBlocks(row.layout);
  if (changed) throw new HttpError(403, "Adding or changing Code blocks, React blocks, page JavaScript or <head> tags needs the “Add code to pages” permission.", { needsPermission: "pages.code" });
}

export function publishPage(id: number, userId: number | null) {
  const row = get("SELECT * FROM pages WHERE id = ?", id) ?? notFound("Page");
  const snap = snapshotOf(row);
  run("UPDATE pages SET published = ?, status = 'published', published_at = ?, publish_at = NULL WHERE id = ?", JSON.stringify(snap), now(), id);
  saveRevision("page", id, snap, userId, "Published");
  logActivity(userId, "published", "page", id, row.title);
  emit("page.published", { id, title: row.title, slug: row.slug });
}

pages.post("/pages/:id/publish", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  if (!can(req, "pages.publish")) {
    run("UPDATE pages SET status = 'review', updated_at = ? WHERE id = ?", now(), id);
    logActivity(req.user!.id, "sent for review", "page", id, get("SELECT title FROM pages WHERE id = ?", id)?.title ?? "");
    return res.json({ ...loadPage(id), sentForReview: true });
  }
  publishPage(id, req.user!.id);
  res.json(loadPage(id));
});

pages.post("/pages/:id/unpublish", requirePerm("pages.publish"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT title, is_home FROM pages WHERE id = ?", id) ?? notFound("Page");
  run("UPDATE pages SET published = NULL, status = 'draft', published_at = NULL WHERE id = ?", id);
  logActivity(req.user!.id, "unpublished", "page", id, row.title);
  res.json(loadPage(id));
});

pages.post("/pages/:id/discard", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT * FROM pages WHERE id = ?", id) ?? notFound("Page");
  if (!row.published) throw new HttpError(400, "This page has never been published, so there is nothing to revert to.");
  const s = json<PageSnapshot>(row.published, null as any);
  run(
    "UPDATE pages SET title=?, layout=?, seo=?, custom_css=?, custom_js=?, custom_head=?, template_id=?, status='published', updated_at=? WHERE id=?",
    s.title,
    JSON.stringify(s.layout),
    JSON.stringify(s.seo ?? {}),
    s.customCss ?? "",
    s.customJs ?? "",
    s.customHead ?? "",
    s.templateId,
    now(),
    id,
  );
  res.json(loadPage(id));
});

pages.post("/pages/:id/restore/:revId", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = get("SELECT * FROM revisions WHERE id = ? AND entity = 'page' AND entity_id = ?", idParam(req.params.revId), id) ?? notFound("Revision");
  const s = json<PageSnapshot>(rev.data, null as any);
  run(
    "UPDATE pages SET title=?, layout=?, seo=?, custom_css=?, custom_js=?, custom_head=?, template_id=?, status = CASE WHEN published IS NULL THEN 'draft' ELSE 'draft' END, updated_at=?, updated_by=? WHERE id=?",
    s.title,
    JSON.stringify(s.layout),
    JSON.stringify(s.seo ?? {}),
    s.customCss ?? "",
    s.customJs ?? "",
    s.customHead ?? "",
    s.templateId,
    now(),
    req.user!.id,
    id,
  );
  saveRevision("page", id, s, req.user!.id, `Restored version from ${rev.created_at.slice(0, 16).replace("T", " ")}`);
  logActivity(req.user!.id, "restored a version of", "page", id, s.title);
  res.json(loadPage(id));
});

pages.post("/pages/:id/duplicate", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const src = get("SELECT * FROM pages WHERE id = ?", id) ?? notFound("Page");
  const title = `${src.title} (copy)`;
  const slug = uniqueSlug(src.parent_id, `${src.slug}-copy`);
  const r = run(
    "INSERT INTO pages(parent_id, title, slug, sort, template_id, layout, seo, custom_css, custom_js, custom_head, show_in_nav, updated_at, updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    src.parent_id,
    title,
    slug,
    src.sort + 1,
    src.template_id,
    src.layout,
    src.seo,
    src.custom_css,
    src.custom_js,
    src.custom_head,
    0,
    now(),
    req.user!.id,
  );
  logActivity(req.user!.id, "duplicated", "page", r.lastId, title);
  res.json(loadPage(r.lastId));
});

pages.post("/pages/:id/home", requirePerm("pages.publish"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT parent_id, title FROM pages WHERE id = ?", id) ?? notFound("Page");
  if (row.parent_id) throw new HttpError(400, "Only a top-level page can be the homepage. Move it to the top level first.");
  tx(() => {
    run("UPDATE pages SET is_home = 0");
    run("UPDATE pages SET is_home = 1 WHERE id = ?", id);
  });
  logActivity(req.user!.id, "set as homepage", "page", id, row.title);
  res.json({ ok: true });
});

pages.put("/pages-order", requirePerm("pages.edit"), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  tx(() => {
    for (const it of items) {
      const id = idParam(it.id);
      const parentId = it.parentId ? idParam(it.parentId) : null;
      const isHome = get("SELECT is_home FROM pages WHERE id = ?", id)?.is_home;
      if (isHome && parentId) throw new HttpError(400, "The homepage must stay at the top level.");
      run("UPDATE pages SET parent_id = ?, sort = ? WHERE id = ?", parentId, Number(it.sort) || 0, id);
    }
  });
  res.json({ ok: true });
});

pages.delete("/pages/:id", requirePerm("pages.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT title, is_home, published FROM pages WHERE id = ?", id) ?? notFound("Page");
  if (row.published && !can(req, "pages.publish")) throw new HttpError(403, "This page is live, so deleting it needs permission to publish pages.");
  if (row.is_home) throw new HttpError(400, "This is the homepage. Choose another homepage before deleting it.");
  const children = get("SELECT COUNT(*) n FROM pages WHERE parent_id = ?", id)!.n;
  if (children && req.query.withChildren !== "1") throw new HttpError(409, `This page has ${children} sub-page${children > 1 ? "s" : ""}. Delete them too?`, { children });
  run("DELETE FROM pages WHERE id = ?", id);
  logActivity(req.user!.id, "deleted", "page", id, row.title);
  res.json({ ok: true });
});

/** Render the given (unsaved) page state for the editor canvas. */
pages.post("/render/page/:id", requirePerm("pages.edit"), async (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT * FROM pages WHERE id = ?", id) ?? notFound("Page");
  const b = req.body ?? {};
  const snap: PageSnapshot = {
    title: b.title ?? row.title,
    layout: b.layout ?? json(row.layout, { sections: [] }),
    seo: b.seo ?? json(row.seo, {}),
    customCss: b.customCss ?? row.custom_css,
    customJs: b.customJs ?? row.custom_js,
    customHead: b.customHead ?? row.custom_head,
    templateId: b.templateId !== undefined ? b.templateId : row.template_id,
  };
  const html = await renderPageSnapshot({ id, parentId: row.parent_id, slug: row.slug, path: computePaths().get(id) ?? "/" }, snap, { editor: b.mode !== "preview" });
  res.type("html").send(html);
});
