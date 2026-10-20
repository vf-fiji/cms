import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { ContentType, FieldDef, FieldType } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import { Icon, PICKER_ICONS } from "../lib/icons";
import { bus } from "../lib/auth";
import { keyify, slugify } from "../lib/format";
import { Button, confirmDialog, ErrorState, Field, Modal, Spinner, Switch, toast } from "../components/ui";
import { CodeEditor } from "../components/CodeEditor";
import { invalidateRefCache } from "../components/FieldEditor";

export const FIELD_TYPES: { type: FieldType; label: string; icon: string; desc: string }[] = [
  { type: "text", label: "Short text", icon: "Type", desc: "Names, titles, single lines" },
  { type: "textarea", label: "Long text", icon: "Pilcrow", desc: "Plain paragraphs" },
  { type: "richtext", label: "Rich text", icon: "Bold", desc: "Formatted text with links" },
  { type: "number", label: "Number", icon: "Hash", desc: "Prices, counts, scores" },
  { type: "boolean", label: "Yes / no", icon: "ToggleLeft", desc: "On/off switch" },
  { type: "date", label: "Date", icon: "Calendar", desc: "A calendar date" },
  { type: "datetime", label: "Date & time", icon: "Clock", desc: "Date with a time" },
  { type: "select", label: "Dropdown", icon: "ChevronDown", desc: "Pick one option" },
  { type: "multiselect", label: "Checkboxes", icon: "Check", desc: "Pick several options" },
  { type: "image", label: "Image", icon: "Image", desc: "One image from Media" },
  { type: "gallery", label: "Gallery", icon: "Images", desc: "Several images" },
  { type: "file", label: "File", icon: "FileText", desc: "PDF or document" },
  { type: "url", label: "Link", icon: "Link", desc: "Web address or page path" },
  { type: "email", label: "Email", icon: "Mail", desc: "Validated email address" },
  { type: "color", label: "Colour", icon: "Palette", desc: "Colour picker" },
  { type: "reference", label: "Related item", icon: "Link2", desc: "Link to another content item" },
  { type: "tags", label: "Tag list", icon: "Tags", desc: "Free-form list of words" },
  { type: "list", label: "Repeater", icon: "Rows3", desc: "A list of grouped fields" },
  { type: "code", label: "Code", icon: "CodeXml", desc: "HTML, CSS or JS snippet" },
];
const typeMeta = (t: FieldType) => FIELD_TYPES.find((f) => f.type === t) ?? FIELD_TYPES[0];
const COLORS = ["#e60000", "#9c2aa0", "#00b0ca", "#007c92", "#a8b400", "#fecb00", "#eb9700", "#4a4d4e", "#25282b", "#820000"];

