import { Router } from "express";
import { all, get, run, json, now, logActivity, saveRevision, tx } from "../db";
import { requirePerm, can, HttpError } from "../auth";
import { previewPages, savePreview } from "../preview";
import { str, key, idParam, notFound } from "../http";
import { mapFunction, runFunction, HOOK_EVENTS, unwrap } from "../functions";
import { BUILTIN_WIDGETS } from "../../shared/widgets";
import type { CustomWidget, Template, CodeAsset, FieldDef } from "../../shared/types";

export const developer = Router();

// ---------- revisions ----------
// Every save of a template, widget, site file or server function keeps a snapshot
// in the shared revisions table, so Code Studio can show history and roll back.
type CodeEntity = "template" | "widget" | "asset" | "function";

const SNAPSHOT: Record<CodeEntity, (r: any) => Record<string, unknown>> = {
  template: (r) => ({ name: r.name, html: r.html, css: r.css, js: r.js, head: r.head }),
  widget: (r) => ({ name: r.name, icon: r.icon, description: r.description, fields: json<FieldDef[]>(r.fields, []), renderer: r.renderer, ssr: !!r.ssr, template: r.template, css: r.css, js: r.js }),
  asset: (r) => ({ name: r.name, location: r.location, content: r.content, enabled: !!r.enabled }),
  function: (r) => ({ name: r.name, route: r.route, method: r.method, event: r.event, intervalMinutes: r.interval_minutes, code: r.code, enabled: !!r.enabled, isPublic: !!r.is_public }),
};

/** Records a revision after a save. Rapid saves by the same person (within 2 minutes) update the latest revision instead of piling up new ones. */
function recordRevision(entity: CodeEntity, id: number, before: any, after: any, userId: number, note = "Saved") {
  const snap = JSON.stringify(SNAPSHOT[entity](after));
  // Files that existed before history was kept: remember how they looked, so the first save can be undone too
  if (!get("SELECT 1 FROM revisions WHERE entity = ? AND entity_id = ? LIMIT 1", entity, id)) saveRevision(entity, id, SNAPSHOT[entity](before), null, "Earlier version", isoTime(before.updated_at));
  const last = get("SELECT id, data, note, user_id, created_at FROM revisions WHERE entity = ? AND entity_id = ? ORDER BY id DESC LIMIT 1", entity, id)!;
  if (last.data === snap) return;
  if (note === "Saved" && last.note === "Saved" && last.user_id === userId && Date.now() - new Date(last.created_at).getTime() <= 120_000) {
    run("UPDATE revisions SET data = ? WHERE id = ?", snap, last.id);
  } else saveRevision(entity, id, JSON.parse(snap), userId, note);
}

// SQLite's datetime('now') default has no "T" or zone; revisions store ISO timestamps
const isoTime = (t: string | null) => (!t ? now() : t.includes("T") ? t : `${t.replace(" ", "T")}Z`);

function findRevision(entity: CodeEntity, id: number, revId: unknown) {
  const rev = get("SELECT * FROM revisions WHERE id = ? AND entity = ? AND entity_id = ?", idParam(revId), entity, id) ?? notFound("Revision");
  return { data: json<any>(rev.data, {}), note: `Restored version from ${String(rev.created_at).slice(0, 16).replace("T", " ")}` };
}

const forgetRevisions = (entity: CodeEntity, id: number) => run("DELETE FROM revisions WHERE entity = ? AND entity_id = ?", entity, id);

// ---------- templates ----------
function mapTemplate(r: any): Template & { pageCount?: number } {
  return { id: r.id, name: r.name, html: r.html, css: r.css, js: r.js, head: r.head, isDefault: !!r.is_default, updatedAt: r.updated_at, pageCount: r.page_count };
}

