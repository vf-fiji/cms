import type { WidgetNode, SectionNode, PageLayout, FormDef, CustomWidget } from "../../shared/types";
import { sanitizeRichText } from "../sanitize";
import { escapeHtml as e, renderLiquid, SafeHtml, liquidItem } from "./liquid";
import { listPublishedItems } from "../content";
import { all, get, json } from "../db";
import { renderReactWidget } from "../react";
import { bestVariant, dimensionsFor, focalFor, srcsetFor } from "../images";
import { search } from "../search";

const CONTAINER: Record<string, number> = { narrow: 808, contained: 1128, wide: 1488 };

/** `sizes` for an image filling `share` of the current column. */
function sizesFor(ctx: RenderCtx, share = 1) {
  const cols = ctx.layout?.colWidth ?? 12;
  const width = ctx.layout?.sectionWidth ?? "contained";
  const frac = (cols / 12) * share;
  const wide = width === "full" ? `${Math.round(frac * 100)}vw` : `${Math.round((CONTAINER[width] ?? 1128) * frac)}px`;
  return `(max-width: 860px) ${Math.round(100 * Math.min(1, share * 2))}vw, ${wide}`;
}

/** Responsive <img>: srcset from resized copies, intrinsic size, focal point. */
function img(src: string, ctx: RenderCtx, opts: { alt?: string; share?: number; cls?: string; style?: string; eager?: boolean } = {}) {
  const srcset = srcsetFor(src);
  const focal = focalFor(src);
  const dims = dimensionsFor(src);
  const style = [opts.style, focal ? `object-position:${focal}` : ""].filter(Boolean).join(";");
  return `<img src="${e(src)}"${srcset ? ` srcset="${e(srcset)}" sizes="${e(sizesFor(ctx, opts.share))}"` : ""}${dims ? ` width="${dims.width}" height="${dims.height}"` : ""} alt="${e(opts.alt ?? "")}" ${opts.eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"${opts.cls ? ` class="${opts.cls}"` : ""}${style ? ` style="${e(style)}"` : ""}>`;
}

/** CSS for a background image, using a resized copy and the focal point. */
function bgStyle(src: string) {
  const focal = focalFor(src);
  return `background-image:url('${bestVariant(src, 1600).replace(/'/g, "%27")}')${focal ? `;background-position:${focal}` : ""}`;
}

export interface RenderCtx {
  editor: boolean;
  page: { id: number | null; path: string; title: string; parentId: number | null };
  site: Record<string, any>;
  query: Record<string, string>;
  css: Map<string, string>;
  js: Map<string, string>;
  /** ES module scripts (React widget mounts). Unlike js, these also run in the editor canvas. */
  modules: Map<string, string>;
  /** true once a React widget is on the page, so the import map is emitted */
  react: boolean;
  /** JS/JSX sources rendered in the browser, scanned for Tailwind classes */
  sources: string[];
  /** where the widget being rendered sits, for responsive image sizes */
  layout?: { sectionWidth: string; colWidth: number };
  /** level of the last heading a widget wrote, so card titles nest under it (h2 under h1, h3 under h2) */
  lastHeading?: number;
  nav: NavItem[];
  customWidgets?: Map<string, CustomWidget>;
}

export interface NavItem {
  id: number;
  title: string;
  url: string;
  active: boolean;
  children: NavItem[];
  parentId: number | null;
}

const attr = (name: string, v: unknown) => (v === undefined || v === null || v === "" ? "" : ` ${name}="${e(v)}"`);
const safeUrl = (u: unknown) => {
  const s = String(u ?? "").trim();
  if (/^\s*javascript:/i.test(s)) return "#";
  return s;
};

export async function renderLayout(layout: PageLayout, ctx: RenderCtx): Promise<string> {
  const out: string[] = [];
  for (const s of layout.sections ?? []) out.push(await renderSection(s, ctx));
  if (ctx.editor && !(layout.sections ?? []).length) {
    out.push(`<div class="rfe-empty-page"><div><strong>This page is empty</strong><span>Drag a widget or a layout from the left panel to start.</span></div></div>`);
  }
  return out.join("\n");
}

