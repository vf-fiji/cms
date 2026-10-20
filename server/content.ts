import { all, get, json } from "./db";
import type { ContentItem, ContentType, FieldDef } from "../shared/types";

export function mapType(r: any): ContentType {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    singular: r.singular,
    icon: r.icon,
    color: r.color,
    description: r.description,
    fields: json<FieldDef[]>(r.fields, []),
    urlPrefix: r.url_prefix,
    hasDetailPages: !!r.has_detail_pages,
    detailTemplate: r.detail_template,
    listTemplate: r.list_template,
    sort: r.sort,
    itemCount: r.item_count ?? undefined,
  };
}

export function mapItem(r: any): ContentItem {
  return {
    id: r.id,
    typeId: r.type_id,
    title: r.title,
    slug: r.slug,
    data: json(r.data, {}),
    status: r.status,
    tags: json(r.tags, []),
    categories: json(r.categories, []),
    publishAt: r.publish_at,
    publishedAt: r.published_at,
    sort: r.sort,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    authorName: r.author_name ?? null,
  };
}

export function getTypeByKey(key: string): ContentType | undefined {
  const r = get("SELECT * FROM content_types WHERE key = ?", key);
  return r ? mapType(r) : undefined;
}

export function itemUrl(type: ContentType, item: { slug: string }) {
  const prefix = (type.urlPrefix || type.key).replace(/^\/+|\/+$/g, "");
  return `/${prefix}/${item.slug}`;
}

/** Shape of a content item inside Liquid templates and the headless API. */
export function itemForTemplate(type: ContentType, item: ContentItem) {
  const imageField = type.fields.find((f) => f.type === "image");
  const summaryField = type.fields.find((f) => ["summary", "excerpt", "description", "intro"].includes(f.key));
  const bodyField = type.fields.find((f) => f.type === "richtext");
  const summary =
    (summaryField && item.data[summaryField.key]) ||
    (bodyField
      ? String(item.data[bodyField.key] ?? "")
          .replace(/<[^>]+>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .slice(0, 28)
          .join(" ") + "…"
      : "");
  return {
    ...item.data,
    id: item.id,
    type: type.key,
    title: item.title,
    slug: item.slug,
    url: type.hasDetailPages ? itemUrl(type, item) : "",
    date: item.publishedAt ?? item.createdAt,
    tags: item.tags,
    categories: item.categories,
    image: (imageField && item.data[imageField.key]) || "",
    summary,
    data: item.data,
  };
}

export function listPublishedItems(
  typeKey: string,
  opts: { limit?: number; offset?: number; tag?: string; category?: string; sort?: string } = {},
) {
  const type = getTypeByKey(typeKey);
  if (!type) return { type: undefined, items: [] as any[], total: 0 };
  const where = ["type_id = ?", "status = 'published'"];
  const params: any[] = [type.id];
  if (opts.tag) {
    where.push("EXISTS (SELECT 1 FROM json_each(tags) WHERE lower(value) = lower(?))");
    params.push(opts.tag);
  }
  if (opts.category) {
    where.push("EXISTS (SELECT 1 FROM json_each(categories) WHERE lower(value) = lower(?))");
    params.push(opts.category);
  }
  const order =
    opts.sort === "oldest"
      ? "COALESCE(published_at, created_at) ASC"
      : opts.sort === "title"
        ? "title COLLATE NOCASE ASC"
        : opts.sort === "manual"
          ? "sort ASC, id ASC"
          : "COALESCE(published_at, created_at) DESC";
  const total = get<{ n: number }>(`SELECT COUNT(*) n FROM content_items WHERE ${where.join(" AND ")}`, ...params)!.n;
  const rows = all(
    `SELECT * FROM content_items WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
    ...params,
    opts.limit ?? 10,
    opts.offset ?? 0,
  );
  return { type, items: rows.map((r) => itemForTemplate(type, mapItem(r))), total };
}

export function getPublishedItem(typeKey: string, slug: string) {
  const type = getTypeByKey(typeKey);
  if (!type) return undefined;
  const r = get("SELECT * FROM content_items WHERE type_id = ? AND slug = ? AND status = 'published'", type.id, slug);
  return r ? itemForTemplate(type, mapItem(r)) : undefined;
}
