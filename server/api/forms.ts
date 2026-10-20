import { Router } from "express";
import { all, get, run, json, now, logActivity } from "../db";
import { requirePerm, HttpError } from "../auth";
import { str, key, idParam, notFound, toCsv } from "../http";
import type { FormDef, FormField } from "../../shared/types";
import { runHooks, emit } from "../functions";
import { rateLimit, envLimit } from "../ratelimit";

export const forms = Router();

export function mapForm(r: any): FormDef {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    fields: json(r.fields, []),
    settings: { submitLabel: "Send", successMessage: "Thanks! We received your message.", storeSubmissions: true, ...json(r.settings, {}) },
    submissionCount: r.submission_count,
    updatedAt: r.updated_at,
  };
}

const FORM_SELECT = "SELECT f.*, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id) submission_count, (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = f.id AND s.is_read = 0) unread FROM forms f";

forms.get("/forms", (_req, res) => res.json(all(`${FORM_SELECT} ORDER BY f.name`).map((r) => ({ ...mapForm(r), unread: r.unread }))));
forms.get("/forms/:id", (req, res) => res.json(mapForm(get(`${FORM_SELECT} WHERE f.id = ?`, idParam(req.params.id)) ?? notFound("Form"))));

function cleanFields(list: unknown): FormField[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.map((f: any, i) => {
    const k = key(f?.key, `Field ${i + 1} key`, true);
    if (seen.has(k)) throw new HttpError(400, `Two fields use the key “${k}”.`);
    seen.add(k);
    return {
      id: String(f.id || k),
      key: k,
      label: str(f.label, "Label", { required: true, max: 200 }),
      type: f.type,
      required: !!f.required,
      placeholder: str(f.placeholder, "Placeholder", { max: 120 }),
      help: str(f.help, "Help", { max: 300 }),
      options: Array.isArray(f.options) ? f.options.map(String).filter(Boolean) : [],
      width: f.width === "half" ? "half" : "full",
      defaultValue: str(f.defaultValue, "Default", { max: 300 }),
    };
  });
}

forms.post("/forms", requirePerm("forms.manage"), (req, res) => {
  const name = str(req.body?.name, "Form name", { required: true, max: 120 });
  const k = key(req.body?.key || name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), "Form key");
  if (get("SELECT 1 FROM forms WHERE key = ?", k)) throw new HttpError(409, `A form with key “${k}” already exists.`);
  const fields = req.body?.fields
    ? cleanFields(req.body.fields)
    : [
        { id: "name", key: "name", label: "Name", type: "text", required: true, width: "half" },
        { id: "email", key: "email", label: "Email", type: "email", required: true, width: "half" },
        { id: "message", key: "message", label: "Message", type: "textarea", required: true, width: "full" },
      ];
  const r = run("INSERT INTO forms(key, name, fields, settings, updated_at) VALUES(?,?,?,?,?)", k, name, JSON.stringify(fields), JSON.stringify({ submitLabel: "Send", successMessage: "Thanks! We received your message.", storeSubmissions: true }), now());
  logActivity(req.user!.id, "created", "form", r.lastId, name);
  res.json(mapForm(get(`${FORM_SELECT} WHERE f.id = ?`, r.lastId)));
});

forms.put("/forms/:id", requirePerm("forms.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const f = get("SELECT * FROM forms WHERE id = ?", id) ?? notFound("Form");
  const s = req.body?.settings ?? json(f.settings, {});
  const settings = {
    submitLabel: str(s.submitLabel, "Button label", { max: 60 }) || "Send",
    successMessage: str(s.successMessage, "Success message", { max: 500 }) || "Thanks!",
    redirectUrl: str(s.redirectUrl, "Redirect", { max: 500 }),
    notifyEmail: str(s.notifyEmail, "Notify email", { max: 200 }),
    storeSubmissions: s.storeSubmissions !== false,
  };
  run("UPDATE forms SET name = ?, fields = ?, settings = ?, updated_at = ? WHERE id = ?", str(req.body?.name ?? f.name, "Form name", { required: true, max: 120 }), JSON.stringify(req.body?.fields ? cleanFields(req.body.fields) : json(f.fields, [])), JSON.stringify(settings), now(), id);
  logActivity(req.user!.id, "edited", "form", id, f.name);
  res.json(mapForm(get(`${FORM_SELECT} WHERE f.id = ?`, id)));
});

forms.delete("/forms/:id", requirePerm("forms.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const f = get("SELECT name FROM forms WHERE id = ?", id) ?? notFound("Form");
  run("DELETE FROM forms WHERE id = ?", id);
  logActivity(req.user!.id, "deleted", "form", id, f.name);
  res.json({ ok: true });
});

