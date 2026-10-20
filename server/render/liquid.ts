import { Liquid } from "liquidjs";
import { listPublishedItems, getPublishedItem } from "../content";
import { mediaUrl } from "../media";

export const liquid = new Liquid({
  cache: false,
  ownPropertyOnly: true,
  strictFilters: false,
  strictVariables: false,
  jsTruthy: true,
  timezoneOffset: 0,
});

liquid.registerFilter("json", (v: unknown, indent?: number) => JSON.stringify(v ?? null, null, indent ?? 0));
liquid.registerFilter("media_url", (v: unknown) => mediaUrl(String(v ?? "")));
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
  listPublishedItems(String(typeKey), { limit: Number(limit) || 10, tag: tag ? String(tag) : undefined }).items,
);
/** {% assign post = 'news' | content_item: 'my-slug' %} */
liquid.registerFilter("content_item", (typeKey: string, slug: string) => getPublishedItem(String(typeKey), String(slug)) ?? null);
/** {% assign weather = 'weather' | fn %} -- runs a server function endpoint and returns its result */
liquid.registerFilter("fn", async (route: string, input?: unknown) => {
  const { invokeEndpointByRoute } = await import("../functions");
  try {
    return await invokeEndpointByRoute(String(route), { method: "GET", query: input && typeof input === "object" ? (input as any) : {}, body: input ?? null, headers: {} });
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
