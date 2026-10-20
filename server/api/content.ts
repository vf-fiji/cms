import { Router } from "express";
import { all, get, run, json, now, logActivity, saveRevision, slugify, tx } from "../db";
import { requirePerm, can, HttpError } from "../auth";
import { str, key, idParam, notFound } from "../http";
import { mapType, mapItem, getTypeByKey, itemUrl } from "../content";
import { runHooks, emit } from "../functions";
import { renderContentDetail } from "../render/site";
import type { FieldDef } from "../../shared/types";

export const content = Router();

const FIELD_TYPES = new Set(["text", "textarea", "richtext", "number", "boolean", "date", "datetime", "select", "multiselect", "image", "gallery", "file", "url", "email", "color", "code", "reference", "tags", "list"]);
const RESERVED = new Set(["id", "title", "slug", "status", "tags", "categories", "url", "type", "date", "data"]);

function cleanFields(input: unknown): FieldDef[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.map((f: any, i) => {
    const k = key(f?.key, `Field ${i + 1} key`, true);
    if (RESERVED.has(k)) throw new HttpError(400, `“${k}” is reserved. Choose another field key.`);
    if (seen.has(k)) throw new HttpError(400, `Two fields use the key “${k}”. Field keys must be unique.`);
    seen.add(k);
    if (!FIELD_TYPES.has(f?.type)) throw new HttpError(400, `Field “${k}” has an unknown type.`);
    return {
      key: k,
      label: str(f.label, "Field label", { required: true, max: 80 }),
      type: f.type,
      required: !!f.required,
      help: str(f.help, "Help text", { max: 300 }) || undefined,
      placeholder: str(f.placeholder, "Placeholder", { max: 120 }) || undefined,
      options: Array.isArray(f.options) ? f.options.filter((o: any) => o?.value).map((o: any) => ({ value: String(o.value), label: String(o.label || o.value) })) : undefined,
      refType: f.refType || undefined,
      language: f.language || undefined,
      fields: f.type === "list" ? cleanFields(f.fields ?? []) : undefined,
    } as FieldDef;
  });
}

// ---------- types (module builder) ----------
content.get("/types", (_req, res) => {
  res.json(all("SELECT t.*, (SELECT COUNT(*) FROM content_items i WHERE i.type_id = t.id) item_count FROM content_types t ORDER BY t.sort, t.name").map(mapType));
});

content.get("/types/:key", (req, res) => {
  const r = get("SELECT t.*, (SELECT COUNT(*) FROM content_items i WHERE i.type_id = t.id) item_count FROM content_types t WHERE t.key = ?", req.params.key) ?? notFound("Content type");
  res.json(mapType(r));
});

content.post("/types", requirePerm("content.types"), (req, res) => {
  const b = req.body ?? {};
  const name = str(b.name, "Name", { required: true, max: 60 });
  const k = key(b.key || slugify(name).replace(/-/g, "_"), "Key");
  if (get("SELECT 1 FROM content_types WHERE key = ?", k)) throw new HttpError(409, `A content type with key “${k}” already exists.`);
  const fields = b.fields ? cleanFields(b.fields) : [
    { key: "summary", label: "Summary", type: "textarea" },
    { key: "image", label: "Image", type: "image" },
    { key: "body", label: "Body", type: "richtext" },
  ];
  const r = run(
    "INSERT INTO content_types(key, name, singular, icon, color, description, fields, url_prefix, has_detail_pages, sort) VALUES(?,?,?,?,?,?,?,?,?,?)",
    k,
    name,
    str(b.singular, "Singular name", { max: 60 }) || name.replace(/s$/, ""),
    b.icon || "FileText",
    b.color || "#6366f1",
    str(b.description, "Description", { max: 300 }),
    JSON.stringify(fields),
    slugify(b.urlPrefix || k),
    b.hasDetailPages === false ? 0 : 1,
    (get("SELECT MAX(sort) m FROM content_types")?.m ?? 0) + 1,
  );
  logActivity(req.user!.id, "created content type", "type", r.lastId, name);
  res.json(mapType(get("SELECT * FROM content_types WHERE id = ?", r.lastId)));
});

