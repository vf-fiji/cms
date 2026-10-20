import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";
import { sanitizeRichText } from "../server/sanitize";

const layoutWith = (...widgets: { type: string; props: Record<string, unknown> }[]) => ({
  sections: [{ id: "s1", props: {}, columns: [{ id: "c1", width: 12, widgets: widgets.map((w, i) => ({ id: `w${i}`, ...w })) }] }],
});

describe("rich text sanitizing", () => {
  it("keeps formatting and drops scripts, handlers and javascript: links", () => {
    const out = sanitizeRichText(
      `<h2>Hi</h2><p onclick="x()">A <strong>b</strong> <a href="javascript:alert(1)">bad</a> <a href="https://x.fj" target="_blank">ok</a></p><img src=x onerror=alert(1)><script>alert(1)</script><iframe src="//evil"></iframe>`,
    );
    assert.match(out, /<h2>Hi<\/h2>/);
    assert.match(out, /<strong>b<\/strong>/);
    assert.match(out, /<a href="https:\/\/x.fj" target="_blank" rel="noopener noreferrer">ok<\/a>/);
    assert.doesNotMatch(out, /onclick|onerror|javascript:|<script|<iframe/i);
  });
});

describe("permissions and escaping (server)", () => {
  let server: TestServer;
  let admin: Client;
  let author: Client;
  let authorRoleId: number;
  let editorRoleId: number;

  before(async () => {
    server = await startServer();
    admin = new Client(server.url);
    await admin.login(ADMIN.email, ADMIN.password);
    const roles = (await admin.get("/api/roles")).body;
    authorRoleId = roles.find((r: any) => r.name === "Author").id;
    editorRoleId = roles.find((r: any) => r.name === "Editor").id;
    assert.ok(roles.find((r: any) => r.name === "Editor").permissions.includes("pages.code"), "editors keep code access");
    assert.ok(!roles.find((r: any) => r.name === "Author").permissions.includes("pages.code"), "authors don't get it");
    const made = await admin.post("/api/users", { name: "Ada Author", email: "author@test.local", roleId: authorRoleId });
    author = new Client(server.url);
    await author.login("author@test.local", made.body.temporaryPassword);
  });
  after(async () => {
    await server?.stop();
  });

  it("stops authors adding scripts to pages, but lets them edit text", async () => {
    const id = (await author.post("/api/pages", { title: "Author page", starter: "blank" })).body.id;
    const code = await author.put(`/api/pages/${id}`, { layout: layoutWith({ type: "html", props: { html: "<script>steal()</script>" } }) });
    assert.equal(code.status, 403);
    assert.match(code.body.error, /Add code to pages/);
    assert.equal((await author.put(`/api/pages/${id}`, { customHead: "<script>x()</script>" })).status, 403);
    assert.equal((await author.put(`/api/pages/${id}`, { customJs: "x()" })).status, 403);
    assert.equal((await author.put(`/api/pages/${id}`, { layout: layoutWith({ type: "heading", props: { text: "Fine", level: "h2" } }) })).status, 200);
  });

  it("lets authors move code blocks someone else added, but not change them", async () => {
    const id = (await admin.post("/api/pages", { title: "Mixed", starter: "blank" })).body.id;
    const code = { type: "html", props: { html: "<p>embed</p>" } };
    const text = { type: "heading", props: { text: "T", level: "h2" } };
    assert.equal((await admin.put(`/api/pages/${id}`, { layout: layoutWith(code, text) })).status, 200);
    assert.equal((await author.put(`/api/pages/${id}`, { layout: layoutWith(text, code) })).status, 200, "reordering is fine");
    assert.equal((await author.put(`/api/pages/${id}`, { layout: layoutWith(text, { type: "html", props: { html: "<p>changed</p>" } }) })).status, 403);
  });

  it("cleans rich text in Text blocks when rendering", async () => {
    const id = (await author.post("/api/pages", { title: "Rich", starter: "blank" })).body.id;
    await author.put(`/api/pages/${id}`, { layout: layoutWith({ type: "text", props: { html: '<p>Hello <img src=x onerror="alert(1)"></p>' } }) });
    await admin.post(`/api/pages/${id}/publish`);
    const html = await fetch(`${server.url}/rich`).then((r) => r.text());
    assert.match(html, /Hello/);
    assert.doesNotMatch(html, /onerror/);
  });

  it("doesn't let authors publish by scheduling, or change live pages' addresses", async () => {
    const id = (await author.post("/api/pages", { title: "Sneaky", starter: "blank" })).body.id;
    const r = await author.put(`/api/pages/${id}`, { publishAt: "2000-01-01T00:00:00.000Z" });
    assert.equal(r.status, 403);
    await admin.post(`/api/pages/${id}/publish`);
    assert.equal((await author.put(`/api/pages/${id}`, { slug: "moved" })).status, 403);
    assert.equal((await author.del(`/api/pages/${id}`)).status, 403);
    assert.equal((await author.put(`/api/pages/${id}`, { title: "Sneaky (edited draft)" })).status, 200, "draft edits are fine");
  });

  it("doesn't let authors change or schedule live content", async () => {
    const made = await author.post("/api/types/news/items", { title: "Author news", data: { summary: "s", body: "<p>b</p>" } });
    const id = made.body.id;
    assert.equal((await author.put(`/api/items/${id}`, { publishAt: "2000-01-01T00:00:00.000Z" })).status, 403);
    await admin.post(`/api/items/${id}/publish`);
    assert.equal((await author.put(`/api/items/${id}`, { title: "Changed live" })).status, 403);
    assert.equal((await author.del(`/api/items/${id}`)).status, 403);
  });

  it("escapes content titles in templates and cleans rich text bodies", async () => {
    const made = await admin.post("/api/types/news/items", {
      title: "<img src=x onerror=alert(1)>Headline",
      data: { summary: "s", body: '<p>Body <a href="javascript:alert(1)">x</a></p>' },
    });
    await admin.post(`/api/items/${made.body.id}/publish`);
    const html = await fetch(`${server.url}/news/${made.body.slug}`).then((r) => r.text());
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;Headline/);
    assert.doesNotMatch(html, /<img src=x onerror/);
    assert.match(html, /<p>Body <a>x<\/a><\/p>/, "the body is still HTML, minus the bad link");
  });

  it("only accepts web addresses or site paths as form redirects", async () => {
    const form = (await admin.get("/api/forms")).body[0];
    const full = (await admin.get(`/api/forms/${form.id}`)).body;
    const bad = await admin.put(`/api/forms/${form.id}`, { ...full, settings: { ...full.settings, redirectUrl: "javascript:alert(1)" } });
    assert.equal(bad.status, 400);
    const ok = await admin.put(`/api/forms/${form.id}`, { ...full, settings: { ...full.settings, redirectUrl: "/thanks" } });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });

  it("doesn't let a user manager hand out more access than they have", async () => {
    const mgrRole = (await admin.post("/api/roles", { name: "People manager", permissions: ["users.manage"] })).body.id;
    const made = await admin.post("/api/users", { name: "Pat", email: "pat@test.local", roleId: mgrRole });
    const pat = new Client(server.url);
    await pat.login("pat@test.local", made.body.temporaryPassword);
    const admins = (await pat.get("/api/roles")).body.find((r: any) => r.name === "Administrator");
    assert.equal((await pat.post("/api/users", { name: "Evil", email: "evil@test.local", roleId: admins.id })).status, 403);
    assert.equal((await pat.put(`/api/roles/${mgrRole}`, { name: "People manager", permissions: ["users.manage", "settings.manage"] })).status, 403);
    const adminUser = (await pat.get("/api/users")).body.find((u: any) => u.email === ADMIN.email);
    assert.equal((await pat.post(`/api/users/${adminUser.id}/reset-password`)).status, 403);
    // within their own access it still works
    assert.equal((await pat.post("/api/roles", { name: "Helpers", permissions: ["users.manage"] })).status, 200);
    assert.equal((await admin.post("/api/users", { name: "Ed", email: "ed@test.local", roleId: editorRoleId })).status, 200);
  });

  it("clamps list limits, so limit=-1 can't return everything", async () => {
    const r = await fetch(`${server.url}/api/public/content/news?limit=-1`).then((x) => x.json());
    assert.equal(r.items.length, 1);
  });

  it("protects signed-in-only function endpoints like the admin API, and keeps them off public pages", async () => {
    const f = (await admin.post("/api/functions", { name: "Private", kind: "endpoint", route: "private-fn" })).body;
    await admin.put(`/api/functions/${f.id}`, { code: "export default () => ({ secret: 42 });", method: "ANY", enabled: true, isPublic: false });
    assert.equal((await fetch(`${server.url}/api/fn/private-fn`)).status, 401);
    assert.equal((await admin.get("/api/fn/private-fn")).status, 200);
    const noCsrf = await admin.request("POST", "/api/fn/private-fn", {}, { csrf: false });
    assert.equal(noCsrf.status, 403, "a cross-site POST carrying only the cookie is refused");
    // a page editor can't print a private endpoint's output on a public page
    const id = (await admin.post("/api/pages", { title: "Leak", starter: "blank" })).body.id;
    await admin.put(`/api/pages/${id}`, { layout: layoutWith({ type: "html", props: { html: "{% assign d = 'private-fn' | fn %}[{{ d.secret }}]" } }) });
    await admin.post(`/api/pages/${id}/publish`);
    const html = await fetch(`${server.url}/leak`).then((x) => x.text());
    assert.doesNotMatch(html, /\[42\]/);
  });

  it("signs out other sessions when the password changes", async () => {
    const made = await admin.post("/api/users", { name: "Sam", email: "sam@test.local", roleId: authorRoleId });
    const a = new Client(server.url);
    const b = new Client(server.url);
    await a.login("sam@test.local", made.body.temporaryPassword);
    await b.login("sam@test.local", made.body.temporaryPassword);
    assert.equal((await a.post("/api/auth/password", { current: made.body.temporaryPassword, next: "a-brand-new-password" })).status, 200);
    assert.equal((await a.get("/api/pages")).status, 200, "the session that changed it stays signed in");
    assert.equal((await b.get("/api/pages")).status, 401);
  });

  it("pauses sign-in for an account after 10 wrong passwords, from any number of addresses", async () => {
    // each attempt claims a different client address; the per-account limit still applies
    const limited = await startServer({ env: { REEF_TRUST_PROXY: "loopback" } });
    try {
      const tryOnce = (i: number) =>
        fetch(`${limited.url}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `203.0.113.${i}` }, body: JSON.stringify({ email: ADMIN.email, password: `wrong-${i}` }) });
      for (let i = 1; i <= 10; i++) assert.equal((await tryOnce(i)).status, 401);
      const locked = await tryOnce(11);
      assert.equal(locked.status, 429);
      assert.match((await locked.json()).error, /this account/);
    } finally {
      await limited.stop();
    }
  });

  it("answers malformed requests with 4xx, without filling the error log", async () => {
    const bad = await fetch(`${server.url}/api/public/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{oops" });
    assert.equal(bad.status, 400);
    assert.equal((await fetch(`${server.url}/%E0%A4%A`)).status, 400);
    const errors = (await admin.get("/api/system/health")).body.errors;
    assert.equal(errors.filter((e: any) => e.scope === "server").length, 0);
  });
});
