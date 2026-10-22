// Live preview for Code Studio: unsaved changes to a widget, template or code
// asset, applied to a page's draft. The studio keeps a preview session per
// open file and loads the page at its real address with ?reef_studio=<token>,
// so the page behaves exactly as it will when published (address-aware
// blocks, navigation, routes).
import crypto from "node:crypto";
import { all } from "./db";
import { HttpError } from "./auth";
import { computePaths } from "./render/site";
import type { CodeAsset, CustomWidget, Template } from "../shared/types";

export interface StudioOverrides {
  widget?: Pick<CustomWidget, "key"> & Partial<Pick<CustomWidget, "template" | "css" | "js" | "fields" | "renderer" | "ssr">>;
  template?: Pick<Template, "id"> & Partial<Pick<Template, "html" | "css" | "js" | "head">>;
  asset?: Pick<CodeAsset, "id"> & Partial<Pick<CodeAsset, "content" | "kind" | "location" | "enabled">>;
}

const TTL = 2 * 60 * 60_000;
const MAX_SESSIONS = 200;
const sessions = new Map<string, { userId: number; overrides: StudioOverrides; at: number }>();

const text = (v: unknown, max = 500_000) => {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw new HttpError(400, "Preview changes must be text.");
  if (v.length > max) throw new HttpError(413, "This file is too large to preview.");
  return v;
};

/** Checks the unsaved changes sent by the studio and keeps only the fields that affect rendering. */
function clean(b: any): StudioOverrides {
  const out: StudioOverrides = {};
  if (b?.widget && typeof b.widget.key === "string") {
    const w = b.widget;
    out.widget = {
      key: w.key,
      template: text(w.template),
      css: text(w.css),
      js: text(w.js),
      fields: Array.isArray(w.fields) ? w.fields : undefined,
      renderer: w.renderer === "react" ? "react" : w.renderer === "liquid" ? "liquid" : undefined,
      ssr: typeof w.ssr === "boolean" ? w.ssr : undefined,
    };
  }
  if (b?.template && Number.isInteger(b.template.id)) {
    const t = b.template;
    out.template = { id: t.id, html: text(t.html), css: text(t.css), js: text(t.js), head: text(t.head) };
  }
  if (b?.asset && Number.isInteger(b.asset.id)) {
    const a = b.asset;
    out.asset = {
      id: a.id,
      content: text(a.content),
      kind: ["css", "js", "html"].includes(a.kind) ? a.kind : undefined,
      location: ["head", "body-end"].includes(a.location) ? a.location : undefined,
      enabled: typeof a.enabled === "boolean" ? a.enabled : undefined,
    };
  }
  return out;
}

/** Creates or updates a preview session. Returns its token. */
export function savePreview(userId: number, token: string | undefined, body: unknown): string {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.at > TTL) sessions.delete(k);
  const existing = token ? sessions.get(token) : undefined;
  if (existing && existing.userId !== userId) throw new HttpError(403, "This preview belongs to someone else.");
  const key = existing ? token! : crypto.randomBytes(18).toString("base64url");
  if (!existing && sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  sessions.set(key, { userId, overrides: clean(body), at: now });
  return key;
}

/** The unsaved changes of a preview session, for the signed-in user who made it. */
export function previewOverrides(token: string, userId: number): StudioOverrides | null {
  const s = sessions.get(token);
  if (!s || s.userId !== userId || Date.now() - s.at > TTL) return null;
  s.at = Date.now();
  return s.overrides;
}

/** Pages to preview a widget or template on: the ones that use it first, then the rest. */
export function previewPages(opts: { widget?: string; template?: number }) {
  const paths = computePaths();
  const rows = all<any>("SELECT id, title, layout, template_id, is_home, published IS NOT NULL AS live FROM pages ORDER BY sort, id");
  const defaultTemplate = all<any>("SELECT id FROM templates ORDER BY is_default DESC, id LIMIT 1")[0]?.id;
  return rows
    .map((r) => ({
      id: r.id as number,
      title: r.title as string,
      path: paths.get(r.id) ?? "/",
      live: !!r.live,
      uses: opts.widget
        ? String(r.layout).includes(`"type":"${opts.widget}"`)
        : opts.template !== undefined
          ? (r.template_id ?? defaultTemplate) === opts.template
          : false,
    }))
    .sort((a, b) => Number(b.uses) - Number(a.uses));
}