developer.get("/templates", (_req, res) =>
  res.json(all("SELECT t.*, (SELECT COUNT(*) FROM pages p WHERE p.template_id = t.id) page_count FROM templates t ORDER BY t.is_default DESC, t.name").map(mapTemplate)),
);
developer.get("/templates/:id", (req, res) => res.json(mapTemplate(get("SELECT * FROM templates WHERE id = ?", idParam(req.params.id)) ?? notFound("Template"))));
developer.post("/templates", requirePerm("templates.edit"), (req, res) => {
  const name = str(req.body?.name, "Template name", { required: true, max: 80 });
  const src = req.body?.copyFrom ? get("SELECT * FROM templates WHERE id = ?", idParam(req.body.copyFrom)) : get("SELECT * FROM templates ORDER BY is_default DESC LIMIT 1");
  const r = run("INSERT INTO templates(name, html, css, js, head, updated_at) VALUES(?,?,?,?,?,?)", name, src?.html ?? "{{ content }}", src?.css ?? "", src?.js ?? "", src?.head ?? "", now());
  logActivity(req.user!.id, "created", "template", r.lastId, name);
  res.json(mapTemplate(get("SELECT * FROM templates WHERE id = ?", r.lastId)));
});
function updateTemplate(id: number, b: any, userId: number, note?: string) {
  const t = get("SELECT * FROM templates WHERE id = ?", id) ?? notFound("Template");
  run("UPDATE templates SET name=?, html=?, css=?, js=?, head=?, updated_at=? WHERE id=?", str(b.name ?? t.name, "Name", { required: true, max: 80 }), b.html ?? t.html, b.css ?? t.css, b.js ?? t.js, b.head ?? t.head, now(), id);
  const after = get("SELECT * FROM templates WHERE id = ?", id);
  recordRevision("template", id, t, after, userId, note);
  logActivity(userId, note ? "restored a version of" : "edited", "template", id, t.name);
  return mapTemplate(after);
}
developer.put("/templates/:id", requirePerm("templates.edit"), (req, res) => res.json(updateTemplate(idParam(req.params.id), req.body ?? {}, req.user!.id)));
developer.post("/templates/:id/restore/:revId", requirePerm("templates.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = findRevision("template", id, req.params.revId);
  res.json(updateTemplate(id, rev.data, req.user!.id, rev.note));
});
developer.post("/templates/:id/default", requirePerm("templates.edit"), (req, res) => {
  const id = idParam(req.params.id);
  tx(() => {
    run("UPDATE templates SET is_default = 0");
    run("UPDATE templates SET is_default = 1 WHERE id = ?", id);
  });
  res.json({ ok: true });
});
developer.delete("/templates/:id", requirePerm("templates.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const t = get("SELECT * FROM templates WHERE id = ?", id) ?? notFound("Template");
  if (t.is_default) throw new HttpError(400, "This is the default template. Make another template the default first.");
  run("DELETE FROM templates WHERE id = ?", id);
  forgetRevisions("template", id);
  logActivity(req.user!.id, "deleted", "template", id, t.name);
  res.json({ ok: true });
});

// ---------- custom widgets ----------
function mapWidget(r: any): CustomWidget {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    icon: r.icon,
    category: r.category,
    description: r.description,
    fields: json<FieldDef[]>(r.fields, []),
    renderer: r.renderer === "react" ? "react" : "liquid",
    ssr: !!r.ssr,
    template: r.template,
    css: r.css,
    js: r.js,
    updatedAt: r.updated_at,
  };
}

developer.get("/widgets", (_req, res) => res.json(all("SELECT * FROM custom_widgets ORDER BY name").map(mapWidget)));
// Code Studio's live preview: unsaved changes, kept for a while under a token the preview page uses
developer.post("/studio-preview", (req, res) => {
  if (!can(req, "code.edit") && !can(req, "templates.edit")) throw new HttpError(403, "You don't have permission to edit code.");
  const b = req.body ?? {};
  res.json({ token: savePreview(req.user!.id, typeof b.token === "string" ? b.token : undefined, b.overrides) });
});
developer.get("/studio-preview/pages", (req, res) => {
  if (!can(req, "code.edit") && !can(req, "templates.edit")) throw new HttpError(403, "You don't have permission to edit code.");
  res.json(previewPages({ widget: req.query.widget ? String(req.query.widget) : undefined, template: req.query.template ? Number(req.query.template) : undefined }));
});

