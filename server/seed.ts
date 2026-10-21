import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { get, run, now, tx, saveSettings, DATA_DIR, UPLOAD_DIR, DEFAULT_SETTINGS } from "./db";
import { hashPassword } from "./auth";
import { ALL_PERMISSIONS } from "../shared/types";
import { makeSection, makeWidget, getWidgetDef } from "../shared/widgets";
import { DEFAULT_DETAIL_TEMPLATE } from "./render/site";

export const DEFAULT_TEMPLATE_HTML = `<header class="site-header" data-rf-header>
  <div class="site-header-inner">
    <a class="site-logo" href="/">
      {% if site.logo != "" %}<img src="{{ site.logo }}" alt="{{ site.siteName }}">{% else %}<span class="site-logo-mark" aria-hidden="true"></span>{{ site.siteName }}{% endif %}
    </a>
    <button class="site-menu-toggle" type="button" aria-label="Open menu" aria-expanded="false" data-rf-menu-toggle><span></span><span></span></button>
    <nav class="site-nav" aria-label="Main" data-rf-menu>
      <ul>
        {% for item in nav %}
        <li{% if item.children.size > 0 %} class="has-children"{% endif %}>
          <a href="{{ item.url }}"{% if item.active %} aria-current="page"{% endif %}>{{ item.title }}</a>
          {% if item.children.size > 0 %}
          <ul class="site-subnav">
            {% for child in item.children %}<li><a href="{{ child.url }}">{{ child.title }}</a></li>{% endfor %}
          </ul>
          {% endif %}
        </li>
        {% endfor %}
      </ul>
    </nav>
  </div>
</header>

<main>
  {{ content }}
</main>

<footer class="site-footer">
  <div class="site-footer-inner">
    <div class="site-footer-brand">
      <strong>{{ site.siteName }}</strong>
      <p>{{ site.tagline }}</p>
    </div>
    <nav class="site-footer-nav" aria-label="Footer">
      {% for item in nav %}<a href="{{ item.url }}">{{ item.title }}</a>{% endfor %}
    </nav>
    <div class="site-social">
      {% for link in site.socialLinks %}<a href="{{ link.url }}" rel="noopener">{{ link.label }}</a>{% endfor %}
    </div>
  </div>
  <div class="site-footer-bottom"><!--reef:footer--></div>
</footer>`;

export const DEFAULT_TEMPLATE_CSS = `/* Header, navigation and footer for the default template (Apple-style).
   Widget styles live in /_reef/site.css; override anything here. */
.site-header { position: sticky; top: 0; z-index: 50; background: rgb(251 251 253 / .8); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); border-bottom: 1px solid rgb(0 0 0 / .08); }
.site-header-inner { max-width: 1128px; margin: 0 auto; padding: 0 22px; height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
.site-logo { display: inline-flex; align-items: center; gap: 9px; font-weight: 600; font-size: 17px; letter-spacing: -.022em; color: var(--rf-ink); text-decoration: none; }
.site-logo img { height: 28px; width: auto; }
.site-logo-mark { width: 24px; height: 24px; border-radius: 50%; background: radial-gradient(circle at 32% 28%, #ff5a5a, var(--rf-primary) 55%, var(--rf-accent)); box-shadow: 0 4px 10px -4px var(--rf-primary); }
.site-nav ul { list-style: none; display: flex; gap: 2px; margin: 0; padding: 0; }
.site-nav li { position: relative; }
.site-nav a { display: block; padding: 0 12px; line-height: 52px; color: rgb(0 0 0 / .8); font-weight: 400; font-size: 13.5px; letter-spacing: -.01em; text-decoration: none; transition: color .3s; }
.site-nav a:hover { color: #000; }
.site-nav a[aria-current="page"] { color: #000; font-weight: 600; }
.site-nav a[aria-current="page"]::after { content: ""; display: block; height: 2px; margin-top: -2px; border-radius: 2px; background: var(--rf-primary); }
.site-subnav { position: absolute; top: 100%; left: -8px; min-width: 220px; padding: 8px !important; display: none !important; flex-direction: column; background: rgb(251 251 253 / .92); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); border-radius: 18px; box-shadow: 0 24px 50px -20px rgb(0 0 0 / .3), 0 0 0 .5px rgb(0 0 0 / .08); }
.site-subnav a { line-height: 1.4; padding: 10px 12px; border-radius: 10px; font-size: 14px; }
.site-subnav a:hover { background: rgb(0 0 0 / .05); }
.site-nav li:hover > .site-subnav, .site-nav li:focus-within > .site-subnav { display: flex !important; }
.site-menu-toggle { display: none; background: none; border: 0; width: 40px; height: 40px; padding: 11px; cursor: pointer; }
.site-menu-toggle span { display: block; height: 1.5px; background: var(--rf-ink); margin: 6px 0; border-radius: 2px; transition: transform .3s; }
.site-menu-toggle[aria-expanded="true"] span:first-child { transform: translateY(3.75px) rotate(45deg); }
.site-menu-toggle[aria-expanded="true"] span:last-child { transform: translateY(-3.75px) rotate(-45deg); }
@media (max-width: 860px) {
  .site-menu-toggle { display: block; }
  .site-nav { position: fixed; inset: 52px 0 auto 0; background: rgb(251 251 253 / .96); -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px); padding: 8px 22px 28px; border-bottom: 1px solid rgb(0 0 0 / .08); display: none; }
  .site-nav.is-open { display: block; }
  .site-nav ul { flex-direction: column; }
  .site-nav a { line-height: 1.3; padding: 14px 0; font-size: 22px; font-weight: 600; letter-spacing: -.02em; }
  .site-nav a[aria-current="page"]::after { display: none; }
  .site-subnav { position: static; display: flex !important; background: none; box-shadow: none; padding: 0 0 0 14px !important; }
  .site-subnav a { font-size: 17px; font-weight: 500; padding: 8px 0; }
}
.site-footer { background: #f5f5f7; color: #6e6e73; font-size: 13px; }
.site-footer-inner { max-width: 1128px; margin: 0 auto; padding: 48px 22px 28px; display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 32px; }
.site-footer-brand strong { color: #1d1d1f; font-size: 15px; font-weight: 600; letter-spacing: -.015em; }
.site-footer-brand p { margin: 6px 0 0; }
.site-footer-nav, .site-social { display: flex; flex-direction: column; gap: 10px; }
.site-footer a { color: #424245; text-decoration: none; }
.site-footer a:hover { color: #1d1d1f; text-decoration: underline; }
.site-footer-bottom { max-width: 1128px; margin: 0 auto; padding: 18px 22px 30px; border-top: 1px solid #d2d2d7; font-size: 12px; color: #6e6e73; }
@media (max-width: 760px) { .site-footer-inner { grid-template-columns: 1fr; } }
`;

