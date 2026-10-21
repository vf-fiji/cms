import express, { type NextFunction, type Request, type Response } from "express";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { all, get, run, now, UPLOAD_DIR, getSettings, db } from "./db";
import { loadUser, HttpError } from "./auth";
import { core } from "./api/core";
import { pages, publishPage } from "./api/pages";
import { content, publishItem } from "./api/content";
import { media } from "./api/media";
import { forms } from "./api/forms";
import { developer } from "./api/developer";
import { sitegraph } from "./api/sitegraph";
import { publicApi } from "./api/public";
import { recovery } from "./api/recovery";
import { parseTrustProxy } from "./http";
import { getMailTransport } from "./mail";
import { renderPublicPath, renderPageSnapshot, renderContentDetail, computePaths, sitemapXml, flushViews, type PageSnapshot } from "./render/site";
import { runDueSchedules, warmFunctionWorkers } from "./functions";
import { seedIfEmpty } from "./seed";
import { reactRuntime, getBrowserModule } from "./react";
import { backfillVariants } from "./images";
import { json } from "./db";
import { mapType } from "./content";
import { escapeHtml } from "./render/liquid";
import { installProcessHandlers, logError } from "./log";
import { startBackupSchedule } from "./backup-schedule";

installProcessHandlers();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT ?? 4400);
const HOST = process.env.HOST ?? "127.0.0.1";
const isProd = process.env.NODE_ENV === "production";

seedIfEmpty();

const app = express();
const server = http.createServer(app);
app.disable("x-powered-by");
// Behind a reverse proxy, set REEF_TRUST_PROXY so req.ip / req.protocol come from X-Forwarded-*.
app.set("trust proxy", parseTrustProxy(process.env.REEF_TRUST_PROXY));

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
  // only over HTTPS, so a plain-HTTP dev or test setup never gets pinned
  if (isProd && req.secure) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
});

app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(loadUser);

// ---------- API ----------
app.use("/api", publicApi, recovery);
app.use("/api", core, pages, content, media, forms, developer, sitegraph);
app.use("/api", (_req, _res, next) => next(new HttpError(404, "Unknown API route.")));

// ---------- files ----------
app.use(
  "/media",
  express.static(UPLOAD_DIR, {
    maxAge: "30d",
    immutable: true,
    setHeaders: (res, file) => {
      if (file.endsWith(".svg")) res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    },
  }),
);
// React runtime + compiled JSX widgets
app.get("/_reef/react.js", async (_req, res) => {
  res.type("application/javascript").setHeader("Cache-Control", isProd ? "public, max-age=3600" : "no-cache");
  res.send(await reactRuntime());
});
app.get("/_reef/rw/:hash.js", (req, res) => {
  const code = getBrowserModule(String(req.params.hash));
  if (!code) throw new HttpError(404, "Compiled widget not found. Reload the page.");
  res.type("application/javascript").setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(code);
});
app.use("/_reef", express.static(path.join(ROOT, "static"), { maxAge: isProd ? "1h" : 0 }));

// ---------- previews (signed-in only) ----------
app.get("/preview/page/:id", async (req, res) => {
  if (!req.user) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  const row = get("SELECT * FROM pages WHERE id = ?", Number(req.params.id));
  if (!row) throw new HttpError(404, "Page not found");
  const snap: PageSnapshot = {
    title: row.title,
    layout: json(row.layout, { sections: [] }),
    seo: json(row.seo, {}),
    customCss: row.custom_css,
    customJs: row.custom_js,
    customHead: row.custom_head,
    templateId: row.template_id,
  };
  const html = await renderPageSnapshot({ id: row.id, parentId: row.parent_id, slug: row.slug, path: computePaths().get(row.id) ?? "/" }, snap, { query: req.query as any });
  res.type("html").send(html.replace("<body", `<body data-preview`).replace("</body>", `${PREVIEW_BAR}</body>`));
});
app.get("/preview/item/:id", async (req, res) => {
  if (!req.user) return res.redirect(`/admin/login?next=${encodeURIComponent(req.originalUrl)}`);
  const row = get("SELECT * FROM content_items WHERE id = ?", Number(req.params.id));
  if (!row) throw new HttpError(404, "Item not found");
  const type = mapType(get("SELECT * FROM content_types WHERE id = ?", row.type_id));
  const html = await renderContentDetail(type.key, row, {}, false);
  res.type("html").send(html.replace("</body>", `${PREVIEW_BAR}</body>`));
});
const PREVIEW_BAR = `<div style="position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#18181b;color:#fff;font:500 13px/1 system-ui;padding:10px 16px;border-radius:999px;box-shadow:0 10px 30px rgba(0,0,0,.3);display:flex;gap:12px;align-items:center"><span style="width:8px;height:8px;border-radius:50%;background:#f59e0b"></span>Draft preview — visitors can't see unpublished changes<a href="javascript:window.close()" style="color:#a5b4fc">Close</a></div>`;

/** The public address: REEF_PUBLIC_URL when set (the Host header can be forged), else this request's. */
const siteOrigin = (req: Request) => process.env.REEF_PUBLIC_URL?.replace(/\/+$/, "") || `${req.protocol}://${req.get("host")}`;

