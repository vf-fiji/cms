import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { ContentItem, ContentType } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth, bus } from "../lib/auth";
import { timeAgo } from "../lib/format";
import { Button, confirmDialog, Empty, ErrorState, Menu, SkeletonRows, StatusBadge, toast, useLoad, press } from "../components/ui";

export function ContentHome() {
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, error, reload } = useLoad(() => api.get<ContentType[]>("/types"));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Content</h1>
          <div className="page-sub">Structured content you can reuse across pages, lists and the headless API.</div>
        </div>
        {can("content.types") && (
          <Button variant="primary" icon="Plus" onClick={() => nav("/types/new")}>
            New content type
          </Button>
        )}
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : (
        <div className="cards-grid">
          {data.map((t) => (
            <div key={t.id} className="card type-card" onClick={() => nav(`/content/${t.key}`)}>
              <div className="row">
                <span className="type-card-icon" style={{ background: `linear-gradient(135deg, ${t.color}, ${t.color}cc)` }}>
                  <Icon name={t.icon} size={19} />
                </span>
                <div className="spacer" />
                {can("content.types") && (
                  <Button size="sm" variant="ghost" icon="Settings" onClick={(e) => (e.stopPropagation(), nav(`/types/${t.key}`))}>
                    Fields
                  </Button>
                )}
              </div>
              <div>
                <Link to={`/content/${t.key}`} className="stretched-link" style={{ fontWeight: 650, fontSize: 15.5, color: "inherit" }} onClick={(e) => e.stopPropagation()}>{t.name}</Link>
                <div className="muted" style={{ fontSize: 13 }}>{t.description || `${t.fields.length} fields`}</div>
              </div>
              <div className="row subtle" style={{ fontSize: 12.5 }}>
                <span>
                  <strong style={{ color: "var(--text)" }}>{t.itemCount}</strong> items
                </span>
                <span>·</span>
                <span>{t.fields.length} fields</span>
                {t.hasDetailPages && (
                  <>
                    <span>·</span>
                    <span className="mono">/{t.urlPrefix}/…</span>
                  </>
                )}
              </div>
            </div>
          ))}
          {can("content.types") && (
            <div className="card type-card" style={{ borderStyle: "dashed", justifyContent: "center", alignItems: "center", textAlign: "center", minHeight: 160, boxShadow: "none" }} {...press(() => nav("/types/new"))}>
              <span className="empty-icon" style={{ margin: 0 }}>
                <Icon name="Plus" size={22} />
              </span>
              <strong>Create a content type</strong>
              <span className="subtle" style={{ fontSize: 12.5 }}>Products, FAQs, case studies, people…</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ContentList() {
  const { type: typeKey } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState("all");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [sort, setSort] = useState("updated");
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dragId, setDragId] = useState<number | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q), 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    setSelected(new Set());
    setStatus("all");
    setQ("");
  }, [typeKey]);
  const type = useLoad(() => api.get<ContentType>(`/types/${typeKey}`), [typeKey]);
  const list = useLoad(
    () => api.get<{ items: ContentItem[]; total: number; counts: Record<string, number> }>(`/types/${typeKey}/items?status=${status}&q=${encodeURIComponent(debouncedQ)}&sort=${sort}&limit=200`),
    [typeKey, status, debouncedQ, sort],
  );
  const t = type.data;
  const items = list.data?.items ?? [];
  const imageField = t?.fields.find((f) => f.type === "image");
  const counts = list.data?.counts ?? {};
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  const bulk = async (action: string) => {
    const ids = [...selected];
    if (action === "delete" && !(await confirmDialog({ title: `Delete ${ids.length} item${ids.length > 1 ? "s" : ""}?`, message: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    try {
      const r = await api.post<{ ok: boolean; errors: string[] }>("/items-bulk", { ids, action });
      r.errors.forEach((e) => toast.error(e));
      if (r.ok) toast.success(`${action === "delete" ? "Deleted" : action === "publish" ? "Published" : "Unpublished"} ${ids.length} item${ids.length > 1 ? "s" : ""}`);
      setSelected(new Set());
      list.reload();
      bus.emit("types-changed");
    } catch (e) {
      toast.error(e);
    }
  };

  const reorder = async (targetId: number) => {
    if (dragId === null || dragId === targetId) return;
    const ids = items.map((i) => i.id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    list.setData({ ...list.data!, items: ids.map((id) => items.find((i) => i.id === id)!) });
    setDragId(null);
    try {
      await api.put(`/types/${typeKey}/order`, { ids });
    } catch (e) {
      toast.error(e);
      list.reload();
    }
  };

  if (type.error) return <div className="page"><ErrorState message={type.error} onRetry={type.reload} /></div>;
  const allChecked = items.length > 0 && items.every((i) => selected.has(i.id));
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <div className="crumbs">
            <a onClick={() => nav("/content")} style={{ cursor: "pointer" }}>Content</a>
            <Icon name="ChevronRight" size={13} />
            <span>{t?.name ?? "…"}</span>
          </div>
          <h1 className="page-title row" style={{ gap: 10 }}>
            {t && (
              <span className="type-card-icon" style={{ width: 32, height: 32, borderRadius: 10, background: t.color }}>
                <Icon name={t.icon} size={16} />
              </span>
            )}
            {t?.name}
          </h1>
        </div>
        <div className="row">
          {can("content.types") && t && (
            <Button icon="Settings" onClick={() => nav(`/types/${t.key}`)}>
              Edit fields
            </Button>
          )}
          {can("content.edit") && t && (
            <Button variant="primary" icon="Plus" onClick={() => nav(`/content/${t.key}/new`)}>
              New {t.singular.toLowerCase()}
            </Button>
          )}
        </div>
      </div>
      <div className="row row-wrap" style={{ marginBottom: 14 }}>
        <div className="tabs">
          {[
            ["all", "All", total],
            ["published", "Published", counts.published],
            ["draft", "Drafts", counts.draft],
            ["review", "In review", counts.review],
            ["scheduled", "Scheduled", counts.scheduled],
          ].map(([k, l, n]) => (
            <button key={k as string} className={`tab ${status === k ? "active" : ""}`} onClick={() => setStatus(k as string)}>
              {l} <span className="count">{(n as number) ?? 0}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <select className="select" style={{ width: 170 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
          <option value="updated">Recently edited</option>
          <option value="published">Publish date</option>
          <option value="title">Title A–Z</option>
          <option value="manual">Manual order (drag)</option>
        </select>
        <div className="search-input" style={{ width: 240 }}>
          <Icon name="Search" size={15} />
          <input className="input" placeholder={`Search ${t?.name.toLowerCase() ?? ""}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {list.error ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : !list.data ? (
          <SkeletonRows rows={6} />
        ) : !items.length ? (
          q || status !== "all" ? (
            <Empty icon="Search" title="Nothing matches">Try another search or filter.</Empty>
          ) : (
            <Empty icon={t?.icon ?? "Layers"} title={`No ${t?.name.toLowerCase()} yet`} action={can("content.edit") && t ? <Button variant="primary" icon="Plus" onClick={() => nav(`/content/${t.key}/new`)}>Create the first one</Button> : undefined}>
              Items you create here can be shown on any page with a Content list widget.
            </Empty>
          )
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <input type="checkbox" className="checkbox" aria-label="Select all" checked={allChecked} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />
                  </th>
                  {sort === "manual" && <th style={{ width: 28 }} />}
                  <th>Title</th>
                  <th>Status</th>
                  <th>Tags</th>
                  <th>Updated</th>
                  <th><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr
                    key={i.id}
                    className={`clickable ${selected.has(i.id) ? "selected" : ""}`}
                    onClick={() => nav(`/content/${typeKey}/${i.id}`)}
                    draggable={sort === "manual"}
                    onDragStart={() => setDragId(i.id)}
                    onDragOver={(e) => sort === "manual" && e.preventDefault()}
                    onDrop={() => reorder(i.id)}
                    style={dragId === i.id ? { opacity: 0.4 } : undefined}
                  >
                    <td onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${i.title}`}
                        checked={selected.has(i.id)}
                        onChange={(e) => setSelected((s) => (e.target.checked ? s.add(i.id) : s.delete(i.id), new Set(s)))}
                      />
                    </td>
                    {sort === "manual" && (
                      <td style={{ cursor: "grab", color: "var(--text-3)" }}>
                        <Icon name="GripVertical" size={15} />
                      </td>
                    )}
                    <td>
                      <div className="row" style={{ gap: 12 }}>
                        {imageField && (i.data[imageField.key] ? <img className="thumb" src={i.data[imageField.key]} alt="" /> : <span className="thumb" style={{ display: "grid", placeItems: "center", color: "var(--text-3)" }}><Icon name="Image" size={14} /></span>)}
                        <div style={{ minWidth: 0 }}>
                          <div className="cell-title truncate" style={{ maxWidth: 420 }}>{i.title}</div>
                          <div className="subtle mono" style={{ fontSize: 12 }}>{i.slug}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={i.status} />
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                        {i.tags.slice(0, 3).map((tag) => (
                          <span key={tag} className="badge no-dot">{tag}</span>
                        ))}
                        {i.tags.length > 3 && <span className="subtle" style={{ fontSize: 12 }}>+{i.tags.length - 3}</span>}
                      </div>
                    </td>
                    <td className="subtle" style={{ whiteSpace: "nowrap", fontSize: 13 }}>
                      {timeAgo(i.updatedAt)}
                      {i.authorName && <div style={{ fontSize: 12 }}>{i.authorName}</div>}
                    </td>
                    <td className="cell-actions" onClick={(e) => e.stopPropagation()}>
                      <Menu
                        trigger={(open) => <Button size="sm" variant="ghost" iconOnly icon="MoreHorizontal" onClick={open} aria-label="Actions" />}
                        items={[
                          { label: "Edit", icon: "Pencil", onClick: () => nav(`/content/${typeKey}/${i.id}`) },
                          { label: "Preview", icon: "Eye", hidden: !t?.hasDetailPages, onClick: () => window.open(`/preview/item/${i.id}`, "_blank") },
                          { label: "View live", icon: "ExternalLink", hidden: !t?.hasDetailPages || i.status !== "published", onClick: () => window.open(`/${t?.urlPrefix}/${i.slug}`, "_blank") },
                          {
                            label: "Duplicate",
                            icon: "Copy",
                            onClick: async () => {
                              try {
                                const c = await api.post<ContentItem>(`/items/${i.id}/duplicate`);
                                toast.success("Duplicated");
                                nav(`/content/${typeKey}/${c.id}`);
                              } catch (e) {
                                toast.error(e);
                              }
                            },
                          },
                          { separator: true },
                          {
                            label: "Delete",
                            icon: "Trash2",
                            danger: true,
                            onClick: async () => {
                              if (!(await confirmDialog({ title: `Delete “${i.title}”?`, message: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
                              await api.del(`/items/${i.id}`).then(() => (toast.success("Deleted"), list.reload(), bus.emit("types-changed"))).catch(toast.error);
                            },
                          },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {selected.size > 0 && (
        <div className="bulk-bar">
          <strong>{selected.size} selected</strong>
          {can("content.publish") && <Button size="sm" icon="Send" onClick={() => bulk("publish")}>Publish</Button>}
          {can("content.publish") && <Button size="sm" icon="EyeOff" onClick={() => bulk("unpublish")}>Unpublish</Button>}
          <Button size="sm" icon="Trash2" onClick={() => bulk("delete")}>Delete</Button>
          <Button size="sm" iconOnly icon="X" aria-label="Clear selection" onClick={() => setSelected(new Set())} />
        </div>
      )}
    </div>
  );
}
