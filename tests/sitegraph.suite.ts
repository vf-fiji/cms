import "./env";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { seedIfEmpty } from "../server/seed";
import { buildSiteGraph } from "../server/api/sitegraph";
import { run, get } from "../server/db";
import { makeSection, makeWidget } from "../shared/widgets";

before(() => {
  seedIfEmpty();
});

const edge = (g: ReturnType<typeof buildSiteGraph>, kind: string, source: string, target: string) =>
  g.edges.some((e) => e.kind === kind && ((e.source === source && e.target === target) || (e.source === target && e.target === source)));
const pageId = (slug: string) => `page:${get("SELECT id FROM pages WHERE slug = ?", slug).id}`;

describe("site graph", () => {
  it("puts the homepage at the centre and hangs top-level pages off it", () => {
    const g = buildSiteGraph();
    const home = g.nodes.find((n) => n.kind === "home")!;
    assert.equal(home.path, "/");
    assert.equal(home.depth, 0);
    for (const slug of ["about", "news", "events", "contact"]) assert.ok(edge(g, "child", home.id, pageId(slug)), `home → ${slug}`);
    assert.ok(edge(g, "child", pageId("about"), pageId("history")));
    assert.equal(g.nodes.find((n) => n.id === pageId("history"))!.depth, 2);
  });

  it("connects pages to the content they list and the forms they embed", () => {
    const g = buildSiteGraph();
    assert.ok(edge(g, "lists", pageId("news"), "type:news"));
    assert.ok(edge(g, "lists", pageId("events"), "type:events"));
    const contact = get("SELECT id FROM forms WHERE key = 'contact'").id;
    assert.ok(edge(g, "form", pageId("contact"), `form:${contact}`));
    assert.equal(g.nodes.find((n) => n.id === `form:${contact}`)!.live, true);
  });

  it("includes content items under their type, capped per type", () => {
    const g = buildSiteGraph({ itemsPerType: 2 });
    const newsItems = g.nodes.filter((n) => n.kind === "item" && n.parent === "type:news");
    assert.equal(newsItems.length, 2);
    for (const it of newsItems) assert.ok(edge(g, "item", "type:news", it.id));
    assert.equal(g.stats.totalItems, 13, "stats still count every item");
    assert.match(newsItems[0].path!, /^\/news\//);
  });

  it("finds internal links in buttons and rich text, and ignores external ones", () => {
    const layout = {
      sections: [
        makeSection([12], [
          [
            makeWidget("button", { label: "Contact", url: "/contact?from=promo#form" }),
            makeWidget("text", { html: '<p>See <a href="/news/welcome-to-your-new-website">our welcome post</a> or <a href="https://example.com">elsewhere</a>.</p>' }),
            makeWidget("button", { label: "Mail", url: "mailto:hi@example.com" }),
          ],
        ]),
      ],
    };
    run("INSERT INTO pages(parent_id, title, slug, sort, layout, status, updated_at) VALUES(?, 'Promo', 'promo', 99, ?, 'draft', ?)", get("SELECT id FROM pages WHERE slug = 'about'").id, JSON.stringify(layout), new Date().toISOString());
    const g = buildSiteGraph();
    const promo = pageId("promo");
    assert.ok(edge(g, "link", promo, pageId("contact")), "button link (query and hash ignored)");
    const welcome = get("SELECT id FROM content_items WHERE slug = 'welcome-to-your-new-website'").id;
    assert.ok(edge(g, "link", promo, `item:${welcome}`), "rich-text link to a content item");
    assert.equal(g.edges.filter((e) => e.source === promo && e.kind === "link").length, 2, "external and mailto links ignored");
    const node = g.nodes.find((n) => n.id === promo)!;
    assert.equal(node.live, false);
    assert.equal(node.depth, 2);
  });

  it("never draws two lines between the same pair of nodes", () => {
    const g = buildSiteGraph();
    const seen = new Set<string>();
    for (const e of g.edges) {
      const k = [e.source, e.target].sort().join("|");
      assert.ok(!seen.has(k), `duplicate edge ${k}`);
      seen.add(k);
    }
    // the homepage's hero button links to /news, which is already its child
    assert.ok(!g.edges.some((e) => e.kind === "link" && e.source === g.nodes.find((n) => n.kind === "home")!.id && e.target === pageId("news")));
  });

  it("flags live pages with unpublished edits and counts views", () => {
    run("UPDATE pages SET updated_at = ? WHERE slug = 'about'", new Date(Date.now() + 60_000).toISOString());
    run("INSERT INTO page_views(day, path, views) VALUES(?, '/about', 7)", new Date().toISOString().slice(0, 10));
    const about = buildSiteGraph().nodes.find((n) => n.id === pageId("about"))!;
    assert.equal(about.changesPending, true);
    assert.equal(about.views, 7);
  });
});