content.put("/types/:key", requirePerm("content.types"), (req, res) => {
  const t = getTypeByKey(String(req.params.key)) ?? notFound("Content type");
  const b = req.body ?? {};
  run(
    "UPDATE content_types SET name=?, singular=?, icon=?, color=?, description=?, fields=?, url_prefix=?, has_detail_pages=?, detail_template=?, list_template=? WHERE id=?",
    str(b.name ?? t.name, "Name", { required: true, max: 60 }),
    str(b.singular ?? t.singular, "Singular name", { required: true, max: 60 }),
    b.icon ?? t.icon,
    b.color ?? t.color,
    str(b.description ?? t.description, "Description", { max: 300 }),
    JSON.stringify(b.fields ? cleanFields(b.fields) : t.fields),
    slugify(b.urlPrefix ?? t.urlPrefix ?? t.key),
    (b.hasDetailPages ?? t.hasDetailPages) ? 1 : 0,
    b.detailTemplate ?? t.detailTemplate,
    b.listTemplate ?? t.listTemplate,
    t.id,
  );
  logActivity(req.user!.id, "updated content type", "type", t.id, t.name);
  res.json(mapType(get("SELECT * FROM content_types WHERE id = ?", t.id)));
});

content.delete("/types/:key", requirePerm("content.types"), (req, res) => {
  const t = getTypeByKey(String(req.params.key)) ?? notFound("Content type");
  const n = get("SELECT COUNT(*) n FROM content_items WHERE type_id = ?", t.id)!.n;
  if (n && req.query.force !== "1") throw new HttpError(409, `“${t.name}” has ${n} item${n === 1 ? "" : "s"}. Deleting the type deletes them too.`, { items: n });
  run("DELETE FROM content_types WHERE id = ?", t.id);
  logActivity(req.user!.id, "deleted content type", "type", t.id, t.name);
  res.json({ ok: true });
});

// ---------- items ----------
const ITEM_SELECT = "SELECT i.*, u.name author_name FROM content_items i LEFT JOIN users u ON u.id = i.author_id";

