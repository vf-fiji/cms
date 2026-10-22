import "./env";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, Client, startServer, type TestServer } from "./helpers";

let server: TestServer;
let admin: Client;
let developer: Client;
let editor: Client;

async function userWithRole(email: string, roleName: string) {
  const roles = await admin.get("/api/roles");
  const role = roles.body.find((r: any) => r.name === roleName);
  const r = await admin.post("/api/users", { name: `${roleName} User`, email, roleId: role.id });
  assert.equal(r.status, 200);
  const c = new Client(server.url);
  await c.login(email, r.body.temporaryPassword);
  return c;
}

before(async () => {
  server = await startServer();
  admin = new Client(server.url);
  await admin.login(ADMIN.email, ADMIN.password);
  developer = await userWithRole("dev@test.local", "Developer");
  editor = await userWithRole("editor@test.local", "Editor");
});
after(async () => {
  await server?.stop();
});

const history = async (entity: string, id: number) => (await admin.get(`/api/revisions/${entity}/${id}`)).body as { id: number; note: string; userName: string | null }[];
const revisionData = async (revId: number) => (await admin.get(`/api/revision/${revId}`)).body.data;

describe("template history", () => {
  let id: number;
  let original: string;

  before(async () => {
    const t = await admin.post("/api/templates", { name: "History template" });
    id = t.body.id;
    original = t.body.html;
  });

  it("keeps the version from before the first save, then the saved one", async () => {
    const r = await admin.put(`/api/templates/${id}`, { html: "<main>v1 {{ content }}</main>" });
    assert.equal(r.status, 200);
    const revs = await history("template", id);
    assert.deepEqual(revs.map((r) => r.note), ["Saved", "Earlier version"]);
    assert.equal(revs[0].userName, "Site Admin");
    assert.equal((await revisionData(revs[1].id)).html, original);
    assert.equal((await revisionData(revs[0].id)).html, "<main>v1 {{ content }}</main>");
  });

  it("folds rapid saves by the same person into one revision", async () => {
    await admin.put(`/api/templates/${id}`, { html: "<main>v2 {{ content }}</main>" });
    await admin.put(`/api/templates/${id}`, { css: "main { color: red; }" });
    const revs = await history("template", id);
    assert.equal(revs.length, 2);
    const latest = await revisionData(revs[0].id);
    assert.equal(latest.html, "<main>v2 {{ content }}</main>");
    assert.equal(latest.css, "main { color: red; }");
  });

  it("doesn't add a revision when nothing changed", async () => {
    const before = (await history("template", id)).length;
    await admin.put(`/api/templates/${id}`, {});
    assert.equal((await history("template", id)).length, before);
  });

  it("restores an older version and records the restore", async () => {
    const revs = await history("template", id);
    const r = await admin.post(`/api/templates/${id}/restore/${revs.at(-1)!.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.html, original);
    assert.equal((await admin.get(`/api/templates/${id}`)).body.html, original);
    const after = await history("template", id);
    assert.match(after[0].note, /^Restored version from \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    assert.equal((await revisionData(after[0].id)).html, original);
  });

  it("starts a new revision for the next save after a restore", async () => {
    const before = (await history("template", id)).length;
    await admin.put(`/api/templates/${id}`, { html: "<main>v3 {{ content }}</main>" });
    const revs = await history("template", id);
    assert.equal(revs.length, before + 1);
    assert.equal(revs[0].note, "Saved");
  });

  it("won't restore a revision that belongs to something else", async () => {
    const other = await admin.post("/api/templates", { name: "Other template" });
    await admin.put(`/api/templates/${other.body.id}`, { html: "other" });
    const foreign = (await history("template", other.body.id))[0];
    assert.equal((await admin.post(`/api/templates/${id}/restore/${foreign.id}`)).status, 404);
    assert.equal((await admin.post(`/api/templates/${id}/restore/999999`)).status, 404);
  });
});

describe("widget history", () => {
  let id: number;

  before(async () => {
    const w = await admin.post("/api/widgets", { name: "History widget", renderer: "liquid" });
    id = w.body.id;
  });

  it("keeps separate revisions for different people", async () => {
    await admin.put(`/api/widgets/${id}`, { template: "<p>admin</p>", fields: [{ key: "title", label: "Title", type: "text" }] });
    await developer.put(`/api/widgets/${id}`, { template: "<p>developer</p>", fields: [{ key: "heading", label: "Heading", type: "text" }] });
    const revs = await history("widget", id);
    assert.deepEqual(revs.map((r) => [r.note, r.userName]), [["Saved", "Developer User"], ["Saved", "Site Admin"], ["Earlier version", null]]);
  });

  it("restores the template and the fields", async () => {
    const adminSave = (await history("widget", id))[1];
    const r = await developer.post(`/api/widgets/${id}/restore/${adminSave.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.template, "<p>admin</p>");
    assert.deepEqual(r.body.fields.map((f: any) => f.key), ["title"]);
  });
});

describe("site code history", () => {
  it("restores content and settings of a site-wide file", async () => {
    const a = await admin.post("/api/assets", { name: "history.css", kind: "css" });
    await admin.put(`/api/assets/${a.body.id}`, { content: "body { margin: 0; }", enabled: false });
    const revs = await history("asset", a.body.id);
    assert.equal(revs.length, 2);
    const r = await admin.post(`/api/assets/${a.body.id}/restore/${revs[1].id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.content, a.body.content);
    assert.equal(r.body.enabled, true);
  });

  it("forgets the history when the file is deleted", async () => {
    const a = await admin.post("/api/assets", { name: "temp.js", kind: "js" });
    await admin.put(`/api/assets/${a.body.id}`, { content: "console.log(1);" });
    assert.ok((await history("asset", a.body.id)).length > 0);
    await admin.del(`/api/assets/${a.body.id}`);
    assert.deepEqual(await history("asset", a.body.id), []);
  });
});

describe("server function history", () => {
  let id: number;

  before(async () => {
    const f = await admin.post("/api/functions", { name: "History fn", kind: "endpoint", route: "history-fn" });
    id = f.body.id;
    await admin.put(`/api/functions/${id}`, { code: "export default () => ({ version: 1 });", method: "GET" });
  });

  it("restores the code, and the restored version is what runs", async () => {
    await developer.put(`/api/functions/${id}`, { code: "export default () => ({ version: 2 });" });
    assert.deepEqual(await (await fetch(`${server.url}/api/fn/history-fn`)).json(), { version: 2 });
    const v1 = (await history("function", id)).find((r) => r.userName === "Site Admin")!;
    const r = await developer.post(`/api/functions/${id}/restore/${v1.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.code, "export default () => ({ version: 1 });");
    assert.equal(r.body.method, "GET");
    assert.deepEqual(await (await fetch(`${server.url}/api/fn/history-fn`)).json(), { version: 1 });
  });

  it("hides code history from people who can't edit code", async () => {
    const [latest] = await history("function", id);
    assert.equal((await editor.get(`/api/revisions/function/${id}`)).status, 403);
    assert.equal((await editor.get(`/api/revision/${latest.id}`)).status, 403);
    assert.equal((await editor.post(`/api/functions/${id}/restore/${latest.id}`)).status, 403);
  });
});

describe("live preview", () => {
  let key: string;
  let pagePath: string;

  before(async () => {
    const w = await developer.post("/api/widgets", { name: "Preview widget", renderer: "liquid" });
    key = w.body.key;
    await developer.put(`/api/widgets/${w.body.id}`, { template: "<p class='pw'>saved version</p>" });
    const p = await admin.post("/api/pages", { title: "Preview page", starter: "blank" });
    const page = await admin.get(`/api/pages/${p.body.id}`);
    const layout = { sections: [{ id: "s1", props: {}, columns: [{ id: "c1", width: 12, props: {}, widgets: [{ id: "w1", type: key, props: {} }] }] }] };
    await admin.put(`/api/pages/${p.body.id}`, { layout, baseUpdatedAt: page.body.updatedAt });
    pagePath = `/${page.body.slug}`;
  });

  it("shows a page's draft with unsaved widget changes, at the page's own address", async () => {
    const r = await developer.post("/api/studio-preview", { overrides: { widget: { key, template: "<p class='pw'>unsaved version</p>" } } });
    assert.equal(r.status, 200);
    const page = await developer.request("GET", `${pagePath}?reef_studio=${r.body.token}`);
    assert.equal(page.status, 200);
    assert.match(String(page.body), /unsaved version/);
    assert.doesNotMatch(String(page.body), /class='pw'>saved version/);
    assert.equal(page.headers.get("cache-control"), "no-store");
    // the saved widget is untouched
    const saved = await developer.get(`/api/widgets`);
    assert.match(saved.body.find((w: any) => w.key === key).template, /saved version/);
  });

  it("updates the same preview as the code changes", async () => {
    const first = await developer.post("/api/studio-preview", { overrides: { widget: { key, template: "<p>one</p>" } } });
    const again = await developer.post("/api/studio-preview", { token: first.body.token, overrides: { widget: { key, template: "<p>two</p>" } } });
    assert.equal(again.body.token, first.body.token);
    assert.match(String((await developer.request("GET", `${pagePath}?reef_studio=${first.body.token}`)).body), /<p>two<\/p>/);
  });

  it("applies unsaved template changes", async () => {
    const t = (await admin.get("/api/templates")).body.find((x: any) => x.isDefault);
    const r = await developer.post("/api/studio-preview", { overrides: { template: { id: t.id, html: "<div class='tpl-preview'>{{ content }}</div>" } } });
    assert.match(String((await developer.request("GET", `${pagePath}?reef_studio=${r.body.token}`)).body), /tpl-preview/);
  });

  it("keeps previews to the person who made them, and to people who edit code", async () => {
    const r = await developer.post("/api/studio-preview", { overrides: { widget: { key, template: "<p>private</p>" } } });
    assert.equal((await admin.request("GET", `${pagePath}?reef_studio=${r.body.token}`)).status, 410);
    const visitor = await fetch(`${server.url}${pagePath}?reef_studio=${r.body.token}`);
    assert.doesNotMatch(await visitor.text(), /private/);
    assert.equal((await editor.post("/api/studio-preview", { overrides: {} })).status, 403);
  });

  it("lists the pages that use the widget first", async () => {
    const pages = (await developer.get(`/api/studio-preview/pages?widget=${key}`)).body;
    assert.equal(pages[0].path, pagePath);
    assert.equal(pages[0].uses, true);
  });
});
