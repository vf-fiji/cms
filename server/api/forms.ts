import { Router, type Request } from "express";
import { logError } from "../log";
import { all, get, run, json, now, logActivity, getSettings } from "../db";
import { requirePerm, HttpError } from "../auth";
import { str, key, idParam, notFound, toCsv } from "../http";
import type { FormDef, FormField } from "../../shared/types";
import { runHooks, emit } from "../functions";
import { rateLimit, envLimit } from "../ratelimit";
import { sendMail, getMailTransport } from "../mail";
import { publicBaseUrl } from "./recovery";

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

// Plain addresses only: no display names, quotes, brackets or whitespace, so nothing a
// form manager types can add or change an email header.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;
const MAX_NOTIFY = 10;

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"]. Throws a 400 naming the first bad address. */
export function parseNotifyEmails(v: string): string[] {
  const list = v.split(/[,;]/).map((a) => a.trim()).filter(Boolean);
  for (const a of list) if (!ADDRESS.test(a)) throw new HttpError(400, `“${a.slice(0, 80)}” isn't a valid notification email address. Separate several with commas.`);
  if (list.length > MAX_NOTIFY) throw new HttpError(400, `Use at most ${MAX_NOTIFY} notification email addresses.`);
  return [...new Set(list.map((a) => a.toLowerCase()))];
}

/** Single-line header text: control characters (CR/LF included) become spaces. */
const headerText = (s: string, max = 150) => s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, max);

const valueText = (v: unknown) => {
  const s = Array.isArray(v) ? v.join(", ") : String(v ?? "");
  return s.trim() ? s.replace(/\r\n?/g, "\n").replace(/\n/g, "\n  ") : "(empty)";
};

/** The plain-text email sent to a form's notification addresses. */
export function formNotification(form: FormDef, sub: { id: number | null; data: Record<string, unknown>; pagePath: string }, baseUrl: string | null) {
  const site = getSettings().siteName || "VodaForge";
  const shown = form.fields.filter((f) => f.type !== "heading");
  const known = new Set(shown.map((f) => f.key));
  const rows = [
    ...shown.map((f) => [f.label || f.key, sub.data[f.key]] as const),
    // Keys a form.beforeSubmit hook added
    ...Object.entries(sub.data).filter(([k]) => !known.has(k)),
  ];
  const text = [
    `New response to “${form.name}” on ${site}.`,
    "",
    `Form: ${form.name}`,
    `Page: ${sub.pagePath || "(unknown)"}`,
    `Received: ${new Date().toUTCString()}`,
    "",
    ...rows.map(([label, v]) => `${label}:\n  ${valueText(v)}\n`),
    sub.id === null
      ? "This form doesn't store responses in VodaForge, so this email is the only copy."
      : baseUrl
        ? `See all responses: ${baseUrl}/admin/forms/${form.id}?tab=responses`
        : "See all responses in the VodaForge admin under Forms.",
  ].join("\n");
  return { subject: headerText(`New response: ${form.name}`), text };
}

let warnedNoMail = false;

/** A form's "redirect after submit" must be a web address or a path on this site, never javascript: etc. */
const isSafeRedirect = (u: string) => /^\/(?!\/)/.test(u) || /^https?:\/\//i.test(u);
function safeRedirect(url: string) {
  const u = url.trim();
  if (!u) return "";
  if (isSafeRedirect(u)) return u;
  throw new HttpError(400, "The redirect must be a page on this site (starting with /) or a full https:// address.");
}

/** Fire and forget: email problems are logged and never fail or slow down the submission. */
function notifyByEmail(req: Request, form: FormDef, sub: { id: number | null; data: Record<string, unknown>; pagePath: string }) {
  try {
    let to: string[];
    try {
      to = parseNotifyEmails(form.settings.notifyEmail ?? "");
    } catch (e: any) {
      return logError("forms", new Error(`Not emailing responses to “${form.key}”: ${e.message}`));
    }
    if (!to.length) return;
    if (!getMailTransport().delivers) {
      if (!warnedNoMail) console.warn(`[forms] Form “${form.key}” has a notification email, but email isn't configured (set SMTP_HOST). Responses are not emailed.`);
      warnedNoMail = true;
      return;
    }
    const msg = formNotification(form, sub, publicBaseUrl(req));
    sendMail({ to: to.join(", "), ...msg }).catch((e: any) => logError("forms", new Error(`Couldn't email a response to “${form.key}”: ${e?.message ?? e}`), { recipients: to.length }));
  } catch (e: any) {
    logError("forms", new Error(`Couldn't email a response to “${form.key}”: ${e?.message ?? e}`));
  }
}

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
    redirectUrl: safeRedirect(str(s.redirectUrl, "Redirect", { max: 500 })),
    notifyEmail: parseNotifyEmails(str(s.notifyEmail, "Notification email", { max: 500 })).join(", "),
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
  const pagePath = String(body._page ?? "").slice(0, 300);
  if (form.settings.storeSubmissions) {
    id = run("INSERT INTO form_submissions(form_id, data, page_path, created_at) VALUES(?,?,?,?)", form.id, JSON.stringify(data), pagePath, now()).lastId;
  }
  emit("form.submitted", { form: form.key, id, data, notifyEmail: form.settings.notifyEmail });
  notifyByEmail(req, form, { id, data, pagePath });
  // checked again here for forms saved before redirects were validated
  const redirect = form.settings.redirectUrl && isSafeRedirect(form.settings.redirectUrl.trim()) ? form.settings.redirectUrl.trim() : "";
  if (wantsJson) return res.json({ ok: true, message: form.settings.successMessage, redirect: redirect || null });
  res.redirect(303, redirect || `${localPath(body._page).split("?")[0]}?submitted=1`);
});
