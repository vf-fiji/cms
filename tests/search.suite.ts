import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";
import { toFtsQuery } from "../server/search";

const layoutWith = (...widgets: { type: string; props: Record<string, unknown> }[]) => ({
  sections: [{ id: "s1", props: {}, columns: [{ id: "c1", width: 12, widgets: widgets.map((w, i) => ({ id: `w${i}`, ...w })) }] }],
});

describe("search query parsing", () => {
  it("quotes every word, makes the last a prefix and drops FTS syntax", () => {
    assert.equal(toFtsQuery("Kava ceremony"), '"kava" "ceremony"*');
    assert.equal(toFtsQuery('"; DROP TABLE x --'), '";" "drop" "table" "x" "--"*');
    assert.equal(toFtsQuery("news AND (sport OR NOT*)"), '"news" "sport"*');
    assert.equal(toFtsQuery("  "), "");
  });
});

describe("site search", () => {
  let server: TestServer;
  let admin: Client;
  let pageId: number;
  const find = (q: string) => fetch(`${server.url}/api/public/search?q=${encodeURIComponent(q)}`).then((r) => r.json());

  before(async () => {
    server = await startServer({ env: { REEF_RATE_LIMIT_SEARCH: "1000" } });
    admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
    const p = await admin.post("/api/pages", { title: "Kava Traditions", starter: "blank" });
    pageId = p.body.id;
    await admin.put(`/api/pages/${pageId}`, {
      layout: layoutWith(
        { type: "text", props: { html: "<p>The <strong>sevusevu</strong> ceremony welcomes visitors to a village.</p>" } },
        { type: "html", props: { code: "<script>var hiddenScriptWord = 1</script>" } },
      ),
    });
  });
  after(async () => {
    await server?.stop();
  });

  it("finds nothing on an unpublished page", async () => {
    const r = await find("sevusevu");
    assert.equal(r.results.length, 0);
  });

  it("finds a page once it's published, by body text, with highlighted snippets", async () => {
    await admin.post(`/api/pages/${pageId}/publish`);
    const r = await find("sevusev");
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].url, "/kava-traditions");
    assert.equal(r.results[0].title, "Kava Traditions");
    assert.match(r.results[0].snippet, /<mark>sevusevu<\/mark>/);
    assert.doesNotMatch(r.results[0].snippet, /<strong>/, "page HTML is stripped, not echoed");
  });

  it("ignores code, and ranks title matches first", async () => {
    assert.equal((await find("hiddenScriptWord")).results.length, 0);
    const r = await find("kava");
    assert.equal(r.results[0].title, "Kava Traditions");
  });

  it("drops a page from results when it's unpublished", async () => {
    await admin.post(`/api/pages/${pageId}/unpublish`);
    assert.equal((await find("sevusevu")).results.length, 0);
    await admin.post(`/api/pages/${pageId}/publish`);
    assert.equal((await find("sevusevu")).results.length, 1);
  });

  it("indexes published content items that have detail pages", async () => {
    const made = await admin.post("/api/types/news/items", { title: "Drua win the cup", data: { summary: "A famous victory in Suva", body: "<p>Report to follow.</p>" } });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const id = made.body.id;
    assert.equal((await find("famous victory")).results.length, 0);
    await admin.post(`/api/items/${id}/publish`);
    const r = await find("famous victory");
    assert.equal(r.results.length, 1);
    assert.match(r.results[0].url, /drua-win-the-cup$/);
  });

  it("escapes the query and snippets, so search can't inject markup", async () => {
    const r = await find('<img src=x onerror=alert(1)> sevusevu');
    assert.equal(r.results.length, 0);
    const html = await fetch(`${server.url}/kava-traditions?q=${encodeURIComponent("<script>")}`).then((x) => x.text());
    assert.doesNotMatch(html, /value="<script>/);
  });

  it("renders the Search widget with results from the query string", async () => {
    const p = await admin.post("/api/pages", { title: "Find", starter: "blank" });
    await admin.put(`/api/pages/${p.body.id}`, { layout: layoutWith({ type: "search", props: { placeholder: "Search Fiji", limit: 5 } }) });
    await admin.post(`/api/pages/${p.body.id}/publish`);
    const empty = await fetch(`${server.url}/find`).then((x) => x.text());
    assert.match(empty, /role="search"/);
    assert.match(empty, /placeholder="Search Fiji"/);
    assert.doesNotMatch(empty, /rf-search-results/);
    const html = await fetch(`${server.url}/find?q=${encodeURIComponent('sevusevu "<b>')}`).then((x) => x.text());
    assert.match(html, /value="sevusevu &quot;&lt;b&gt;"/);
    const none = await fetch(`${server.url}/find?q=sevusevu`).then((x) => x.text());
    assert.match(none, /1 result for/);
    assert.match(none, /href="\/kava-traditions"/);
    assert.match(none, /<mark>sevusevu<\/mark>/);
  });

  it("rate limits the public endpoint", async () => {
    const limited = await startServer({ env: { REEF_RATE_LIMIT_SEARCH: "2" } });
    try {
      const hit = () => fetch(`${limited.url}/api/public/search?q=hello`);
      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 200);
      assert.equal((await hit()).status, 429);
    } finally {
      await limited.stop();
    }
  });
});
