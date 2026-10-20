import "./env";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedIfEmpty } from "../server/seed";
import { renderLayout } from "../server/render/widgets";
import { newCtx, renderPublicPath, sitemapXml } from "../server/render/site";
import { renderLiquid } from "../server/render/liquid";
import { run } from "../server/db";
import { BUILTIN_WIDGETS, makeSection, makeWidget } from "../shared/widgets";
import type { PageLayout, WidgetNode } from "../shared/types";

before(() => {
  seedIfEmpty();
});

const one = (w: WidgetNode): PageLayout => ({ sections: [makeSection([12], [[w]])] });

describe("built-in widgets", () => {
  for (const def of BUILTIN_WIDGETS) {
    it(`renders “${def.name}” with its defaults`, async () => {
      const ctx = newCtx("/", false);
      const html = await renderLayout(one(makeWidget(def.type, def.defaults)), ctx);
      assert.match(html, new RegExp(`rf-widget-${def.type}\\b`));
      assert.doesNotMatch(html, /rf-error/, `${def.type} rendered an error`);
    });
  }

  it("escapes text and neutralises javascript: links", async () => {
    const ctx = newCtx("/", false);
    const html = await renderLayout(
      {
        sections: [
          makeSection([6, 6], [[makeWidget("heading", { text: "<script>alert(1)</script>", level: "h2" })], [makeWidget("button", { label: "Go", url: "javascript:alert(1)", variant: "primary" })]]),
        ],
      },
      ctx,
    );
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /href="#"/);
    assert.doesNotMatch(html, /javascript:alert/);
  });

  it("nests card and list titles under the heading before them, for a valid outline", async () => {
    const list = makeWidget("contentList", { contentType: "news", limit: 2, showImage: true, layout: "grid" });
    const card = makeWidget("card", { title: "Card", text: "x" });
    const underH1 = await renderLayout({ sections: [makeSection([12], [[makeWidget("hero", { title: "Top" }), list, card]])] }, newCtx("/", false));
    assert.match(underH1, /<h1[\s>]/);
    assert.match(underH1, /rf-content-body"><time>[^<]*<\/time><h2>|rf-content-body"><h2>/);
    assert.match(underH1, /<h2>Card<\/h2>/, "a later card follows the outline too, not the list's own titles");
    const underH2 = await renderLayout({ sections: [makeSection([12], [[makeWidget("heading", { text: "Latest", level: "h2" }), list]])] }, newCtx("/", false));
    assert.match(underH2, /rf-content-body">(?:<time>[^<]*<\/time>)?<h3>/);
    // the image link repeats the title link, so it's hidden from keyboards and screen readers
    if (underH1.includes("rf-content-img")) assert.match(underH1, /class="rf-content-img" href="[^"]+" tabindex="-1" aria-hidden="true"/);
  });

  it("applies section and widget layout options", async () => {
    const ctx = newCtx("/", false);
    const s = makeSection([4, 8], [[makeWidget("spacer", { height: 10, _visibility: "mobile", _anchor: "gap" })], []]);
    s.props = { ...s.props, background: "dark", width: "narrow", anchor: "intro" };
    const html = await renderLayout({ sections: [s] }, ctx);
    assert.match(html, /rf-bg-dark/);
    assert.match(html, /rf-w-narrow/);
    assert.match(html, /id="intro"/);
    assert.match(html, /rf-col-4[\s\S]*rf-col-8/);
    assert.match(html, /rf-only-mobile/);
    assert.match(html, /id="gap"/);
  });

  it("adds editor markup only in editor mode", async () => {
    const layout = one(makeWidget("heading", { text: "Hi" }));
    const live = await renderLayout(layout, newCtx("/", false));
    const editor = await renderLayout(layout, newCtx("/", true));
    assert.doesNotMatch(live, /data-rf-widget/);
    assert.match(editor, /data-rf-widget=/);
    assert.match(editor, /data-rf-inline="text"/);
    assert.match(await renderLayout({ sections: [] }, newCtx("/", true)), /This page is empty/);
  });

  it("collects Code block CSS/JS but keeps scripts out of the editor", async () => {
    const w = makeWidget("html", { html: "<p>{{ 1 | plus: 1 }}</p>", css: ".x{color:red}", js: "console.log('hi')" });
    const live = newCtx("/", false);
    assert.match(await renderLayout(one(w), live), /<p>2<\/p>/);
    assert.equal(live.css.size, 1);
    assert.equal(live.js.size, 1);
    const editor = newCtx("/", true);
    await renderLayout(one(w), editor);
    assert.equal(editor.js.size, 0);
  });

  it("lists published content with filters", async () => {
    const ctx = newCtx("/", false);
    const html = await renderLayout(one(makeWidget("contentList", { contentType: "news", limit: 10, layout: "compact", tag: "SEO" })), ctx);
    assert.match(html, /Five tips for writing great page titles/);
    assert.doesNotMatch(html, /Welcome to your new website/);
  });

  it("renders seeded forms with required fields and a honeypot", async () => {
    const html = await renderLayout(one(makeWidget("form", { formKey: "contact" })), newCtx("/contact", false));
    assert.match(html, /action="\/api\/public\/forms\/contact\/submit"/);
    assert.match(html, /name="email"[^>]*required/);
    assert.match(html, /name="_hp"/);
  });

  it("renders custom Liquid widgets with their props", async () => {
    const html = await renderLayout(one(makeWidget("team-grid", { heading: "Our people", limit: 2 })), newCtx("/", false));
    assert.match(html, /Our people/);
    assert.equal((html.match(/class="team-card"/g) ?? []).length, 2);
  });

  it("registers React widgets as module scripts", async () => {
    const ctx = newCtx("/", false);
    const html = await renderLayout(one(makeWidget("react", BUILTIN_WIDGETS.find((w) => w.type === "react")!.defaults)), ctx);
    assert.match(html, /data-reef-react=/);
    assert.equal(ctx.react, true);
    assert.equal(ctx.modules.size, 1);
    assert.match([...ctx.modules.values()][0], /mount\(C,/);
  });
});

describe("Liquid", () => {
  it("loads content with the content filter", async () => {
    assert.equal(await renderLiquid("{% assign n = 'news' | content: 2 %}{{ n.size }}", {}), "2");
    assert.equal(await renderLiquid("{% assign n = 'nope' | content: 2 %}{{ n.size }}", {}), "0");
  });

  it("calls server functions with the fn filter", async () => {
    assert.equal(await renderLiquid("{% assign d = 'headlines' | fn %}{{ d.count }}", {}), "3");
    assert.match(await renderLiquid("{% assign d = 'missing' | fn %}{{ d.error }}", {}), /No function/);
  });

  it("shows template errors instead of crashing the page", async () => {
    assert.match(await renderLiquid("{% if %}", {}), /Template error/);
  });

  it("escapes output by default, except HTML Reef rendered or cleaned", async () => {
    assert.equal(await renderLiquid("{{ t }}", { t: "<img src=x onerror=alert(1)>" }), "&lt;img src=x onerror=alert(1)&gt;");
    assert.equal(await renderLiquid("{{ t | raw }}", { t: "<b>trusted</b>" }), "<b>trusted</b>");
  });

  it("provides excerpt and json helpers", async () => {
    assert.equal(await renderLiquid("{{ '<p>one two three</p>' | excerpt: 2 }}", {}), "one two…");
    assert.equal(await renderLiquid("{{ x | json | raw }}", { x: { a: 1 } }), '{"a":1}');
    assert.equal(await renderLiquid("{{ x | json }}", { x: { a: 1 } }), "{&quot;a&quot;:1}", "escaped unless marked raw");
    const escapedLt = "\\" + "u003c"; // the JSON escape for "<"
    assert.equal(await renderLiquid("{{ x | json | raw }}", { x: "</script>" }), `"${escapedLt}/script>"`, "can't close a script tag");
  });
});

describe("public routing", () => {
  it("renders the homepage and content detail pages", async () => {
    const home = await renderPublicPath("/", {});
    assert.equal(home.status, 200);
    assert.match(home.html!, /<title>Coral Coast/);
    const article = await renderPublicPath("/news/welcome-to-your-new-website", {});
    assert.equal(article.status, 200);
    assert.match(article.html!, /<h1>Welcome to your new website<\/h1>/);
  });

  it("resolves nested page paths case-insensitively, redirecting to the page's own address", async () => {
    assert.equal((await renderPublicPath("/about/history", {})).status, 200);
    const variant = await renderPublicPath("/About/History/", { p: "2" });
    assert.equal(variant.status, 301);
    assert.equal(variant.redirect, "/about/history?p=2");
  });

  it("returns 404 for unknown pages and unpublished items", async () => {
    assert.equal((await renderPublicPath("/nope", {})).status, 404);
    run("UPDATE content_items SET status = 'draft' WHERE slug = 'designing-for-mobile-first'");
    assert.equal((await renderPublicPath("/news/designing-for-mobile-first", {})).status, 404);
  });

  it("applies redirects before pages", async () => {
    run("INSERT INTO redirects(from_path, to_path, code) VALUES('/about', '/news', 302)");
    const r = await renderPublicPath("/about", {});
    assert.equal(r.status, 302);
    assert.equal(r.redirect, "/news");
    run("DELETE FROM redirects WHERE from_path = '/about'");
  });

  it("builds a sitemap without noindex pages or drafts", async () => {
    run(`UPDATE pages SET published = json_set(published, '$.seo.noIndex', json('true')) WHERE slug = 'events'`);
    const xml = sitemapXml("https://example.com");
    assert.match(xml, /<loc>https:\/\/example\.com\/<\/loc>/);
    assert.match(xml, /https:\/\/example\.com\/news\/welcome-to-your-new-website/);
    assert.doesNotMatch(xml, /example\.com\/events</);
    assert.doesNotMatch(xml, /designing-for-mobile-first/);
  });
});