developer.post("/widgets", requirePerm("code.edit"), (req, res) => {
  const name = str(req.body?.name, "Widget name", { required: true, max: 60 });
  const k = key(req.body?.key || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "Widget key");
  if (BUILTIN_WIDGETS.some((w) => w.type === k) || get("SELECT 1 FROM custom_widgets WHERE key = ?", k)) throw new HttpError(409, `A widget with key “${k}” already exists.`);
  const isReact = req.body?.renderer === "react";
  const component = k.replace(/(^|-)([a-z0-9])/g, (_m: string, _d: string, c: string) => c.toUpperCase());
  const r = run(
    "INSERT INTO custom_widgets(key, name, icon, category, description, fields, renderer, ssr, template, css, js, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    k,
    name,
    req.body?.icon || (isReact ? "Atom" : "Puzzle"),
    "Custom",
    str(req.body?.description, "Description", { max: 200 }),
    JSON.stringify([{ key: "title", label: "Title", type: "text", default: "Hello" }]),
    isReact ? "react" : "liquid",
    1,
    isReact
      ? `// Props come from the fields you define in the Fields tab.\n// Rendered on the server for SEO, then hydrated in the browser.\nimport { useState } from "react";\n\nexport default function ${component}({ title }) {\n  const [open, setOpen] = useState(false);\n  return (\n    <div className="${k}">\n      <h3>{title}</h3>\n      <button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"} details</button>\n      {open && <p>Hello from React!</p>}\n    </div>\n  );\n}\n`
      : `<div class="${k}">\n  <h3>{{ props.title }}</h3>\n</div>`,
    `.${k} {\n  padding: 24px;\n  border-radius: 16px;\n  background: #f4f4f5;\n}`,
    "",
    now(),
  );
  logActivity(req.user!.id, "created", "widget", r.lastId, name);
  res.json(mapWidget(get("SELECT * FROM custom_widgets WHERE id = ?", r.lastId)));
});
function updateWidget(id: number, b: any, userId: number, note?: string) {
  const w = get("SELECT * FROM custom_widgets WHERE id = ?", id) ?? notFound("Widget");
  let fields = w.fields;
  if (b.fields !== undefined) {
    if (!Array.isArray(b.fields)) throw new HttpError(400, "Fields must be a list.");
    fields = JSON.stringify(b.fields.map((f: any) => ({ ...f, key: key(f.key, "Field key", true), label: String(f.label || f.key) })));
  }
  run(
    "UPDATE custom_widgets SET name=?, icon=?, description=?, fields=?, renderer=?, ssr=?, template=?, css=?, js=?, updated_at=? WHERE id=?",
    str(b.name ?? w.name, "Name", { required: true, max: 60 }),
    b.icon ?? w.icon,
    str(b.description ?? w.description, "Description", { max: 200 }),
    fields,
    b.renderer === "react" || b.renderer === "liquid" ? b.renderer : w.renderer,
    b.ssr === undefined ? !!w.ssr : !!b.ssr,
    b.template ?? w.template,
    b.css ?? w.css,
    b.js ?? w.js,
    now(),
    id,
  );
  const after = get("SELECT * FROM custom_widgets WHERE id = ?", id);
  recordRevision("widget", id, w, after, userId, note);
  logActivity(userId, note ? "restored a version of" : "edited", "widget", id, w.name);
  return mapWidget(after);
}
developer.put("/widgets/:id", requirePerm("code.edit"), (req, res) => res.json(updateWidget(idParam(req.params.id), req.body ?? {}, req.user!.id)));
developer.post("/widgets/:id/restore/:revId", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = findRevision("widget", id, req.params.revId);
  res.json(updateWidget(id, rev.data, req.user!.id, rev.note));
});
developer.delete("/widgets/:id", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const w = get("SELECT * FROM custom_widgets WHERE id = ?", id) ?? notFound("Widget");
  const used = get("SELECT COUNT(*) n FROM pages WHERE layout LIKE ?", `%"type":"${w.key}"%`)!.n;
  if (used && req.query.force !== "1") throw new HttpError(409, `This widget is used on ${used} page${used === 1 ? "" : "s"}. Delete it anyway? Those blocks will disappear from the live site.`);
  run("DELETE FROM custom_widgets WHERE id = ?", id);
  forgetRevisions("widget", id);
  res.json({ ok: true });
});

