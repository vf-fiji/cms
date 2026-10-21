import "./env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { executeCode, runFunction, runHooks, invokeEndpointByRoute, mapFunction, unwrap, runDueSchedules } from "../server/functions";
import { HttpError } from "../server/auth";
import { all, get, now, run } from "../server/db";

function addFunction(f: { name: string; kind: string; route?: string; event?: string; code: string; interval?: number; enabled?: boolean }) {
  const r = run(
    "INSERT INTO functions(name, kind, route, method, event, interval_minutes, code, enabled, is_public, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    f.name,
    f.kind,
    f.route ?? "",
    "ANY",
    f.event ?? "",
    f.interval ?? 60,
    f.code,
    f.enabled === false ? 0 : 1,
    1,
    now(),
  );
  return mapFunction(get("SELECT * FROM functions WHERE id = ?", r.lastId));
}

describe("executeCode", () => {
  it("runs an async default export and captures console output", async () => {
    const out = await executeCode(`export default async ({ request }) => { console.log("hello", { n: 1 }); return { echo: request.query.q }; };`, { request: { query: { q: "hi" } } });
    assert.equal(out.ok, true);
    assert.deepEqual((out as any).result, { echo: "hi" });
    assert.equal(out.logs[0].level, "info");
    assert.match(out.logs[0].message, /hello/);
  });

  it("explains a missing default export", async () => {
    const out = await executeCode("const x = 1;", {});
    assert.equal(out.ok, false);
    assert.match((out as any).error, /export default/);
  });

  it("reports thrown errors without crashing", async () => {
    const out = await executeCode(`export default () => { throw new Error("boom"); };`, {});
    assert.equal(out.ok, false);
    assert.equal((out as any).error, "boom");
    assert.equal(out.logs.at(-1)!.level, "error");
  });

  it("stops a synchronous infinite loop in the handler", async () => {
    const out = await executeCode(`export default () => { for (;;) {} };`, {});
    assert.equal(out.ok, false);
    assert.match((out as any).error, /timed out/i);
  });

  it("stops a top-level infinite loop", async () => {
    const out = await executeCode(`for (;;) {}\nexport default () => 1;`, {});
    assert.equal(out.ok, false);
    assert.match((out as any).error, /timed out/i);
  });

  it("times out handlers that never resolve", async () => {
    const out = await executeCode(`export default () => new Promise(() => {});`, {}, 200);
    assert.equal(out.ok, false);
    assert.match((out as any).error, /Timed out after 0.2s/);
  });

  it("disallows eval and new Function inside functions", async () => {
    const out = await executeCode(`export default () => eval("1 + 1");`, {});
    assert.equal(out.ok, false);
    assert.match((out as any).error, /disallowed|not allowed|Code generation/i);
  });
});

describe("the cms API", () => {
  it("reads, writes and lists the key-value store", async () => {
    const fn = addFunction({
      name: "kv test",
      kind: "endpoint",
      route: "kv-test",
      code: `export default ({ cms }) => { cms.kv.set("a:1", { x: 1 }); cms.kv.set("a:2", 2); return { one: cms.kv.get("a:1"), list: cms.kv.list("a:").length, missing: cms.kv.get("nope") }; };`,
    });
    const out = await runFunction(fn, {});
    assert.deepEqual((out as any).result, { one: { x: 1 }, list: 2, missing: null });
  });

  it("creates and updates content, and runs SQL", async () => {
    run("INSERT INTO content_types(key, name, singular, fields) VALUES('notes', 'Notes', 'Note', '[]')");
    const fn = addFunction({
      name: "content test",
      kind: "endpoint",
      route: "content-test",
      code: `export default ({ cms }) => {
        const a = cms.content.create("notes", { title: "First note", status: "published", data: { n: 1 } });
        const b = cms.content.create("notes", { title: "First note", data: { n: 9 } });
        cms.content.update(a.id, { data: { n: 2 } });
        const [{ c }] = cms.db.query("SELECT COUNT(*) AS c FROM content_items WHERE type_id = (SELECT id FROM content_types WHERE key = ?)", "notes");
        return { slugs: [a.slug, b.slug], n: cms.content.get("notes", "first-note").n, published: cms.content.list("notes").length, all: c };
      };`,
    });
    const out = await runFunction(fn, {});
    assert.equal(out.ok, true, (out as any).error);
    assert.deepEqual((out as any).result, { slugs: ["first-note", "first-note-2"], n: 2, published: 1, all: 2 });
  });

  it("returns custom status codes and headers with cms.respond", async () => {
    const fn = addFunction({ name: "respond", kind: "endpoint", route: "teapot", code: `export default ({ cms }) => cms.respond("short and stout", { status: 418, headers: { "X-VodaForge": "yes" } });` });
    const out = await runFunction(fn, {});
    assert.deepEqual(unwrap((out as any).result), { status: 418, headers: { "X-VodaForge": "yes" }, body: "short and stout" });
  });

  it("invokes endpoints by route and records logs and status", async () => {
    const fn = addFunction({ name: "logger", kind: "endpoint", route: "logger", code: `export default () => { console.warn("careful"); return 7; };` });
    assert.equal(await invokeEndpointByRoute("logger", { method: "GET", query: {}, body: null, headers: {} }), 7);
    const logs = all("SELECT level, message FROM function_logs WHERE function_id = ? ORDER BY id", fn.id);
    assert.deepEqual(logs.map((l) => l.level), ["warn", "success"]);
    assert.equal(get("SELECT last_status FROM functions WHERE id = ?", fn.id).last_status, "ok");
    await assert.rejects(invokeEndpointByRoute("no-such-route", { method: "GET", query: {}, body: null, headers: {} }), (e: any) => e instanceof HttpError && e.status === 404);
  });
});

