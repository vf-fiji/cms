import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { FormDef, FormField } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth, bus } from "../lib/auth";
import { keyify, timeAgo, formatDate } from "../lib/format";
import { Button, confirmDialog, Drawer, Empty, ErrorState, Field, Menu, promptDialog, SkeletonRows, Spinner, Switch, toast, useLoad } from "../components/ui";

const FORM_FIELD_TYPES: { type: FormField["type"]; label: string; icon: string }[] = [
  { type: "text", label: "Short answer", icon: "Type" },
  { type: "email", label: "Email", icon: "Mail" },
  { type: "phone", label: "Phone", icon: "Phone" },
  { type: "textarea", label: "Paragraph", icon: "Pilcrow" },
  { type: "number", label: "Number", icon: "Hash" },
  { type: "select", label: "Dropdown", icon: "ChevronDown" },
  { type: "radio", label: "Multiple choice", icon: "ToggleLeft" },
  { type: "checkbox", label: "Checkboxes", icon: "Check" },
  { type: "date", label: "Date", icon: "Calendar" },
  { type: "consent", label: "Consent", icon: "ShieldCheck" },
  { type: "hidden", label: "Hidden value", icon: "EyeOff" },
  { type: "heading", label: "Section heading", icon: "Heading" },
];
const ft = (t: string) => FORM_FIELD_TYPES.find((x) => x.type === t) ?? FORM_FIELD_TYPES[0];