export const LANDING_TEMPLATE_CSS = `.lp-header { padding: 22px 32px; position: absolute; z-index: 5; }
.site-logo { display: inline-flex; gap: 9px; align-items: center; font-weight: 600; letter-spacing: -.02em; color: inherit; text-decoration: none; }
.site-logo-mark { width: 24px; height: 24px; border-radius: 50%; background: radial-gradient(circle at 32% 28%, #ff5a5a, var(--rf-primary) 55%, var(--rf-accent)); }
.lp-footer { padding: 32px; text-align: center; color: #6e6e73; font-size: 12px; background: #f5f5f7; }`;

export const DEFAULT_TEMPLATE_JS = `// Mobile menu toggle for the default template
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-rf-menu-toggle]");
  if (!btn) return;
  const menu = document.querySelector("[data-rf-menu]");
  const open = !menu.classList.contains("is-open");
  menu.classList.toggle("is-open", open);
  btn.setAttribute("aria-expanded", String(open));
});
`;

/** Abstract artwork so the demo site isn't empty. */
export function artSvg(seed: number, a: string, b: string, c: string) {
  const r = (n: number) => Math.abs(Math.sin(seed * 97 + n * 13.7)) ;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" width="1200" height="800">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient>
<filter id="f" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="70"/></filter></defs>
<rect width="1200" height="800" fill="url(#g)"/>
<g filter="url(#f)" opacity=".85">
<circle cx="${200 + r(1) * 800}" cy="${150 + r(2) * 500}" r="${180 + r(3) * 160}" fill="${c}"/>
<circle cx="${100 + r(4) * 900}" cy="${200 + r(5) * 400}" r="${140 + r(6) * 140}" fill="${b}"/>
<circle cx="${300 + r(7) * 700}" cy="${300 + r(8) * 400}" r="${120 + r(9) * 120}" fill="#ffffff" opacity=".35"/>
</g>
<g fill="none" stroke="#fff" stroke-opacity=".18" stroke-width="2">
<path d="M0 ${560 + r(10) * 80} C 300 ${480 + r(11) * 80}, 600 ${640 + r(12) * 60}, 1200 ${520 + r(13) * 80}"/>
<path d="M0 ${620 + r(14) * 80} C 400 ${540 + r(15) * 80}, 800 ${700 + r(16) * 60}, 1200 ${600 + r(17) * 80}"/>
</g></svg>`;
}

/** Vodafone-inspired palettes: [name, from, to, glow]. The first one is the homepage hero. */
export const ART_PALETTES: [string, string, string, string][] = [
  ["Red glow", "#e60000", "#5a0008", "#ff5a4f"],
  ["Graphite", "#25282b", "#0b0c0d", "#e60000"],
  ["Aubergine", "#5e2750", "#1f0a1b", "#9c2aa0"],
  ["Aqua", "#00b0ca", "#00566a", "#8ee6f2"],
  ["Sunrise", "#eb9700", "#e60000", "#fecb00"],
  ["Spring", "#a8b400", "#3d5c00", "#e8f080"],
];

function seedMedia(): string[] {
  run("INSERT OR IGNORE INTO media_folders(name) VALUES('Artwork')");
  return ART_PALETTES.map(([name, a, b, c], i) => {
    const filename = `${name.toLowerCase().replace(/\s+/g, "-")}-${crypto.randomBytes(3).toString("hex")}.svg`;
    const svg = artSvg(i + 1, a, b, c);
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), svg);
    run(
      "INSERT INTO media(folder, filename, original_name, mime, size, width, height, alt, title, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      "Artwork",
      filename,
      `${name}.svg`,
      "image/svg+xml",
      Buffer.byteLength(svg),
      1200,
      800,
      `Abstract ${name.toLowerCase()} gradient artwork`,
      `${name} artwork`,
      now(),
    );
    return `/media/${filename}`;
  });
}

/** A React + Tailwind custom widget, seeded as an example. */
export const TAILWIND_CALLOUT_SOURCE = `// React + Tailwind: utility classes in className are picked up automatically,
// including ones inside strings like the button's on/off classes below.
import { useState } from "react";

export default function Callout({ title, text, ctaLabel, ctaUrl }) {
  const [liked, setLiked] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-[2rem] bg-neutral-950 px-8 py-12 text-white md:px-14 md:py-16">
      <div className="pointer-events-none absolute -top-24 -right-24 size-80 rounded-full bg-primary/40 blur-3xl" />
      <div className="relative max-w-2xl">
        <p className="text-sm font-semibold text-red-300">Built with React + Tailwind</p>
        <h2 className="mt-3 text-4xl font-bold tracking-tight text-white md:text-5xl">{title}</h2>
        <p className="mt-4 text-lg text-neutral-300">{text}</p>
        <div className="mt-8 flex flex-wrap items-center gap-4">
          <a href={ctaUrl} className="rounded-full bg-white px-6 py-3 font-medium text-neutral-950 no-underline transition hover:bg-neutral-200">
            {ctaLabel}
          </a>
          <button
            type="button"
            onClick={() => setLiked(!liked)}
            className={liked ? "rounded-full border border-primary bg-primary px-6 py-3 font-medium text-white transition" : "rounded-full border border-white/30 px-6 py-3 font-medium text-white transition hover:bg-white/10"}
          >
            {liked ? "♥ Thanks!" : "♡ Like this"}
          </button>
        </div>
      </div>
    </div>
  );
}
`;

/** Adds the React + Tailwind example widget if it isn't there yet. Returns its key. */
export function insertTailwindExample() {
  if (get("SELECT 1 FROM custom_widgets WHERE key = 'tw-callout'")) return "tw-callout";
  run(
    "INSERT INTO custom_widgets(key, name, icon, category, description, fields, renderer, ssr, template, css, js, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    "tw-callout",
    "Callout (React + Tailwind)",
    "Wind",
    "Custom",
    "A dark call-to-action panel styled entirely with Tailwind utilities.",
    JSON.stringify([
      { key: "title", label: "Title", type: "text", default: "Ready when you are" },
      { key: "text", label: "Text", type: "textarea", default: "Every class on this panel is a Tailwind utility, compiled on the server for just this page." },
      { key: "ctaLabel", label: "Button label", type: "text", default: "Get in touch" },
      { key: "ctaUrl", label: "Button link", type: "url", default: "/contact" },
    ]),
    "react",
    1,
    TAILWIND_CALLOUT_SOURCE,
    "",
    "",
    now(),
  );
  return "tw-callout";
}

export function seedIfEmpty() {
  if (get("SELECT 1 FROM users LIMIT 1")) return;
  console.log("[seed] First run: creating roles, admin account and a starter site…");

  const email = (process.env.REEF_ADMIN_EMAIL ?? "admin@reef.local").toLowerCase();
  const password = process.env.REEF_ADMIN_PASSWORD ?? crypto.randomBytes(12).toString("base64url");

  tx(() => {
    const all = ALL_PERMISSIONS.map((p) => p.key);
    const adminRole = run("INSERT INTO roles(name, description, permissions, is_system) VALUES(?,?,?,1)", "Administrator", "Full access to everything, including users and settings.", JSON.stringify(all)).lastId;
    run(
      "INSERT INTO roles(name, description, permissions, is_system) VALUES(?,?,?,1)",
      "Developer",
      "Builds templates, widgets, code and server functions.",
      JSON.stringify(all.filter((p) => p !== "users.manage")),
    );
    run(
      "INSERT INTO roles(name, description, permissions, is_system) VALUES(?,?,?,1)",
      "Editor",
      "Creates and publishes pages, content, media and forms.",
      JSON.stringify(["pages.edit", "pages.publish", "pages.code", "content.edit", "content.publish", "media.manage", "forms.manage", "forms.submissions"]),
    );
    run(
      "INSERT INTO roles(name, description, permissions, is_system) VALUES(?,?,?,1)",
      "Author",
      "Writes drafts. Publishing goes to an editor for review.",
      JSON.stringify(["pages.edit", "content.edit", "media.manage"]),
    );
    run("INSERT INTO users(email, name, password_hash, role_id, created_at) VALUES(?,?,?,?,?)", email, "Site Admin", hashPassword(password), adminRole, now());

    saveSettings({
      ...DEFAULT_SETTINGS,
      siteName: "Coral Coast",
      tagline: "A demo site built with VodaForge",
      socialLinks: [
        { label: "Instagram", url: "https://instagram.com" },
        { label: "LinkedIn", url: "https://linkedin.com" },
      ],
      footerText: "© {{ 'now' | date: '%Y' }} Coral Coast. Sample content for demonstration.",
      defaultMetaDescription: "A demonstration website managed with VodaForge.",
    });

    const tplId = run(
      "INSERT INTO templates(name, html, css, js, head, is_default, updated_at) VALUES(?,?,?,?,?,1,?)",
      "Default",
      DEFAULT_TEMPLATE_HTML,
      DEFAULT_TEMPLATE_CSS,
      DEFAULT_TEMPLATE_JS,
      '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400..800&display=swap">',
      now(),
    ).lastId;
    run(
      "INSERT INTO templates(name, html, css, js, head, is_default, updated_at) VALUES(?,?,?,?,?,0,?)",
      "Landing (no navigation)",
      `<header class="lp-header"><a href="/" class="site-logo"><span class="site-logo-mark"></span>{{ site.siteName }}</a></header>\n<main>{{ content }}</main>\n<footer class="lp-footer"><!--reef:footer--></footer>`,
      LANDING_TEMPLATE_CSS,
      "",
      "",
      now(),
    );

    const art = seedMedia();

    // ----- content types -----
    const newsId = run(
      "INSERT INTO content_types(key, name, singular, icon, color, description, fields, url_prefix, detail_template, sort) VALUES(?,?,?,?,?,?,?,?,?,1)",
      "news",
      "News",
      "Article",
      "Newspaper",
      "#e60000",
      "Articles and announcements.",
      JSON.stringify([
        { key: "summary", label: "Summary", type: "textarea", help: "Shown on cards and in search results." },
        { key: "image", label: "Featured image", type: "image" },
        { key: "body", label: "Body", type: "richtext", required: true },
        { key: "author", label: "Author", type: "text" },
        { key: "featured", label: "Featured on homepage", type: "boolean" },
      ]),
      "news",
      DEFAULT_DETAIL_TEMPLATE,
    ).lastId;
    const eventsId = run(
      "INSERT INTO content_types(key, name, singular, icon, color, description, fields, url_prefix, detail_template, sort) VALUES(?,?,?,?,?,?,?,?,?,2)",
      "events",
      "Events",
      "Event",
      "CalendarDays",
      "#9c2aa0",
      "Things happening, with dates and venues.",
      JSON.stringify([
        { key: "startsAt", label: "Starts", type: "datetime", required: true },
        { key: "venue", label: "Venue", type: "text" },
        { key: "summary", label: "Summary", type: "textarea" },
        { key: "image", label: "Image", type: "image" },
        { key: "body", label: "Details", type: "richtext" },
        { key: "ticketUrl", label: "Ticket link", type: "url" },
      ]),
      "events",
      `<article class="rf-article">
  <header class="rf-article-header">
    <a class="rf-back" href="/events">← All events</a>
    <time>{{ item.startsAt | date: "%A %e %B %Y, %H:%M" }}</time>
    <h1>{{ item.title }}</h1>
    {% if item.venue %}<p class="rf-lead">📍 {{ item.venue }}</p>{% endif %}
  </header>
  {% if item.image %}<img class="rf-article-image" src="{{ item.image }}" alt="">{% endif %}
  <div class="rf-article-body">{{ item.body }}</div>
  {% if item.ticketUrl %}<p><a class="rf-btn rf-btn-primary rf-btn-lg" href="{{ item.ticketUrl }}">Get tickets</a></p>{% endif %}
