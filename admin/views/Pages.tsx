import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { Page, Template } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { timeAgo, slugify } from "../lib/format";
import { Button, confirmDialog, Empty, ErrorState, Field, Menu, Modal, SkeletonRows, StatusBadge, Switch, toast, useLoad } from "../components/ui";

type PageRow = Omit<Page, "layout" | "customCss" | "customJs" | "customHead"> & { widgetCount: number };

const STARTERS = [
  { key: "blank", label: "Blank", icon: "FileText", desc: "Start from nothing" },
  { key: "landing", label: "Landing page", icon: "PanelTop", desc: "Hero, features and a call to action" },
  { key: "article", label: "Article", icon: "Pilcrow", desc: "Narrow column for reading" },
  { key: "contact", label: "Contact", icon: "Mail", desc: "Form with a map" },
];

export function Pages() {
  const nav = useNavigate();
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const { data, error, reload, setData } = useLoad(() => api.get<PageRow[]>("/pages"));
  const [creating, setCreating] = useState<{ parentId: number | null } | null>(params.get("new") ? { parentId: null } : null);
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set());
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("all");
  const [drag, setDrag] = useState<{ id: number; over?: number; pos?: "before" | "after" | "inside" } | null>(null);

  useEffect(() => {
    if (params.get("new")) {
      params.delete("new");
      setParams(params, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tree = useMemo(() => {
    const list = data ?? [];
    const kids = new Map<number | null, PageRow[]>();
    for (const p of list) {
      const k = p.parentId ?? null;
      if (!kids.has(k)) kids.set(k, []);
      kids.get(k)!.push(p);
    }
    for (const arr of kids.values()) arr.sort((a, b) => a.sort - b.sort || a.id - b.id);
    return kids;
  }, [data]);

  const filtering = q.trim() !== "" || status !== "all";
  const matches = (p: PageRow) =>
    (!q.trim() || p.title.toLowerCase().includes(q.toLowerCase()) || p.path.includes(q.toLowerCase())) &&
    (status === "all" || (status === "changes" ? p.status === "published" && p.hasUnpublishedChanges : p.status === status));

  const rows: { page: PageRow; depth: number; hasKids: boolean }[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const p of tree.get(parent) ?? []) {
      const hasKids = (tree.get(p.id) ?? []).length > 0;
      if (!filtering || matches(p)) rows.push({ page: p, depth: filtering ? 0 : depth, hasKids: !filtering && hasKids });
      if (filtering || !collapsed.has(p.id)) walk(p.id, depth + 1);
    }
  };
  walk(null, 0);

  const isDescendant = (id: number, maybeChild: number): boolean => {
    for (const c of tree.get(id) ?? []) if (c.id === maybeChild || isDescendant(c.id, maybeChild)) return true;
    return false;
  };

  const drop = async () => {
    if (!drag?.over || !drag.pos || drag.over === drag.id || !data) return setDrag(null);
    if (isDescendant(drag.id, drag.over)) {
      toast.error("A page can't be moved inside its own sub-pages.");
      return setDrag(null);
    }
    const moving = data.find((p) => p.id === drag.id)!;
    const target = data.find((p) => p.id === drag.over)!;
    if (moving.isHome && (drag.pos === "inside" || target.parentId)) {
      toast.error("The homepage has to stay at the top level.");
      return setDrag(null);
    }
    const newParent = drag.pos === "inside" ? target.id : target.parentId;
    const siblings = (tree.get(newParent ?? null) ?? []).filter((p) => p.id !== moving.id);
    let idx = drag.pos === "inside" ? siblings.length : siblings.findIndex((p) => p.id === target.id) + (drag.pos === "after" ? 1 : 0);
    siblings.splice(idx, 0, moving);
    const items = siblings.map((p, i) => ({ id: p.id, parentId: newParent, sort: i + 1 }));
    setDrag(null);
    // optimistic update
    setData(data.map((p) => {
      const it = items.find((x) => x.id === p.id);
      return it ? { ...p, parentId: it.parentId ?? null, sort: it.sort } : p;
    }));
    if (drag.pos === "inside") setCollapsed((c) => (c.delete(target.id), new Set(c)));
    try {
      await api.put("/pages-order", { items });
      toast.success(`Moved “${moving.title}”`);
    } catch (e) {
      toast.error(e);
    }
    reload();
  };

  const remove = async (p: PageRow) => {
    if (!(await confirmDialog({ title: `Delete “${p.title}”?`, message: "The page and its revision history will be removed. This can't be undone.", confirmLabel: "Delete page", danger: true }))) return;
    try {
      await api.del(`/pages/${p.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (!(await confirmDialog({ title: "Delete sub-pages too?", message: e.message, confirmLabel: "Delete all", danger: true }))) return;
        await api.del(`/pages/${p.id}?withChildren=1`).catch(toast.error);
      } else return toast.error(e);
    }
    toast.success(`Deleted “${p.title}”`);
    reload();
  };

  const act = async (fn: () => Promise<unknown>, msg: string) => {
    try {
      await fn();
      toast.success(msg);
      reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const counts = useMemo(() => {
    const c = { all: 0, published: 0, draft: 0, review: 0, changes: 0 } as Record<string, number>;
    for (const p of data ?? []) {
      c.all++;
      c[p.status] = (c[p.status] ?? 0) + 1;
      if (p.status === "published" && p.hasUnpublishedChanges) c.changes++;
    }
    return c;
  }, [data]);

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Pages</h1>
          <div className="page-sub">Your site's structure. Drag pages to reorder them, or drop one onto another to nest it.</div>
        </div>
        <div className="row">
          <Button icon="Map" onClick={() => nav("/sitemap")}>3D map</Button>
          <Button variant="primary" icon="Plus" onClick={() => setCreating({ parentId: null })}>
            New page
          </Button>
        </div>
      </div>
      <div className="row row-wrap" style={{ marginBottom: 14 }}>
        <div className="tabs">
          {[
            ["all", "All"],
            ["published", "Published"],
            ["draft", "Drafts"],
            ["review", "In review"],
            ["changes", "Unpublished changes"],
          ].map(([k, l]) => (
            <button key={k} className={`tab ${status === k ? "active" : ""}`} onClick={() => setStatus(k)}>
              {l} <span className="count">{counts[k] ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <div className="search-input" style={{ width: 260 }}>
          <Icon name="Search" size={15} />
          <input className="input" placeholder="Filter pages" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows rows={6} />
        ) : rows.length === 0 ? (
          filtering ? (
            <Empty icon="Search" title="No pages match">Try a different filter.</Empty>
          ) : (
            <Empty icon="Files" title="No pages yet" action={<Button variant="primary" icon="Plus" onClick={() => setCreating({ parentId: null })}>Create your first page</Button>}>
              Pages are built visually from sections and widgets.
            </Empty>
          )
        ) : (
          rows.map(({ page: p, depth, hasKids }) => (
            <div
              key={p.id}
              className={`tree-row ${drag?.id === p.id ? "dragging" : ""} ${drag?.over === p.id && drag.pos ? `drop-${drag.pos}` : ""}`}
              draggable={!filtering}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(p.id));
                setDrag({ id: p.id });
              }}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                const r = e.currentTarget.getBoundingClientRect();
                const y = (e.clientY - r.top) / r.height;
                const pos = y < 0.28 ? "before" : y > 0.72 ? "after" : "inside";
                if (drag.over !== p.id || drag.pos !== pos) setDrag({ ...drag, over: p.id, pos });
              }}
              onDragEnd={() => setDrag(null)}
              onDrop={(e) => {
                e.preventDefault();
                drop();
              }}
            >
              <span className="tree-handle" title="Drag to move">
                <Icon name="GripVertical" size={15} />
              </span>
              <span style={{ width: depth * 24, flex: "none" }} />
              {hasKids ? (
                <button className="tree-toggle" aria-label={collapsed.has(p.id) ? "Expand" : "Collapse"} onClick={() => setCollapsed((c) => (c.has(p.id) ? c.delete(p.id) : c.add(p.id), new Set(c)))}>
                  <Icon name={collapsed.has(p.id) ? "ChevronRight" : "ChevronDown"} size={15} />
                </button>
              ) : (
                <span style={{ width: 22, flex: "none" }} />
              )}
              <span className="list-icon" style={{ width: 28, height: 28, ...(p.isHome ? { background: "var(--accent-soft)", color: "var(--accent-text)" } : {}) }}>
                <Icon name={p.isHome ? "Home" : "FileText"} size={14} />
              </span>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}>
                  <span className="tree-title truncate" onClick={() => nav(`/pages/${p.id}`)}>
                    {p.title}
                  </span>
                  {!p.showInNav && <span className="badge no-dot" title="Hidden from navigation menus"><Icon name="EyeOff" size={11} /> Hidden</span>}
                </div>
                <div className="tree-path truncate">{p.path}</div>
              </div>
              <StatusBadge status={p.status} dirty={p.hasUnpublishedChanges} />
              <span className="subtle" style={{ width: 120, textAlign: "right", fontSize: 12.5 }} title={p.updatedBy ? `by ${p.updatedBy}` : undefined}>
                {timeAgo(p.updatedAt)}
              </span>
              <div className="row-actions">
                <Button size="sm" icon="Pencil" onClick={() => nav(`/pages/${p.id}`)}>
                  Edit
                </Button>
                {p.status !== "draft" || !p.hasUnpublishedChanges ? (
                  <a className="btn btn-sm btn-ghost btn-icon" href={p.path} target="_blank" rel="noreferrer" title="View live">
                    <Icon name="ExternalLink" size={14} />
                  </a>
                ) : null}
                <Menu
                  trigger={(open) => <Button size="sm" variant="ghost" iconOnly icon="MoreHorizontal" onClick={open} aria-label="More actions" />}
                  items={[
                    { label: "Add sub-page", icon: "FilePlus2", onClick: () => setCreating({ parentId: p.id }) },
                    { label: "Duplicate", icon: "Copy", onClick: () => act(() => api.post(`/pages/${p.id}/duplicate`), `Duplicated “${p.title}”`) },
                    { label: "Preview draft", icon: "Eye", onClick: () => window.open(`/preview/page/${p.id}`, "_blank") },
                    { label: "Set as homepage", icon: "Home", hidden: p.isHome || !!p.parentId || !can("pages.publish"), onClick: () => act(() => api.post(`/pages/${p.id}/home`), `“${p.title}” is now the homepage`) },
                    { label: "Unpublish", icon: "EyeOff", hidden: !p.publishedAt || !can("pages.publish"), onClick: () => act(() => api.post(`/pages/${p.id}/unpublish`), `“${p.title}” is no longer live`) },
                    { separator: true },
                    { label: "Delete", icon: "Trash2", danger: true, hidden: p.isHome, onClick: () => remove(p) },
                  ]}
                />
              </div>
            </div>
          ))
        )}
      </div>
      {creating && <NewPageModal parentId={creating.parentId} pages={data ?? []} onClose={() => setCreating(null)} onCreated={(p) => nav(`/pages/${p.id}`)} />}
    </div>
  );
}

function NewPageModal({ parentId, pages, onClose, onCreated }: { parentId: number | null; pages: PageRow[]; onClose: () => void; onCreated: (p: Page) => void }) {
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [parent, setParent] = useState<number | null>(parentId);
  const [starter, setStarter] = useState("landing");
  const [templateId, setTemplateId] = useState<number | "">("");
  const [showInNav, setShowInNav] = useState(true);
  const [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  useEffect(() => {
    api.get<Template[]>("/templates").then((t) => {
      setTemplates(t);
      setTemplateId(t.find((x) => x.isDefault)?.id ?? t[0]?.id ?? "");
    });
  }, []);
  const parentPath = parent ? pages.find((p) => p.id === parent)?.path.replace(/\/$/, "") ?? "" : "";
  const finalSlug = slugTouched ? slug : slugify(title);
  const create = async () => {
    if (!title.trim()) return toast.error("Give the page a title first.");
    setBusy(true);
    try {
      const p = await api.post<Page>("/pages", { title, slug: finalSlug, parentId: parent, starter, templateId: templateId || null, showInNav });
      toast.success(`Created “${p.title}”`);
      onCreated(p);
    } catch (e) {
      toast.error(e);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New page"
      description="You can change all of this later in page settings."
      size="lg"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={create} iconRight="ArrowRight">
            Create and open editor
          </Button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Title" required>
          <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && create()} placeholder="e.g. About us" />
        </Field>
        <Field label="URL" help={`${parentPath}/${finalSlug || "…"}`}>
          <div className="input-group">
            <span className="input-prefix">{parentPath || ""}/</span>
            <input
              className="input"
              value={finalSlug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(slugify(e.target.value) || e.target.value.toLowerCase());
              }}
            />
          </div>
        </Field>
        <Field label="Parent page">
          <select className="select" value={parent ?? ""} onChange={(e) => setParent(e.target.value ? Number(e.target.value) : null)}>
            <option value="">None (top level)</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.path} — {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Template">
          <select className="select" value={templateId} onChange={(e) => setTemplateId(Number(e.target.value))}>
            {templates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Start with">
        <div className="type-picker" style={{ gridTemplateColumns: "repeat(4, 1fr)" }}>
          {STARTERS.map((s) => (
            <button key={s.key} type="button" className="type-option" style={starter === s.key ? { borderColor: "var(--accent)", boxShadow: "var(--ring)" } : undefined} onClick={() => setStarter(s.key)}>
              <span className="field-type-icon">
                <Icon name={s.icon} size={15} />
              </span>
              <strong>{s.label}</strong>
              <span>{s.desc}</span>
            </button>
          ))}
        </div>
      </Field>
      <Switch checked={showInNav} onChange={setShowInNav} label="Show in navigation menus" />
    </Modal>
  );
}