// ---------- global code assets ----------
function mapAsset(r: any): CodeAsset {
  return { id: r.id, name: r.name, kind: r.kind, location: r.location, content: r.content, enabled: !!r.enabled, sort: r.sort, updatedAt: r.updated_at };
}
developer.get("/assets", (_req, res) => res.json(all("SELECT * FROM code_assets ORDER BY sort, id").map(mapAsset)));
developer.post("/assets", requirePerm("code.edit"), (req, res) => {
  const kind = ["css", "js", "html"].includes(req.body?.kind) ? req.body.kind : "css";
  const name = str(req.body?.name, "File name", { required: true, max: 80 });
  const starter = { css: "/* Styles added here load on every page */\n", js: "// Runs on every page of the live site\ndocument.addEventListener('DOMContentLoaded', () => {\n  \n});\n", html: "<!-- HTML injected into every page -->\n" }[kind as "css"];
  const r = run("INSERT INTO code_assets(name, kind, location, content, sort, updated_at) VALUES(?,?,?,?,?,?)", name, kind, kind === "js" ? "body-end" : "head", starter, (get("SELECT MAX(sort) m FROM code_assets")?.m ?? 0) + 1, now());
  logActivity(req.user!.id, "created", "asset", r.lastId, name);
  res.json(mapAsset(get("SELECT * FROM code_assets WHERE id = ?", r.lastId)));
});
function updateAsset(id: number, b: any, userId: number, note?: string) {
  const a = get("SELECT * FROM code_assets WHERE id = ?", id) ?? notFound("File");
  run(
    "UPDATE code_assets SET name=?, location=?, content=?, enabled=?, updated_at=? WHERE id=?",
    str(b.name ?? a.name, "Name", { required: true, max: 80 }),
    ["head", "body-end"].includes(b.location) ? b.location : a.location,
    b.content ?? a.content,
    b.enabled === undefined ? !!a.enabled : !!b.enabled,
    now(),
    id,
  );
  const after = get("SELECT * FROM code_assets WHERE id = ?", id);
  recordRevision("asset", id, a, after, userId, note);
  logActivity(userId, note ? "restored a version of" : "edited", "asset", id, a.name);
  return mapAsset(after);
}
developer.put("/assets/:id", requirePerm("code.edit"), (req, res) => res.json(updateAsset(idParam(req.params.id), req.body ?? {}, req.user!.id)));
developer.post("/assets/:id/restore/:revId", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = findRevision("asset", id, req.params.revId);
  res.json(updateAsset(id, rev.data, req.user!.id, rev.note));
});
developer.delete("/assets/:id", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  run("DELETE FROM code_assets WHERE id = ?", id);
  forgetRevisions("asset", id);
  res.json({ ok: true });
});

// ---------- server functions ----------
developer.get("/functions-meta", (_req, res) => res.json({ hookEvents: HOOK_EVENTS }));
developer.get("/functions", requirePerm("code.edit"), (_req, res) => res.json(all("SELECT * FROM functions ORDER BY kind, name").map(mapFunction)));

const STARTER_CODE: Record<string, string> = {
  endpoint: `// Reachable at /api/fn/{route}. Return any JSON-serialisable value.
// Available: request { method, query, body, headers, user }, cms, console
export default async ({ request, cms }) => {
  const latest = cms.content.list("news", { limit: 3 });
  return {
    message: "Hello from VodaForge!",
    you: request.query.name ?? "stranger",
    latest: latest.map((n) => n.title),
  };
};
`,
  hook: `// Runs when the selected event happens.
// For "before" events, return the (modified) payload, or throw an Error to block the action.
export default async ({ event, payload, cms }) => {
  console.log("Event", event, payload);
  return payload;
};
`,
  schedule: `// Runs automatically on the interval you choose.
export default async ({ cms }) => {
  const runs = (cms.kv.get("schedule-runs") ?? 0) + 1;
  cms.kv.set("schedule-runs", runs);
  console.log("Scheduled run #" + runs);
};
`,
};