export function TypeBuilder() {
  const { key } = useParams();
  const isNew = key === "new";
  const nav = useNavigate();
  const [t, setT] = useState<Partial<ContentType> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [types, setTypes] = useState<ContentType[]>([]);

  useEffect(() => {
    api.get<ContentType[]>("/types").then(setTypes).catch(() => {});
    if (isNew) {
      setT({
        name: "",
        singular: "",
        key: "",
        icon: "FileText",
        color: COLORS[0],
        description: "",
        urlPrefix: "",
        hasDetailPages: true,
        fields: [
          { key: "summary", label: "Summary", type: "textarea" },
          { key: "image", label: "Image", type: "image" },
          { key: "body", label: "Body", type: "richtext" },
        ],
      });
      setSelected(null);
    } else api.get<ContentType>(`/types/${key}`).then(setT).catch((e) => setError(e.message));
  }, [key, isNew]);

  if (error) return <div className="page"><ErrorState message={error} /></div>;
  if (!t) return <Spinner />;
  const fields = t.fields ?? [];
  const set = (p: Partial<ContentType>) => {
    setT({ ...t, ...p });
    setDirty(true);
  };
  const setField = (i: number, p: Partial<FieldDef>) => set({ fields: fields.map((f, j) => (j === i ? { ...f, ...p } : f)) });
  const addField = (type: FieldType) => {
    const meta = typeMeta(type);
    let k = keyify(meta.label);
    for (let n = 2; fields.some((f) => f.key === k); n++) k = `${keyify(meta.label)}${n}`;
    const f: FieldDef = { key: k, label: meta.label, type, ...(type === "select" || type === "multiselect" ? { options: [{ value: "option-1", label: "Option 1" }] } : {}), ...(type === "list" ? { fields: [{ key: "title", label: "Title", type: "text" }] } : {}) };
    set({ fields: [...fields, f] });
    setSelected(fields.length);
    setPicker(false);
  };
  const save = async () => {
    if (!t.name?.trim()) return toast.error("Give the content type a name.");
    setBusy(true);
    try {
      const body = { ...t, key: t.key || keyify(t.name).toLowerCase(), singular: t.singular || t.name.replace(/s$/, ""), urlPrefix: t.urlPrefix || slugify(t.name) };
      const saved = isNew ? await api.post<ContentType>("/types", body) : await api.put<ContentType>(`/types/${key}`, body);
      if (isNew) await api.put(`/types/${saved.key}`, body); // also store templates on create
      toast.success(isNew ? `Created “${saved.name}”` : "Content type saved");
      setDirty(false);
      invalidateRefCache();
      bus.emit("types-changed");
      if (isNew) nav(`/content/${saved.key}`);
      else setT(saved);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: "The type's fields and settings are removed.", confirmLabel: "Delete type", danger: true }))) return;
    try {
      await api.del(`/types/${key}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (!(await confirmDialog({ title: "Delete its items too?", message: e.message, confirmLabel: "Delete everything", danger: true }))) return;
        await api.del(`/types/${key}?force=1`);
      } else return toast.error(e);
    }
    toast.success("Content type deleted");
    bus.emit("types-changed");
    nav("/content");
  };
  const sel = selected !== null ? fields[selected] : null;
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="crumbs">
            <a style={{ cursor: "pointer" }} onClick={() => nav("/content")}>Content</a>
            <Icon name="ChevronRight" size={13} />
            <span>{isNew ? "New content type" : t.name}</span>
          </div>
          <h1 className="page-title">{isNew ? "Create a content type" : `${t.name} fields`}</h1>
          <div className="page-sub">Design the form editors fill in. Changes apply immediately — no rebuild or restart.</div>
        </div>
        <div className="row">
          {!isNew && <Button icon="Layers" onClick={() => nav(`/content/${key}`)}>View items</Button>}
          <Button variant="primary" icon="Save" loading={busy} onClick={save} disabled={!dirty && !isNew}>
            {isNew ? "Create content type" : "Save changes"}
          </Button>
        </div>
      </div>

      <div className="builder">
        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <div className="grid-2">
              <Field label="Name (plural)" required>
                <input
                  className="input"
                  value={t.name ?? ""}
                  placeholder="e.g. Products"
                  autoFocus={isNew}
                  onChange={(e) => set({ name: e.target.value, ...(isNew && !keyTouched ? { key: keyify(e.target.value).toLowerCase(), urlPrefix: slugify(e.target.value), singular: e.target.value.replace(/s$/i, "") } : {}) })}
                />
              </Field>
              <Field label="Singular name">
                <input className="input" value={t.singular ?? ""} placeholder="e.g. Product" onChange={(e) => set({ singular: e.target.value })} />
              </Field>
              <Field label="API key" help={isNew ? "Used in templates and the API. Can't be changed later." : "Used in templates and the API."}>
                <input className="input mono" value={t.key ?? ""} disabled={!isNew} onChange={(e) => (setKeyTouched(true), set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "") }))} />
              </Field>
              <Field label="Description">
                <input className="input" value={t.description ?? ""} placeholder="What is this content for?" onChange={(e) => set({ description: e.target.value })} />
              </Field>
            </div>
            <div className="grid-2">
              <Field label="Icon">
                <div className="icon-grid">
                  {PICKER_ICONS.map((ic) => (
                    <button key={ic} type="button" className={t.icon === ic ? "active" : ""} onClick={() => set({ icon: ic })} aria-label={ic} title={ic}>
                      <Icon name={ic} size={15} />
                    </button>
                  ))}
                </div>
              </Field>
              <div>
                <Field label="Colour">
                  <div className="swatches">
                    {COLORS.map((c) => (
                      <button key={c} type="button" className={`swatch ${t.color === c ? "active" : ""}`} style={{ background: c }} onClick={() => set({ color: c })} aria-label={c} />
                    ))}
                  </div>
                </Field>
                <Field label="Detail pages" help={t.hasDetailPages ? `Each item gets its own page at /${t.urlPrefix || "…"}/item-slug` : "Items only appear inside lists and the API."}>
                  <Switch checked={!!t.hasDetailPages} onChange={(v) => set({ hasDetailPages: v })} label="Give each item its own page" />
                </Field>
                {t.hasDetailPages && (
                  <Field label="URL prefix">
                    <div className="input-group">
                      <span className="input-prefix">/</span>
                      <input className="input mono" value={t.urlPrefix ?? ""} onChange={(e) => set({ urlPrefix: slugify(e.target.value) || e.target.value })} />
                    </div>
                  </Field>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Fields</div>
              <Button size="sm" variant="primary" icon="Plus" onClick={() => setPicker(true)}>Add field</Button>
            </div>
            <div className="card-body col" style={{ gap: 8 }}>
              <div className="field-row" style={{ cursor: "default", background: "var(--panel-2)" }}>
                <span className="field-type-icon"><Icon name="Type" size={15} /></span>
                <div className="grow"><strong>Title</strong> <span className="subtle">· built in</span></div>
                <span className="badge no-dot">Required</span>
              </div>
              {fields.map((f, i) => (
                <div
                  key={i}
                  className={`field-row ${selected === i ? "active" : ""}`}
                  onClick={() => setSelected(i)}
                  draggable
                  onDragStart={() => setDragIdx(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx === null || dragIdx === i) return;
                    const next = [...fields];
                    const [m] = next.splice(dragIdx, 1);
                    next.splice(i, 0, m);
                    set({ fields: next });
                    setSelected(i);
                    setDragIdx(null);
                  }}
                  style={dragIdx === i ? { opacity: 0.4 } : undefined}
                >
                  <span style={{ cursor: "grab", color: "var(--text-3)" }}><Icon name="GripVertical" size={15} /></span>
                  <span className="field-type-icon"><Icon name={typeMeta(f.type).icon} size={15} /></span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <strong>{f.label}</strong> <span className="subtle mono" style={{ fontSize: 12 }}>{f.key}</span>
                    <div className="subtle" style={{ fontSize: 12 }}>{typeMeta(f.type).label}</div>
                  </div>
                  {f.required && <span className="badge no-dot">Required</span>}
                  <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label={`Remove ${f.label}`} onClick={(e) => {
                    e.stopPropagation();
                    set({ fields: fields.filter((_, j) => j !== i) });
                    setSelected(null);
                  }} />
                </div>
              ))}
              {!fields.length && <div className="subtle" style={{ padding: 12, textAlign: "center" }}>No fields yet. Add one to get started.</div>}
            </div>
          </div>

          {t.hasDetailPages && (
            <details className="card">
              <summary className="card-header" style={{ cursor: "pointer", listStyle: "none" }}>
                <div>
                  <div className="card-title">Detail page template</div>
                  <div className="subtle" style={{ fontSize: 12.5 }}>Liquid HTML used for each item's own page. Fields are available as {"{{ item.fieldKey }}"}.</div>
                </div>
                <Icon name="ChevronDown" size={16} />
              </summary>
              <div className="code-field" style={{ margin: 16 }}>
                <CodeEditor language="liquid" value={t.detailTemplate ?? ""} onChange={(v) => set({ detailTemplate: v })} minHeight="320px" />
              </div>
            </details>
          )}

          {!isNew && (
            <div className="card card-pad row" style={{ borderColor: "color-mix(in srgb, var(--danger) 30%, var(--border))" }}>
              <div className="grow">
                <strong>Delete this content type</strong>
                <div className="subtle" style={{ fontSize: 13 }}>Removes the type and, if you confirm, all of its items.</div>
              </div>
              <Button variant="danger" icon="Trash2" onClick={remove}>Delete</Button>
            </div>
          )}
        </div>

        <div className="sticky-side">
          <div className="card">
            <div className="card-header">
              <div className="card-title">{sel ? "Field settings" : "Field settings"}</div>
            </div>
            <div className="card-body">
              {!sel ? (
                <div className="subtle" style={{ fontSize: 13 }}>Select a field to edit it, or drag fields to change their order.</div>
              ) : (
                <>
                  <Field label="Label">
                    <input className="input" value={sel.label} onChange={(e) => setField(selected!, { label: e.target.value })} />
                  </Field>
                  <Field label="Key" help="Used in templates: {{ item.key }}">
                    <input className="input mono" value={sel.key} onChange={(e) => setField(selected!, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, "") })} />
                  </Field>
                  <Field label="Type">
                    <select className="select" value={sel.type} onChange={(e) => setField(selected!, { type: e.target.value as FieldType })}>
                      {FIELD_TYPES.map((f) => (
                        <option key={f.type} value={f.type}>{f.label}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Help text">
                    <input className="input" value={sel.help ?? ""} placeholder="Shown under the field" onChange={(e) => setField(selected!, { help: e.target.value })} />
                  </Field>
                  {["text", "textarea", "url", "email"].includes(sel.type) && (
                    <Field label="Placeholder">
                      <input className="input" value={sel.placeholder ?? ""} onChange={(e) => setField(selected!, { placeholder: e.target.value })} />
                    </Field>
                  )}
                  {(sel.type === "select" || sel.type === "multiselect") && (
                    <Field label="Options" help="One per line. Use value|Label to set them separately.">
                      <textarea
                        className="textarea"
                        rows={5}
                        value={(sel.options ?? []).map((o) => (o.value === slugify(o.label) ? o.label : `${o.value}|${o.label}`)).join("\n")}
                        onChange={(e) =>
                          setField(selected!, {
                            options: e.target.value
                              .split("\n")
                              .filter((l) => l.trim())
                              .map((l) => {
                                const [a, b] = l.split("|");
                                return b ? { value: a.trim(), label: b.trim() } : { value: slugify(a) || a.trim(), label: a.trim() };
                              }),
                          })
                        }
                      />
                    </Field>
                  )}
                  {sel.type === "reference" && (
                    <Field label="Links to">
                      <select className="select" value={sel.refType ?? ""} onChange={(e) => setField(selected!, { refType: e.target.value })}>
                        <option value="">Choose a content type…</option>
                        {types.map((x) => (
                          <option key={x.key} value={x.key}>{x.name}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  {sel.type === "code" && (
                    <Field label="Language">
                      <select className="select" value={sel.language ?? "html"} onChange={(e) => setField(selected!, { language: e.target.value as any })}>
                        <option value="html">HTML</option>
                        <option value="css">CSS</option>
                        <option value="javascript">JavaScript</option>
                        <option value="jsx">JSX (React)</option>
                        <option value="json">JSON</option>
                      </select>
                    </Field>
                  )}
                  {sel.type === "list" && <SubFields fields={sel.fields ?? []} onChange={(sub) => setField(selected!, { fields: sub })} />}
                  <Switch checked={!!sel.required} onChange={(v) => setField(selected!, { required: v })} label="Required to publish" />
                </>
              )}
            </div>
          </div>
          <div className="card card-pad" style={{ fontSize: 13 }}>
            <div className="row" style={{ marginBottom: 6 }}>
              <Icon name="Braces" size={15} />
              <strong>Use it anywhere</strong>
            </div>
            <div className="muted">
              Show items on a page with the <strong>Content list</strong> widget, in Liquid with <code className="mono">{`{% assign items = '${t.key || "key"}' | content: 5 %}`}</code>, or fetch JSON from <code className="mono">/api/public/content/{t.key || "key"}</code>.
            </div>
          </div>
        </div>
      </div>

      {picker && (
        <Modal title="Add a field" description="Pick the kind of information this field holds." size="lg" onClose={() => setPicker(false)}>
          <div className="type-picker">
            {FIELD_TYPES.map((f) => (
              <button key={f.type} type="button" className="type-option" onClick={() => addField(f.type)}>
                <span className="field-type-icon"><Icon name={f.icon} size={15} /></span>
                <strong>{f.label}</strong>
                <span>{f.desc}</span>
              </button>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

export function SubFields({ fields, onChange }: { fields: FieldDef[]; onChange: (f: FieldDef[]) => void }) {
  return (
    <Field label="Fields in each item">
      <div className="col" style={{ gap: 6 }}>
        {fields.map((f, i) => (
          <div key={i} className="row" style={{ gap: 4 }}>
            <input className="input input-sm" value={f.label} onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, label: e.target.value, key: keyify(e.target.value) } : x)))} />
            <select className="select input-sm" style={{ width: 110 }} value={f.type} onChange={(e) => onChange(fields.map((x, j) => (j === i ? { ...x, type: e.target.value as FieldType } : x)))}>
              {FIELD_TYPES.filter((t) => t.type !== "list").map((t) => (
                <option key={t.type} value={t.type}>{t.label}</option>
              ))}
            </select>
            <Button size="sm" variant="ghost" iconOnly icon="X" aria-label="Remove" onClick={() => onChange(fields.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" icon="Plus" onClick={() => onChange([...fields, { key: `field${fields.length + 1}`, label: `Field ${fields.length + 1}`, type: "text" }])}>Add</Button>
      </div>
    </Field>
  );
}