forms.get("/forms/:id/submissions", requirePerm("forms.submissions"), (req, res) => {
  const id = idParam(req.params.id);
  const q = String(req.query.q ?? "").trim();
  const rows = all(
    `SELECT * FROM form_submissions WHERE form_id = ? ${q ? "AND data LIKE ?" : ""} ORDER BY id DESC LIMIT 1000`,
    ...(q ? [id, `%${q}%`] : [id]),
  );
  res.json(rows.map((r) => ({ id: r.id, data: json(r.data, {}), pagePath: r.page_path, isRead: !!r.is_read, createdAt: r.created_at })));
});

forms.put("/submissions/:id/read", requirePerm("forms.submissions"), (req, res) => {
  run("UPDATE form_submissions SET is_read = ? WHERE id = ?", req.body?.read === false ? 0 : 1, idParam(req.params.id));
  res.json({ ok: true });
});

forms.delete("/submissions/:id", requirePerm("forms.submissions"), (req, res) => {
  run("DELETE FROM form_submissions WHERE id = ?", idParam(req.params.id));
  res.json({ ok: true });
});

forms.get("/forms/:id/export.csv", requirePerm("forms.submissions"), (req, res) => {
  const form = mapForm(get("SELECT * FROM forms WHERE id = ?", idParam(req.params.id)) ?? notFound("Form"));
  const rows = all("SELECT * FROM form_submissions WHERE form_id = ? ORDER BY id", form.id).map((r) => ({ submitted: r.created_at, page: r.page_path, ...json(r.data, {}) }));
  const cols = ["submitted", "page", ...form.fields.filter((f) => f.type !== "heading").map((f) => f.key)];
  res.setHeader("Content-Disposition", `attachment; filename="${form.key}-responses.csv"`);
  res.type("text/csv").send(toCsv(rows, cols));
});

/** Public submission endpoint (mounted without auth). */
const localPath = (v: unknown) => {
  const s = String(v ?? "/");
  return s.startsWith("/") && !s.startsWith("//") && !s.startsWith("/\\") ? s : "/";
};

export const publicForms = Router();
const submitLimit = rateLimit({
  max: envLimit("REEF_RATE_LIMIT_FORMS", 10),
  windowMs: 60_000,
  message: "You've sent a lot of messages in a short time. Please wait a minute and try again.",
  onLimited: (req, res, _retryAfter, message) => {
    if ((req.headers.accept ?? "").includes("application/json")) return res.status(429).json({ error: message });
    res.status(429).type("html").send(`<p>${message}</p><p><a href="javascript:history.back()">Go back</a></p>`);
  },
});
publicForms.post("/public/forms/:key/submit", submitLimit, async (req, res) => {
  const r = get("SELECT * FROM forms WHERE key = ?", String(req.params.key)) ?? notFound("Form");
  const form = mapForm(r);
  const body = req.body ?? {};
  const wantsJson = (req.headers.accept ?? "").includes("application/json");
  if (body._hp) return wantsJson ? res.json({ ok: true }) : res.redirect(303, localPath(body._page)); // honeypot
  const errors: Record<string, string> = {};
  let data: Record<string, unknown> = {};
  for (const f of form.fields) {
    if (f.type === "heading") continue;
    let v = body[f.key];
    if (Array.isArray(v)) v = v.map((x) => String(x).slice(0, 500));
    else v = v === undefined ? "" : String(v).slice(0, 5000).trim();
    if (f.required && (!v || (Array.isArray(v) && !v.length))) errors[f.key] = `${f.label} is required.`;
    else if (v && f.type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) errors[f.key] = "Enter a valid email address.";
    else if (v && f.type === "number" && Number.isNaN(Number(v))) errors[f.key] = `${f.label} must be a number.`;
    data[f.key] = v;
  }
  if (Object.keys(errors).length) {
    if (wantsJson) return res.status(400).json({ error: "Please check the highlighted fields.", fields: errors });
    return res.status(400).send(`<p>${Object.values(errors).join("<br>")}</p><p><a href="javascript:history.back()">Go back</a></p>`);
  }
  try {
    const out = await runHooks("form.beforeSubmit", { form: form.key, data });
    data = out.data ?? data;
  } catch (e: any) {
    if (wantsJson) return res.status(422).json({ error: e.message });
    throw e;
  }
  let id: number | null = null;
  if (form.settings.storeSubmissions) {
    id = run("INSERT INTO form_submissions(form_id, data, page_path, created_at) VALUES(?,?,?,?)", form.id, JSON.stringify(data), String(body._page ?? "").slice(0, 300), now()).lastId;
  }
  emit("form.submitted", { form: form.key, id, data, notifyEmail: form.settings.notifyEmail });
  if (wantsJson) return res.json({ ok: true, message: form.settings.successMessage, redirect: form.settings.redirectUrl || null });
  res.redirect(303, form.settings.redirectUrl || `${localPath(body._page).split("?")[0]}?submitted=1`);
});