developer.post("/functions", requirePerm("code.edit"), (req, res) => {
  const kind = ["endpoint", "hook", "schedule"].includes(req.body?.kind) ? req.body.kind : "endpoint";
  const name = str(req.body?.name, "Name", { required: true, max: 80 });
  const route = kind === "endpoint" ? key(req.body?.route || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "Route") : "";
  if (route && get("SELECT 1 FROM functions WHERE kind = 'endpoint' AND route = ?", route)) throw new HttpError(409, `Another endpoint already uses /api/fn/${route}.`);
  const r = run(
    "INSERT INTO functions(name, kind, route, method, event, interval_minutes, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    name,
    kind,
    route,
    "ANY",
    kind === "hook" ? req.body?.event || "content.beforeSave" : "",
    60,
    STARTER_CODE[kind],
    1,
    1,
    now(),
  );
  logActivity(req.user!.id, "created", "function", r.lastId, name);
  res.json(mapFunction(get("SELECT * FROM functions WHERE id = ?", r.lastId)));
});
function updateFunction(id: number, b: any, userId: number, note?: string) {
  const row = get("SELECT * FROM functions WHERE id = ?", id) ?? notFound("Function");
  const f = mapFunction(row);
  const route = f.kind === "endpoint" && b.route !== undefined ? key(b.route, "Route") : f.route;
  if (route !== f.route && get("SELECT 1 FROM functions WHERE kind = 'endpoint' AND route = ? AND id != ?", route, id)) throw new HttpError(409, `Another endpoint already uses /api/fn/${route}.`);
  if (b.event !== undefined && f.kind === "hook" && !HOOK_EVENTS.some((e) => e.value === b.event)) throw new HttpError(400, "Choose a valid event.");
  run(
    "UPDATE functions SET name=?, route=?, method=?, event=?, interval_minutes=?, code=?, enabled=?, is_public=?, updated_at=? WHERE id=?",
    str(b.name ?? f.name, "Name", { required: true, max: 80 }),
    route,
    ["GET", "POST", "PUT", "DELETE", "ANY"].includes(b.method) ? b.method : f.method,
    b.event ?? f.event,
    Math.max(1, Math.min(10080, Number(b.intervalMinutes ?? f.intervalMinutes) || 60)),
    b.code ?? f.code,
    b.enabled === undefined ? f.enabled : !!b.enabled,
    b.isPublic === undefined ? f.isPublic : !!b.isPublic,
    now(),
    id,
  );
  const after = get("SELECT * FROM functions WHERE id = ?", id);
  recordRevision("function", id, row, after, userId, note);
  logActivity(userId, note ? "restored a version of" : "edited", "function", id, f.name);
  return mapFunction(after);
}
developer.put("/functions/:id", requirePerm("code.edit"), (req, res) => res.json(updateFunction(idParam(req.params.id), req.body ?? {}, req.user!.id)));
developer.post("/functions/:id/restore/:revId", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const rev = findRevision("function", id, req.params.revId);
  res.json(updateFunction(id, rev.data, req.user!.id, rev.note));
});
developer.delete("/functions/:id", requirePerm("code.edit"), (req, res) => {
  const id = idParam(req.params.id);
  const f = get("SELECT name FROM functions WHERE id = ?", id) ?? notFound("Function");
  run("DELETE FROM functions WHERE id = ?", id);
  forgetRevisions("function", id);
  logActivity(req.user!.id, "deleted", "function", id, f.name);
  res.json({ ok: true });
});
developer.post("/functions/:id/test", requirePerm("code.edit"), async (req, res) => {
  const id = idParam(req.params.id);
  const f = mapFunction(get("SELECT * FROM functions WHERE id = ?", id) ?? notFound("Function"));
  const code = typeof req.body?.code === "string" ? req.body.code : f.code; // test unsaved code
  const input = req.body?.input ?? {};
  const args =
    f.kind === "endpoint"
      ? { request: { method: input.method ?? "GET", query: input.query ?? {}, body: input.body ?? null, headers: {}, user: { id: req.user!.id, name: req.user!.name, email: req.user!.email } } }
      : f.kind === "hook"
        ? { event: f.event, payload: input.payload ?? {}, data: input.payload ?? {} }
        : { event: "schedule", scheduledAt: now() };
  const outcome = await runFunction({ ...f, code }, args);
  res.json({ ok: outcome.ok, result: outcome.ok ? unwrap(outcome.result) : null, error: outcome.ok ? null : outcome.error, logs: outcome.logs, ms: outcome.ms });
});
developer.get("/functions/:id/logs", requirePerm("code.edit"), (req, res) => {
  res.json(all("SELECT * FROM function_logs WHERE function_id = ? ORDER BY id DESC LIMIT 200", idParam(req.params.id)).map((r) => ({ id: r.id, level: r.level, message: r.message, createdAt: r.created_at })));
});
developer.delete("/functions/:id/logs", requirePerm("code.edit"), (req, res) => {
  run("DELETE FROM function_logs WHERE function_id = ?", idParam(req.params.id));
  res.json({ ok: true });
});

// key-value store browser
developer.get("/kv", requirePerm("code.edit"), (_req, res) => res.json(all("SELECT key, value, updated_at FROM kv ORDER BY key").map((r) => ({ key: r.key, value: json(r.value, null), updatedAt: r.updated_at }))));
developer.delete("/kv/:key", requirePerm("code.edit"), (req, res) => {
  run("DELETE FROM kv WHERE key = ?", String(req.params.key));
  res.json({ ok: true });
});