</article>`,
    ).lastId;
    const teamId = run(
      "INSERT INTO content_types(key, name, singular, icon, color, description, fields, url_prefix, has_detail_pages, sort) VALUES(?,?,?,?,?,?,?,?,0,3)",
      "team",
      "Team",
      "Team member",
      "Users",
      "#007c92",
      "People shown on the About page.",
      JSON.stringify([
        { key: "role", label: "Role", type: "text", required: true },
        { key: "photo", label: "Photo", type: "image" },
        { key: "bio", label: "Short bio", type: "textarea" },
        { key: "email", label: "Email", type: "email" },
      ]),
      "team",
    ).lastId;

    const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
    const news = [
      ["Welcome to your new website", "A quick tour of what you can do with VodaForge, from drag-and-drop pages to server functions.", 0, ["Announcements", "Guide"]],
      ["Five tips for writing great page titles", "Short, specific titles help visitors and search engines. Here's a checklist we use.", 1, ["Guide", "SEO"]],
      ["Our community day is coming up", "Join us for a day of workshops, food and conversation. Everyone is welcome.", 2, ["Community"]],
      ["Designing for mobile first", "Most visitors arrive on a phone. Preview every page at phone width before you publish.", 3, ["Design"]],
      ["How we use content types", "News, events and team members are all content types. You can create your own in minutes.", 4, ["Guide"]],
      ["Spring update: faster pages", "Pages are rendered on the server and cached by browsers, so they load quickly everywhere.", 5, ["Announcements"]],
    ] as const;
    news.forEach(([title, summary, i, tags]) => {
      run(
        "INSERT INTO content_items(type_id, title, slug, data, status, tags, published_at, sort, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        newsId,
        title,
        title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
        JSON.stringify({
          summary,
          image: art[i % art.length],
          body: `<p>${summary}</p><h2>What's next</h2><p>This is sample content created when VodaForge was installed. Edit it in <strong>Content → News</strong>, or delete it when you're ready to add your own.</p><ul><li>Edit text with the rich text editor</li><li>Add a featured image from the media library</li><li>Tag articles so lists can filter them</li></ul>`,
          author: "VodaForge Team",
          featured: i < 3,
        }),
        "published",
        JSON.stringify(tags),
        day(i * 3),
        i,
        day(i * 3),
        day(i * 3),
      );
    });
    const future = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 16);
    [
      ["Community open day", "Town hall", 12],
      ["Design workshop", "Studio 2", 26],
      ["End of year celebration", "Waterfront park", 48],
    ].forEach(([title, venue, n], i) =>
      run(
        "INSERT INTO content_items(type_id, title, slug, data, status, tags, published_at, sort, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        eventsId,
        title,
        String(title).toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        JSON.stringify({ startsAt: future(Number(n)), venue, summary: `Sample event at ${venue}.`, image: art[(i + 3) % art.length], body: "<p>Sample event details.</p>" }),
        "published",
        "[]",
        day(1),
        i,
        day(1),
        day(1),
      ),
    );
    [
      ["Ana Tuilagi", "Director", "Leads strategy and partnerships."],
      ["Sam Patel", "Content lead", "Keeps the website fresh and accurate."],
      ["Mere Vula", "Developer", "Builds widgets and integrations."],
      ["Josh Lee", "Designer", "Looks after layout, colour and type."],
    ].forEach(([title, role, bio], i) =>
      run(
        "INSERT INTO content_items(type_id, title, slug, data, status, tags, published_at, sort, author_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,1,?,?)",
        teamId,
        title,
        title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
        JSON.stringify({ role, bio, photo: "" }),
        "published",
        "[]",
        day(1),
        i,
        day(1),
        day(1),
      ),
    );
    for (const t of ["Announcements", "Guide", "Community", "Design", "SEO"]) run("INSERT INTO terms(taxonomy, name, slug) VALUES('tags', ?, ?)", t, t.toLowerCase());
    for (const c of ["Organisation", "Programmes", "Media"]) run("INSERT INTO terms(taxonomy, name, slug) VALUES('categories', ?, ?)", c, c.toLowerCase());

    // ----- forms -----
    run(
      "INSERT INTO forms(key, name, fields, settings, updated_at) VALUES(?,?,?,?,?)",
      "contact",
      "Contact us",
      JSON.stringify([
        { id: "name", key: "name", label: "Your name", type: "text", required: true, width: "half" },
        { id: "email", key: "email", label: "Email", type: "email", required: true, width: "half" },
        { id: "topic", key: "topic", label: "Topic", type: "select", options: ["General question", "Partnerships", "Media", "Website feedback"], width: "full" },
        { id: "message", key: "message", label: "Message", type: "textarea", required: true, width: "full" },
        { id: "consent", key: "consent", label: "I agree to be contacted about my enquiry", type: "consent", required: true, width: "full" },
      ]),
      JSON.stringify({ submitLabel: "Send message", successMessage: "Thanks! We'll be in touch within one working day.", storeSubmissions: true }),
      now(),
    );
    run(
      "INSERT INTO forms(key, name, fields, settings, updated_at) VALUES(?,?,?,?,?)",
      "newsletter",
      "Newsletter sign-up",
      JSON.stringify([
        { id: "email", key: "email", label: "Email address", type: "email", required: true, placeholder: "you@example.com", width: "full" },
      ]),
      JSON.stringify({ submitLabel: "Subscribe", successMessage: "You're subscribed. Welcome aboard!", storeSubmissions: true }),
      now(),
    );

    // ----- custom widget -----
    run(
      "INSERT INTO custom_widgets(key, name, icon, category, description, fields, template, css, js, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      "team-grid",
      "Team grid",
      "Users",
      "Custom",
      "Shows people from the Team content type.",
      JSON.stringify([
        { key: "heading", label: "Heading", type: "text", default: "Meet the team" },
        { key: "limit", label: "How many", type: "number", default: 8 },
      ]),
      `<div class="team-grid">
  {% if props.heading != "" %}<h2>{{ props.heading }}</h2>{% endif %}
  {% assign people = 'team' | content: props.limit %}
  <div class="team-grid-list">
    {% for p in people %}
    <div class="team-card">
      {% if p.photo != "" %}<img src="{{ p.photo }}" alt="{{ p.title }}">{% else %}<div class="team-avatar">{{ p.title | slice: 0 }}</div>{% endif %}
      <strong>{{ p.title }}</strong>
      <span>{{ p.role }}</span>
      <p>{{ p.bio }}</p>
    </div>
    {% endfor %}
  </div>
