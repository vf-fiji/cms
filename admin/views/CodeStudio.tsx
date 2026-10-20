import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { CodeAsset, CustomWidget, ServerFunction, Template } from "../../shared/types";
import { api } from "../lib/api";
import { Icon, PICKER_ICONS } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { timeAgo } from "../lib/format";
import { CodeEditor, type CodeLang } from "../components/CodeEditor";
import { Button, confirmDialog, Field, Modal, Switch, toast, useHotkey, useProChrome } from "../components/ui";

type Kind = "template" | "asset" | "widget" | "function";
type AnyFile = Template | CodeAsset | CustomWidget | ServerFunction;
interface OpenRef {
  kind: Kind;
  id: number;
}
const refKey = (r: OpenRef) => `${r.kind}:${r.id}`;

const EXT: Record<string, [string, string]> = {
  css: ["CSS", "#569cd6"],
  js: ["JS", "#dcdcaa"],
  html: ["<>", "#e37933"],
  liquid: ["{}", "#c586c0"],
  react: ["⚛", "#61dafb"],
  endpoint: ["API", "#4ec9b0"],
  hook: ["⚡", "#ce9178"],
  schedule: ["⏱", "#9cdcfe"],
};

export function CodeStudio() {
  useProChrome();
  const nav = useNavigate();
  const { can } = useAuth();
  const [params] = useSearchParams();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [assets, setAssets] = useState<CodeAsset[]>([]);
  const [widgets, setWidgets] = useState<CustomWidget[]>([]);
  const [functions, setFunctions] = useState<ServerFunction[]>([]);
  const [hookEvents, setHookEvents] = useState<{ value: string; label: string }[]>([]);
  const [open, setOpen] = useState<OpenRef[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [buffers, setBuffers] = useState<Record<string, AnyFile>>({});
  const [saving, setSaving] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [panel, setPanel] = useState<"files" | "kv" | "help">("files");
  const [creating, setCreating] = useState<Kind | null>(null);

  const loadAll = useCallback(async () => {
    const [t, a, w, f, m] = await Promise.all([
      api.get<Template[]>("/templates"),
      can("code.edit") ? api.get<CodeAsset[]>("/assets") : Promise.resolve([]),
      can("code.edit") ? api.get<CustomWidget[]>("/widgets") : Promise.resolve([]),
      can("code.edit") ? api.get<ServerFunction[]>("/functions") : Promise.resolve([]),
      api.get<{ hookEvents: { value: string; label: string }[] }>("/functions-meta"),
    ]);
    setTemplates(t);
    setAssets(a);
    setWidgets(w);
    setFunctions(f);
    setHookEvents(m.hookEvents);
    return { t, a, w, f };
  }, [can]);

  const originals = useMemo(() => {
    const map: Record<string, AnyFile> = {};
    templates.forEach((x) => (map[`template:${x.id}`] = x));
    assets.forEach((x) => (map[`asset:${x.id}`] = x));
    widgets.forEach((x) => (map[`widget:${x.id}`] = x));
    functions.forEach((x) => (map[`function:${x.id}`] = x));
    return map;
  }, [templates, assets, widgets, functions]);

  const openFile = useCallback((r: OpenRef) => {
    setOpen((o) => (o.some((x) => refKey(x) === refKey(r)) ? o : [...o, r]));
    setActive(refKey(r));
  }, []);

  useEffect(() => {
    loadAll().then(({ t, w, f }) => {
      const fn = params.get("fn");
      const wid = params.get("widget");
      const tpl = params.get("tpl");
      if (fn && f.some((x) => x.id === Number(fn))) openFile({ kind: "function", id: Number(fn) });
      else if (wid && w.some((x) => x.id === Number(wid))) openFile({ kind: "widget", id: Number(wid) });
      else if (tpl && t.some((x) => x.id === Number(tpl))) openFile({ kind: "template", id: Number(tpl) });
      else if (t[0]) openFile({ kind: "template", id: t[0].id });
    }).catch(toast.error);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = active ? buffers[active] ?? originals[active] : null;
  const currentRef = open.find((o) => refKey(o) === active) ?? null;
  const isDirty = (k: string) => !!buffers[k] && JSON.stringify(buffers[k]) !== JSON.stringify(originals[k]);
  const edit = (patch: Partial<AnyFile>) => {
    if (!active || !current) return;
    setBuffers((b) => ({ ...b, [active]: { ...(b[active] ?? originals[active]), ...patch } as AnyFile }));
  };

  const save = useCallback(async () => {
    if (!active || !currentRef || !isDirty(active)) return;
    setSaving(true);
    const body = buffers[active];
    const url = { template: "/templates", asset: "/assets", widget: "/widgets", function: "/functions" }[currentRef.kind];
    try {
      await api.put(`${url}/${currentRef.id}`, body);
      await loadAll();
      setBuffers((b) => {
        const n = { ...b };
        delete n[active];
        return n;
      });
      toast.success(currentRef.kind === "function" ? "Saved — the function is live" : "Saved — changes are live on the site");
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, currentRef, buffers, loadAll]);
  useHotkey("mod+s", (e) => {
    e.preventDefault();
    save();
  });

  const close = async (k: string) => {
    if (isDirty(k) && !(await confirmDialog({ title: "Close without saving?", message: "Your changes to this file will be lost.", confirmLabel: "Discard changes", danger: true }))) return;
    setBuffers((b) => {
      const n = { ...b };
      delete n[k];
      return n;
    });
    setOpen((o) => {
      const next = o.filter((x) => refKey(x) !== k);
      if (active === k) setActive(next.length ? refKey(next[next.length - 1]) : null);
      return next;
    });
  };

  const create = async (kind: Kind, extra: Record<string, unknown>) => {
    const url = { template: "/templates", asset: "/assets", widget: "/widgets", function: "/functions" }[kind];
    try {
      const f = await api.post<AnyFile>(url, extra);
      await loadAll();
      openFile({ kind, id: f.id });
      setCreating(null);
      toast.success("Created");
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (r: OpenRef) => {
    const f = originals[refKey(r)] as any;
    if (!(await confirmDialog({ title: `Delete ${f.name}?`, message: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    const url = { template: "/templates", asset: "/assets", widget: "/widgets", function: "/functions" }[r.kind];
    try {
      await api.del(`${url}/${r.id}`);
    } catch (e: any) {
      if (e.status === 409 && (await confirmDialog({ title: "It's in use", message: e.message, confirmLabel: "Delete anyway", danger: true }))) await api.del(`${url}/${r.id}?force=1`).catch(toast.error);
      else if (e.status !== 409) return toast.error(e);
      else return;
    }
    await close(refKey(r));
    loadAll();
  };

  const group = (id: string, label: string, onAdd: (() => void) | null, children: React.ReactNode) => (
    <div>
      <div className="studio-group" onClick={() => setCollapsed((c) => (c.has(id) ? c.delete(id) : c.add(id), new Set(c)))}>
        <Icon name={collapsed.has(id) ? "ChevronRight" : "ChevronDown"} size={13} />
        <span className="grow">{label}</span>
        {onAdd && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAdd();
            }}
            style={{ background: "none", border: 0, color: "inherit", cursor: "pointer", padding: 2 }}
            aria-label={`New ${label}`}
            title={`New ${label.toLowerCase()}`}
          >
            <Icon name="Plus" size={14} />
          </button>
        )}
      </div>
      {!collapsed.has(id) && children}
    </div>
  );
  const fileRow = (r: OpenRef, name: string, ext: string, extra?: React.ReactNode) => {
    const k = refKey(r);
    const [label, color] = EXT[ext] ?? ["·", "#999"];
    return (
      <div key={k} className={`studio-file ${active === k ? "active" : ""}`} onClick={() => openFile(r)} title={name}>
        <span className="ext" style={{ color }}>{label}</span>
        <span className="truncate">{name}</span>
        {extra}
        {isDirty(k) && <span className="dot" style={{ background: "#e2c08d" }} />}
      </div>
    );
  };

  return (
    <div className="studio">
      <div className="studio-rail">
        <button title="Back to admin" aria-label="Back to admin" onClick={() => nav("/")}>
          <Icon name="ArrowLeft" size={19} />
        </button>
        <div style={{ height: 8 }} />
        <button className={panel === "files" ? "active" : ""} title="Explorer" aria-label="Explorer" onClick={() => setPanel("files")}>
          <Icon name="Files" size={19} />
        </button>
        <button className={panel === "kv" ? "active" : ""} title="Key-value store" aria-label="Key-value store" onClick={() => setPanel("kv")}>
          <Icon name="Database" size={19} />
        </button>
        <button className={panel === "help" ? "active" : ""} title="Reference" aria-label="Reference" onClick={() => setPanel("help")}>
          <Icon name="BookOpen" size={19} />
        </button>
        <div className="spacer" />
        <button title="View site" aria-label="View site" onClick={() => window.open("/", "_blank")}>
          <Icon name="Globe" size={19} />
        </button>
      </div>

      <div className="studio-side">
        {panel === "files" && (
          <>
            <div className="studio-side-head">
              <span>Explorer</span>
              <button title="Refresh" aria-label="Refresh" onClick={() => loadAll()}>
                <Icon name="RotateCcw" size={14} />
              </button>
            </div>
            <div className="studio-tree">
              {group("tpl", "Templates", can("templates.edit") ? () => setCreating("template") : null, templates.map((t) => fileRow({ kind: "template", id: t.id }, t.name, "liquid", t.isDefault ? <span style={{ fontSize: 10, color: "#888", marginLeft: 4 }}>default</span> : null)))}
              {can("code.edit") && (
                <>
                  {group("assets", "Site code", () => setCreating("asset"), assets.map((a) => fileRow({ kind: "asset", id: a.id }, a.name, a.kind, !a.enabled ? <span style={{ fontSize: 10, color: "#888", marginLeft: 4 }}>off</span> : null)))}
                  {group("widgets", "Widgets", () => setCreating("widget"), widgets.map((w) => fileRow({ kind: "widget", id: w.id }, w.name, w.renderer === "react" ? "react" : "liquid")))}
                  {group("fns", "Server functions", () => setCreating("function"), functions.map((f) => fileRow({ kind: "function", id: f.id }, f.name, f.kind, <span className="dot" style={{ marginLeft: "auto", background: !f.enabled ? "#555" : f.lastStatus === "error" ? "#f48771" : "#89d185" }} title={!f.enabled ? "Disabled" : f.lastStatus ?? "Not run yet"} />)))}
                </>
              )}
            </div>
          </>
        )}
        {panel === "kv" && <KvPanel />}
        {panel === "help" && <HelpPanel />}
      </div>

      <div className="studio-main">
        <div className="studio-tabs">
          {open.map((r) => {
            const k = refKey(r);
            const f = (buffers[k] ?? originals[k]) as any;
            if (!f) return null;
            return (
              <div key={k} className={`studio-tab ${active === k ? "active" : ""}`} onClick={() => setActive(k)}>
                <span>{f.name}</span>
                {isDirty(k) ? (
                  <span className="unsaved" onClick={(e) => (e.stopPropagation(), close(k))} />
                ) : (
                  <button onClick={(e) => (e.stopPropagation(), close(k))} aria-label="Close tab">
                    <Icon name="X" size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        {!current || !currentRef ? (
          <div className="studio-empty">
            <div>
              <h3>Code Studio</h3>
              <p>Pick a file on the left. Everything you save goes live immediately — no build or deploy.</p>
              <p><span className="kbd">Ctrl</span> + <span className="kbd">S</span> to save</p>
            </div>
          </div>
        ) : (
          <FileEditor
            key={active!}
            kind={currentRef.kind}
            file={current}
            dirty={isDirty(active!)}
            saving={saving}
            onEdit={edit}
            onSave={save}
            onDelete={() => remove(currentRef)}
            hookEvents={hookEvents}
            onReload={loadAll}
          />
        )}
        <div className="studio-status">
          <Icon name="CodeXml" size={13} />
          <span>{currentRef ? currentRef.kind[0].toUpperCase() + currentRef.kind.slice(1) : "Reef"}</span>
          {active && isDirty(active) && <span>● Unsaved</span>}
          <span className="spacer" />
          <span>Ctrl+S save</span>
          <span>UTF-8</span>
        </div>
      </div>

      {creating && <CreateDialog kind={creating} hookEvents={hookEvents} onClose={() => setCreating(null)} onCreate={(extra) => create(creating, extra)} />}
    </div>
  );
}

// ---------------------------------------------------------------------
function FileEditor({
  kind,
  file,
  dirty,
  saving,
  onEdit,
  onSave,
  onDelete,
  hookEvents,
  onReload,
}: {
  kind: Kind;
  file: AnyFile;
  dirty: boolean;
  saving: boolean;
  onEdit: (p: any) => void;
  onSave: () => void;
  onDelete: () => void;
  hookEvents: { value: string; label: string }[];
  onReload: () => void;
}) {
  const f = file as any;
  const tabs: { key: string; label: string; lang: CodeLang }[] =
    kind === "template"
      ? [
          { key: "html", label: "HTML (Liquid)", lang: "liquid" },
          { key: "css", label: "CSS", lang: "css" },
          { key: "js", label: "JavaScript", lang: "javascript" },
          { key: "head", label: "<head>", lang: "html" },
        ]
      : kind === "asset"
        ? [{ key: "content", label: f.name, lang: f.kind === "css" ? "css" : f.kind === "js" ? "javascript" : "html" }]
        : kind === "widget"
          ? [
              { key: "template", label: f.renderer === "react" ? "Component (JSX)" : "Template (Liquid)", lang: f.renderer === "react" ? "jsx" : "liquid" },
              { key: "css", label: "CSS", lang: "css" },
              ...(f.renderer === "react" ? [] : [{ key: "js", label: "JavaScript", lang: "javascript" as CodeLang }]),
              { key: "fields", label: "Fields (JSON)", lang: "json" },
            ]
          : [{ key: "code", label: "index.js", lang: "javascript" }];
  const [sub, setSub] = useState(tabs[0].key);
  const tab = tabs.find((t) => t.key === sub) ?? tabs[0];
  const [fieldsText, setFieldsText] = useState(() => (kind === "widget" ? JSON.stringify(f.fields, null, 2) : ""));
  const [fieldsError, setFieldsError] = useState<string | null>(null);
  const value = tab.key === "fields" ? fieldsText : String(f[tab.key] ?? "");
  const onChange = (v: string) => {
    if (tab.key === "fields") {
      setFieldsText(v);
      try {
        const parsed = JSON.parse(v);
        if (!Array.isArray(parsed)) throw new Error("Fields must be a JSON array.");
        setFieldsError(null);
        onEdit({ fields: parsed });
      } catch (e: any) {
        setFieldsError(e.message);
      }
    } else onEdit({ [tab.key]: v });
  };

  return (
    <>
      <div className="studio-toolbar">
        {tabs.length > 1 && (
          <div className="studio-sub-tabs">
            {tabs.map((t) => (
              <button key={t.key} className={sub === t.key ? "active" : ""} onClick={() => setSub(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="spacer" />
        {kind === "template" && <Button size="sm" icon="Globe" onClick={() => window.open("/", "_blank")}>View site</Button>}
        <Button size="sm" variant="primary" icon="Save" loading={saving} disabled={!dirty || !!fieldsError} onClick={onSave}>Save</Button>
      </div>
      <div className="studio-editor">
        {kind === "function" ? (
          <FunctionWorkbench fn={f} value={value} onChange={onChange} onSave={onSave} onReload={onReload} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {fieldsError && tab.key === "fields" && <div style={{ background: "#5a1d1d", color: "#f48771", padding: "6px 12px", fontSize: 12 }}>{fieldsError}</div>}
            <CodeEditor value={value} onChange={onChange} language={tab.lang} height="100%" dark onSave={onSave} className="grow" />
          </div>
        )}
        <aside className="studio-props">
          <Props kind={kind} f={f} onEdit={onEdit} onDelete={onDelete} hookEvents={hookEvents} />
        </aside>
      </div>
    </>
  );
}

function Props({ kind, f, onEdit, onDelete, hookEvents }: { kind: Kind; f: any; onEdit: (p: any) => void; onDelete: () => void; hookEvents: { value: string; label: string }[] }) {
  const [iconOpen, setIconOpen] = useState(false);
  return (
    <>
      <Field label="Name">
        <input className="input" value={f.name} onChange={(e) => onEdit({ name: e.target.value })} />
      </Field>
      {kind === "template" && (
        <>
          <div className="help" style={{ marginBottom: 14 }}>
            Use <code>{"{{ content }}"}</code> where the page goes, <code>{"{% for item in nav %}"}</code> for menus, and <code>{"{{ site.siteName }}"}</code> for settings.
          </div>
          {f.isDefault ? (
            <span className="badge badge-success">Default template</span>
          ) : (
            <Button size="sm" icon="Star" onClick={() => api.post(`/templates/${f.id}/default`).then(() => toast.success("Default template changed"))}>Make default</Button>
          )}
        </>
      )}
      {kind === "asset" && (
        <>
          <Field label="Status">
            <Switch checked={f.enabled} onChange={(v) => onEdit({ enabled: v })} label={f.enabled ? "Loaded on every page" : "Disabled"} />
          </Field>
          <Field label="Position">
            <select className="select" value={f.location} onChange={(e) => onEdit({ location: e.target.value })}>
              <option value="head">In &lt;head&gt;</option>
              <option value="body-end">End of &lt;body&gt;</option>
            </select>
          </Field>
        </>
      )}
      {kind === "widget" && (
        <>
          <Field label="Renderer">
            <select className="select" value={f.renderer} onChange={(e) => onEdit({ renderer: e.target.value })}>
              <option value="liquid">Liquid template (HTML)</option>
              <option value="react">React component (JSX)</option>
            </select>
          </Field>
          {f.renderer === "react" && (
            <Field label="Server-side rendering" help="Render HTML on the server for SEO and fast first paint, then hydrate in the browser. Turn off for components that need window at render time.">
              <Switch checked={f.ssr} onChange={(v) => onEdit({ ssr: v })} label={f.ssr ? "SSR + hydrate" : "Browser only"} />
            </Field>
          )}
          <Field label="Description">
            <input className="input" value={f.description} onChange={(e) => onEdit({ description: e.target.value })} />
          </Field>
          <Field label="Icon">
            <Button size="sm" icon={f.icon} onClick={() => setIconOpen(!iconOpen)}>{f.icon}</Button>
            {iconOpen && (
              <div className="icon-grid" style={{ gridTemplateColumns: "repeat(6, 1fr)", marginTop: 8 }}>
                {PICKER_ICONS.map((ic) => (
                  <button key={ic} className={f.icon === ic ? "active" : ""} style={{ background: "#2d2d30", color: "#ccc" }} onClick={() => (onEdit({ icon: ic }), setIconOpen(false))} aria-label={ic}>
                    <Icon name={ic} size={14} />
                  </button>
                ))}
              </div>
            )}
          </Field>
          <div className="help" style={{ marginBottom: 14 }}>
            {f.renderer === "react" ? (
              <>Your default export receives the widget's fields as props. Import React hooks from <code>"react"</code>; any other npm package loads from esm.sh.</>
            ) : (
              <>Fields are available as <code>{"{{ props.key }}"}</code>. Load content with <code>{"{% assign items = 'news' | content: 3 %}"}</code>.</>
            )}
          </div>
          <div className="help">Key: <code>{f.key}</code> · Appears under “Custom” in the page editor.</div>
        </>
      )}
      {kind === "function" && (
        <>
          <Field label="Status">
            <Switch checked={f.enabled} onChange={(v) => onEdit({ enabled: v })} label={f.enabled ? "Enabled" : "Disabled"} />
          </Field>
          {f.kind === "endpoint" && (
            <>
              <Field label="Route" help={`${location.origin}/api/fn/${f.route}`}>
                <div className="input-group">
                  <span className="input-prefix" style={{ background: "#252526", borderColor: "#3c3c3c" }}>/api/fn/</span>
                  <input className="input mono" value={f.route} onChange={(e) => onEdit({ route: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") })} />
                </div>
              </Field>
              <Field label="Method">
                <select className="select" value={f.method} onChange={(e) => onEdit({ method: e.target.value })}>
                  {["ANY", "GET", "POST", "PUT", "DELETE"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="Access">
                <Switch checked={f.isPublic} onChange={(v) => onEdit({ isPublic: v })} label={f.isPublic ? "Public" : "Signed-in staff only"} />
              </Field>
            </>
          )}
          {f.kind === "hook" && (
            <Field label="Runs when">
              <select className="select" value={f.event} onChange={(e) => onEdit({ event: e.target.value })}>
                {hookEvents.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
              </select>
            </Field>
          )}
          {f.kind === "schedule" && (
            <Field label="Every (minutes)">
              <input className="input" type="number" min={1} value={f.intervalMinutes} onChange={(e) => onEdit({ intervalMinutes: Number(e.target.value) })} />
            </Field>
          )}
          <div className="help">Last run: {f.lastRunAt ? `${timeAgo(f.lastRunAt)} (${f.lastStatus})` : "never"}</div>
        </>
      )}
      <div className="divider" style={{ background: "#333" }} />
      <Button size="sm" icon="Trash2" onClick={onDelete} disabled={kind === "template" && f.isDefault}>Delete</Button>
    </>
  );
}

// ---------------------------------------------------------------------
function FunctionWorkbench({ fn, value, onChange, onSave, onReload }: { fn: ServerFunction; value: string; onChange: (v: string) => void; onSave: () => void; onReload: () => void }) {
  const [consoleTab, setConsoleTab] = useState<"output" | "logs">("output");
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState(() =>
    fn.kind === "endpoint" ? JSON.stringify({ method: "GET", query: { name: "Reef" }, body: null }, null, 2) : fn.kind === "hook" ? JSON.stringify({ payload: { type: "news", title: "Test", data: { body: "<p>Hello world. Second sentence.</p>" } } }, null, 2) : "{}",
  );
  const [result, setResult] = useState<any>(null);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<{ id: number; level: string; message: string; createdAt: string }[]>([]);
  const loadLogs = useCallback(() => api.get<any[]>(`/functions/${fn.id}/logs`).then(setLogs).catch(() => {}), [fn.id]);
  useEffect(() => {
    loadLogs();
  }, [loadLogs]);
  const runTest = async () => {
    let parsed: any = {};
    try {
      parsed = JSON.parse(input || "{}");
    } catch {
      return toast.error("The test input isn't valid JSON.");
    }
    setRunning(true);
    setConsoleTab("output");
    setCollapsed(false);
    try {
      setResult(await api.post(`/functions/${fn.id}/test`, { code: value, input: parsed }));
      loadLogs();
      onReload();
    } catch (e) {
      toast.error(e);
    } finally {
      setRunning(false);
    }
  };
  return (
    <div className={`studio-split ${collapsed ? "collapsed" : ""}`} style={{ flex: 1, minWidth: 0 }}>
      <div style={{ minHeight: 0, display: "flex", flexDirection: "column" }}>
        <CodeEditor value={value} onChange={onChange} language="javascript" height="100%" dark onSave={onSave} className="grow" />
      </div>
      <div className="studio-console">
        <div className="studio-console-head">
          <button className={`tabbtn ${consoleTab === "output" ? "active" : ""}`} onClick={() => setConsoleTab("output")}>Test</button>
          <button className={`tabbtn ${consoleTab === "logs" ? "active" : ""}`} onClick={() => (setConsoleTab("logs"), loadLogs())}>Logs ({logs.length})</button>
          <span className="spacer" />
          {consoleTab === "logs" && <Button size="sm" variant="ghost" onClick={() => api.del(`/functions/${fn.id}/logs`).then(loadLogs)}>Clear</Button>}
          <Button size="sm" variant="primary" icon="Play" loading={running} onClick={runTest}>Run</Button>
          <Button size="sm" variant="ghost" iconOnly icon={collapsed ? "ChevronDown" : "Minus"} onClick={() => setCollapsed(!collapsed)} aria-label="Toggle console" />
        </div>
        {!collapsed && (
          <div className="studio-console-body" style={{ display: consoleTab === "output" ? "grid" : "block", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {consoleTab === "output" ? (
              <>
                <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
                  <div style={{ color: "#888", marginBottom: 4 }}>Test input (JSON) — runs your unsaved code</div>
                  <textarea value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} style={{ flex: 1, minHeight: 120, background: "#1e1e1e", color: "#d4d4d4", border: "1px solid #333", borderRadius: 6, padding: 8, font: "inherit", resize: "none" }} />
                </div>
                <div>
                  {!result ? (
                    <div style={{ color: "#777" }}>Press Run to execute the function with this input.</div>
                  ) : (
                    <>
                      <div style={{ color: result.ok ? "#89d185" : "#f48771", marginBottom: 6 }}>
                        {result.ok ? `✓ Success in ${result.ms} ms${result.result?.status && result.result.status !== 200 ? ` · HTTP ${result.result.status}` : ""}` : `✗ ${result.error}`}
                      </div>
                      {result.logs.map((l: any, i: number) => (
                        <div key={i} className={`log-line log-${l.level}`}>{l.message}</div>
                      ))}
                      {result.ok && <pre style={{ margin: "6px 0 0", color: "#9cdcfe", whiteSpace: "pre-wrap" }}>{JSON.stringify(result.result?.body, null, 2)}</pre>}
                    </>
                  )}
                </div>
              </>
            ) : !logs.length ? (
              <div style={{ color: "#777" }}>No logs yet. console.log output from real runs appears here.</div>
            ) : (
              logs.map((l) => (
                <div key={l.id} className={`log-line log-${l.level}`}>
                  <time>{new Date(l.createdAt).toLocaleTimeString()}</time>
                  <span>{l.message}</span>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------
function CreateDialog({ kind, hookEvents, onClose, onCreate }: { kind: Kind; hookEvents: { value: string; label: string }[]; onClose: () => void; onCreate: (extra: Record<string, unknown>) => void }) {
  const [name, setName] = useState("");
  const [sub, setSub] = useState(kind === "asset" ? "css" : kind === "widget" ? "react" : kind === "function" ? "endpoint" : "");
  const [event, setEvent] = useState(hookEvents[0]?.value ?? "");
  const titles: Record<Kind, string> = { template: "New template", asset: "New site-wide file", widget: "New custom widget", function: "New server function" };
  const options: Record<Kind, [string, string, string, string][]> = {
    template: [],
    asset: [
      ["css", "CSS", "Brush", "Styles loaded on every page"],
      ["js", "JavaScript", "Braces", "Runs on every page"],
      ["html", "HTML snippet", "CodeXml", "Tags injected into every page"],
    ],
    widget: [
      ["react", "React component", "Atom", "JSX with hooks, SSR + hydration"],
      ["liquid", "Liquid template", "LayoutTemplate", "HTML with {{ variables }}"],
    ],
    function: [
      ["endpoint", "API endpoint", "Server", "Responds at /api/fn/your-route"],
      ["hook", "Event hook", "Webhook", "Runs when content or forms change"],
      ["schedule", "Scheduled job", "Clock", "Runs every N minutes"],
    ],
  };
  const submit = () => {
    if (!name.trim()) return toast.error("Give it a name.");
    const extra: Record<string, unknown> = { name };
    if (kind === "asset") Object.assign(extra, { kind: sub, name: /\.\w+$/.test(name) ? name : `${name}.${sub}` });
    if (kind === "widget") extra.renderer = sub;
    if (kind === "function") Object.assign(extra, { kind: sub, event });
    onCreate(extra);
  };
  return (
    <Modal title={titles[kind]} onClose={onClose} footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" onClick={submit}>Create</Button></>}>
      {options[kind].length > 0 && (
        <div className="type-picker" style={{ gridTemplateColumns: `repeat(${options[kind].length}, 1fr)`, marginBottom: 16 }}>
          {options[kind].map(([k, l, ic, d]) => (
            <button key={k} type="button" className="type-option" style={sub === k ? { borderColor: "var(--accent)", boxShadow: "var(--ring)" } : undefined} onClick={() => setSub(k)}>
              <span className="field-type-icon"><Icon name={ic} size={15} /></span>
              <strong>{l}</strong>
              <span>{d}</span>
            </button>
          ))}
        </div>
      )}
      <Field label="Name">
        <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} placeholder={kind === "function" ? "e.g. Weather lookup" : kind === "widget" ? "e.g. Countdown timer" : kind === "asset" ? "e.g. animations" : "e.g. Campaign landing"} />
      </Field>
      {kind === "function" && sub === "hook" && (
        <Field label="Runs when">
          <select className="select" value={event} onChange={(e) => setEvent(e.target.value)}>
            {hookEvents.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
          </select>
        </Field>
      )}
    </Modal>
  );
}

function KvPanel() {
  const [rows, setRows] = useState<{ key: string; value: unknown; updatedAt: string }[] | null>(null);
  const load = () => api.get<any[]>("/kv").then(setRows).catch(() => setRows([]));
  useEffect(() => {
    load();
  }, []);
  return (
    <>
      <div className="studio-side-head">
        <span>Key-value store</span>
        <button title="Refresh" aria-label="Refresh" onClick={load}><Icon name="RotateCcw" size={14} /></button>
      </div>
      <div className="studio-tree" style={{ padding: "0 12px" }}>
        <div style={{ color: "#888", fontSize: 12, marginBottom: 10 }}>Data saved by functions with cms.kv.set().</div>
        {!rows?.length && <div style={{ color: "#777" }}>Empty.</div>}
        {rows?.map((r) => (
          <div key={r.key} style={{ marginBottom: 10, borderBottom: "1px solid #2b2b2b", paddingBottom: 8 }}>
            <div className="row">
              <strong className="grow mono truncate" style={{ color: "#9cdcfe", fontSize: 12 }}>{r.key}</strong>
              <button style={{ background: "none", border: 0, color: "#888", cursor: "pointer" }} aria-label="Delete key" onClick={() => api.del(`/kv/${encodeURIComponent(r.key)}`).then(load)}><Icon name="Trash2" size={13} /></button>
            </div>
            <pre className="mono" style={{ margin: "4px 0 0", fontSize: 11.5, color: "#ce9178", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{JSON.stringify(r.value, null, 1).slice(0, 400)}</pre>
          </div>
        ))}
      </div>
    </>
  );
}

function HelpPanel() {
  const block = (title: string, code: string) => (
    <div style={{ marginBottom: 14 }}>
      <div style={{ color: "#ddd", fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <pre className="mono" style={{ margin: 0, fontSize: 11.5, background: "#1e1e1e", padding: 8, borderRadius: 6, color: "#9cdcfe", whiteSpace: "pre-wrap" }}>{code}</pre>
    </div>
  );
  return (
    <>
      <div className="studio-side-head"><span>Reference</span></div>
      <div className="studio-tree" style={{ padding: "0 12px", fontSize: 12.5 }}>
        {block("Liquid: content", "{% assign news = 'news' | content: 3 %}\n{% for n in news %}\n  <a href=\"{{ n.url }}\">{{ n.title }}</a>\n{% endfor %}")}
        {block("Liquid: call a function", "{% assign data = 'headlines' | fn %}\n{{ data.count }} stories")}
        {block("React widget", "import { useState } from \"react\";\nexport default function W({ title }) {\n  const [n, set] = useState(0);\n  return <button onClick={() => set(n + 1)}>{title} {n}</button>;\n}")}
        {block("Tailwind CSS (v4)", `<div class="grid gap-6 md:grid-cols-3">
  <div class="rounded-3xl bg-primary/10 p-8">…</div>
</div>

// React: className="rounded-full bg-primary px-4"
// Theme & @utility: Settings → Tailwind CSS`)}
        {block("Functions: the cms object", "cms.content.list(type, { limit, tag })\ncms.content.get(type, slug)\ncms.content.create(type, { title, data })\ncms.forms.submissions(formKey)\ncms.kv.get(key) / cms.kv.set(key, value)\ncms.db.query(sql, ...params)\ncms.respond(body, { status, headers })\nfetch(url) · console.log(...)")}
        {block("Headless API", "GET /api/public/content/news?limit=5\nGET /api/public/content/news/:slug\nGET /api/public/pages\nGET /api/public/site")}
      </div>
    </>
  );
}