const ITEM_HEADING_WIDGETS = new Set(["card", "features", "contentList", "search"]);
/** Heading tag for repeated item titles: one level below the last heading on the page, h2–h4. */
const itemHeading = (ctx: RenderCtx) => `h${Math.min(4, Math.max(2, (ctx.lastHeading ?? 1) + 1))}`;

async function renderSection(s: SectionNode, ctx: RenderCtx): Promise<string> {
  const p = s.props ?? {};
  const classes = [
    "rf-section",
    `rf-bg-${p.background || "none"}`,
    `rf-py-${p.paddingY || "lg"}`,
    p.bgImage ? "rf-has-image" : "",
    p.cssClass || "",
  ];
  const styles: string[] = [];
  if (p.background === "custom" && p.bgColor) styles.push(`background-color:${p.bgColor}`);
  if (p.bgImage) styles.push(bgStyle(String(p.bgImage)));
  if (p.minHeight) styles.push(`min-height:${Number(p.minHeight)}px`);
  if (p.style) styles.push(String(p.style).replace(/[\n\r]/g, " "));
  const overlay = p.bgImage && Number(p.overlay ?? 40) > 0 ? `<div class="rf-overlay" style="opacity:${Number(p.overlay ?? 40) / 100}"></div>` : "";
  const cols: string[] = [];
  for (const c of s.columns ?? []) {
    const widgets: string[] = [];
    ctx.layout = { sectionWidth: p.width || "contained", colWidth: Math.max(1, Math.min(12, c.width || 12)) };
    for (const w of c.widgets ?? []) {
      const html = await renderWidget(w, ctx);
      // widgets that repeat item titles don't change the outline; everything else (hero, heading, text…) does
      if (!ITEM_HEADING_WIDGETS.has(w.type)) {
        const levels = [...html.matchAll(/<h([1-6])[\s>]/g)];
        if (levels.length) ctx.lastHeading = Number(levels[levels.length - 1][1]);
      }
      widgets.push(html);
    }
    const empty = ctx.editor && !(c.widgets ?? []).length ? `<div class="rfe-empty-col">Drop widgets here</div>` : "";
    cols.push(
      `<div class="rf-col rf-col-${Math.max(1, Math.min(12, c.width || 12))}"${ctx.editor ? attr("data-rf-column", c.id) : ""}>${widgets.join("")}${empty}</div>`,
    );
  }
  return `<section class="${classes.filter(Boolean).join(" ")}"${attr("id", p.anchor)}${styles.length ? attr("style", styles.join(";")) : ""}${ctx.editor ? attr("data-rf-section", s.id) : ""}>${overlay}<div class="rf-container rf-w-${p.width || "contained"}"><div class="rf-row rf-gap-${p.gap || "md"} rf-valign-${p.valign || "start"}">${cols.join("")}</div></div></section>`;
}

export async function renderWidget(w: WidgetNode, ctx: RenderCtx): Promise<string> {
  const p = w.props ?? {};
  let inner = "";
  try {
    inner = await renderWidgetInner(w, ctx);
  } catch (err: any) {
    inner = `<div class="rf-error">Widget error: ${e(err?.message ?? err)}</div>`;
  }
  const cls = ["rf-widget", `rf-widget-${w.type}`, p._spacing ? `rf-mb-${p._spacing}` : "rf-mb-md", p._visibility && p._visibility !== "all" ? `rf-only-${p._visibility}` : "", p._class || ""];
  return `<div class="${cls.filter(Boolean).join(" ")}"${attr("id", p._anchor)}${p._style ? attr("style", String(p._style).replace(/[\n\r]/g, " ")) : ""}${ctx.editor ? attr("data-rf-widget", w.id) + attr("data-rf-type", w.type) : ""}>${inner}</div>`;
}