</div>`,
      `.team-grid h2 { margin-bottom: 28px; }
.team-grid-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; }
.team-card { padding: 24px; border-radius: 18px; background: #fff; box-shadow: 0 1px 2px rgb(15 23 42 / .06), 0 12px 32px -16px rgb(15 23 42 / .18); }
.team-card img, .team-avatar { width: 64px; height: 64px; border-radius: 50%; object-fit: cover; margin-bottom: 14px; }
.team-avatar { display: grid; place-items: center; font-weight: 700; font-size: 24px; color: #fff; background: linear-gradient(135deg, var(--rf-primary), var(--rf-accent)); }
.team-card strong { display: block; font-size: 17px; }
.team-card span { color: var(--rf-primary); font-weight: 600; font-size: 14px; }
.team-card p { color: #64748b; margin: 10px 0 0; font-size: 15px; }`,
      "",
      now(),
    );

    run(
      "INSERT INTO custom_widgets(key, name, icon, category, description, fields, renderer, ssr, template, css, js, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      "pricing-toggle",
      "Pricing (React)",
      "Atom",
      "Custom",
      "Pricing table with a monthly/yearly switch, written in React.",
      JSON.stringify([
        { key: "heading", label: "Heading", type: "text", default: "Simple pricing" },
        { key: "discount", label: "Yearly discount (%)", type: "number", default: 20 },
        {
          key: "plans",
          label: "Plans",
          type: "list",
          fields: [
            { key: "name", label: "Name", type: "text" },
            { key: "price", label: "Monthly price", type: "number" },
            { key: "features", label: "Features (one per line)", type: "textarea" },
          ],
          default: [],
        },
      ]),
      "react",
      1,
      `// A React widget. Props come from the fields defined for this widget.
// It is rendered on the server (good for SEO) and hydrated in the browser.
import { useState } from "react";

export default function PricingToggle({ heading, discount = 20, plans = [] }) {
  const [yearly, setYearly] = useState(false);
  const price = (p) => (yearly ? Math.round(p * 12 * (1 - discount / 100)) : p);
  return (
    <div className="pt">
      <div className="pt-head">
        <h2>{heading}</h2>
        <div className="pt-switch" role="group" aria-label="Billing period">
          <button aria-pressed={!yearly} onClick={() => setYearly(false)}>Monthly</button>
          <button aria-pressed={yearly} onClick={() => setYearly(true)}>Yearly <small>-{discount}%</small></button>
        </div>
      </div>
      <div className="pt-grid">
        {plans.map((plan, i) => (
          <div key={i} className={"pt-card" + (i === 1 ? " pt-featured" : "")}>
            <h3>{plan.name}</h3>
            <p className="pt-price">\${price(Number(plan.price) || 0)}<span>/{yearly ? "year" : "month"}</span></p>
            <ul>{String(plan.features || "").split("\\n").filter(Boolean).map((f) => <li key={f}>{f}</li>)}</ul>
          </div>
        ))}
      </div>
    </div>
  );
}
`,
      `.pt-head { display: flex; justify-content: space-between; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 28px; }
.pt-head h2 { margin: 0; }
.pt-switch { display: inline-flex; padding: 4px; border-radius: 999px; background: #f1f5f9; }
.pt-switch button { border: 0; background: none; padding: 8px 16px; border-radius: 999px; font: inherit; font-weight: 600; color: #64748b; cursor: pointer; }
.pt-switch button[aria-pressed="true"] { background: #fff; color: #0f172a; box-shadow: 0 1px 3px rgb(15 23 42 / .15); }
.pt-switch small { color: var(--rf-primary); }
.pt-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 20px; }
.pt-card { padding: 28px; border-radius: 20px; background: #fff; box-shadow: 0 0 0 1px rgb(15 23 42 / .08); }
.pt-featured { box-shadow: 0 0 0 2px var(--rf-primary), 0 24px 48px -24px var(--rf-primary); }
.pt-price { font-size: 2.4rem; font-weight: 800; color: #0f172a; letter-spacing: -0.03em; margin: 8px 0 16px; }
.pt-price span { font-size: 1rem; font-weight: 500; color: #64748b; }
.pt-card ul { padding-left: 18px; margin: 0; color: #475569; }`,
      "",
      now(),
    );

    insertTailwindExample();

    // ----- global code -----
    run(
      "INSERT INTO code_assets(name, kind, location, content, enabled, sort, updated_at) VALUES(?,?,?,?,?,?,?)",
      "custom.css",
      "css",
      "head",
      "/* Site-wide CSS. Loaded on every page after the template styles. */\n:root {\n  --rf-radius: 14px;\n}\n",
      1,
      1,
      now(),
    );
    run(
      "INSERT INTO code_assets(name, kind, location, content, enabled, sort, updated_at) VALUES(?,?,?,?,?,?,?)",
      "main.js",
      "js",
      "body-end",
      "// Site-wide JavaScript. Runs on every page of the live site.\n// Example: fade sections in as they scroll into view.\nconst io = new IntersectionObserver((entries) => {\n  for (const e of entries) if (e.isIntersecting) { e.target.classList.add('is-visible'); io.unobserve(e.target); }\n}, { threshold: 0.12 });\ndocument.querySelectorAll('.rf-section').forEach((s) => { s.classList.add('reveal'); io.observe(s); });\n",
      1,
      2,
      now(),
    );
    run(
      "INSERT INTO code_assets(name, kind, location, content, enabled, sort, updated_at) VALUES(?,?,?,?,?,?,?)",
      "reveal.css",
      "css",
      "head",
      ".reveal { opacity: 0; transform: translateY(14px); transition: opacity .6s ease, transform .6s ease; }\n.reveal.is-visible { opacity: 1; transform: none; }\n@media (prefers-reduced-motion: reduce) { .reveal { opacity: 1; transform: none; } }\n",
      1,
      3,
      now(),
    );

    // ----- server functions -----
    run(
      "INSERT INTO functions(name, kind, route, method, event, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "Latest headlines",
      "endpoint",
      "headlines",
      "GET",
      "",
      `// GET /api/fn/headlines?limit=3
// A tiny JSON API built from your News content.
export default async ({ request, cms }) => {
  const limit = Math.min(Number(request.query.limit) || 3, 10);
  const items = cms.content.list("news", { limit });
  return {
    count: items.length,
    items: items.map((n) => ({ title: n.title, url: n.url, date: n.date })),
  };
};
`,
      1,
      1,
      now(),
    );
    run(
      "INSERT INTO functions(name, kind, route, method, event, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "Auto-fill summary",
      "hook",
      "",
      "ANY",
      "content.beforeSave",
      `// Runs before any content item is saved.
// If a News item has no summary, build one from the first sentences of the body.
export default async ({ payload }) => {
  if (payload.type !== "news") return payload;
  const data = { ...payload.data };
  if (!data.summary && data.body) {
    const text = String(data.body).replace(/<[^>]+>/g, " ").replace(/\\s+/g, " ").trim();
    data.summary = text.split(/(?<=[.!?])\\s/).slice(0, 2).join(" ").slice(0, 220);
    console.log("Generated summary for", payload.title);
  }
  return { ...payload, data };
};
`,
      1,
      1,
      now(),
    );
    run(
      "INSERT INTO functions(name, kind, route, method, event, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      "Block spam enquiries",
      "hook",
      "",
      "ANY",
      "form.beforeSubmit",
      `// Throwing an error rejects the submission and shows the message to the visitor.
const BLOCKED = ["viagra", "casino", "crypto giveaway"];
export default async ({ payload }) => {
  const text = JSON.stringify(payload.data).toLowerCase();
  if (BLOCKED.some((w) => text.includes(w))) {
    throw new Error("Your message looks like spam. Please rephrase it.");
  }
  return payload;
};
`,
      1,
      1,
      now(),
    );
    run(
      "INSERT INTO functions(name, kind, route, method, event, interval_minutes, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
      "Nightly content report",
      "schedule",
      "",
      "ANY",
      "",
      1440,
      `// Runs once a day. Stores a small report in the key-value store.
export default async ({ cms }) => {
  const [{ n }] = cms.db.query("SELECT COUNT(*) AS n FROM content_items WHERE status = 'published'");
  cms.kv.set("report:published-items", { n, at: new Date().toISOString() });
  console.log("Published items:", n);
};
`,
      0,
      1,
      now(),
    );

    // ----- pages -----
    const W = (type: string, props: Record<string, any> = {}) => makeWidget(type, { ...getWidgetDef(type)?.defaults, ...props });
    const page = (title: string, slug: string, sort: number, sections: any[], opts: { parent?: number; home?: boolean; nav?: boolean; tpl?: number; seo?: any } = {}) => {
      const layout = JSON.stringify({ sections });
      const seo = JSON.stringify(opts.seo ?? {});
      const snap = JSON.stringify({ title, layout: JSON.parse(layout), seo: JSON.parse(seo), customCss: "", customJs: "", customHead: "", templateId: opts.tpl ?? tplId });
      return run(
        "INSERT INTO pages(parent_id, title, slug, sort, template_id, status, show_in_nav, is_home, seo, layout, published, published_at, updated_at, updated_by) VALUES(?,?,?,?,?,'published',?,?,?,?,?,?,?,1)",
        opts.parent ?? null,
        title,
        slug,
        sort,
        opts.tpl ?? tplId,
        opts.nav === false ? 0 : 1,
        opts.home ? 1 : 0,
        seo,
        layout,
        snap,
        now(),
        now(),
      ).lastId;
    };
    const sec = (widths: number[], cols: any[][], props: Record<string, any> = {}) => {
      const s = makeSection(widths, cols);
      s.props = { ...s.props, ...props };
      return s;
    };

    page(
      "Home",
      "home",
      1,
      [
        sec([12], [[W("hero", { eyebrow: "VodaForge demo", title: "A website your whole team can actually edit", subtitle: "Drag-and-drop pages, structured content and a full code studio — all in one calm, fast workspace.", image: art[0], overlay: 30, ctaLabel: "Read the news", ctaUrl: "/news", cta2Label: "Contact us", cta2Url: "/contact", height: "lg" })]], { paddingY: "none", width: "full", gap: "none" }),
        sec([12], [[W("stats", { items: [{ value: "6", label: "Sample articles" }, { value: "18", label: "Built-in widgets" }, { value: "∞", label: "Custom widgets" }, { value: "0", label: "Deploys needed to change code" }] })]], { paddingY: "md" }),
        sec([12], [[W("heading", { eyebrow: "What you get", text: "Everything Sitefinity does, without the friction", align: "center", level: "h2" }), W("features", { columns: "3", align: "left", items: [
          { icon: "🧱", title: "Visual page builder", text: "Drag widgets into flexible column layouts and see the real page as you edit." },
          { icon: "🗂️", title: "Content types", text: "Model news, events, products or anything else with your own fields." },
          { icon: "🧑‍💻", title: "Code Studio", text: "Edit templates, CSS, JavaScript and server-side functions without a deploy." },
          { icon: "📝", title: "Forms & responses", text: "Build forms visually, collect responses and export them to CSV." },
          { icon: "🕓", title: "Revisions & workflow", text: "Every save is versioned. Authors can send work to editors for review." },
          { icon: "🔌", title: "Headless API", text: "Use your content anywhere through a clean JSON API." },
        ] })]], { background: "subtle" }),
        sec([12], [[W("heading", { eyebrow: "Latest", text: "News and updates", level: "h2" }), W("contentList", { contentType: "news", limit: 3, layout: "grid", columns: "3" }), W("button", { label: "All news", url: "/news", variant: "outline", align: "left" })]]),
        sec([6, 6], [[W("heading", { text: "Built for editors. Loved by developers.", level: "h2" }), W("text", { html: "<p>Editors get a clean, forgiving interface with live preview, undo, autosave and plain-language messages. Developers get Liquid templates, custom widgets and JavaScript functions that run on the server.</p>", size: "lg" }), W("button", { label: "Get in touch", url: "/contact" })], [W("quote", { quote: "We rebuilt our homepage in an afternoon — and the developer only had to step in once.", author: "Sample testimonial", role: "Demo content" })]], { valign: "center" }),
        sec([12], [[makeWidget("pricing-toggle", { heading: "Plans for every team", discount: 20, plans: [
          { name: "Starter", price: 0, features: "1 site\nUnlimited pages\nCommunity support" },
          { name: "Team", price: 29, features: "5 sites\nWorkflow & roles\nPriority support" },
          { name: "Enterprise", price: 99, features: "Unlimited sites\nSSO & audit\nDedicated help" },
        ] })]], { background: "subtle" }),
        sec([12], [[W("heading", { text: "Stay in the loop", level: "h2", align: "center" }), W("form", { formKey: "newsletter" })]], { background: "dark", width: "narrow" }),
      ],
      { home: true, seo: { metaDescription: "A demonstration website managed with VodaForge." } },
    );
    const aboutId = page("About", "about", 2, [
      sec([12], [[W("heading", { eyebrow: "About us", text: "We help people find what they need, fast", level: "h1" }), W("text", { html: "<p>This is a sample About page. Open it in the page editor to see how sections, columns and widgets fit together.</p>", size: "lg" })]], { width: "narrow", paddingY: "xl" }),
      sec([12], [[makeWidget("team-grid", { heading: "Meet the team", limit: 8 })]], { background: "subtle" }),
      sec([12], [[makeWidget("tw-callout", { title: "Ready when you are", text: "Every class on this panel is a Tailwind utility, compiled on the server for just this page.", ctaLabel: "Get in touch", ctaUrl: "/contact" })]]),
      sec([12], [[W("heading", { text: "Frequently asked questions", level: "h2" }), W("accordion")]], { width: "narrow" }),
    ]);
    page("History", "history", 1, [sec([12], [[W("heading", { text: "Our history", level: "h1" }), W("text", { html: "<p>A sub-page of About. Sub-pages appear in the dropdown menu automatically.</p>" })]], { width: "narrow", paddingY: "xl" })], { parent: aboutId });
    page("News", "news", 3, [
      sec([12], [[W("heading", { eyebrow: "Newsroom", text: "News", level: "h1" }), W("contentList", { contentType: "news", limit: 6, layout: "grid", columns: "3", paginate: true })]], { paddingY: "xl" }),
    ]);
    page("Events", "events", 4, [
      sec([12], [[W("heading", { eyebrow: "What's on", text: "Upcoming events", level: "h1" }), W("contentList", { contentType: "events", limit: 10, layout: "list", sort: "manual" })]], { paddingY: "xl" }),
    ]);
    page("Contact", "contact", 5, [
      sec([7, 5], [[W("heading", { text: "Get in touch", level: "h1" }), W("text", { html: "<p>We usually reply within one working day.</p>", size: "lg" }), W("form", { formKey: "contact" })], [W("map", { address: "Suva, Fiji", height: 460 })]], { paddingY: "xl", gap: "lg" }),
    ]);
  });

  const credFile = path.join(DATA_DIR, "admin-credentials.txt");
  if (!process.env.REEF_ADMIN_PASSWORD) {
    fs.writeFileSync(credFile, `VodaForge initial administrator\nEmail: ${email}\nPassword: ${password}\n\nChange this password after signing in (avatar menu → Account), then delete this file.\n`, { mode: 0o600 });
    console.log(`[seed] Admin sign-in details written to ${credFile}`);
  }
}