content.get("/types/:key/items", (req, res) => {
  const t = getTypeByKey(String(req.params.key)) ?? notFound("Content type");
  const where = ["i.type_id = ?"];
  const params: any[] = [t.id];
  const q = String(req.query.q ?? "").trim();
  if (q) {
    where.push("(i.title LIKE ? OR i.data LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }
  if (req.query.status && req.query.status !== "all") {
    where.push("i.status = ?");
    params.push(String(req.query.status));
  }
  if (req.query.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(i.tags) WHERE lower(value) = lower(?))");
    params.push(String(req.query.tag));
  }
  const sort = String(req.query.sort ?? "updated");
  const order = { updated: "i.updated_at DESC", title: "i.title COLLATE NOCASE", manual: "i.sort, i.id", published: "COALESCE(i.published_at, i.created_at) DESC" }[sort] ?? "i.updated_at DESC";
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const total = get(`SELECT COUNT(*) n FROM content_items i WHERE ${where.join(" AND ")}`, ...params)!.n;
  const counts = Object.fromEntries(all("SELECT status, COUNT(*) n FROM content_items WHERE type_id = ? GROUP BY status", t.id).map((r) => [r.status, r.n]));
  res.json({ items: all(`${ITEM_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset).map(mapItem), total, counts });
});

function validateData(fields: FieldDef[], data: any, enforceRequired: boolean) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    const v = data?.[f.key];
    if (enforceRequired && f.required && (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length))) {
      throw new HttpError(400, `“${f.label}” is required before publishing.`, { field: f.key });
    }
    if (v === undefined) continue;
    if (f.type === "number" && v !== "" && v !== null && Number.isNaN(Number(v))) throw new HttpError(400, `“${f.label}” must be a number.`, { field: f.key });
    if (f.type === "email" && v && !/^[^@\s]+@[^@\s]+$/.test(String(v))) throw new HttpError(400, `“${f.label}” must be an email address.`, { field: f.key });
    out[f.key] = f.type === "number" && v !== "" && v !== null ? Number(v) : v;
  }
  return out;
}

function uniqueItemSlug(typeId: number, base: string, exceptId = 0) {
  let slug = base;
  for (let i = 2; get("SELECT 1 FROM content_items WHERE type_id = ? AND slug = ? AND id != ?", typeId, slug, exceptId); i++) slug = `${base}-${i}`;
  return slug;
}

function loadItem(id: number) {
  return mapItem(get(`${ITEM_SELECT} WHERE i.id = ?`, id) ?? notFound("Item"));
}

content.post("/types/:key/items", requirePerm("content.edit"), async (req, res) => {
  const t = getTypeByKey(String(req.params.key)) ?? notFound("Content type");
  let b = req.body ?? {};
  const title = str(b.title, "Title", { required: true, max: 200 });
  let data = validateData(t.fields, b.data ?? {}, false);
  ({ data } = await runHooks("content.beforeSave", { type: t.key, title, data, isNew: true }));
  const slug = uniqueItemSlug(t.id, slugify(b.slug || title));
  const r = run(
    "INSERT INTO content_items(type_id, title, slug, data, status, tags, categories, sort, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    t.id,
    title,
    slug,
    JSON.stringify(data),
    "draft",
    JSON.stringify(b.tags ?? []),
    JSON.stringify(b.categories ?? []),
    (get("SELECT MIN(sort) m FROM content_items WHERE type_id = ?", t.id)?.m ?? 0) - 1,
    req.user!.id,
    now(),
    now(),
  );
  logActivity(req.user!.id, "created", t.key, r.lastId, title);
  emit("content.afterSave", { type: t.key, id: r.lastId, title });
  res.json(loadItem(r.lastId));
});

content.get("/items/:id", (req, res) => res.json(loadItem(idParam(req.params.id))));

content.put("/items/:id", requirePerm("content.edit"), async (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT * FROM content_items WHERE id = ?", id) ?? notFound("Item");
  const t = mapType(get("SELECT * FROM content_types WHERE id = ?", row.type_id));
  const b = req.body ?? {};
  if (b.baseUpdatedAt && b.baseUpdatedAt !== row.updated_at && !b.force) throw new HttpError(409, "Someone saved this item after you opened it. Reload to see their changes, or overwrite them.", { conflict: true });
  // items have no separate draft copy, so saving a published item changes the live site
  if (!can(req, "content.publish")) {
    if (row.status === "published") throw new HttpError(403, "This item is live, so changing it needs permission to publish content. Ask an editor, or unpublish it first.");
    if ((b.publishAt && b.publishAt !== row.publish_at) || b.publishedAt) throw new HttpError(403, "Scheduling content to publish needs permission to publish content. Send it for review instead.");
  }
  const title = str(b.title ?? row.title, "Title", { required: true, max: 200 });
  let data = validateData(t.fields, b.data ?? json(row.data, {}), row.status === "published");
  ({ data } = await runHooks("content.beforeSave", { type: t.key, id, title, data, isNew: false }));
  const updatedAt = now();
  run(
    "UPDATE content_items SET title=?, slug=?, data=?, tags=?, categories=?, publish_at=?, published_at=COALESCE(?, published_at), updated_at=? WHERE id=?",
    title,
    b.slug !== undefined ? uniqueItemSlug(t.id, slugify(b.slug || title), id) : row.slug,
    JSON.stringify(data),
    JSON.stringify(Array.isArray(b.tags) ? b.tags : json(row.tags, [])),
    JSON.stringify(Array.isArray(b.categories) ? b.categories : json(row.categories, [])),
    b.publishAt !== undefined ? b.publishAt || null : row.publish_at,
    b.publishedAt || null,
    updatedAt,
    id,
  );
  if (b.publishAt && row.status !== "published") run("UPDATE content_items SET status = 'scheduled' WHERE id = ?", id);
  saveRevision("item", id, { title, data, tags: b.tags, categories: b.categories }, req.user!.id, "Saved");
  logActivity(req.user!.id, "edited", t.key, id, title);
  emit("content.afterSave", { type: t.key, id, title });
  res.json(loadItem(id));
});

export function publishItem(id: number, userId: number | null) {
  const row = get("SELECT * FROM content_items WHERE id = ?", id) ?? notFound("Item");
  const t = mapType(get("SELECT * FROM content_types WHERE id = ?", row.type_id));
  validateData(t.fields, json(row.data, {}), true);
  run("UPDATE content_items SET status='published', published_at=COALESCE(published_at, ?), publish_at=NULL, updated_at=? WHERE id=?", now(), now(), id);
  logActivity(userId, "published", t.key, id, row.title);
  emit("content.published", { type: t.key, id, title: row.title, slug: row.slug, url: itemUrl(t, row) });
}

content.post("/items/:id/publish", requirePerm("content.edit"), (req, res) => {
  const id = idParam(req.params.id);
  if (!can(req, "content.publish")) {
    run("UPDATE content_items SET status='review', updated_at=? WHERE id=?", now(), id);
    return res.json({ ...loadItem(id), sentForReview: true });
  }
  publishItem(id, req.user!.id);
  res.json(loadItem(id));
});

content.post("/items/:id/unpublish", requirePerm("content.publish"), (req, res) => {
  const id = idParam(req.params.id);
  run("UPDATE content_items SET status='draft', updated_at=? WHERE id=?", now(), id);
  logActivity(req.user!.id, "unpublished", "item", id, get("SELECT title FROM content_items WHERE id=?", id)?.title ?? "");
  res.json(loadItem(id));
});

content.post("/items/:id/duplicate", requirePerm("content.edit"), (req, res) => {
  const src = get("SELECT * FROM content_items WHERE id = ?", idParam(req.params.id)) ?? notFound("Item");
  const title = `${src.title} (copy)`;
  const r = run(
    "INSERT INTO content_items(type_id, title, slug, data, status, tags, categories, sort, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    src.type_id,
    title,
    uniqueItemSlug(src.type_id, `${src.slug}-copy`),
    src.data,
    "draft",
    src.tags,
    src.categories,
    src.sort,
    req.user!.id,
    now(),
    now(),
  );
  res.json(loadItem(r.lastId));
});

content.post("/items/:id/restore/:revId", requirePerm("content.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = get("SELECT * FROM revisions WHERE id = ? AND entity = 'item' AND entity_id = ?", idParam(req.params.revId), id) ?? notFound("Revision");
  const d = json<any>(rev.data, {});
  run("UPDATE content_items SET title=?, data=?, tags=COALESCE(?, tags), categories=COALESCE(?, categories), updated_at=? WHERE id=?", d.title, JSON.stringify(d.data ?? {}), d.tags ? JSON.stringify(d.tags) : null, d.categories ? JSON.stringify(d.categories) : null, now(), id);
  res.json(loadItem(id));
});

content.delete("/items/:id", requirePerm("content.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const row = get("SELECT title, status FROM content_items WHERE id = ?", id) ?? notFound("Item");
  if (row.status === "published" && !can(req, "content.publish")) throw new HttpError(403, "This item is live, so deleting it needs permission to publish content.");
  run("DELETE FROM content_items WHERE id = ?", id);
  logActivity(req.user!.id, "deleted", "item", id, row.title);
  res.json({ ok: true });
});

content.post("/items-bulk", requirePerm("content.edit"), (req, res) => {
  const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(idParam);
  const action = String(req.body?.action);
  const errors: string[] = [];
  for (const id of ids) {
    try {
      if (action === "publish") {
        if (!can(req, "content.publish")) throw new HttpError(403, "You can't publish.");
        publishItem(id, req.user!.id);
      } else if (action === "unpublish") {
        if (!can(req, "content.publish")) throw new HttpError(403, "You can't unpublish.");
        run("UPDATE content_items SET status='draft', updated_at=? WHERE id=?", now(), id);
      } else if (action === "delete") {
        if (get("SELECT status FROM content_items WHERE id = ?", id)?.status === "published" && !can(req, "content.publish")) throw new HttpError(403, "It's live, so deleting it needs permission to publish content.");
        run("DELETE FROM content_items WHERE id = ?", id);
      } else if (action === "tag" && req.body?.tag) {
        const row = get("SELECT tags, status FROM content_items WHERE id = ?", id);
        if (row?.status === "published" && !can(req, "content.publish")) throw new HttpError(403, "It's live, so changing it needs permission to publish content.");
        const tags = new Set(json<string[]>(row?.tags, []));
        tags.add(String(req.body.tag));
        run("UPDATE content_items SET tags = ? WHERE id = ?", JSON.stringify([...tags]), id);
      }
    } catch (e: any) {
      errors.push(`${get("SELECT title FROM content_items WHERE id=?", id)?.title ?? id}: ${e.message}`);
    }
  }
  if (ids.length) logActivity(req.user!.id, `bulk ${action}`, "item", null, `${ids.length} items`);
  res.json({ ok: !errors.length, errors });
});

content.put("/types/:key/order", requirePerm("content.edit"), (req, res) => {
  const t = getTypeByKey(String(req.params.key)) ?? notFound("Content type");
  const ids: number[] = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(idParam);
  tx(() => ids.forEach((id, i) => run("UPDATE content_items SET sort = ? WHERE id = ? AND type_id = ?", i, id, t.id)));
  res.json({ ok: true });
});

content.get("/items/:id/preview", async (req, res) => {
  const row = get("SELECT * FROM content_items WHERE id = ?", idParam(req.params.id)) ?? notFound("Item");
  const t = mapType(get("SELECT * FROM content_types WHERE id = ?", row.type_id));
  res.type("html").send(await renderContentDetail(t.key, row, {}, false));
});
