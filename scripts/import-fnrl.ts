// Sets VodaForge up to manage the Fiji National Rugby League website.
//
//   npm run fnrl:import -- --site=http://localhost:5173 [--api=http://127.0.0.1:3000] [--secret=...] [--keep-demo] [--widgets-only]
//
//   --site     the FNRL website address as a browser sees it. The editor loads
//              the FNRL blocks (fnrl-kit.js) and styles (fnrl-kit.css) from here.
//   --api      where this script reaches the FNRL server (defaults to --site).
//   --secret   CMS_WEBHOOK_SECRET of the FNRL server. When given, publishing a
//              page or a news item tells the FNRL site straight away; without it
//              the site picks changes up within 15 seconds.
//   --widgets-only  only refresh the FNRL block code (after FNRL blocks change).
//   --keep-demo     keep the VodaForge demo pages and content.
//
// It replaces the demo pages with the FNRL pages (Home, About, Governance,
// Policies), all published, and imports FNRL's news with its photos. Take a
// backup first (npm run backup); running it again resets the FNRL pages and news.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { imageSize } from "image-size";
import { all, get, run, now, saveSettings, tx, UPLOAD_DIR } from "../server/db";
import { isRaster, makeVariants, invalidateMediaCache } from "../server/images";
import { markSearchDirty } from "../server/search";
import { DEFAULT_DETAIL_TEMPLATE } from "../server/render/site";
import type { FieldDef, PageLayout } from "../shared/types";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "true"];
  }),
);
const site = String(args.site || process.env.FNRL_SITE_URL || "").replace(/\/+$/, "");
const api = String(args.api || process.env.FNRL_API_URL || site).replace(/\/+$/, "");
const secret = String(args.secret || process.env.CMS_WEBHOOK_SECRET || "");
if (!/^https?:\/\//.test(site)) {
  console.error("Give the FNRL website address, e.g. npm run fnrl:import -- --site=https://fnrl.com.fj");
  process.exit(1);
}

const done: string[] = [];
const getJson = async <T>(url: string): Promise<T> => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.json()) as T;
};
const id = () => crypto.randomBytes(5).toString("hex");
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" };
let photos = 0;

interface KitWidget {
  key: string;
  name: string;
  icon: string;
  category: string;
  description: string;
  fields: FieldDef[];
  source: string;
}
interface SeedPage {
  path: string;
  title: string;
  seoDescription: string;
  blocks: { type: string; props?: Record<string, unknown> }[];
}

const { widgets } = await getJson<{ widgets: KitWidget[] }>(`${api}/cms-kit/widgets.json`);

// 1. FNRL blocks as React widgets. They import the shared FNRL kit (@fnrl/kit).
tx(() => {
  for (const w of widgets) {
    const existing = get<{ id: number }>("SELECT id FROM custom_widgets WHERE key = ?", w.key);
    const values = [w.name, w.icon, w.category, w.description, JSON.stringify(w.fields), w.source, "", "", "react", 0, now()];
    if (existing) {
      run("UPDATE custom_widgets SET name=?, icon=?, category=?, description=?, fields=?, template=?, css=?, js=?, renderer=?, ssr=?, updated_at=? WHERE id=?", ...values, existing.id);
    } else {
      run("INSERT INTO custom_widgets(name, icon, category, description, fields, template, css, js, renderer, ssr, updated_at, key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", ...values, w.key);
    }
  }
});
saveSettings({ importMap: { "@fnrl/kit": `${site}/cms-kit/fnrl-kit.js` } } as any);
done.push(`${widgets.length} FNRL blocks installed (Widgets › FNRL …), loading the FNRL kit from ${site}/cms-kit/`);

if (args["widgets-only"] !== "true") await importSite();

markSearchDirty();
console.log(done.map((d) => `✓ ${d}`).join("\n"));

