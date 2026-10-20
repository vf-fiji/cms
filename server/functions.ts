// Runtime for developer-authored server functions (endpoints, hooks, schedules).
//
// Code runs in a separate V8 context via node:vm. That keeps globals tidy and
// enforces a CPU timeout, but it is NOT a security boundary: only trusted
// developers (the "code.edit" permission) can author functions.
import vm from "node:vm";
import { logError } from "./log";
import { Worker } from "node:worker_threads";
import { all, get, run, json, now, getSettings, slugify } from "./db";
import { getTypeByKey, listPublishedItems, getPublishedItem, itemForTemplate, mapItem } from "./content";
import type { ServerFunction } from "../shared/types";
import { HttpError } from "./auth";

export function mapFunction(r: any): ServerFunction {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    route: r.route,
    method: r.method,
    event: r.event,
    intervalMinutes: r.interval_minutes,
    code: r.code,
    enabled: !!r.enabled,
    isPublic: !!r.is_public,
    lastRunAt: r.last_run_at,
    lastStatus: r.last_status,
    updatedAt: r.updated_at,
  };
}

export const HOOK_EVENTS = [
  { value: "content.beforeSave", label: "Before content is saved (can change or reject)" },
  { value: "content.afterSave", label: "After content is saved" },
  { value: "content.published", label: "When content is published" },
  { value: "page.published", label: "When a page is published" },
  { value: "form.beforeSubmit", label: "Before a form submission is stored (can reject)" },
  { value: "form.submitted", label: "After a form submission is stored" },
  { value: "media.uploaded", label: "After a file is uploaded" },
];

export interface FnInput {
  method: string;
  query: Record<string, any>;
  body: any;
  headers: Record<string, any>;
  params?: Record<string, any>;
  user?: { id: number; name: string; email: string } | null;
}

interface LogLine {
  level: string;
  message: string;
  at: string;
}

const RESPONSE = Symbol.for("reef.response");

export function buildCmsApi() {
  return Object.freeze({
    content: Object.freeze({
      list: (typeKey: string, opts: any = {}) => {
        if (opts.status === "any") {
          const type = getTypeByKey(typeKey);
          if (!type) return [];
          return all("SELECT * FROM content_items WHERE type_id = ? ORDER BY id DESC LIMIT ?", type.id, Number(opts.limit) || 50).map((r) => itemForTemplate(type, mapItem(r)));
        }
        return listPublishedItems(typeKey, opts).items;
      },
      get: (typeKey: string, slug: string) => getPublishedItem(typeKey, slug) ?? null,
      create: (typeKey: string, item: { title: string; data?: any; status?: string; tags?: string[]; slug?: string }) => {
        const type = getTypeByKey(typeKey);
        if (!type) throw new Error(`Unknown content type '${typeKey}'`);
        const slug = uniqueItemSlug(type.id, item.slug || slugify(item.title));
        const status = item.status === "published" ? "published" : "draft";
        const r = run(
          "INSERT INTO content_items(type_id, title, slug, data, status, tags, published_at, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
          type.id,
          item.title,
          slug,
          JSON.stringify(item.data ?? {}),
          status,
          JSON.stringify(item.tags ?? []),
          status === "published" ? now() : null,
          now(),
          now(),
        );
        return { id: r.lastId, slug };
      },
      update: (id: number, patch: { title?: string; data?: any; status?: string }) => {
        const row = get("SELECT * FROM content_items WHERE id = ?", id);
        if (!row) throw new Error(`Content item ${id} not found`);
        const data = { ...json(row.data, {}), ...(patch.data ?? {}) };
        run("UPDATE content_items SET title = ?, data = ?, status = ?, updated_at = ? WHERE id = ?", patch.title ?? row.title, JSON.stringify(data), patch.status ?? row.status, now(), id);
        return true;
      },
    }),
    forms: Object.freeze({
      submissions: (formKey: string, limit = 50) => {
        const f = get("SELECT id FROM forms WHERE key = ?", formKey);
        if (!f) return [];
        return all("SELECT id, data, created_at FROM form_submissions WHERE form_id = ? ORDER BY id DESC LIMIT ?", f.id, limit).map((r) => ({ id: r.id, createdAt: r.created_at, ...json(r.data, {}) }));
      },
    }),
    kv: Object.freeze({
      get: (key: string) => json(get("SELECT value FROM kv WHERE key = ?", key)?.value, null),
      set: (key: string, value: unknown) => {
        run("INSERT INTO kv(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at", key, JSON.stringify(value), now());
        return true;
      },
      delete: (key: string) => run("DELETE FROM kv WHERE key = ?", key).changes > 0,
      list: (prefix = "") => all("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key", prefix + "%").map((r) => ({ key: r.key, value: json(r.value, null) })),
    }),
    db: Object.freeze({
      query: (sql: string, ...params: any[]) => all(sql, ...params),
      run: (sql: string, ...params: any[]) => run(sql, ...params),
    }),
    pages: Object.freeze({
      list: () => all("SELECT id, title, slug, parent_id AS parentId, published IS NOT NULL AS live FROM pages ORDER BY sort"),
    }),
    settings: () => getSettings(),
    respond: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({ [RESPONSE]: true, body, status: init.status ?? 200, headers: init.headers ?? {} }),
  });
}

