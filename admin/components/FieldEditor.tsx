import { useEffect, useState } from "react";
import type { FieldDef, MediaItem } from "../../shared/types";
import { Icon } from "../lib/icons";
import { api } from "../lib/api";
import { Button, Field, Switch, press } from "./ui";
import { RichText } from "./RichText";
import { CodeField } from "./CodeEditor";
import { MediaPicker } from "./MediaPicker";

// Small shared cache for reference dropdowns.
const refCache = new Map<string, Promise<{ value: string; label: string }[]>>();
export function invalidateRefCache() {
  refCache.clear();
}
function loadRef(refType: string) {
  if (!refCache.has(refType)) {
    const p =
      refType === "__types"
        ? api.get<any[]>("/types").then((ts) => ts.map((t) => ({ value: t.key, label: t.name })))
        : refType === "__forms"
          ? api.get<any[]>("/forms").then((fs) => fs.map((f) => ({ value: f.key, label: f.name })))
          : api.get<any>(`/types/${refType}/items?limit=200&sort=title`).then((r) => r.items.map((i: any) => ({ value: String(i.id), label: i.title })));
    refCache.set(refType, p.catch(() => []));
  }
  return refCache.get(refType)!;
}
function useRefOptions(refType?: string) {
  const [opts, setOpts] = useState<{ value: string; label: string }[]>([]);
  useEffect(() => {
    if (refType) loadRef(refType).then(setOpts);
  }, [refType]);
  return opts;
}