async function importSite() {
  const seed = await getJson<{ pages: SeedPage[]; stories: any[] }>(`${api}/api/public/cms/seed`);

  // 2. Site settings
  saveSettings({
    siteName: "Fiji National Rugby League",
    tagline: "The home of rugby league in Fiji",
    defaultMetaDescription: "News, fixtures, results and pathways for rugby league in Fiji: the Fiji Bati, Fiji Bulikula, clubs and communities.",
    primaryColor: "#e8793a",
    accentColor: "#0b0d10",
    headlessApiEnabled: true,
  } as any);
  done.push("Site name, colours and the headless API set for FNRL");

  // 3. Template: the FNRL styles around the page, as on the FNRL site
  const tpl = {
    name: "FNRL",
    head: `<link rel="stylesheet" href="${site}/cms-kit/fnrl-kit.css">`,
    html: `<div class="nx nx-cms-canvas"><main id="nx-main">{{ content }}</main></div>`,
    css: "body{margin:0;background:#0b0d10}",
  };
  const existingTpl = get<{ id: number }>("SELECT id FROM templates WHERE name = ?", tpl.name);
  const templateId = existingTpl
    ? (run("UPDATE templates SET head=?, html=?, css=?, js='', updated_at=? WHERE id=?", tpl.head, tpl.html, tpl.css, now(), existingTpl.id), existingTpl.id)
    : Number(run("INSERT INTO templates(name, head, html, css, js, is_default, updated_at) VALUES(?,?,?,?,'',0,?)", tpl.name, tpl.head, tpl.html, tpl.css, now()).lastId);
  run("UPDATE templates SET is_default = CASE WHEN id = ? THEN 1 ELSE 0 END", templateId);
  done.push(`Template “FNRL” (the default for new pages)`);

  // 4. Pages: one full-width section per FNRL block, published
  const keepDemo = args["keep-demo"] === "true";
  tx(() => {
    if (keepDemo) {
      for (const p of seed.pages) run("DELETE FROM pages WHERE slug = ? AND parent_id IS NULL", slugOf(p.path));
    } else {
      run("DELETE FROM pages");
      run("DELETE FROM revisions WHERE entity = 'page'");
    }
    seed.pages.forEach((p, n) => {
      const layout: PageLayout = {
        sections: p.blocks.map((b) => ({
          id: id(),
          props: { paddingY: "none", width: "full", gap: "none" },
          // every field filled in, so the inspector shows what the FNRL site shows
          columns: [{ id: id(), width: 12, props: {}, widgets: [{ id: id(), type: b.type, props: { ...defaultsOf(b.type), ...(b.props ?? {}), _spacing: "none" } }] }],
        })),
      };
      const seo = { metaDescription: p.seoDescription };
      const snapshot = { title: p.title, layout, seo, customCss: "", customJs: "", customHead: "", templateId };
      const stamp = now(); // the same time, so the page doesn't show as having unpublished changes
      run(
        "INSERT INTO pages(title, slug, sort, template_id, status, show_in_nav, is_home, seo, layout, published, published_at, updated_at) VALUES(?,?,?,?,'published',1,?,?,?,?,?,?)",
        p.title,
        slugOf(p.path),
        n,
        templateId,
        p.path === "/" ? 1 : 0,
        JSON.stringify(seo),
        JSON.stringify(layout),
        JSON.stringify(snapshot),
        stamp,
        stamp,
      );
    });
    if (seed.pages.some((p) => p.path === "/")) run("UPDATE pages SET is_home = CASE WHEN slug = 'home' AND parent_id IS NULL THEN 1 ELSE 0 END");
  });
  done.push(`Pages ${seed.pages.map((p) => p.title).join(", ")} created and published${keepDemo ? "" : " (demo pages removed)"}`);

  // 5. News: FNRL's story fields
  const newsFields: FieldDef[] = [
    { key: "summary", label: "Summary", type: "textarea", required: true, help: "One or two sentences, shown on story cards and in search." },
    {
      key: "category",
      label: "Category",
      type: "select",
      default: "Our game",
      options: ["Fiji Bati", "Fiji Bulikula", "Schools", "Community", "Our game", "Competitions", "Announcements"].map((v) => ({ value: v, label: v })),
    },
    { key: "image", label: "Photo", type: "image", required: true, help: "Landscape, at least 1600 px wide." },
    { key: "body", label: "Story", type: "richtext", required: true },
    { key: "credit", label: "Photo credit", type: "text", help: "Shown under the headline, e.g. Photo: NRL / SWPix." },
    { key: "displayDate", label: "Date shown", type: "text", help: "Leave empty to show the publish date. Use for features such as “From the FNRL archive”." },
    { key: "featured", label: "Feature on the home page", type: "boolean", help: "Featured stories lead the news list and the home page carousel." },
    { key: "source", label: "Original story link", type: "url", help: "For stories from NRL.com or another publisher (https only)." },
    { key: "videoUrl", label: "Video link", type: "url", help: "YouTube or Vodafone Play (https only)." },
    { key: "teamIds", label: "Teams", type: "tags", help: "FNRL team ids, e.g. fiji-bati. Links the story to those teams." },
    { key: "competitionIds", label: "Competitions", type: "tags", help: "FNRL competition ids. Links the story to those competitions." },
    { key: "programId", label: "Program", type: "text", help: "FNRL program id, if the story is about a program." },
  ];
  const typeRow = get<{ id: number }>("SELECT id FROM content_types WHERE key = 'news'");
  const typeId = typeRow
    ? (run("UPDATE content_types SET name='News', singular='Story', icon='Newspaper', color='#e8793a', description=?, fields=?, url_prefix='news', has_detail_pages=1 WHERE id=?", "Stories on the FNRL website.", JSON.stringify(newsFields), typeRow.id), typeRow.id)
    : Number(
        run(
          "INSERT INTO content_types(key, name, singular, icon, color, description, fields, url_prefix, detail_template, sort) VALUES('news','News','Story','Newspaper','#e8793a',?,?,'news',?,1)",
          "Stories on the FNRL website.",
          JSON.stringify(newsFields),
          DEFAULT_DETAIL_TEMPLATE,
        ).lastId,
      );
  if (!keepDemo) {
    // The Coral Coast demo content
    run("DELETE FROM content_types WHERE key IN ('events', 'team')");
  }
  run("DELETE FROM content_items WHERE type_id = ?", typeId);

  const imageCache = new Map<string, string>();
  let imported = 0;
  for (const s of seed.stories) {
    const image = s.image ? await importImage(String(s.image), imageCache) : "";
    const data = {
      summary: s.description || "",
      category: s.category || "Our game",
      image,
      body: toHtml(s.body),
      credit: s.credit || "",
      displayDate: /^\d{1,2} \w+ \d{4}$/.test(s.date || "") ? "" : s.date || "",
      featured: !!s.featured,
      source: s.source || "",
      videoUrl: s.videoUrl || "",
      teamIds: s.teamIds || [],
      competitionIds: s.competitionIds || [],
      programId: s.programId || "",
    };
    const publishedAt = s.publishedAt || parseDate(s.date) || now();
    run(
      "INSERT INTO content_items(type_id, title, slug, data, status, tags, categories, published_at, created_at, updated_at) VALUES(?,?,?,?,'published','[]',?,?,?,?)",
      typeId,
      s.title,
      s.id,
      JSON.stringify(data),
      JSON.stringify([data.category]),
      publishedAt,
      publishedAt,
      now(),
    );
    imported++;
  }
  invalidateMediaCache();
  done.push(`${imported} news stories imported (${photos} new photos in Media › FNRL news)`);

  // 6. Tell the FNRL site when something is published
  run("DELETE FROM functions WHERE kind = 'hook' AND name LIKE 'FNRL: %'");
  if (secret) {
    const code = `// Tells the FNRL website to show the change straight away.
export default async ({ event }) => {
  const r = await fetch(${JSON.stringify(`${api}/api/cms/revalidate`)}, {
    method: "POST",
    headers: { "x-cms-secret": ${JSON.stringify(secret)} },
  });
  console.log(event, "→ FNRL", r.status);
};`;
    for (const event of ["page.published", "content.published"]) {
      run("INSERT INTO functions(name, kind, event, code, enabled, is_public, updated_at) VALUES(?, 'hook', ?, ?, 1, 0, ?)", `FNRL: refresh after ${event}`, event, code, now());
    }
    done.push("Publishing now refreshes the FNRL site immediately (Code Studio › Functions › FNRL: …)");
  } else {
    done.push("No --secret given: the FNRL site shows published changes within 15 seconds");
  }
}