function uniqueItemSlug(typeId: number, base: string) {
  let slug = base;
  for (let i = 2; get("SELECT 1 FROM content_items WHERE type_id = ? AND slug = ?", typeId, slug); i++) slug = `${base}-${i}`;
  return slug;
}

function fmt(args: unknown[]) {
  return args.map((a) => (typeof a === "string" ? a : (() => { try { return JSON.stringify(a, null, 2); } catch { return String(a); } })())).join(" ");
}

/**
 * Values created inside the sandbox belong to another realm (their own Object
 * and Array prototypes). Copy them so host code sees ordinary objects.
 */
function toHostRealm(v: unknown): unknown {
  if (v && typeof v === "object" && (v as any)[RESPONSE]) return { ...(v as object), body: toHostRealm((v as any).body), headers: toHostRealm((v as any).headers) };
  try {
    return structuredClone(v);
  } catch {
    return v; // e.g. contains functions; pass through untouched
  }
}

export async function executeCode(code: string, args: Record<string, unknown>, timeoutMs = 10_000) {
  const logs: LogLine[] = [];
  const push = (level: string) => (...a: unknown[]) => logs.push({ level, message: fmt(a).slice(0, 4000), at: now() });
  const consoleShim = { log: push("info"), info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") };
  const exportsObj: { default?: unknown } = {};
  const sandbox: Record<string, unknown> = {
    console: consoleShim,
    __exports: exportsObj,
    module: { exports: exportsObj },
    exports: exportsObj,
    fetch,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    structuredClone,
    crypto: { randomUUID: () => crypto.randomUUID() },
    Response: undefined,
  };
  const context = vm.createContext(sandbox, { name: "reef-function", codeGeneration: { strings: false, wasm: false } });
  const source = code.replace(/export\s+default\s+/, "__exports.default = ");
  const started = performance.now();
  try {
    new vm.Script(source, { filename: "function.js" }).runInContext(context, { timeout: 1000 });
    const entry = (exportsObj as any).default ?? (sandbox.module as any).exports?.default ?? (sandbox.module as any).exports;
    if (typeof entry !== "function") throw new Error("Your code must `export default` a function, e.g. export default async ({ request }) => { … }");
    // Call the handler inside the context too, so its synchronous work is also
    // covered by the CPU timeout. (Work after an `await` is only covered by the
    // wall-clock timeout below, which can't interrupt a busy loop.)
    sandbox.__entry = entry;
    sandbox.__args = args;
    const invocation = new vm.Script("__entry(__args)", { filename: "function.js" }).runInContext(context, { timeout: 1000 });
    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      Promise.resolve(invocation),
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs / 1000}s`)), timeoutMs))),
    ]).finally(() => clearTimeout(timer));
    return { ok: true as const, result: toHostRealm(result), logs, ms: Math.round(performance.now() - started) };
  } catch (err: any) {
    logs.push({ level: "error", message: err?.stack?.split("\n").slice(0, 4).join("\n") ?? String(err), at: now() });
    return { ok: false as const, error: err?.message ?? String(err), logs, ms: Math.round(performance.now() - started) };
  }
}

function persistRun(fnId: number, outcome: { ok: boolean; logs: LogLine[]; ms: number; error?: string }) {
  for (const l of outcome.logs.slice(-50)) run("INSERT INTO function_logs(function_id, level, message, created_at) VALUES(?,?,?,?)", fnId, l.level, l.message, l.at);
  run("INSERT INTO function_logs(function_id, level, message, created_at) VALUES(?,?,?,?)", fnId, outcome.ok ? "success" : "error", outcome.ok ? `Finished in ${outcome.ms} ms` : `Failed after ${outcome.ms} ms: ${outcome.error}`, now());
  run("UPDATE functions SET last_run_at = ?, last_status = ? WHERE id = ?", now(), outcome.ok ? "ok" : "error", fnId);
  run("DELETE FROM function_logs WHERE function_id = ? AND id NOT IN (SELECT id FROM function_logs WHERE function_id = ? ORDER BY id DESC LIMIT 300)", fnId, fnId);
}

// ---------- worker pool ----------
// Each call runs in a worker thread. If it overruns, the worker is terminated:
// that stops any kind of runaway code, including loops after an `await`.
type Outcome = Awaited<ReturnType<typeof executeCode>>;
interface Slot {
  worker: Worker;
  busy: boolean;
}
const POOL_MAX = Math.max(1, Number(process.env.REEF_FN_WORKERS) || 4);
const MEMORY_MB = Math.max(32, Number(process.env.REEF_FN_MEMORY_MB) || 256);
export const FUNCTION_TIMEOUT_MS = Math.max(100, Number(process.env.REEF_FN_TIMEOUT_MS) || 10_000);
const slots: Slot[] = [];
const waiting: ((s: Slot) => void)[] = [];
let jobSeq = 0;

function spawnSlot(): Slot {
  const worker = new Worker(new URL("./function-worker.ts", import.meta.url), {
    execArgv: ["--import", "tsx"],
    resourceLimits: { maxOldGenerationSizeMb: MEMORY_MB },
  });
  worker.unref(); // never keep the process alive just for idle workers
  const slot: Slot = { worker, busy: false };
  worker.on("exit", () => {
    const i = slots.indexOf(slot);
    if (i >= 0) slots.splice(i, 1);
  });
  slots.push(slot);
  return slot;
}

function acquire(): Promise<Slot> {
  const idle = slots.find((s) => !s.busy);
  if (idle) return Promise.resolve(idle);
  if (slots.length < POOL_MAX) return Promise.resolve(spawnSlot());
  return new Promise((resolve) => waiting.push(resolve));
}

function release(slot: Slot) {
  slot.busy = false;
  const next = waiting.shift();
  if (next) next(slots.includes(slot) ? slot : spawnSlot());
}

function discard(slot: Slot) {
  const i = slots.indexOf(slot);
  if (i >= 0) slots.splice(i, 1);
  void slot.worker.terminate();
  const next = waiting.shift();
  if (next) next(spawnSlot());
}

/** Starts one worker ahead of time so the first request isn't slowed by start-up. */
export function warmFunctionWorkers() {
  if (!slots.length) spawnSlot();
}

export async function runInWorker(code: string, args: Record<string, unknown>, timeoutMs = FUNCTION_TIMEOUT_MS): Promise<Outcome> {
  const slot = await acquire();
  slot.busy = true;
  const started = performance.now();
  const id = ++jobSeq;
  return new Promise<Outcome>((resolve) => {
    const finish = (outcome: Outcome, healthy: boolean) => {
      clearTimeout(timer);
      slot.worker.off("message", onMessage);
      slot.worker.off("error", onError);
      if (healthy) release(slot);
      else discard(slot);
      resolve(outcome);
    };
    const fail = (error: string): Outcome => ({ ok: false, error, logs: [{ level: "error", message: error, at: now() }], ms: Math.round(performance.now() - started) });
    // a little longer than the in-worker limit, so ordinary timeouts report from inside with their logs
    const timer = setTimeout(() => finish(fail(`Timed out after ${timeoutMs / 1000}s and was stopped`), false), timeoutMs + 500);
    const onMessage = (m: { id: number; outcome: Outcome }) => m.id === id && finish(m.outcome, true);
    const onError = (err: any) =>
      finish(fail(err?.code === "ERR_WORKER_OUT_OF_MEMORY" ? `Ran out of memory (limit ${MEMORY_MB} MB) and was stopped` : `The function crashed: ${err?.message ?? err}`), false);
    slot.worker.on("message", onMessage);
    slot.worker.once("error", onError);
    try {
      slot.worker.postMessage({ id, code, args, timeoutMs });
    } catch (e: any) {
      finish(fail(`The function's input couldn't be passed to it: ${e?.message ?? e}`), true);
    }
  });
}

export async function runFunction(fn: ServerFunction, input: Record<string, unknown>, opts: { timeoutMs?: number } = {}) {
  const outcome = await runInWorker(fn.code, input, opts.timeoutMs);
  persistRun(fn.id, outcome);
  return outcome;
}

export async function invokeEndpointByRoute(route: string, req: FnInput) {
  const row = get("SELECT * FROM functions WHERE kind = 'endpoint' AND route = ? AND enabled = 1", route.replace(/^\/+/, ""));
  if (!row) throw new HttpError(404, `No function is listening on /api/fn/${route}`);
  const fn = mapFunction(row);
  const outcome = await runFunction(fn, { request: req });
  if (!outcome.ok) throw new HttpError(500, outcome.error);
  return unwrap(outcome.result).body;
}

/**
 * cms.respond() marks its result with a Symbol, which doesn't survive being
 * posted between threads. Workers send this plain form instead.
 */
export function toTransferable(result: any) {
  if (result && typeof result === "object" && result[RESPONSE]) return { __reefResponse: true, status: result.status, headers: result.headers, body: result.body };
  return result;
}

export function unwrap(result: any): { status: number; headers: Record<string, string>; body: unknown } {
  if (result && typeof result === "object" && (result[RESPONSE] || result.__reefResponse === true)) return { status: result.status, headers: result.headers, body: result.body };
  return { status: 200, headers: {}, body: result === undefined ? null : result };
}

/**
 * Runs every enabled hook for an event in order. "before" hooks may return a
 * replacement payload, or throw to cancel the action (the message is shown to
 * the editor or site visitor).
 */
export async function runHooks<T>(event: string, payload: T): Promise<T> {
  const hooks = all("SELECT * FROM functions WHERE kind = 'hook' AND event = ? AND enabled = 1 ORDER BY id", event).map(mapFunction);
  let current = payload;
  for (const h of hooks) {
    const outcome = await runFunction(h, { event, payload: current, data: current });
    if (!outcome.ok) {
      if (event.includes("before")) throw new HttpError(422, outcome.error);
      continue;
    }
    if (event.includes("before") && outcome.result && typeof outcome.result === "object") current = outcome.result as T;
  }
  return current;
}

/** Fire-and-forget variant for "after" events. */
export function emit(event: string, payload: unknown) {
  runHooks(event, payload).catch((e) => logError("hooks", e, { event }, "warn"));
}

export async function runDueSchedules() {
  const due = all("SELECT * FROM functions WHERE kind = 'schedule' AND enabled = 1").map(mapFunction);
  for (const fn of due) {
    const last = fn.lastRunAt ? new Date(fn.lastRunAt).getTime() : 0;
    if (Date.now() - last >= Math.max(1, fn.intervalMinutes) * 60_000) {
      await runFunction(fn, { event: "schedule", scheduledAt: now() });
    }
  }
}
