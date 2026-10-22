import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Client, startServer, TINY_PNG, type TestServer } from "./helpers";

let server: TestServer;
let admin: Client;

before(async () => {
  server = await startServer();
  admin = new Client(server.url);
  await admin.login(ADMIN.email, ADMIN.password);
});
after(async () => {
  await server?.stop();
});

const layoutWith = (text: string) => ({
  sections: [{ id: "s1", props: {}, columns: [{ id: "c1", width: 12, props: {}, widgets: [{ id: "w1", type: "heading", props: { text, level: "h1" } }] }] }],
});

describe("auth & security", () => {
  it("rejects a wrong password with a friendly message", async () => {
    const c = new Client(server.url);
    const r = await c.post("/api/auth/login", { email: ADMIN.email, password: "nope" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /don't match/);
  });

  it("requires a session for admin APIs", async () => {
    const r = await new Client(server.url).get("/api/pages");
    assert.equal(r.status, 401);
  });

  it("returns the signed-in user and a CSRF token", async () => {
    const me = await admin.get("/api/auth/me");
    assert.equal(me.body.user.email, ADMIN.email);
    assert.equal(me.body.user.roleName, "Administrator");
    assert.ok(me.body.csrf.length > 10);
  });

  it("rejects writes without the CSRF token", async () => {
    const r = await admin.request("PUT", "/api/settings", { siteName: "Hacked" }, { csrf: false });
    assert.equal(r.status, 403);
    const s = await admin.get("/api/settings");
    assert.notEqual(s.body.siteName, "Hacked");
  });

  it("serves the site graph only to signed-in users", async () => {
    assert.equal((await new Client(server.url).get("/api/site-graph")).status, 401);
    const r = await admin.get("/api/site-graph");
    assert.equal(r.status, 200);
    assert.ok(r.body.nodes.some((n: any) => n.kind === "home"));
    assert.ok(r.body.edges.length > 0);
  });

  it("signs out and invalidates the session", async () => {
    const c = new Client(server.url);
    await c.login(ADMIN.email, ADMIN.password);
    assert.equal((await c.post("/api/auth/logout")).status, 200);
    assert.equal((await c.get("/api/pages")).status, 401);
  });
});

describe("pages", () => {
  let id: number;
  let updatedAt: string;

  it("creates a draft page that isn't public yet", async () => {
    const r = await admin.post("/api/pages", { title: "Test Page", starter: "blank" });
    assert.equal(r.status, 200);
    assert.equal(r.body.slug, "test-page");
    assert.equal(r.body.status, "draft");
    id = r.body.id;
    assert.equal((await fetch(`${server.url}/test-page`)).status, 404);
  });

  it("saves a draft and records a revision", async () => {
    const p = await admin.get(`/api/pages/${id}`);
    const r = await admin.put(`/api/pages/${id}`, { layout: layoutWith("First version"), baseUpdatedAt: p.body.updatedAt });
    assert.equal(r.status, 200);
    updatedAt = r.body.updatedAt;
    const revs = await admin.get(`/api/revisions/page/${id}`);
    assert.ok(revs.body.length >= 1);
  });

  it("refuses a save based on a stale version (409)", async () => {
    const r = await admin.put(`/api/pages/${id}`, { title: "Stale", baseUpdatedAt: "2000-01-01T00:00:00.000Z" });
    assert.equal(r.status, 409);
    assert.equal(r.body.details?.conflict, true);
    const forced = await admin.put(`/api/pages/${id}`, { title: "Test Page", baseUpdatedAt: "2000-01-01T00:00:00.000Z", force: true });
    assert.equal(forced.status, 200);
    updatedAt = forced.body.updatedAt;
  });

  it("publishes, and the page goes live", async () => {
    const r = await admin.post(`/api/pages/${id}/publish`);
    assert.equal(r.body.status, "published");
    assert.equal(r.body.hasUnpublishedChanges, false);
    const html = await (await fetch(`${server.url}/test-page`)).text();
    assert.match(html, /First version/);
  });

  it("keeps edits private until they're published, and can discard them", async () => {
    const r = await admin.put(`/api/pages/${id}`, { layout: layoutWith("Unpublished edit") });
    assert.equal(r.body.status, "published");
    assert.equal(r.body.hasUnpublishedChanges, true);
    let live = await (await fetch(`${server.url}/test-page`)).text();
    assert.match(live, /First version/);
    assert.doesNotMatch(live, /Unpublished edit/);

    const d = await admin.post(`/api/pages/${id}/discard`);
    assert.equal(d.body.hasUnpublishedChanges, false);
    assert.equal(d.body.layout.sections[0].columns[0].widgets[0].props.text, "First version");
    live = await (await fetch(`${server.url}/test-page`)).text();
    assert.match(live, /First version/);
  });

  it("restores an older revision as a draft", async () => {
    await admin.put(`/api/pages/${id}`, { layout: layoutWith("Third version") });
    const revs = await admin.get(`/api/revisions/page/${id}`);
    const firstSave = revs.body.find((r: any) => r.note === "Saved draft");
    assert.ok(firstSave, "expected a 'Saved draft' revision");
    const r = await admin.post(`/api/pages/${id}/restore/${firstSave.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.layout.sections[0].columns[0].widgets[0].props.text, "First version");
  });

  it("renders unsaved state for the editor canvas with editor markup", async () => {
    const r = await admin.request("POST", `/api/render/page/${id}`, { layout: layoutWith("Canvas only") });
    assert.equal(r.status, 200);
    assert.match(r.body, /Canvas only/);
    assert.match(r.body, /data-rf-widget="w1"/);
    assert.match(r.body, /\/_reef\/editor\.js/);
  });

  it("stops a page from being moved under its own child", async () => {
    const child = await admin.post("/api/pages", { title: "Child", parentId: id });
    const r = await admin.put(`/api/pages/${id}`, { parentId: child.body.id });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /sub-pages/);
  });

  it("asks before deleting a page with sub-pages", async () => {
    const r = await admin.del(`/api/pages/${id}`);
    assert.equal(r.status, 409);
    assert.equal((await admin.del(`/api/pages/${id}?withChildren=1`)).status, 200);
    assert.equal((await fetch(`${server.url}/test-page`)).status, 404);
  });

  it("won't delete the homepage", async () => {
    const pages = await admin.get("/api/pages");
    const home = pages.body.find((p: any) => p.isHome);
    const r = await admin.del(`/api/pages/${home.id}`);
    assert.equal(r.status, 400);
  });
});

describe("content types & items", () => {
  let itemId: number;

  it("creates a content type with custom fields", async () => {
    const r = await admin.post("/api/types", {
      name: "Products",
      key: "products",
      fields: [
        { key: "price", label: "Price", type: "number", required: true },
        { key: "summary", label: "Summary", type: "textarea" },
      ],
    });
    assert.equal(r.status, 200);
    assert.equal(r.body.key, "products");
    assert.equal(r.body.fields.length, 2);
  });

  it("rejects duplicate and reserved field keys", async () => {
    const dup = await admin.post("/api/types", { name: "Bad", key: "bad", fields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "A2", type: "text" }] });
    assert.equal(dup.status, 400);
    const reserved = await admin.post("/api/types", { name: "Bad2", key: "bad2", fields: [{ key: "slug", label: "Slug", type: "text" }] });
    assert.equal(reserved.status, 400);
  });

  it("lets drafts skip required fields but blocks publishing without them", async () => {
    const r = await admin.post("/api/types/products/items", { title: "Coconut Oil", data: {} });
    assert.equal(r.status, 200);
    assert.equal(r.body.status, "draft");
    assert.equal(r.body.slug, "coconut-oil");
    itemId = r.body.id;
    const pub = await admin.post(`/api/items/${itemId}/publish`);
    assert.equal(pub.status, 400);
    assert.equal(pub.body.details.field, "price");
  });

  it("validates field types", async () => {
    const r = await admin.put(`/api/items/${itemId}`, { data: { price: "not a number" } });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /number/);
  });

  it("publishes once valid and exposes only published items publicly", async () => {
    await admin.put(`/api/items/${itemId}`, { data: { price: 12.5, summary: "Cold pressed." } });
    const pub = await admin.post(`/api/items/${itemId}/publish`);
    assert.equal(pub.body.status, "published");
    await admin.post("/api/types/products/items", { title: "Secret draft", data: { price: 1 } });

    const list = await fetch(`${server.url}/api/public/content/products`).then((r) => r.json());
    assert.equal(list.total, 1);
    assert.equal(list.items[0].title, "Coconut Oil");
    assert.equal(list.items[0].price, 12.5);
    assert.equal(list.items[0].url, "/products/coconut-oil");

    const detail = await fetch(`${server.url}/products/coconut-oil`);
    assert.equal(detail.status, 200);
    assert.match(await detail.text(), /Coconut Oil/);
    assert.equal((await fetch(`${server.url}/products/secret-draft`)).status, 404);
  });

  it("gives duplicate titles unique slugs", async () => {
    const r = await admin.post("/api/types/products/items", { title: "Coconut Oil", data: { price: 3 } });
    assert.equal(r.body.slug, "coconut-oil-2");
  });

  it("runs bulk actions and reports per-item errors", async () => {
    const list = await admin.get("/api/types/products/items?status=draft");
    const ids = list.body.items.map((i: any) => i.id);
    const r = await admin.post("/api/items-bulk", { ids, action: "publish" });
    assert.equal(r.body.ok, true);
    const after = await admin.get("/api/types/products/items?status=draft");
    assert.equal(after.body.total, 0);
  });

  it("asks before deleting a type that has items", async () => {
    const r = await admin.del("/api/types/products");
    assert.equal(r.status, 409);
    assert.equal((await admin.del("/api/types/products?force=1")).status, 200);
    assert.equal((await fetch(`${server.url}/api/public/content/products`)).status, 404);
  });
});

describe("forms", () => {
  const submit = (body: unknown) =>
    fetch(`${server.url}/api/public/forms/contact/submit`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });

  it("reports missing and invalid fields", async () => {
    const r = await submit({ name: "", email: "not-an-email" });
    assert.equal(r.status, 400);
    const body = await r.json();
    assert.ok(body.fields.name);
    assert.match(body.fields.email, /valid email/);
    assert.ok(body.fields.message);
  });

  it("stores a valid submission", async () => {
    const r = await submit({ name: "Ana", email: "ana@example.com", message: "Hello", consent: "yes", _page: "/contact" });
    assert.equal(r.status, 200);
    const forms = await admin.get("/api/forms");
    const contact = forms.body.find((f: any) => f.key === "contact");
    const subs = await admin.get(`/api/forms/${contact.id}/submissions`);
    assert.equal(subs.body.length, 1);
    assert.equal(subs.body[0].data.name, "Ana");
    assert.equal(subs.body[0].pagePath, "/contact");
  });

  it("silently drops honeypot submissions", async () => {
    const r = await submit({ name: "Bot", email: "bot@example.com", message: "spam", consent: "yes", _hp: "gotcha" });
    assert.equal(r.status, 200);
    const contact = (await admin.get("/api/forms")).body.find((f: any) => f.key === "contact");
    assert.equal(contact.submissionCount, 1);
  });

  it("lets a before-submit hook reject spam", async () => {
    const r = await submit({ name: "Spammer", email: "s@example.com", message: "Win at the casino", consent: "yes" });
    assert.equal(r.status, 422);
    assert.match((await r.json()).error, /spam/);
  });

  it("exports responses as CSV with formula injection guarded", async () => {
    await submit({ name: "=HYPERLINK(\"x\")", email: "csv@example.com", message: "Hi", consent: "yes" });
    const contact = (await admin.get("/api/forms")).body.find((f: any) => f.key === "contact");
    const r = await admin.get(`/api/forms/${contact.id}/export.csv`);
    assert.equal(r.status, 200);
    assert.match(r.body, /submitted,page,name,email/);
    assert.match(r.body, /'=HYPERLINK/);
  });

  it("only redirects to local paths for non-JS form posts", async () => {
    const r = await fetch(`${server.url}/api/public/forms/newsletter/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "email=a%40b.co&_page=https%3A%2F%2Fevil.example",
      redirect: "manual",
    });
    assert.equal(r.status, 303);
    assert.equal(r.headers.get("location"), "/?submitted=1");
  });
});

describe("media", () => {
  const upload = (name: string, type: string, data: BlobPart) => {
    const fd = new FormData();
    fd.append("files", new Blob([data], { type }), name);
    return admin.request("POST", "/api/media", undefined, { raw: fd });
  };

  it("accepts a real image and reads its dimensions", async () => {
    const r = await upload("dot.png", "image/png", TINY_PNG);
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 1);
    assert.equal(r.body.items[0].width, 1);
    const file = await fetch(server.url + r.body.items[0].url);
    assert.equal(file.status, 200);
  });

  it("rejects files whose contents don't match an allowed type", async () => {
    const r = await upload("evil.png", "image/png", "<?php echo 'hi'; ?>");
    assert.equal(r.status, 200);
    assert.equal(r.body.items.length, 0);
    assert.match(r.body.rejected[0], /isn't supported/);
  });

  it("rejects SVGs containing script", async () => {
    const r = await upload("x.svg", "image/svg+xml", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(r.body.items.length, 0);
  });

  it("requires the CSRF token to upload", async () => {
    const fd = new FormData();
    fd.append("files", new Blob([TINY_PNG], { type: "image/png" }), "dot.png");
    const r = await admin.request("POST", "/api/media", undefined, { raw: fd, csrf: false });
    assert.equal(r.status, 403);
  });
});

describe("roles & permissions", () => {
  let author: Client;

  before(async () => {
    const roles = await admin.get("/api/roles");
    const authorRole = roles.body.find((r: any) => r.name === "Author");
    const r = await admin.post("/api/users", { name: "Alex Author", email: "author@test.local", roleId: authorRole.id });
    assert.equal(r.status, 200);
    author = new Client(server.url);
    await author.login("author@test.local", r.body.temporaryPassword);
  });

  it("sends an Author's publish to review instead of going live", async () => {
    const p = await author.post("/api/pages", { title: "Author Draft" });
    assert.equal(p.status, 200);
    const r = await author.post(`/api/pages/${p.body.id}/publish`);
    assert.equal(r.body.sentForReview, true);
    assert.equal(r.body.status, "review");
    assert.equal((await fetch(`${server.url}/author-draft`)).status, 404);
  });

  it("blocks actions outside the role", async () => {
    assert.equal((await author.post("/api/types", { name: "Nope" })).status, 403);
    assert.equal((await author.get("/api/users")).status, 403);
    assert.equal((await author.put("/api/settings", { siteName: "x" })).status, 403);
    assert.equal((await author.get("/api/functions")).status, 403);
    const pages = await author.get("/api/pages");
    const home = pages.body.find((p: any) => p.isHome);
    assert.equal((await author.post(`/api/pages/${home.id}/unpublish`)).status, 403);
  });

  it("signs out a user when they're deactivated", async () => {
    const users = await admin.get("/api/users");
    const a = users.body.find((u: any) => u.email === "author@test.local");
    await admin.put(`/api/users/${a.id}`, { active: false });
    assert.equal((await author.get("/api/pages")).status, 401);
  });

  it("won't let an admin lock themselves out", async () => {
    const users = await admin.get("/api/users");
    const me = users.body.find((u: any) => u.email === ADMIN.email);
    assert.equal((await admin.put(`/api/users/${me.id}`, { active: false })).status, 400);
    assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400);
  });
});

describe("public site", () => {
  it("serves a friendly 404", async () => {
    const r = await fetch(`${server.url}/definitely-not-a-page`);
    assert.equal(r.status, 404);
    assert.match(await r.text(), /couldn't find that page/);
  });

  it("follows redirects and counts hits", async () => {
    const add = await admin.post("/api/redirects", { fromPath: "/old-news/", toPath: "/news", code: 301 });
    assert.equal(add.status, 200);
    const r = await fetch(`${server.url}/old-news`, { redirect: "manual" });
    assert.equal(r.status, 301);
    assert.equal(r.headers.get("location"), "/news");
    const list = await admin.get("/api/redirects");
    assert.equal(list.body.find((x: any) => x.fromPath === "/old-news").hits, 1);
  });

  it("lists published pages and items in the sitemap, and links it from robots.txt", async () => {
    const xml = await (await fetch(`${server.url}/sitemap.xml`)).text();
    assert.match(xml, /<loc>http:\/\/127\.0\.0\.1:\d+\/news<\/loc>/);
    assert.match(xml, /\/news\/welcome-to-your-new-website/);
    assert.doesNotMatch(xml, /author-draft/);
    const robots = await (await fetch(`${server.url}/robots.txt`)).text();
    assert.match(robots, /Sitemap: .*\/sitemap\.xml/);
  });

  it("serves server functions at /api/fn and honours the method", async () => {
    const r = await fetch(`${server.url}/api/fn/headlines?limit=2`);
    assert.equal(r.status, 200);
    assert.equal((await r.json()).count, 2);
    assert.equal((await fetch(`${server.url}/api/fn/headlines`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${server.url}/api/fn/missing`)).status, 404);
  });

  it("server-renders React widgets and serves their compiled modules", async () => {
    const html = await (await fetch(`${server.url}/`)).text();
    assert.match(html, /<script type="importmap">/);
    assert.match(html, /data-reef-react="[^"]+"[^>]*data-ssr/);
    assert.match(html, /pt-price/);
    const mod = html.match(/\/_reef\/rw\/([a-f0-9]+)\.js/)![0];
    const js = await fetch(server.url + mod);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type") ?? "", /javascript/);
    const runtime = await fetch(`${server.url}/_reef/react.js`);
    assert.equal(runtime.status, 200);
    assert.match(await runtime.text(), /hydrateRoot/);
  });

  it("refuses Tailwind settings that don't compile, and keeps the old ones", async () => {
    const bad = await admin.put("/api/settings", { tailwindCss: "@apply no-such-utility-zzz;" });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Tailwind couldn't compile/);
    assert.doesNotMatch((await admin.get("/api/settings")).body.tailwindCss, /no-such-utility/);
    const good = await admin.put("/api/settings", { tailwindCss: "@theme { --color-ocean: #00b0ca; }" });
    assert.equal(good.status, 200);
  });

  it("hides the headless API when it's turned off", async () => {
    await admin.put("/api/settings", { headlessApiEnabled: false });
    assert.equal((await fetch(`${server.url}/api/public/content/news`)).status, 404);
    await admin.put("/api/settings", { headlessApiEnabled: true });
    assert.equal((await fetch(`${server.url}/api/public/content/news`)).status, 200);
  });
});

describe("page fragments for headless front ends", () => {
  it("renders a published page body with its React widgets as module addresses", async () => {
    await admin.put("/api/settings", { headlessApiEnabled: true, importMap: { "@site/kit": "https://example.com/kit.js" } });
    const p = await admin.post("/api/pages", { title: "Fragment Page", starter: "blank" });
    const layout = {
      sections: [
        {
          id: "s1",
          props: {},
          columns: [
            {
              id: "c1",
              width: 12,
              props: {},
              widgets: [
                { id: "h1", type: "heading", props: { text: "Fragment heading", level: "h1" } },
                { id: "r1", type: "react", props: { code: `import { Badge } from "@site/kit";\nexport default function R() { return <Badge />; }` } },
              ],
            },
          ],
        },
      ],
    };
    const page = await admin.get(`/api/pages/${p.body.id}`);
    await admin.put(`/api/pages/${p.body.id}`, { layout, baseUpdatedAt: page.body.updatedAt });
    assert.equal((await fetch(`${server.url}/api/public/render?path=/fragment-page`)).status, 404, "drafts aren't served");
    await admin.post(`/api/pages/${p.body.id}/publish`);

    const r = await fetch(`${server.url}/api/public/render?path=/fragment-page`);
    assert.equal(r.status, 200);
    const f = await r.json();
    assert.equal(f.path, "/fragment-page");
    assert.match(f.html, /Fragment heading/);
    assert.doesNotMatch(f.html, /<html|<script/, "only the page body, without scripts");
    assert.equal(f.modules.length, 1);
    assert.equal(f.modules[0].id, "r1");
    assert.match(f.modules[0].src, /^\/_reef\/rw\/[0-9a-f]+\.js$/);
    // import-map packages stay bare for the page's import map instead of going through esm.sh
    const mod = await (await fetch(server.url + f.modules[0].src)).text();
    assert.match(mod, /from "@site\/kit"/);
    const html = await (await fetch(`${server.url}/fragment-page`)).text();
    assert.match(html, /"@site\/kit":"https:\/\/example.com\/kit.js"/);
  });

  it("refuses import-map entries that aren't package names and addresses", async () => {
    assert.equal((await admin.put("/api/settings", { importMap: { "bad key!": "https://example.com/x.js" } })).status, 400);
    assert.equal((await admin.put("/api/settings", { importMap: { kit: "javascript:alert(1)" } })).status, 400);
    await admin.put("/api/settings", { importMap: {} });
  });
});

describe("dynamic routes", () => {
  const publishWith = async (title: string, text: string, routes: string[]) => {
    const p = await admin.post("/api/pages", { title, starter: "blank" });
    const page = await admin.get(`/api/pages/${p.body.id}`);
    const saved = await admin.put(`/api/pages/${p.body.id}`, { layout: layoutWith(text), routes, baseUpdatedAt: page.body.updatedAt });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.routes, routes);
    await admin.post(`/api/pages/${p.body.id}/publish`);
    return p.body.id as number;
  };

  it("shows a page for every address its patterns match", async () => {
    await publishWith("Item template", "Item template body", ["/items/:slug"]);
    const html = await (await fetch(`${server.url}/items/anything-at-all`)).text();
    assert.match(html, /Item template body/);
    assert.equal((await fetch(`${server.url}/items/a/b`)).status, 404, ":slug is one segment");
    const f = await (await fetch(`${server.url}/api/public/render?path=/items/xyz`)).json();
    assert.equal(f.path, "/items/xyz");
    assert.match(f.html, /Item template body/);
    const pages = await (await fetch(`${server.url}/api/public/pages`)).json();
    assert.deepEqual(pages.find((p: any) => p.title === "Item template").routes, ["/items/:slug"]);
  });

  it("prefers the more specific pattern, and real pages over patterns", async () => {
    await publishWith("Docs catch-all", "Any doc", ["/docs/*"]);
    await publishWith("Docs special", "Special doc", ["/docs/special"]);
    assert.match(await (await fetch(`${server.url}/docs/special`)).text(), /Special doc/);
    assert.match(await (await fetch(`${server.url}/docs/a/b/c`)).text(), /Any doc/);
    assert.equal((await fetch(`${server.url}/docs`)).status, 404, "/docs/* needs something after /docs/");
  });

  it("uses a * page for addresses nothing else answers, with a 404 status", async () => {
    await publishWith("Lost", "Custom not found", ["*"]);
    const r = await fetch(`${server.url}/no/such/page/here`);
    assert.equal(r.status, 404);
    const html = await r.text();
    assert.match(html, /Custom not found/);
    assert.match(html, /noindex/);
  });

  it("refuses patterns that aren't addresses", async () => {
    const p = await admin.post("/api/pages", { title: "Bad routes", starter: "blank" });
    const page = await admin.get(`/api/pages/${p.body.id}`);
    for (const bad of ["news/:slug", "/a/*/b", "/<script>", "/a b"]) {
      const r = await admin.put(`/api/pages/${p.body.id}`, { routes: [bad], baseUpdatedAt: page.body.updatedAt, force: true });
      assert.equal(r.status, 400, bad);
    }
  });
});