function defaultsOf(type: string) {
  const w = widgets.find((x) => x.key === type);
  return Object.fromEntries((w?.fields ?? []).map((f) => [f.key, f.default ?? ""]));
}

function slugOf(p: string) {
  return p === "/" ? "home" : p.replace(/^\/+|\/+$/g, "");
}

function toHtml(text = "") {
  if (/<\w+[^>]*>/.test(text)) return text;
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>`)
    .join("");
}

function parseDate(label?: string) {
  const t = label ? Date.parse(label) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Copies an FNRL photo into the media library. Returns its /media address (or the original address if it can't be copied). */
async function importImage(src: string, cache: Map<string, string>) {
  if (cache.has(src)) return cache.get(src)!;
  const url = /^https?:\/\//.test(src) ? src : `${api}${src.startsWith("/") ? "" : "/"}${src}`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    const mime = (r.headers.get("content-type") || "").split(";")[0].trim();
    if (!r.ok || !TYPES[mime]) throw new Error(`${r.status} ${mime}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const original = decodeURIComponent(path.basename(new URL(url).pathname)) || "photo";
    const existing = get<{ filename: string }>("SELECT filename FROM media WHERE folder = 'FNRL news' AND original_name = ? AND size = ?", original, buf.length);
    if (existing) {
      cache.set(src, `/media/${existing.filename}`);
      return cache.get(src)!;
    }
    const base = path.parse(original).name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "photo";
    const filename = `${base}-${crypto.randomBytes(4).toString("hex")}.${TYPES[mime]}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), buf);
    let width: number | null = null;
    let height: number | null = null;
    try {
      const d = imageSize(buf);
      width = d.width ?? null;
      height = d.height ?? null;
    } catch {
      /* dimensions are optional */
    }
    const variants = isRaster(mime) ? await makeVariants(filename, mime, width).catch(() => []) : [];
    run("INSERT OR IGNORE INTO media_folders(name) VALUES('FNRL news')");
    run(
      "INSERT INTO media(folder, filename, original_name, mime, size, width, height, alt, title, variants, created_at) VALUES('FNRL news',?,?,?,?,?,?,'',?,?,?)",
      filename,
      original.slice(0, 200),
      mime,
      buf.length,
      width,
      height,
      base.replace(/-/g, " "),
      JSON.stringify(variants),
      now(),
    );
    photos++;
    cache.set(src, `/media/${filename}`);
  } catch (e) {
    console.warn(`! Couldn't copy ${url} (${(e as Error).message}); the story keeps its FNRL address.`);
    cache.set(src, src);
  }
  return cache.get(src)!;
}