app.get("/sitemap.xml", (req, res) => {
  if (!getSettings().sitemapEnabled) throw new HttpError(404, "Not found");
  res.type("application/xml").send(sitemapXml(siteOrigin(req)));
});
app.get("/robots.txt", (req, res) => {
  const s = getSettings();
  res.type("text/plain").send(`${s.robotsTxt}${s.sitemapEnabled ? `\nSitemap: ${siteOrigin(req)}/sitemap.xml\n` : ""}`);
});

// ---------- admin app ----------
async function mountAdmin() {
  if (isProd) {
    const dist = path.join(ROOT, "dist", "admin");
    app.use("/admin", express.static(dist, { index: false, maxAge: "1h" }));
    app.get(/^\/admin(\/.*)?$/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  } else {
    const { createServer } = await import("vite");
    const vite = await createServer({
      configFile: path.join(ROOT, "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
    });
    app.use((req, res, next) => (req.path === "/admin" || req.path.startsWith("/admin/") ? vite.middlewares(req, res, next) : next()));
  }
}

async function start() {
  await mountAdmin();
  reactRuntime().catch((e) => logError("react", e));
  if (get("SELECT 1 FROM functions WHERE enabled = 1 LIMIT 1")) warmFunctionWorkers();
  // responsive copies for images uploaded before resizing existed (runs in the background)
  setTimeout(() => void backfillVariants(true).catch((e) => logError("images", e)), 2000).unref();
  startBackupSchedule();

  // ---------- public website (catch-all) ----------
  app.get(/.*/, async (req, res) => {
    const result = await renderPublicPath(decodeURIComponent(req.path), req.query as Record<string, string>);
    if (result.redirect) return res.redirect(result.status, result.redirect);
    res.setHeader("X-VodaForge-Cache", result.cached ? "hit" : "miss");
    res.status(result.status).type("html").send(result.html);
  });

  // ---------- errors ----------
  app.use((err: any, req: Request, res: Response, _next: NextFunction) => {
    // body-parser and friends set err.status for bad requests (malformed JSON etc.), and a malformed
    // %-escape in the URL throws URIError. Those are the client's problem, not errors to log.
    const clientStatus = Number(err?.status ?? err?.statusCode);
    const status =
      err instanceof HttpError
        ? err.status
        : err?.type === "entity.too.large" || err?.code === "LIMIT_FILE_SIZE"
          ? 413
          : err instanceof URIError
            ? 400
            : clientStatus >= 400 && clientStatus < 500
              ? clientStatus
              : 500;
    const message =
      err instanceof HttpError
        ? err.message
        : status === 413
          ? "That's too large to upload. The limit is 50 MB per file."
          : status < 500
            ? "That request wasn't valid."
            : "Something went wrong on our side. The error has been logged.";
    if (status === 500) logError("server", err, { method: req.method, path: req.path });
    if (req.path.startsWith("/api/") || req.headers.accept?.includes("application/json")) {
      return res.status(status).json({ error: message, details: err instanceof HttpError ? err.details : undefined });
    }
    res.status(status).type("html").send(`<!doctype html><title>${status}</title><body style="font-family:system-ui;padding:48px;color:#18181b"><h1>${status === 404 ? "Not found" : "Something went wrong"}</h1><p>${escapeHtml(message)}</p><p><a href="/">Home</a></p>`);
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  VodaForge is running — where digital experiences are built`);
    console.log(`  Website:  http://${HOST}:${PORT}/`);
    console.log(`  Admin:    http://${HOST}:${PORT}/admin`);
    console.log(`  Email:    ${getMailTransport().describe}\n`);
    if (isProd && !process.env.REEF_PUBLIC_URL) console.warn("  [warn] REEF_PUBLIC_URL isn't set, so password reset emails can't be sent.\n");
  });
}

// ---------- scheduler: scheduled publishing + scheduled functions ----------
async function tick() {
  const ts = now();
  for (const p of all("SELECT id FROM pages WHERE publish_at IS NOT NULL AND publish_at <= ?", ts)) {
    try {
      publishPage(p.id, null);
    } catch (e) {
      logError("scheduler", e, { page: p.id });
    }
  }
  for (const i of all("SELECT id FROM content_items WHERE publish_at IS NOT NULL AND publish_at <= ? AND status != 'published'", ts)) {
    try {
      publishItem(i.id, null);
    } catch (e: any) {
      run("UPDATE content_items SET publish_at = NULL, status = 'draft' WHERE id = ?", i.id);
      logError("scheduler", e, { item: i.id });
    }
  }
  await runDueSchedules().catch((e) => logError("scheduler", e));
  // expired sessions are refused already; this just keeps the table small
  if (Date.now() - lastSessionPurge > 3_600_000) {
    lastSessionPurge = Date.now();
    run("DELETE FROM sessions WHERE expires_at < ?", new Date().toISOString());
  }
}
let lastSessionPurge = 0;
setInterval(() => void tick(), 30_000).unref();

// ---------- graceful shutdown (docker stop, Ctrl+C) ----------
let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal} received, shutting down`);
  setTimeout(() => process.exit(0), 5_000).unref();
  server.close(() => {
    flushViews();
    try {
      db.close();
    } catch {
      /* already closed */
    }
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

if (!fs.existsSync(path.join(ROOT, "static"))) console.warn("Missing server/static directory");
start();
