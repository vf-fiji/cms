import { Router } from "express";
import { all, get, json, getSettings } from "../db";
import { HttpError } from "../auth";
import { listPublishedItems, getPublishedItem } from "../content";
import { invokeEndpointByRoute, mapFunction, runFunction, unwrap } from "../functions";
import { computePaths, type PageSnapshot } from "../render/site";
import { publicForms } from "./forms";
import { rateLimit, envLimit } from "../ratelimit";
import { search } from "../search";

/** Unauthenticated routes: headless content API, form posts and function endpoints. */
export const publicApi = Router();

publicApi.use(publicForms);

// Used by the Docker healthcheck: also proves the database answers.
publicApi.get("/health", (_req, res) => {
  get("SELECT 1");
  res.setHeader("Cache-Control", "no-store");
  res.json({ ok: true, time: new Date().toISOString() });
});

function requireHeadless() {
  if (!getSettings().headlessApiEnabled) throw new HttpError(404, "The headless API is turned off in Settings.");
}

publicApi.get("/public/content/:type", (req, res) => {
  requireHeadless();
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 20));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const { type, items, total } = listPublishedItems(String(req.params.type), {
    limit,
    offset,
    tag: req.query.tag ? String(req.query.tag) : undefined,
    category: req.query.category ? String(req.query.category) : undefined,
    sort: req.query.sort ? String(req.query.sort) : undefined,
  });
  if (!type) throw new HttpError(404, "Unknown content type.");
  res.json({ type: { key: type.key, name: type.name }, total, limit, offset, items });
});

publicApi.get("/public/content/:type/:slug", (req, res) => {
  requireHeadless();
  const item = getPublishedItem(String(req.params.type), String(req.params.slug));
  if (!item) throw new HttpError(404, "Item not found.");
  res.json(item);
});

publicApi.get("/public/pages", (_req, res) => {
  requireHeadless();
  const paths = computePaths();
  res.json(
    all("SELECT id, parent_id, published, published_at FROM pages WHERE published IS NOT NULL ORDER BY sort").map((r) => {
      const s = json<PageSnapshot>(r.published, null as any);
      return { id: r.id, parentId: r.parent_id, title: s.title, path: paths.get(r.id), seo: s.seo, layout: s.layout, publishedAt: r.published_at };
    }),
  );
});

// Site search for visitors and headless front ends (always on: it only covers published content)
const searchLimit = rateLimit({ max: envLimit("REEF_RATE_LIMIT_SEARCH", 60), windowMs: 60_000, message: "Too many searches. Please wait a moment and try again." });
publicApi.get("/public/search", searchLimit, (req, res) => {
  const q = String(req.query.q ?? "").slice(0, 200);
  res.setHeader("Cache-Control", "no-store");
  res.json({ q, results: search(q, Math.max(1, Math.min(50, Number(req.query.limit) || 10))) });
});

publicApi.get("/public/site", (_req, res) => {
  requireHeadless();
  const s = getSettings();
  res.json({ siteName: s.siteName, tagline: s.tagline, logo: s.logo, primaryColor: s.primaryColor, socialLinks: s.socialLinks });
});

// Developer-authored endpoints: /api/fn/<route>
const fnLimit = rateLimit({
  max: envLimit("REEF_RATE_LIMIT_FN", 120),
  windowMs: 60_000,
  message: "Too many requests to this endpoint. Please slow down and try again shortly.",
});
publicApi.all("/fn/:route", fnLimit, async (req, res) => {
  const row = get("SELECT * FROM functions WHERE kind = 'endpoint' AND route = ? AND enabled = 1", String(req.params.route));
  if (!row) throw new HttpError(404, `No function is listening on /api/fn/${req.params.route}`);
  const fn = mapFunction(row);
  if (fn.method !== "ANY" && fn.method !== req.method) throw new HttpError(405, `This endpoint only accepts ${fn.method} requests.`);
  if (!fn.isPublic) {
    if (!req.user) throw new HttpError(401, "Sign in to call this endpoint.");
    // a session cookie alone isn't enough to change things: same CSRF check as the admin API
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers["x-csrf-token"] !== req.user.csrf) throw new HttpError(403, "This request could not be verified. Refresh the page and try again.");
    if (getSettings().require2fa && !req.user.twoFactorEnabled) throw new HttpError(403, "Set up two-factor sign-in to use this.", { needs2fa: true });
  }
  const outcome = await runFunction(fn, {
    request: {
      method: req.method,
      query: req.query,
      body: req.body ?? null,
      headers: { "content-type": req.headers["content-type"], "user-agent": req.headers["user-agent"], accept: req.headers.accept },
      user: req.user ? { id: req.user.id, name: req.user.name, email: req.user.email } : null,
    },
  });
  // 502: the function failed, not VodaForge. It's in the function's own logs, so it isn't added to the error log.
  if (!outcome.ok) throw new HttpError(502, req.user ? outcome.error : "The function failed. Check its logs in Code Studio.");
  const out = unwrap(outcome.result);
  for (const [k, v] of Object.entries(out.headers)) if (!/^set-cookie$/i.test(k)) res.setHeader(k, v);
  res.status(out.status);
  if (typeof out.body === "string") res.send(out.body);
  else res.json(out.body);
});

export { invokeEndpointByRoute };