describe("worker isolation", () => {
  it("stops a busy loop that starts after an await, then keeps serving", async () => {
    const loop = addFunction({ name: "late loop", kind: "endpoint", route: "late-loop", code: `export default async () => { await new Promise((r) => setTimeout(r, 10)); for (;;) {} };` });
    const started = Date.now();
    const out = await runFunction(loop, {}, { timeoutMs: 400 });
    assert.equal(out.ok, false);
    assert.match((out as any).error, /Timed out after 0.4s and was stopped/);
    assert.ok(Date.now() - started < 3000, "the runaway worker was terminated promptly");
    const ok = addFunction({ name: "after", kind: "endpoint", route: "after-loop", code: `export default () => ({ fine: true });` });
    assert.deepEqual(((await runFunction(ok, {})) as any).result, { fine: true });
  });

  it("runs calls in parallel without one blocking another", async () => {
    const slow = addFunction({ name: "slow", kind: "endpoint", route: "slow", code: `export default async () => { await new Promise((r) => setTimeout(r, 300)); return "slow"; };` });
    const fast = addFunction({ name: "fast", kind: "endpoint", route: "fast", code: `export default () => "fast";` });
    const order: string[] = [];
    await Promise.all([runFunction(slow, {}).then(() => order.push("slow")), runFunction(fast, {}).then(() => order.push("fast"))]);
    assert.deepEqual(order, ["fast", "slow"]);
  });

  it("explains results that can't be sent back from the worker", async () => {
    const fn = addFunction({ name: "returns fn", kind: "endpoint", route: "returns-fn", code: `export default () => ({ cb: () => 1 });` });
    const out = await runFunction(fn, {});
    assert.equal(out.ok, false);
    assert.match((out as any).error, /can't be sent back/);
  });
});

describe("hooks", () => {
  it("lets before-hooks transform the payload, in order", async () => {
    addFunction({ name: "upper", kind: "hook", event: "test.beforeA", code: `export default ({ payload }) => ({ ...payload, title: payload.title.toUpperCase() });` });
    addFunction({ name: "suffix", kind: "hook", event: "test.beforeA", code: `export default ({ payload }) => ({ ...payload, title: payload.title + "!" });` });
    addFunction({ name: "disabled", kind: "hook", event: "test.beforeA", enabled: false, code: `export default () => ({ title: "should not run" });` });
    const out = await runHooks("test.beforeA", { title: "hello" });
    assert.deepEqual(out, { title: "HELLO!" });
  });

  it("turns a thrown error in a before-hook into a 422 with the hook's message", async () => {
    addFunction({ name: "reject", kind: "hook", event: "test.beforeB", code: `export default () => { throw new Error("Titles must be polite"); };` });
    await assert.rejects(runHooks("test.beforeB", { title: "rude" }), (e: any) => e instanceof HttpError && e.status === 422 && e.message === "Titles must be polite");
  });

  it("ignores failures in after-hooks so the action still succeeds", async () => {
    addFunction({ name: "after fails", kind: "hook", event: "test.afterC", code: `export default () => { throw new Error("nope"); };` });
    assert.deepEqual(await runHooks("test.afterC", { id: 1 }), { id: 1 });
  });
});

describe("schedules", () => {
  it("runs due schedules once per interval", async () => {
    const fn = addFunction({ name: "tick", kind: "schedule", interval: 60, code: `export default ({ cms }) => { cms.kv.set("ticks", (cms.kv.get("ticks") ?? 0) + 1); };` });
    await runDueSchedules();
    await runDueSchedules();
    assert.equal(JSON.parse(get("SELECT value FROM kv WHERE key = 'ticks'").value), 1);
    run("UPDATE functions SET last_run_at = ? WHERE id = ?", new Date(Date.now() - 61 * 60_000).toISOString(), fn.id);
    await runDueSchedules();
    assert.equal(JSON.parse(get("SELECT value FROM kv WHERE key = 'ticks'").value), 2);
  });
});
