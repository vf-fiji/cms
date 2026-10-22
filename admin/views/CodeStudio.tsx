import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { CodeAsset, CustomWidget, Revision, ServerFunction, Template } from "../../shared/types";
import { api } from "../lib/api";
import { Icon, PICKER_ICONS } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { formatDate, timeAgo } from "../lib/format";
import { CodeEditor, type CodeLang } from "../components/CodeEditor";
import { StudioPreview } from "../components/StudioPreview";
import { Button, confirmDialog, Field, Modal, Switch, toast, useHotkey, useProChrome, press, pressRow } from "../components/ui";

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
      <div className="studio-group">
        <button className="studio-group-toggle" aria-expanded={!collapsed.has(id)} onClick={() => setCollapsed((c) => (c.has(id) ? c.delete(id) : c.add(id), new Set(c)))}>
          <Icon name={collapsed.has(id) ? "ChevronRight" : "ChevronDown"} size={13} />
          <span className="grow">{label}</span>
        </button>
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
      <div key={k} className={`studio-file ${active === k ? "active" : ""}`} {...press(() => openFile(r))} title={name}>
        <span className="ext" style={{ color }}>{label}</span>
        <span className="truncate">{name}</span>
        {extra}
        {isDirty(k) && <span className="dot" style={{ background: "#e2c08d" }} />}
      </div>
    );
  };

  return (
    <div className="studio">
      <nav className="studio-rail" aria-label="Code Studio">
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
      </nav>

      <aside className="studio-side" aria-label="Files">
        {panel === "files" && (
          <>
            <div className="studio-side-head">
              <span>Explorer</span>
              <button title="Refresh" aria-label="Refresh" onClick={() => loadAll()}>
                <Icon name="RotateCcw" size={14} />
              </button>
            </div>
            <div className="studio-tree">
              {group("tpl", "Templates", can("templates.edit") ? () => setCreating("template") : null, templates.map((t) => fileRow({ kind: "template", id: t.id }, t.name, "liquid", t.isDefault ? <span style={{ fontSize: 10, color: "#a8a8a8", marginLeft: 4 }}>default</span> : null)))}
              {can("code.edit") && (
                <>
                  {group("assets", "Site code", () => setCreating("asset"), assets.map((a) => fileRow({ kind: "asset", id: a.id }, a.name, a.kind, !a.enabled ? <span style={{ fontSize: 10, color: "#a8a8a8", marginLeft: 4 }}>off</span> : null)))}
                  {group("widgets", "Widgets", () => setCreating("widget"), widgets.map((w) => fileRow({ kind: "widget", id: w.id }, w.name, w.renderer === "react" ? "react" : "liquid")))}
                  {group("fns", "Server functions", () => setCreating("function"), functions.map((f) => fileRow({ kind: "function", id: f.id }, f.name, f.kind, <span className="dot" style={{ marginLeft: "auto", background: !f.enabled ? "#555" : f.lastStatus === "error" ? "#f48771" : "#89d185" }} title={!f.enabled ? "Disabled" : f.lastStatus ?? "Not run yet"} />)))}
                </>
              )}
            </div>
          </>
        )}
        {panel === "kv" && <KvPanel />}
        {panel === "help" && <HelpPanel />}
      </aside>

      <main className="studio-main">
        <div className="studio-tabs">
          {open.map((r) => {
            const k = refKey(r);
            const f = (buffers[k] ?? originals[k]) as any;
            if (!f) return null;
            return (
              <div key={k} className={`studio-tab ${active === k ? "active" : ""}`} onClick={() => setActive(k)}>
                <button className="studio-tab-label" aria-current={active === k ? "true" : undefined} onClick={(e) => (e.stopPropagation(), setActive(k))}>
                  {f.name}
                </button>
                <button onClick={(e) => (e.stopPropagation(), close(k))} aria-label={isDirty(k) ? `Close ${f.name} (unsaved changes)` : `Close ${f.name}`} title={isDirty(k) ? "Unsaved changes" : "Close"}>
                  {isDirty(k) ? <span className="unsaved" /> : <Icon name="X" size={13} />}
                </button>
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
          <span>{currentRef ? currentRef.kind[0].toUpperCase() + currentRef.kind.slice(1) : "VodaForge"}</span>
          {active && isDirty(active) && <span>● Unsaved</span>}
          <span className="spacer" />
          <span>Ctrl+S save</span>
          <span>UTF-8</span>
        </div>
      </main>

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
  const [history, setHistory] = useState(false);
  // live preview of a page with this file's unsaved changes (widgets, templates and code assets)
  const previewable = kind === "widget" || kind === "template" || kind === "asset";
  const [preview, setPreview] = useState(() => {
    try {
      return localStorage.getItem("reef-studio-preview") === "on";
    } catch {
      return false;
    }
  });
  const togglePreview = () => {
    setPreview(!preview);
    try {
      localStorage.setItem("reef-studio-preview", preview ? "off" : "on");
    } catch {
      /* preferences are optional */
    }
  };
  const showPreview = previewable && preview && !history;
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
  const restore = async (data: Record<string, any>, when: string) => {
    if (dirty && !(await confirmDialog({ title: "Replace your unsaved changes?", message: "The editor will show this older version instead. Your unsaved edits will be lost.", confirmLabel: "Load this version", danger: true }))) return;
    if (kind === "widget") {
      setFieldsText(JSON.stringify(data.fields ?? [], null, 2));
      setFieldsError(null);
    }
    onEdit(data);
    setHistory(false);
    toast.success(`Loaded the version from ${when}. Review it, then save to make it live.`);
  };

  return (
    <>
      <div className="studio-toolbar">
        {tabs.length > 1 && !history && (
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
        {previewable && (
          <Button size="sm" icon={preview ? "EyeOff" : "Eye"} className={preview ? "active" : ""} onClick={togglePreview} aria-pressed={preview} title="Show a page with your unsaved changes, live as you type">
            Preview
          </Button>
        )}
        <Button size="sm" icon="History" className={history ? "active" : ""} onClick={() => setHistory(!history)} aria-pressed={history}>History</Button>
        <Button size="sm" variant="primary" icon="Save" loading={saving} disabled={!dirty || !!fieldsError} onClick={onSave}>Save</Button>
      </div>
      <div className={`studio-editor${showPreview ? " with-preview" : ""}`}>
        {history ? (
          <HistoryPanel kind={kind} file={f} activeField={tab.key} onRestore={restore} onClose={() => setHistory(false)} />
        ) : kind === "function" ? (
          <FunctionWorkbench fn={f} value={value} onChange={onChange} onSave={onSave} onReload={onReload} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
            {fieldsError && tab.key === "fields" && <div style={{ background: "#5a1d1d", color: "#f48771", padding: "6px 12px", fontSize: 12 }}>{fieldsError}</div>}
            <CodeEditor value={value} onChange={onChange} language={tab.lang} height="100%" dark onSave={onSave} className="grow" />
          </div>
        )}
        {showPreview && <StudioPreview kind={kind as "widget" | "template" | "asset"} file={f} />}
        {!history && (
          <aside className="studio-props" aria-label="Settings">
            <Props kind={kind} f={f} onEdit={onEdit} onDelete={onDelete} hookEvents={hookEvents} />
          </aside>
        )}
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
// History: every save is a revision on the server. Pick one to compare it with the editor, then load it back in.
const HISTORY_FIELDS: Record<Kind, [string, string][]> = {
  template: [["html", "HTML (Liquid)"], ["css", "CSS"], ["js", "JavaScript"], ["head", "<head>"]],
  widget: [["template", "Template / component"], ["css", "CSS"], ["js", "JavaScript"], ["fields", "Fields (JSON)"]],
  asset: [["content", "Content"]],
  function: [["code", "index.js"]],
};
const SETTING_LABELS: Record<string, string> = { name: "Name", icon: "Icon", description: "Description", renderer: "Renderer", ssr: "Server-side rendering", location: "Position", enabled: "Enabled", route: "Route", method: "Method", event: "Runs when", intervalMinutes: "Every (minutes)", isPublic: "Public" };
const fieldText = (v: unknown) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));
const settingText = (v: unknown) => (typeof v === "boolean" ? (v ? "On" : "Off") : v === "" || v == null ? "(empty)" : String(v));

function HistoryPanel({ kind, file, activeField, onRestore, onClose }: { kind: Kind; file: any; activeField: string; onRestore: (data: Record<string, any>, when: string) => void; onClose: () => void }) {
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [data, setData] = useState<Record<number, Record<string, any>>>({});
  const [field, setField] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Revision[]>(`/revisions/${kind}/${file.id}`)
      .then((r) => {
        setRevisions(r);
        setSelected((s) => (s && r.some((x) => x.id === s) ? s : r[0]?.id ?? null));
      })
      .catch((e) => (toast.error(e), setRevisions([])));
  }, [kind, file.id, file.updatedAt]);

  useEffect(() => {
    if (selected == null || data[selected]) return;
    api
      .get<{ data: Record<string, any> }>(`/revision/${selected}`)
      .then((r) => setData((d) => ({ ...d, [selected]: r.data })))
      .catch(toast.error);
  }, [selected, data]);

  const rev = revisions?.find((r) => r.id === selected) ?? null;
  const old = selected != null ? data[selected] : undefined;
  const fields = HISTORY_FIELDS[kind].filter(([k]) => fieldText(old?.[k]) || fieldText(file[k]));
  const changed = new Set(fields.filter(([k]) => old && fieldText(old[k]) !== fieldText(file[k])).map(([k]) => k));
  const settings = old ? Object.keys(old).filter((k) => SETTING_LABELS[k] && JSON.stringify(old[k]) !== JSON.stringify(file[k])) : [];
  const shown = field && fields.some(([k]) => k === field) ? field : changed.has(activeField) ? activeField : ([...changed][0] ?? fields[0]?.[0] ?? null);
  const identical = !!old && !changed.size && !settings.length;
  const when = rev ? formatDate(rev.createdAt, true) : "";

  return (
    <div className="studio-history">
      <div className="studio-history-list">
        <div className="studio-side-head">
          <span>History</span>
          <button title="Back to editor" aria-label="Back to editor" onClick={onClose}>
            <Icon name="X" size={14} />
          </button>
        </div>
        {!revisions ? (
          <div className="studio-history-note">Loading…</div>
        ) : !revisions.length ? (
          <div className="studio-history-note">No history yet. Each time you save, the new version is kept here so you can compare it or roll back.</div>
        ) : (
          revisions.map((r, i) => (
            <button key={r.id} className={`studio-revision ${r.id === selected ? "active" : ""}`} onClick={() => setSelected(r.id)} title={new Date(r.createdAt).toLocaleString()}>
              <span className="dot" style={{ background: r.note.startsWith("Restored") ? "#9cdcfe" : i === 0 ? "#89d185" : "#555" }} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="studio-revision-title">
                  {r.note || "Saved"}
                  {i === 0 && <span className="studio-revision-tag">Latest</span>}
                </span>
                <span className="studio-revision-meta truncate">
                  {r.userName ?? "Unknown"} · {timeAgo(r.createdAt)}
                </span>
              </span>
            </button>
          ))
        )}
      </div>

      <div className="studio-history-main">
        {!rev ? (
          <div className="studio-empty">
            <div>
              <h3>Version history</h3>
              <p>Pick a version on the left to compare it with what's in the editor.</p>
            </div>
          </div>
        ) : (
          <>
            <div className="studio-toolbar">
              {fields.length > 1 && (
                <div className="studio-sub-tabs">
                  {fields.map(([k, label]) => (
                    <button key={k} className={shown === k ? "active" : ""} onClick={() => setField(k)}>
                      {label}
                      {changed.has(k) && <span className="studio-changed-dot" title="Changed" />}
                    </button>
                  ))}
                </div>
              )}
              <div className="spacer" />
              <Button size="sm" variant="primary" icon="RotateCcw" disabled={!old || identical} onClick={() => old && onRestore(old, when)}>
                Restore
              </Button>
            </div>
            {!old ? (
              <div className="studio-history-note">Loading…</div>
            ) : (
              <div className="studio-diff-wrap">
                {settings.length > 0 && (
                  <div className="studio-diff-settings">
                    {settings.map((k) => (
                      <div key={k}>
                        <span>{SETTING_LABELS[k]}</span> <del>{settingText(old[k])}</del> → <ins>{settingText(file[k])}</ins>
                      </div>
                    ))}
                  </div>
                )}
                {identical ? (
                  <div className="studio-history-note">This version is the same as what's in the editor.</div>
                ) : (
                  shown && <SideBySideDiff key={`${selected}:${shown}`} before={fieldText(old[shown])} after={fieldText(file[shown])} beforeLabel={`${rev.userName ?? "Unknown"} · ${when}`} afterLabel="Current (in editor)" />
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

type DiffOp = { type: "same" | "del" | "add"; a?: number; b?: number };

/** Line diff (longest common subsequence). Common head and tail are trimmed first, so typical edits stay cheap. */
function diffLines(a: string[], b: string[]): DiffOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) endA--, endB--;
  const ops: DiffOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: "same", a: i, b: i });
  const n = endA - start;
  const m = endB - start;
  if (n * m > 4_000_000) {
    // too big to align line by line: show the middle as replaced
    for (let i = 0; i < n; i++) ops.push({ type: "del", a: start + i });
    for (let j = 0; j < m; j++) ops.push({ type: "add", b: start + j });
  } else {
    const w = m + 1;
    const L = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = a[start + i] === b[start + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[start + i] === b[start + j]) ops.push({ type: "same", a: start + i++, b: start + j++ });
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ type: "del", a: start + i++ });
      else ops.push({ type: "add", b: start + j++ });
    }
    while (i < n) ops.push({ type: "del", a: start + i++ });
    while (j < m) ops.push({ type: "add", b: start + j++ });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: "same", a: endA + k, b: endB + k });
  return ops;
}

type DiffRow = { kind: "same" | "change"; left?: number; right?: number } | { kind: "fold"; from: number; count: number };
const CONTEXT = 3;

function SideBySideDiff({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const a = useMemo(() => before.split("\n"), [before]);
  const b = useMemo(() => after.split("\n"), [after]);
  const rows = useMemo(() => {
    // pair removed lines with added lines so edits sit side by side
    const out: DiffRow[] = [];
    let dels: number[] = [];
    let adds: number[] = [];
    const flush = () => {
      for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push({ kind: "change", left: dels[k], right: adds[k] });
      dels = [];
      adds = [];
    };
    for (const op of diffLines(a, b)) {
      if (op.type === "same") flush(), out.push({ kind: "same", left: op.a, right: op.b });
      else if (op.type === "del") dels.push(op.a!);
      else adds.push(op.b!);
    }
    flush();
    return out;
  }, [a, b]);
  const visible = useMemo(() => {
    const near = rows.map(() => false);
    rows.forEach((r, i) => {
      if (r.kind === "change") for (let k = Math.max(0, i - CONTEXT); k <= Math.min(rows.length - 1, i + CONTEXT); k++) near[k] = true;
    });
    const out: DiffRow[] = [];
    for (let i = 0; i < rows.length; ) {
      if (near[i]) {
        out.push(rows[i++]);
        continue;
      }
      let j = i;
      while (j < rows.length && !near[j]) j++;
      if (j - i > 2 && !expanded.has(i)) out.push({ kind: "fold", from: i, count: j - i });
      else out.push(...rows.slice(i, j));
      i = j;
    }
    return out;
  }, [rows, expanded]);
  const side = (lines: string[], n: number | undefined, kind: "same" | "change", cls: string) =>
    n === undefined ? (
      <>
        <td className="ln blank" />
        <td className="code blank" />
      </>
    ) : (
      <>
        <td className={`ln ${kind === "change" ? cls : ""}`}>{n + 1}</td>
        <td className={`code ${kind === "change" ? cls : ""}`}>{lines[n] || " "}</td>
      </>
    );
  return (
    <table className="studio-diff">
      <colgroup>
        <col style={{ width: 48 }} />
        <col />
        <col style={{ width: 48 }} />
        <col />
      </colgroup>
      <thead>
        <tr>
          <th colSpan={2}>{beforeLabel}</th>
          <th colSpan={2}>{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {visible.map((r, i) =>
          r.kind === "fold" ? (
            <tr key={`f${r.from}`} className="fold" {...pressRow(() => setExpanded((s) => new Set(s).add(r.from)))}>
              <td colSpan={4}>⋯ {r.count} unchanged lines</td>
            </tr>
          ) : (
            <tr key={i}>
              {side(a, r.left, r.kind, "del")}
              {side(b, r.right, r.kind, "add")}
            </tr>
          ),
        )}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------
function FunctionWorkbench({ fn, value, onChange, onSave, onReload }: { fn: ServerFunction; value: string; onChange: (v: string) => void; onSave: () => void; onReload: () => void }) {
  const [consoleTab, setConsoleTab] = useState<"output" | "logs">("output");
  const [collapsed, setCollapsed] = useState(false);
  const [input, setInput] = useState(() =>
    fn.kind === "endpoint" ? JSON.stringify({ method: "GET", query: { name: "VodaForge" }, body: null }, null, 2) : fn.kind === "hook" ? JSON.stringify({ payload: { type: "news", title: "Test", data: { body: "<p>Hello world. Second sentence.</p>" } } }, null, 2) : "{}",
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
                  <div style={{ color: "#a8a8a8", marginBottom: 4 }}>Test input (JSON) — runs your unsaved code</div>
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
        <div style={{ color: "#a8a8a8", fontSize: 12, marginBottom: 10 }}>Data saved by functions with cms.kv.set().</div>
        {!rows?.length && <div style={{ color: "#777" }}>Empty.</div>}
        {rows?.map((r) => (
          <div key={r.key} style={{ marginBottom: 10, borderBottom: "1px solid #2b2b2b", paddingBottom: 8 }}>
            <div className="row">
              <strong className="grow mono truncate" style={{ color: "#9cdcfe", fontSize: 12 }}>{r.key}</strong>
              <button style={{ background: "none", border: 0, color: "#a8a8a8", cursor: "pointer" }} aria-label="Delete key" onClick={() => api.del(`/kv/${encodeURIComponent(r.key)}`).then(load)}><Icon name="Trash2" size={13} /></button>
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