export function ImageField({ value, onChange, accept = "image" }: { value: string; onChange: (v: string) => void; accept?: "image" | "any" }) {
  const [open, setOpen] = useState(false);
  const isImage = accept === "image" || /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(value || "");
  return (
    <div className="image-field">
      <div className="image-field-preview" {...press(() => setOpen(true))} title="Choose from media library">
        {value ? isImage ? <img src={value} alt="" /> : <Icon name="FileText" size={20} /> : <Icon name={accept === "image" ? "Image" : "Upload"} size={20} />}
      </div>
      <div className="col grow" style={{ gap: 6 }}>
        <div className="row">
          <Button size="sm" icon="FolderOpen" onClick={() => setOpen(true)}>
            {value ? "Replace" : "Choose"}
          </Button>
          {value && <Button size="sm" variant="ghost" icon="X" onClick={() => onChange("")}>Remove</Button>}
        </div>
        <input className="input input-sm" placeholder="or paste a URL" value={value || ""} onChange={(e) => onChange(e.target.value)} />
      </div>
      {open && (
        <MediaPicker
          accept={accept}
          onClose={() => setOpen(false)}
          onPick={(m: MediaItem) => {
            onChange(m.url);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

function GalleryField({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  const list = Array.isArray(value) ? value : [];
  return (
    <div className="col" style={{ gap: 8 }}>
      {list.length > 0 && (
        <div className="gallery-field">
          {list.map((src, i) => (
            <div key={src + i} className="gallery-field-item">
              <img src={src} alt="" />
              <button type="button" aria-label="Remove image" onClick={() => onChange(list.filter((_, j) => j !== i))}>
                <Icon name="X" size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <Button size="sm" icon="Plus" onClick={() => setOpen(true)}>
        Add images
      </Button>
      {open && (
        <MediaPicker
          accept="image"
          multiple
          onClose={() => setOpen(false)}
          onPickMany={(ms) => {
            onChange([...list, ...ms.map((m) => m.url)]);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function TagInput({ value, onChange, taxonomy = "tags", placeholder }: { value: string[]; onChange: (v: string[]) => void; taxonomy?: "tags" | "categories"; placeholder?: string }) {
  const [text, setText] = useState("");
  const [suggest, setSuggest] = useState<string[]>([]);
  const list = Array.isArray(value) ? value : [];
  useEffect(() => {
    api.get<any[]>(`/terms?taxonomy=${taxonomy}`).then((ts) => setSuggest(ts.map((t) => t.name))).catch(() => {});
  }, [taxonomy]);
  const add = (t: string) => {
    const v = t.trim();
    if (v && !list.some((x) => x.toLowerCase() === v.toLowerCase())) onChange([...list, v]);
    setText("");
  };
  const options = suggest.filter((s) => !list.includes(s) && s.toLowerCase().includes(text.toLowerCase())).slice(0, 8);
  return (
    <div className="col" style={{ gap: 8 }}>
      {list.length > 0 && (
        <div className="row row-wrap" style={{ gap: 6 }}>
          {list.map((t) => (
            <span key={t} className="chip">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(list.filter((x) => x !== t))}>
                <Icon name="X" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        className="input input-sm"
        value={text}
        list={`dl-${taxonomy}`}
        placeholder={placeholder ?? "Type and press Enter"}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && list.length) onChange(list.slice(0, -1));
        }}
        onBlur={() => text && add(text)}
      />
      <datalist id={`dl-${taxonomy}`}>
        {options.map((o) => (
          <option key={o} value={o} />
        ))}
      </datalist>
    </div>
  );
}

function Repeater({ field, value, onChange }: { field: FieldDef; value: any[]; onChange: (v: any[]) => void }) {
  const list = Array.isArray(value) ? value : [];
  const [open, setOpen] = useState<number | null>(list.length ? null : null);
  const sub = field.fields ?? [];
  const title = (item: any, i: number) => {
    const first = sub.find((f) => ["text", "textarea"].includes(f.type));
    return (first && item?.[first.key]) || `Item ${i + 1}`;
  };
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return;
    const next = [...list];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setOpen(j);
  };
  return (
    <div className="repeater">
      {list.map((item, i) => (
        <div key={i} className="repeater-item">
          <div className="repeater-head" {...press(() => setOpen(open === i ? null : i))}>
            <Icon name={open === i ? "ChevronDown" : "ChevronRight"} size={14} />
            <span className="grow truncate">{String(title(item, i))}</span>
            <Button size="sm" variant="ghost" iconOnly icon="ArrowUp" aria-label="Move up" onClick={(e) => (e.stopPropagation(), move(i, -1))} />
            <Button size="sm" variant="ghost" iconOnly icon="ArrowDown" aria-label="Move down" onClick={(e) => (e.stopPropagation(), move(i, 1))} />
            <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Remove" onClick={(e) => (e.stopPropagation(), onChange(list.filter((_, j) => j !== i)))} />
          </div>
          {open === i && (
            <div className="repeater-body">
              <FieldsForm fields={sub} values={item ?? {}} onChange={(k, v) => onChange(list.map((x, j) => (j === i ? { ...x, [k]: v } : x)))} />
            </div>
          )}
        </div>
      ))}
      <Button
        size="sm"
        icon="Plus"
        onClick={() => {
          onChange([...list, Object.fromEntries(sub.map((f) => [f.key, f.default ?? ""]))]);
          setOpen(list.length);
        }}
      >
        Add {field.label.toLowerCase().replace(/s$/, "")}
      </Button>
    </div>
  );
}

export function FieldInput({ field, value, onChange }: { field: FieldDef; value: any; onChange: (v: any) => void }) {
  const refOptions = useRefOptions(field.type === "reference" ? field.refType : undefined);
  const id = `f-${field.key}`;
  switch (field.type) {
    case "textarea":
      return <textarea id={id} className="textarea" rows={3} value={value ?? ""} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case "richtext":
      return <RichText value={value ?? ""} onChange={onChange} compact />;
    case "number":
      return <input id={id} className="input" type="number" min={field.min} max={field.max} value={value ?? ""} onChange={(e) => onChange(e.target.value === "" ? "" : Number(e.target.value))} />;
    case "boolean":
      return <Switch checked={!!value} onChange={onChange} label={value ? "On" : "Off"} />;
    case "date":
      return <input id={id} className="input" type="date" value={(value ?? "").slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return <input id={id} className="input" type="datetime-local" value={(value ?? "").slice(0, 16)} onChange={(e) => onChange(e.target.value)} />;
    case "select":
      return (
        <select id={id} className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          {!field.options?.some((o) => o.value === "") && <option value="">—</option>}
          {field.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "multiselect": {
      const list: string[] = Array.isArray(value) ? value : [];
      return (
        <div className="row row-wrap" style={{ gap: 12 }}>
          {field.options?.map((o) => (
            <label key={o.value} className="checkbox">
              <input type="checkbox" checked={list.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value))} />
              {o.label}
            </label>
          ))}
        </div>
      );
    }
    case "image":
      return <ImageField value={value ?? ""} onChange={onChange} />;
    case "file":
      return <ImageField value={value ?? ""} onChange={onChange} accept="any" />;
    case "gallery":
      return <GalleryField value={value ?? []} onChange={onChange} />;
    case "color":
      return (
        <div className="color-input">
          <input type="color" value={/^#[0-9a-f]{6}$/i.test(value ?? "") ? value : "#000000"} onChange={(e) => onChange(e.target.value)} aria-label={`${field.label} colour picker`} />
          <input className="input" value={value ?? ""} placeholder="Default" onChange={(e) => onChange(e.target.value)} />
          {value && <Button size="sm" variant="ghost" iconOnly icon="X" aria-label="Clear colour" onClick={() => onChange("")} />}
        </div>
      );
    case "code":
      return <CodeField value={value ?? ""} onChange={onChange} language={field.language ?? "html"} />;
    case "reference":
      return (
        <select id={id} className="select" value={value ?? ""} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {refOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
    case "tags":
      return <TagInput value={value ?? []} onChange={onChange} />;
    case "list":
      return <Repeater field={field} value={value ?? []} onChange={onChange} />;
    case "url":
      return <input id={id} className="input" value={value ?? ""} placeholder={field.placeholder ?? "https://… or /page"} onChange={(e) => onChange(e.target.value)} />;
    case "email":
      return <input id={id} className="input" type="email" value={value ?? ""} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input id={id} className="input" value={value ?? ""} placeholder={field.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function FieldsForm({ fields, values, onChange, errors }: { fields: FieldDef[]; values: Record<string, any>; onChange: (key: string, value: any) => void; errors?: Record<string, string> }) {
  return (
    <>
      {fields.map((f) => (
        <Field key={f.key} label={f.label} help={f.help} required={f.required} error={errors?.[f.key]} htmlFor={`f-${f.key}`}>
          <FieldInput field={f} value={values?.[f.key]} onChange={(v) => onChange(f.key, v)} />
        </Field>
      ))}
    </>
  );
}
