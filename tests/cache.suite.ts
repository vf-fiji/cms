import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";
import { cachedRender, markUncacheable, cacheVersion } from "../server/render/cache";
import { run } from "../server/db";

const layoutWith = (...widgets: { type: string; props: Record<string, unknown> }[]) => ({
  sections: [{ id: "s1", props: {}, columns: [{ id: "c1", width: 12, widgets: widgets.map((w, i) => ({ id: `w${i}`, ...w })) }] }],
});

describe("page cache (in-process)", () => {
  it("bumps the version on writes to content tables, but not on counters", () => {
    const v = cacheVersion();
    run("INSERT INTO settings(key, value) VALUES('tagline', '\"x\"') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
    assert.equal(cacheVersion(), v + 1);
    run("INSERT INTO page_views(day, path, views) VALUES('2026-01-01', '/x', 1) ON CONFLICT(day, path) DO UPDATE SET views = views + 1");
    assert.equal(cacheVersion(), v + 1, "page views don't invalidate");
  });

  it("serves a cached render until the version changes", async () => {
    let renders = 0;
    const render = async () => ({ status: 200, html: `<p>${++renders}</p>` });
    assert.equal((await cachedRender("/c", {}, render)).html, "<p>1</p>");
    const second = await cachedRender("/c", {}, render);
    assert.equal(second.html, "<p>1</p>");
    assert.equal(second.cached, true);
    assert.equal((await cachedRender("/c", { q: "2", p: "1" }, render)).html, "<p>2</p>", "search and page parameters are part of the key");
    assert.equal((await cachedRender("/c", { p: "1", q: "2" }, render)).html, "<p>2</p>", "in any order");
    assert.equal((await cachedRender("/c", { utm_source: "x" }, render)).html, "<p>3</p>", "other parameters are rendered fresh");
    assert.equal((await cachedRender("/c", { utm_source: "x" }, render)).html, "<p>4</p>");
    run("UPDATE settings SET value = '\"y\"' WHERE key = 'tagline'");
    assert.equal((await cachedRender("/c", {}, render)).html, "<p>5</p>");
  });

  it("never caches a render that marked itself uncacheable", async () => {
    let renders = 0;
    const render = async () => {
      markUncacheable();
      return { status: 200, html: `<p>${++renders}</p>` };
    };
    await cachedRender("/fn", {}, render);
    assert.equal((await cachedRender("/fn", {}, render)).html, "<p>2</p>");
  });
});

describe("page cache (server)", () => {
  let server: TestServer;
  let admin: Client;
  let pageId: number;
  const get = async (p: string) => {
    const r = await fetch(server.url + p);
    return { cache: r.headers.get("x-vodaforge-cache"), html: await r.text(), status: r.status };
  };

  before(async () => {
    server = await startServer();
    admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
    pageId = (await admin.post("/api/pages", { title: "Cached", starter: "blank" })).body.id;
    await admin.put(`/api/pages/${pageId}`, { layout: layoutWith({ type: "heading", props: { text: "Version one", level: "h1" } }) });
    await admin.post(`/api/pages/${pageId}/publish`);
  });
  after(async () => {
    await server?.stop();
  });

  it("serves repeat visits from the cache and still counts the views", async () => {
    assert.equal((await get("/cached")).cache, "miss");
    const second = await get("/cached");
    assert.equal(second.cache, "hit");
    assert.match(second.html, /Version one/);
    const graph = await admin.get("/api/site-graph");
    const node = graph.body.nodes.find((n: any) => n.path === "/cached");
    assert.equal(node.views, 2);
  });

  it("keeps serving the live page while a draft is edited, then updates on publish", async () => {
    await admin.put(`/api/pages/${pageId}`, { layout: layoutWith({ type: "heading", props: { text: "Version two", level: "h1" } }) });
    const during = await get("/cached");
    assert.equal(during.cache, "hit", "autosaving a draft doesn't throw the cache away");
    assert.match(during.html, /Version one/);
    await admin.post(`/api/pages/${pageId}/publish`);
    const afterPublish = await get("/cached");
    assert.equal(afterPublish.cache, "miss");
    assert.match(afterPublish.html, /Version two/);
  });

  it("notices writes made outside the server process", async () => {
    await get("/cached");
    assert.equal((await get("/cached")).cache, "hit");
    const other = new DatabaseSync(path.join(server.dataDir, "reef.db"));
    try {
      other.prepare("UPDATE pages SET title = 'Cached!' WHERE id = ?").run(pageId);
    } finally {
      other.close();
    }
    assert.equal((await get("/cached")).cache, "miss");
  });

  it("updates every page when site settings change", async () => {
    await get("/cached");
    await admin.put("/api/settings", { siteName: "Renamed VodaForge" });
    const r = await get("/cached");
    assert.equal(r.cache, "miss");
    assert.match(r.html, /Renamed VodaForge/);
  });

  it("stops serving a page as soon as it's unpublished", async () => {
    await get("/cached");
    await admin.post(`/api/pages/${pageId}/unpublish`);
    assert.equal((await get("/cached")).status, 404);
  });
});