function videoEmbed(url: string, title: string, autoplay: boolean) {
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/);
  if (yt) return `<div class="rf-embed"><iframe src="https://www.youtube-nocookie.com/embed/${yt[1]}${autoplay ? "?autoplay=1&mute=1" : ""}" title="${e(title)}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen loading="lazy"></iframe></div>`;
  const vm = url.match(/vimeo\.com\/(\d+)/);
  if (vm) return `<div class="rf-embed"><iframe src="https://player.vimeo.com/video/${vm[1]}${autoplay ? "?autoplay=1&muted=1" : ""}" title="${e(title)}" allow="autoplay; fullscreen" allowfullscreen loading="lazy"></iframe></div>`;
  if (url) return `<video class="rf-video" src="${e(url)}" controls ${autoplay ? "autoplay muted loop playsinline" : ""}></video>`;
  return `<div class="rf-placeholder">Add a YouTube, Vimeo or MP4 link</div>`;
}

function buttons(list: { label?: string; url?: string; variant: string }[], size = "md", newTab = false) {
  return list
    .filter((b) => b.label)
    .map((b) => `<a class="rf-btn rf-btn-${b.variant} rf-btn-${size}" href="${e(safeUrl(b.url) || "#")}"${newTab ? ' target="_blank" rel="noopener"' : ""}>${e(b.label)}</a>`)
    .join("");
}

