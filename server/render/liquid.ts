import { Drop, Liquid } from "liquidjs";
import { markUncacheable } from "./cache";
import { listPublishedItems, getPublishedItem, getTypeByKey } from "../content";
import { mediaUrl } from "../media";
import { bestVariant, srcsetFor } from "../images";

/**
 * HTML that's safe to print as-is: page content VodaForge rendered, and rich text it has cleaned.
 * Everything else printed with {{ }} is escaped, so a title like <script> shows as text.
 * Developers can still print trusted HTML with {{ value | raw }}.
 */
export class SafeHtml extends Drop {
  constructor(readonly html: string) {
    super();
  }
  valueOf() {
    return this.html;
  }
  toString() {
    return this.html;
  }
}
const escapeOutput = (v: unknown) => (v instanceof SafeHtml ? v.html : escapeHtml(v));

/** Marks an item's rich text fields (already sanitized by itemForTemplate) as printable HTML. */
export function liquidItem<T extends Record<string, any>>(item: T): T {
  const type = item?.type ? getTypeByKey(String(item.type)) : undefined;
  if (!type) return item;
  const rich = type.fields.filter((f) => f.type === "richtext").map((f) => f.key);
  if (!rich.length) return item;
  const out: Record<string, any> = { ...item, data: { ...(item.data ?? {}) } };
  for (const k of rich) {
    if (typeof item[k] === "string") out[k] = new SafeHtml(item[k]);
    if (typeof item.data?.[k] === "string") out.data[k] = new SafeHtml(item.data[k]);
  }
  return out as T;
}

export const liquid = new Liquid({
  cache: false,
  outputEscape: escapeOutput,
  ownPropertyOnly: true,
  strictFilters: false,
  strictVariables: false,
  jsTruthy: true,
  timezoneOffset: 0,
});

// "<" is written as < so the output can't close a <script> tag it's printed into (use | raw there)
liquid.registerFilter("json", (v: unknown, indent?: number) => JSON.stringify(v ?? null, null, indent ?? 0).replace(/</g, "\\u003c"));
liquid.registerFilter("media_url", (v: unknown) => mediaUrl(String(v ?? "")));
/** <img src="{{ x.image }}" srcset="{{ x.image | srcset }}" sizes="100vw"> */
liquid.registerFilter("srcset", (v: unknown) => srcsetFor(String(v ?? "")));
/** {{ x.image | image_url: 960 }} → the smallest resized copy at least 960px wide */
liquid.registerFilter("image_url", (v: unknown, width = 1600) => bestVariant(String(v ?? ""), Number(width) || 1600));
liquid.registerFilter("excerpt", (v: unknown, words = 30) => {
  const text = String(v ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const parts = text.split(" ");
  return parts.length > words ? parts.slice(0, words).join(" ") + "…" : text;
});
/** {% assign news = 'news' | content: 3 %} */
liquid.registerFilter("content", (typeKey: string, limit = 10, tag?: string) =>
  listPublishedItems(String(typeKey), { limit: Number(limit) || 10, tag: tag ? String(tag) : undefined }).items.map(liquidItem),
);
/** {% assign post = 'news' | content_item: 'my-slug' %} */
liquid.registerFilter("content_item", (typeKey: string, slug: string) => {
  const item = getPublishedItem(String(typeKey), String(slug));
  return item ? liquidItem(item) : null;
});
/** {% assign weather = 'weather' | fn %} -- runs a server function endpoint and returns its result */
liquid.registerFilter("fn", async (route: string, input?: unknown) => {
  markUncacheable(); // a function's answer can change without the database changing
  const { invokeEndpointByRoute } = await import("../functions");
  try {
    return await invokeEndpointByRoute(String(route), { method: "GET", query: input && typeof input === "object" ? (input as any) : {}, body: input ?? null, headers: {} }, { publicOnly: true });
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
});

export async function renderLiquid(template: string, ctx: Record<string, unknown>): Promise<string> {
  if (!template) return "";
  try {
    return await liquid.parseAndRender(template, ctx);
  } catch (e: any) {
    return `<div class="rf-error"><strong>Template error</strong><pre>${escapeHtml(e?.message ?? String(e))}</pre></div>`;
  }
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