export function Forms() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<(FormDef & { unread: number })[]>("/forms"));
  const create = async () => {
    const name = await promptDialog({ title: "New form", label: "Form name", placeholder: "e.g. Volunteer sign-up", confirmLabel: "Create form" });
    if (!name) return;
    try {
      const f = await api.post<FormDef>("/forms", { name });
      bus.emit("forms-changed");
      nav(`/forms/${f.id}`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Forms</h1>
          <div className="page-sub">Build forms visually, add them to any page with the Form widget, and collect responses here.</div>
        </div>
        {can("forms.manage") && <Button variant="primary" icon="Plus" onClick={create}>New form</Button>}
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows />
        ) : !data.length ? (
          <Empty icon="ClipboardList" title="No forms yet" action={can("forms.manage") ? <Button variant="primary" icon="Plus" onClick={create}>Create a form</Button> : undefined}>
            Contact forms, sign-ups, surveys — responses are stored safely and can be exported.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Form</th>
                <th>Fields</th>
                <th>Responses</th>
                <th>Updated</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr key={f.id} className="clickable" onClick={() => nav(`/forms/${f.id}`)}>
                  <td>
                    <div className="row" style={{ gap: 12 }}>
                      <span className="list-icon" style={{ background: "var(--accent-soft)", color: "var(--accent-text)" }}><Icon name="ClipboardList" size={15} /></span>
                      <div>
                        <div className="cell-title">{f.name}</div>
                        <div className="subtle mono" style={{ fontSize: 12 }}>{f.key}</div>
                      </div>
                    </div>
                  </td>
                  <td className="muted">{f.fields.length}</td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <strong>{f.submissionCount}</strong>
                      {f.unread > 0 && <span className="badge badge-accent">{f.unread} new</span>}
                    </span>
                  </td>
                  <td className="subtle">{timeAgo(f.updatedAt)}</td>
                  <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                    <Button size="sm" icon="Inbox" onClick={() => nav(`/forms/${f.id}?tab=responses`)}>Responses</Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function FormBuilder() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? (can("forms.manage") ? "build" : "responses");
  const setTab = (t: string) => setParams({ tab: t }, { replace: true });
  const [form, setForm] = useState<FormDef | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<FormDef>(`/forms/${id}`).then(setForm).catch((e) => setError(e.message));
  }, [id]);
  if (error) return <div className="page"><ErrorState message={error} /></div>;
  if (!form) return <Spinner />;
  const set = (p: Partial<FormDef>) => {
    setForm({ ...form, ...p });
    setDirty(true);
  };
  const setField = (i: number, p: Partial<FormField>) => set({ fields: form.fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const add = (type: FormField["type"]) => {
    const label = ft(type).label;
    let key = keyify(label);
    for (let n = 2; form.fields.some((f) => f.key === key); n++) key = `${keyify(label)}${n}`;
    const f: FormField = { id: key, key, label, type, required: false, width: "full", ...(["select", "radio", "checkbox"].includes(type) ? { options: ["Option 1", "Option 2"] } : {}) };
    set({ fields: [...form.fields, f] });
    setSelected(form.fields.length);
  };
  const save = async () => {
    setBusy(true);
    try {
      setForm(await api.put<FormDef>(`/forms/${form.id}`, form));
      setDirty(false);
      toast.success("Form saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete “${form.name}”?`, message: "The form and all of its responses will be deleted.", confirmLabel: "Delete form", danger: true }))) return;
    await api.del(`/forms/${form.id}`).catch(toast.error);
    bus.emit("forms-changed");
    nav("/forms");
  };
  const sel = selected !== null ? form.fields[selected] : null;
  return (
    <div className="page page-wide" style={{ maxWidth: 1400 }}>
      <div className="page-header">
        <div>
          <div className="crumbs">
            <a style={{ cursor: "pointer" }} onClick={() => nav("/forms")}>Forms</a>
            <Icon name="ChevronRight" size={13} />
            <span>{form.name}</span>
          </div>
          <h1 className="page-title">{form.name}</h1>
        </div>
        <div className="row">
          {can("forms.manage") && (
            <Menu trigger={(o) => <Button iconOnly icon="MoreHorizontal" onClick={o} aria-label="More" />} items={[{ label: "Delete form", icon: "Trash2", danger: true, onClick: remove }]} />
          )}
          {can("forms.manage") && tab !== "responses" && (
            <Button variant="primary" icon="Save" loading={busy} disabled={!dirty} onClick={save}>Save form</Button>
          )}
        </div>
      </div>
      <div className="underline-tabs" style={{ marginBottom: 20 }}>
        {can("forms.manage") && <button className={`underline-tab ${tab === "build" ? "active" : ""}`} onClick={() => setTab("build")}><Icon name="SquarePen" size={14} /> Build</button>}
        {can("forms.submissions") && <button className={`underline-tab ${tab === "responses" ? "active" : ""}`} onClick={() => setTab("responses")}><Icon name="Inbox" size={14} /> Responses <span className="badge no-dot">{form.submissionCount}</span></button>}
        {can("forms.manage") && <button className={`underline-tab ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")}><Icon name="Settings" size={14} /> Settings</button>}
      </div>

      {tab === "build" && (
        <div className="builder" style={{ gridTemplateColumns: "220px 1fr 320px" }}>
          <div className="card card-pad" style={{ position: "sticky", top: 20 }}>
            <div className="section-title">Add a field</div>
            <div className="col" style={{ gap: 4 }}>
              {FORM_FIELD_TYPES.map((t) => (
                <button key={t.type} className="nav-item" onClick={() => add(t.type)} style={{ height: 32 }}>
                  <Icon name={t.icon} size={15} /> {t.label}
                </button>
              ))}
            </div>
          </div>
          <div className="form-preview">
            <div className="subtle" style={{ fontSize: 12, marginBottom: 12, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 650 }}>Preview — click a field to edit, drag to reorder</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {form.fields.map((f, i) => (
                <div
                  key={f.id + i}
                  className={`field-row ${selected === i ? "active" : ""}`}
                  style={{ gridColumn: f.width === "half" ? "span 1" : "1 / -1", flexDirection: "column", alignItems: "stretch", gap: 6, opacity: dragIdx === i ? 0.4 : 1 }}
                  onClick={() => setSelected(i)}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx === null || dragIdx === i) return;
                    const next = [...form.fields];
                    const [m] = next.splice(dragIdx, 1);
                    next.splice(i, 0, m);
                    set({ fields: next });
                    setSelected(i);
                    setDragIdx(null);
                  }}
                >
                  <div className="row">
                    <Icon name="GripVertical" size={14} className="subtle" />
                    <strong className="grow" style={{ fontSize: 13 }}>{f.label}{f.required && <span style={{ color: "var(--danger)" }}> *</span>}</strong>
                    <span className="subtle" style={{ fontSize: 11.5 }}>{ft(f.type).label}</span>
                  </div>
                  <FieldPreview f={f} />
                </div>
              ))}
            </div>
            {!form.fields.length && <div className="subtle" style={{ textAlign: "center", padding: 30 }}>Add fields from the left.</div>}
            <button className="btn btn-primary" style={{ marginTop: 16 }} disabled>{form.settings.submitLabel || "Send"}</button>
          </div>
          <div className="card card-pad" style={{ position: "sticky", top: 20 }}>
            {!sel ? (
              <div className="subtle" style={{ fontSize: 13 }}>Select a field in the preview to edit it.</div>
            ) : (
              <>
                <Field label="Label">
                  <input className="input" value={sel.label} onChange={(e) => setField(selected!, { label: e.target.value })} />
                </Field>
                <Field label="Key" help="Column name in exports and the API.">
                  <input className="input mono" value={sel.key} onChange={(e) => setField(selected!, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} />
                </Field>
                {!["heading", "hidden", "consent"].includes(sel.type) && (
                  <Field label="Placeholder">
                    <input className="input" value={sel.placeholder ?? ""} onChange={(e) => setField(selected!, { placeholder: e.target.value })} />
                  </Field>
                )}
                {sel.type === "hidden" && (
                  <Field label="Value">
                    <input className="input" value={sel.defaultValue ?? ""} onChange={(e) => setField(selected!, { defaultValue: e.target.value })} />
                  </Field>
                )}
                {["select", "radio", "checkbox"].includes(sel.type) && (
                  <Field label="Options" help="One per line.">
                    <textarea className="textarea" rows={5} value={(sel.options ?? []).join("\n")} onChange={(e) => setField(selected!, { options: e.target.value.split("\n") })} />
                  </Field>
                )}
                <Field label="Help text">
                  <input className="input" value={sel.help ?? ""} onChange={(e) => setField(selected!, { help: e.target.value })} />
                </Field>
                <Field label="Width">
                  <div className="tabs">
                    <button className={`tab ${sel.width !== "half" ? "active" : ""}`} onClick={() => setField(selected!, { width: "full" })}>Full</button>
                    <button className={`tab ${sel.width === "half" ? "active" : ""}`} onClick={() => setField(selected!, { width: "half" })}>Half</button>
                  </div>
                </Field>
                {sel.type !== "heading" && sel.type !== "hidden" && <Switch checked={!!sel.required} onChange={(v) => setField(selected!, { required: v })} label="Required" />}
                <div className="divider" />
                <Button variant="danger" size="sm" icon="Trash2" onClick={() => (set({ fields: form.fields.filter((_, j) => j !== selected) }), setSelected(null))}>Remove field</Button>
              </>
            )}
          </div>
        </div>
      )}

      {tab === "settings" && (
        <div className="card card-pad" style={{ maxWidth: 680 }}>
          <Field label="Form name">
            <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="Submit button label">
            <input className="input" value={form.settings.submitLabel} onChange={(e) => set({ settings: { ...form.settings, submitLabel: e.target.value } })} />
          </Field>
          <Field label="Success message" help="Shown after someone submits the form.">
            <textarea className="textarea" rows={2} value={form.settings.successMessage} onChange={(e) => set({ settings: { ...form.settings, successMessage: e.target.value } })} />
          </Field>
          <Field label="Redirect after submit" help="Optional. Send people to a thank-you page instead.">
            <input className="input" placeholder="/thank-you" value={form.settings.redirectUrl ?? ""} onChange={(e) => set({ settings: { ...form.settings, redirectUrl: e.target.value } })} />
          </Field>
          <Field label="Notification email" help="Each response is emailed here as it arrives. Separate several addresses with commas. Needs SMTP set up on the server.">
            <input className="input" type="text" inputMode="email" autoComplete="off" placeholder="team@example.com, sales@example.com" value={form.settings.notifyEmail ?? ""} onChange={(e) => set({ settings: { ...form.settings, notifyEmail: e.target.value } })} />
          </Field>
          <Switch checked={form.settings.storeSubmissions} onChange={(v) => set({ settings: { ...form.settings, storeSubmissions: v } })} label="Store responses in Reef" />
          <div className="divider" />
          <div className="section-title">Use this form</div>
          <div className="muted" style={{ fontSize: 13 }}>
            Add a <strong>Form</strong> widget to any page and choose “{form.name}”. Developers can also post JSON to <code className="mono">/api/public/forms/{form.key}/submit</code>.
          </div>
        </div>
      )}

      {tab === "responses" && <Responses form={form} />}
    </div>
  );
}

function FieldPreview({ f }: { f: FormField }) {
  const style = { pointerEvents: "none" as const };
  switch (f.type) {
    case "heading":
      return null;
    case "hidden":
      return <span className="subtle" style={{ fontSize: 12 }}>Hidden: {f.defaultValue || "(empty)"}</span>;
    case "textarea":
      return <textarea className="textarea" rows={2} placeholder={f.placeholder} style={style} readOnly />;
    case "select":
      return <select className="select" style={style}><option>Select…</option></select>;
    case "radio":
    case "checkbox":
      return (
        <div className="row row-wrap" style={{ gap: 12 }}>
          {(f.options ?? []).filter(Boolean).map((o) => (
            <label key={o} className="checkbox" style={style}><input type={f.type} readOnly /> {o}</label>
          ))}
        </div>
      );
    case "consent":
      return <label className="checkbox" style={style}><input type="checkbox" readOnly /> <span className="muted" style={{ fontSize: 13 }}>{f.label}</span></label>;
    default:
      return <input className="input" placeholder={f.placeholder} style={style} readOnly />;
  }
}

function Responses({ form }: { form: FormDef }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<any | null>(null);
  const { data, error, reload, setData } = useLoad(() => api.get<any[]>(`/forms/${form.id}/submissions?q=${encodeURIComponent(q)}`), [q]);
  const cols = form.fields.filter((f) => !["heading", "hidden"].includes(f.type)).slice(0, 4);
  const markRead = async (r: any, read = true) => {
    await api.put(`/submissions/${r.id}/read`, { read }).catch(() => {});
    setData((data ?? []).map((x) => (x.id === r.id ? { ...x, isRead: read } : x)));
    bus.emit("forms-changed");
  };
  const remove = async (r: any) => {
    if (!(await confirmDialog({ title: "Delete this response?", confirmLabel: "Delete", danger: true }))) return;
    await api.del(`/submissions/${r.id}`).catch(toast.error);
    setOpen(null);
    reload();
    bus.emit("forms-changed");
  };
  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="search-input" style={{ width: 300 }}>
          <Icon name="Search" size={15} />
          <input className="input" placeholder="Search responses" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="spacer" />
        <a className="btn" href={`/api/forms/${form.id}/export.csv`}>
          <Icon name="Download" size={16} /> Export CSV
        </a>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows />
        ) : !data.length ? (
          <Empty icon="Inbox" title="No responses yet">When people submit this form, their answers will appear here.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 24 }} />
                  {cols.map((c) => <th key={c.key}>{c.label}</th>)}
                  <th>Page</th>
                  <th>Received</th>
                </tr>
              </thead>
              <tbody>
                {data.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => (setOpen(r), !r.isRead && markRead(r))}>
                    <td>{!r.isRead && <span className="dot" style={{ background: "var(--accent)", display: "inline-block" }} title="Unread" />}</td>
                    {cols.map((c) => (
                      <td key={c.key} className="truncate" style={{ maxWidth: 240, fontWeight: r.isRead ? 400 : 650 }}>
                        {Array.isArray(r.data[c.key]) ? r.data[c.key].join(", ") : String(r.data[c.key] ?? "")}
                      </td>
                    ))}
                    <td className="mono subtle" style={{ fontSize: 12 }}>{r.pagePath}</td>
                    <td className="subtle" style={{ whiteSpace: "nowrap" }}>{timeAgo(r.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {open && (
        <Drawer
          title="Response"
          onClose={() => setOpen(null)}
          footer={
            <>
              <Button variant="danger" icon="Trash2" onClick={() => remove(open)}>Delete</Button>
              <div className="spacer" />
              <Button onClick={() => (markRead(open, false), setOpen(null))}>Mark unread</Button>
            </>
          }
        >
          <div className="subtle" style={{ marginBottom: 16, fontSize: 13 }}>
            Received {formatDate(open.createdAt, true)} {open.pagePath && <>from <span className="mono">{open.pagePath}</span></>}
          </div>
          {form.fields.filter((f) => f.type !== "heading").map((f) => (
            <div key={f.key} style={{ marginBottom: 14 }}>
              <div className="label" style={{ marginBottom: 4 }}>{f.label}</div>
              <div style={{ whiteSpace: "pre-wrap" }}>{Array.isArray(open.data[f.key]) ? open.data[f.key].join(", ") : String(open.data[f.key] ?? "") || <span className="subtle">—</span>}</div>
            </div>
          ))}
          {open.data.email && (
            <a className="btn btn-primary" href={`mailto:${open.data.email}`}>
              <Icon name="Mail" size={16} /> Reply by email
            </a>
          )}
        </Drawer>
      )}
    </>
  );
}