function formatDate(d: string) {
  try {
    return new Date(d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}

async function renderWidgetInner(w: WidgetNode, ctx: RenderCtx): Promise<string> {
  const p = w.props ?? {};
  const alignCls = p.align ? ` rf-align-${p.align}` : "";
  switch (w.type) {
    case "heading": {
      const lvl = ["h1", "h2", "h3", "h4"].includes(p.level) ? p.level : "h2";
      const eyebrow = p.eyebrow ? `<div class="rf-eyebrow">${e(p.eyebrow)}</div>` : "";
      return `<div class="rf-heading${alignCls}">${eyebrow}<${lvl}${p.color ? attr("style", `color:${p.color}`) : ""}${ctx.editor ? ' data-rf-inline="text"' : ""}>${e(p.text)}</${lvl}></div>`;
    }
    case "text":
      return `<div class="rf-text rf-text-${p.size || "md"}${alignCls}"${ctx.editor ? ' data-rf-inline="html"' : ""}>${sanitizeRichText(p.html)}</div>`;
    case "button":
      return `<div class="rf-buttons${alignCls}">${buttons(
        [
          { label: p.label, url: p.url, variant: p.variant || "primary" },
          { label: p.secondLabel, url: p.secondUrl, variant: p.variant === "primary" ? "outline" : "primary" },
        ],
        p.size,
        p.newTab,
      )}</div>`;
    case "image": {
      if (!p.src) return `<div class="rf-placeholder rf-placeholder-img">Choose an image</div>`;
      const style = p.ratio && p.ratio !== "auto" ? ` style="aspect-ratio:${e(p.ratio)};object-fit:cover"` : "";
      let tag = img(String(p.src), ctx, {
        alt: p.alt,
        cls: `${p.rounded ? "rf-rounded" : ""} ${p.shadow ? "rf-shadow" : ""}`.trim(),
        style: p.ratio && p.ratio !== "auto" ? `aspect-ratio:${p.ratio};object-fit:cover` : "",
      });
      if (p.link) tag = `<a href="${e(safeUrl(p.link))}">${tag}</a>`;
      return `<figure class="rf-figure">${tag}${p.caption ? `<figcaption>${e(p.caption)}</figcaption>` : ""}</figure>`;
    }
    case "hero": {
      const bg = p.image ? ` style="${e(bgStyle(String(p.image)))}"` : "";
      return `<div class="rf-hero rf-hero-${p.height || "md"}${alignCls}${p.image ? " rf-has-image" : ""}"${bg}>${p.image ? `<div class="rf-overlay" style="opacity:${Number(p.overlay ?? 45) / 100}"></div>` : ""}<div class="rf-hero-inner">${p.eyebrow ? `<div class="rf-eyebrow">${e(p.eyebrow)}</div>` : ""}<h1>${e(p.title)}</h1>${p.subtitle ? `<p class="rf-hero-sub">${e(p.subtitle)}</p>` : ""}<div class="rf-buttons">${buttons(
        [
          { label: p.ctaLabel, url: p.ctaUrl, variant: "primary" },
          { label: p.cta2Label, url: p.cta2Url, variant: p.image ? "light" : "outline" },
        ],
        "lg",
      )}</div></div></div>`;
    }
    case "card": {
      const cardImg = p.image ? `<div class="rf-card-img">${img(String(p.image), ctx)}</div>` : "";
      const link = p.url && p.linkLabel ? `<a class="rf-card-link" href="${e(safeUrl(p.url))}">${e(p.linkLabel)} →</a>` : "";
      const h = itemHeading(ctx);
      return `<article class="rf-card rf-card-${p.style || "elevated"}">${cardImg}<div class="rf-card-body"><${h}>${e(p.title)}</${h}><p>${e(p.text)}</p>${link}</div></article>`;
    }
    case "features": {
      const items = (p.items ?? []) as any[];
      const h = itemHeading(ctx);
      return `<div class="rf-features rf-grid-${p.columns || 3}${alignCls}">${items
        .map((i) => `<div class="rf-feature">${i.icon ? `<div class="rf-feature-icon" aria-hidden="true">${e(i.icon)}</div>` : ""}<${h}>${e(i.title)}</${h}><p>${e(i.text)}</p></div>`)
        .join("")}</div>`;
    }
    case "stats":
      return `<div class="rf-stats">${((p.items ?? []) as any[]).map((i) => `<div class="rf-stat"><strong>${e(i.value)}</strong><span>${e(i.label)}</span></div>`).join("")}</div>`;
    case "quote":
      return `<blockquote class="rf-quote"><p>“${e(p.quote)}”</p><footer>${p.avatar ? img(String(p.avatar), ctx, { share: 0.1 }) : `<span class="rf-avatar">${e(String(p.author ?? "?").slice(0, 1))}</span>`}<div><strong>${e(p.author)}</strong>${p.role ? `<span>${e(p.role)}</span>` : ""}</div></footer></blockquote>`;
    case "gallery": {
      const imgs = (p.images ?? []) as string[];
      if (!imgs.length) return `<div class="rf-placeholder rf-placeholder-img">Add images to the gallery</div>`;
      return `<div class="rf-gallery rf-grid-${p.columns || 3}"${p.lightbox ? " data-rf-lightbox" : ""}>${imgs
        .map((src) => `<a href="${e(src)}" class="rf-gallery-item">${img(src, ctx, { share: 1 / Number(p.columns || 3) })}</a>`)
        .join("")}</div>`;
    }
    case "video":
      return videoEmbed(String(p.url ?? ""), p.title ?? "Video", !!p.autoplay);
    case "accordion": {
      const items = (p.items ?? []) as any[];
      return `<div class="rf-accordion">${items
        .map((i, idx) => `<details${p.openFirst && idx === 0 ? " open" : ""}><summary>${e(i.title)}</summary><div class="rf-accordion-body">${e(i.body).replace(/\n/g, "<br>")}</div></details>`)
        .join("")}</div>`;
    }
    case "tabs": {
      const items = (p.items ?? []) as any[];
      return `<div class="rf-tabs" data-rf-tabs><div class="rf-tablist" role="tablist">${items
        .map((i, idx) => `<button type="button" role="tab" aria-selected="${idx === 0}" data-tab="${idx}">${e(i.title)}</button>`)
        .join("")}</div>${items.map((i, idx) => `<div class="rf-tabpanel" role="tabpanel" data-panel="${idx}"${idx ? " hidden" : ""}>${e(i.body).replace(/\n/g, "<br>")}</div>`).join("")}</div>`;
    }
    case "spacer":
      return `<div class="rf-spacer" style="height:${Math.max(0, Number(p.height ?? 48))}px"></div>`;
    case "divider":
      return `<hr class="rf-divider" style="border-top-style:${["solid", "dashed", "dotted"].includes(p.style) ? p.style : "solid"}">`;
    case "search": {
      const q = String(ctx.query.q ?? "").slice(0, 200);
      const form = `<form class="rf-search" role="search" method="get"><input class="rf-search-field" type="search" name="q" value="${e(q)}" placeholder="${e(p.placeholder || "Search the site")}" aria-label="${e(p.placeholder || "Search the site")}" autocomplete="off"><button class="rf-btn rf-btn-primary rf-btn-md" type="submit">${e(p.buttonLabel || "Search")}</button></form>`;
      if (!q.trim()) return form;
      const hits = search(q, Number(p.limit) || 10);
      const list = hits.length
        ? `<ol class="rf-search-results">${hits.map((h) => `<li><a href="${e(h.url)}"><span class="rf-search-title">${e(h.title)}</span><span class="rf-search-url">${e(h.url)}</span></a>${h.snippet ? `<p>${h.snippet}</p>` : ""}</li>`).join("")}</ol>`
        : `<p class="rf-empty">No results for “${e(q)}”. Try fewer or different words.</p>`;
      return `${form}<div class="rf-search-summary" role="status">${hits.length ? `${hits.length} result${hits.length === 1 ? "" : "s"} for “${e(q)}”` : ""}</div>${list}`;
    }
    case "map": {
      const q = encodeURIComponent(String(p.address ?? ""));
      return `<div class="rf-map" style="height:${Number(p.height ?? 360)}px"><iframe title="Map of ${e(p.address)}" src="https://maps.google.com/maps?q=${q}&z=14&output=embed" loading="lazy"></iframe></div>`;
    }
    case "navigation":
      return renderNavWidget(p, ctx);
    case "contentList":
      return renderContentList(w, ctx);
    case "form":
      return renderForm(String(p.formKey ?? ""), p.title, ctx);
    case "html": {
      if (p.css) ctx.css.set(`w-${w.id}`, String(p.css));
      if (p.js && !ctx.editor) ctx.js.set(`w-${w.id}`, `(function(){\n${p.js}\n})();`);
      return await renderLiquid(String(p.html ?? ""), { site: ctx.site, page: ctx.page, nav: ctx.nav, query: ctx.query });
    }
    case "react": {
      if (p.css) ctx.css.set(`w-${w.id}`, String(p.css));
      let props: Record<string, unknown> = {};
      try {
        props = p.props ? JSON.parse(String(p.props)) : {};
      } catch {
        if (ctx.editor) return `<div class="rf-error">The props aren't valid JSON.</div>`;
      }
      // Inline React blocks are written by page editors, so they render in the browser only.
      ctx.sources.push(String(p.code ?? ""));
      const out = await renderReactWidget({ id: w.id, source: String(p.code ?? ""), props, ssr: false, editor: ctx.editor });
      if (out.module) {
        ctx.react = true;
        ctx.modules.set(w.id, out.module);
      }
      return out.html;
    }
    default: {
      const cw = getCustomWidget(w.type, ctx);
      if (!cw) return ctx.editor ? `<div class="rf-placeholder">Unknown widget “${e(w.type)}”</div>` : "";
      if (cw.css) ctx.css.set(`cw-${cw.key}`, cw.css);
      if (cw.renderer === "react") {
        const props = { ...Object.fromEntries(cw.fields.map((f) => [f.key, f.default ?? ""])), ...stripInternal(p) };
        ctx.sources.push(cw.template);
        const out = await renderReactWidget({ id: w.id, source: cw.template, props, ssr: cw.ssr, editor: ctx.editor });
        if (out.module) {
          ctx.react = true;
          ctx.modules.set(w.id, out.module);
        }
        return out.html;
      }
      if (cw.js && !ctx.editor) ctx.js.set(`cw-${cw.key}`, `(function(){\n${cw.js}\n})();`);
      const props: Record<string, unknown> = { ...Object.fromEntries(cw.fields.map((f) => [f.key, f.default ?? ""])), ...p };
      // rich text props are cleaned and printable; everything else is escaped when printed
      for (const f of cw.fields) if (f.type === "richtext") props[f.key] = new SafeHtml(sanitizeRichText(props[f.key]));
      return await renderLiquid(cw.template, { props, widget: { id: w.id, type: w.type }, site: ctx.site, page: ctx.page, nav: ctx.nav, query: ctx.query });
    }
  }
}

function getCustomWidget(key: string, ctx: RenderCtx): CustomWidget | undefined {
  if (!ctx.customWidgets) {
    ctx.customWidgets = new Map(
      all("SELECT * FROM custom_widgets").map((r: any) => [
        r.key,
        { id: r.id, key: r.key, name: r.name, icon: r.icon, category: r.category, description: r.description, fields: json(r.fields, []), renderer: r.renderer === "react" ? "react" : "liquid", ssr: !!r.ssr, template: r.template, css: r.css, js: r.js, updatedAt: r.updated_at },
      ]),
    );
  }
  return ctx.customWidgets.get(key);
}

/** Widget props minus the shared "_spacing"/"_class" style keys. */
function stripInternal(p: Record<string, any>) {
  return Object.fromEntries(Object.entries(p).filter(([k]) => !k.startsWith("_")));
}

function renderNavWidget(p: any, ctx: RenderCtx) {
  let items: NavItem[] = ctx.nav;
  const flat: NavItem[] = [];
  const walk = (list: NavItem[]) => list.forEach((n) => (flat.push(n), walk(n.children)));
  walk(ctx.nav);
  if (p.source === "children") items = flat.find((n) => n.id === ctx.page.id)?.children ?? [];
  if (p.source === "siblings") items = ctx.page.parentId ? (flat.find((n) => n.id === ctx.page.parentId)?.children ?? []) : ctx.nav;
  if (!items.length) return ctx.editor ? `<div class="rf-placeholder">No pages to show here yet</div>` : "";
  return `<nav class="rf-nav rf-nav-${p.direction || "horizontal"}"><ul>${items.map((n) => `<li><a href="${e(n.url)}"${n.active ? ' aria-current="page"' : ""}>${e(n.title)}</a></li>`).join("")}</ul></nav>`;
}

async function renderContentList(w: WidgetNode, ctx: RenderCtx) {
  const p = w.props ?? {};
  const limit = Math.max(1, Math.min(100, Number(p.limit) || 6));
  const pageNo = p.paginate ? Math.max(1, Number(ctx.query.p) || 1) : 1;
  const { type, items, total } = listPublishedItems(String(p.contentType ?? ""), {
    limit,
    offset: (pageNo - 1) * limit,
    tag: p.tag || undefined,
    category: p.category || undefined,
    sort: p.sort,
  });
  if (!type) return `<div class="rf-placeholder">Choose a content type for this list</div>`;
  if (!items.length) return `<div class="rf-empty">${ctx.editor ? `No published ${e(type.name.toLowerCase())} yet.` : "Nothing here yet."}</div>`;
  let html = "";
  if (p.layout === "custom") {
    html = await renderLiquid(String(p.template ?? ""), { items: items.map(liquidItem), type: { key: type.key, name: type.name }, site: ctx.site, page: ctx.page });
  } else if (p.layout === "compact") {
    html = `<ul class="rf-compact-list">${items.map((i) => `<li><a href="${e(i.url)}">${e(i.title)}</a>${p.showDate ? `<time>${formatDate(i.date)}</time>` : ""}</li>`).join("")}</ul>`;
  } else {
    const isGrid = p.layout !== "list";
    const h = itemHeading(ctx);
    html = `<div class="${isGrid ? `rf-content-grid rf-grid-${p.columns || 3}` : "rf-content-list"}">${items
      .map(
        (i) => `<article class="rf-content-card">${p.showImage && i.image ? `<a class="rf-content-img" href="${e(i.url)}" tabindex="-1" aria-hidden="true">${img(String(i.image), ctx, { share: isGrid ? 1 / Number(p.columns || 3) : 0.34 })}</a>` : ""}<div class="rf-content-body">${p.showDate ? `<time>${formatDate(i.date)}</time>` : ""}<${h}><a href="${e(i.url) || "#"}">${e(i.title)}</a></${h}>${p.showSummary && i.summary ? `<p>${e(i.summary)}</p>` : ""}${i.tags?.length ? `<div class="rf-tags">${i.tags.map((t: string) => `<span>${e(t)}</span>`).join("")}</div>` : ""}</div></article>`,
      )
      .join("")}</div>`;
  }
  if (p.paginate && total > limit) {
    const pages = Math.ceil(total / limit);
    html += `<nav class="rf-pagination">${Array.from({ length: pages }, (_, i) => `<a href="?p=${i + 1}"${i + 1 === pageNo ? ' aria-current="page"' : ""}>${i + 1}</a>`).join("")}</nav>`;
  }
  return html;
}

export function renderForm(key: string, title: string | undefined, ctx: RenderCtx) {
  const r = get("SELECT * FROM forms WHERE key = ?", key);
  if (!r) return ctx.editor ? `<div class="rf-placeholder">Choose a form to display</div>` : "";
  const form: FormDef = { id: r.id, key: r.key, name: r.name, fields: json(r.fields, []), settings: json(r.settings, {} as any), updatedAt: r.updated_at };
  const fields = form.fields
    .map((f) => {
      const id = `f-${form.key}-${f.key}`;
      const req = f.required ? " required" : "";
      const label = `<label for="${id}">${e(f.label)}${f.required ? ' <span class="rf-req">*</span>' : ""}</label>`;
      const help = f.help ? `<small>${e(f.help)}</small>` : "";
      const wrap = (inner: string) => `<div class="rf-field rf-field-${f.width === "half" ? "half" : "full"}">${inner}${help}</div>`;
      switch (f.type) {
        case "heading":
          return `<div class="rf-field rf-field-full rf-form-heading">${e(f.label)}</div>`;
        case "hidden":
          return `<input type="hidden" name="${e(f.key)}" value="${e(f.defaultValue)}">`;
        case "textarea":
          return wrap(`${label}<textarea id="${id}" name="${e(f.key)}" rows="5" placeholder="${e(f.placeholder)}"${req}></textarea>`);
        case "select":
          return wrap(`${label}<select id="${id}" name="${e(f.key)}"${req}><option value="">Select…</option>${(f.options ?? []).map((o) => `<option>${e(o)}</option>`).join("")}</select>`);
        case "radio":
          return wrap(`<fieldset><legend>${e(f.label)}${f.required ? ' <span class="rf-req">*</span>' : ""}</legend>${(f.options ?? []).map((o, i) => `<label class="rf-choice"><input type="radio" name="${e(f.key)}" value="${e(o)}"${req && i === 0 ? " required" : ""}> ${e(o)}</label>`).join("")}</fieldset>`);
        case "checkbox":
          return wrap(`<fieldset><legend>${e(f.label)}</legend>${(f.options ?? []).map((o) => `<label class="rf-choice"><input type="checkbox" name="${e(f.key)}" value="${e(o)}"> ${e(o)}</label>`).join("")}</fieldset>`);
        case "consent":
          return wrap(`<label class="rf-choice"><input type="checkbox" name="${e(f.key)}" value="yes"${req}> ${e(f.label)}</label>`);
        default: {
          const t = { email: "email", phone: "tel", number: "number", date: "date" }[f.type as string] ?? "text";
          return wrap(`${label}<input id="${id}" type="${t}" name="${e(f.key)}" placeholder="${e(f.placeholder)}"${req}>`);
        }
      }
    })
    .join("");
  return `<form class="rf-form" method="post" action="/api/public/forms/${e(form.key)}/submit" data-rf-form="${e(form.key)}" data-success="${e(form.settings.successMessage || "Thanks! We received your message.")}"${form.settings.redirectUrl ? attr("data-redirect", form.settings.redirectUrl) : ""}>${title ? `<h3 class="rf-form-title">${e(title)}</h3>` : ""}<div class="rf-form-grid">${fields}</div><input type="text" name="_hp" tabindex="-1" autocomplete="off" class="rf-hp" aria-hidden="true"><input type="hidden" name="_page" value="${e(ctx.page.path)}"><button class="rf-btn rf-btn-primary rf-btn-md" type="submit">${e(form.settings.submitLabel || "Send")}</button><div class="rf-form-status" role="status" aria-live="polite"></div></form>`;
}
