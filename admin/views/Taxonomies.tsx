import { useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { Button, confirmDialog, Empty, ErrorState, promptDialog, SkeletonRows, toast, useLoad } from "../components/ui";

interface Term {
  id: number;
  name: string;
  slug: string;
  description: string;
  count: number;
}

export function Taxonomies() {
  const { can } = useAuth();
  const [tax, setTax] = useState<"tags" | "categories">("tags");
  const [q, setQ] = useState("");
  const { data, error, reload } = useLoad(() => api.get<Term[]>(`/terms?taxonomy=${tax}`), [tax]);
  const label = tax === "tags" ? "tag" : "category";
  const add = async () => {
    const name = await promptDialog({ title: `New ${label}`, label: "Name", confirmLabel: "Add" });
    if (!name) return;
    api.post("/terms", { taxonomy: tax, name }).then(() => (toast.success(`Added “${name}”`), reload())).catch(toast.error);
  };
  const rename = async (t: Term) => {
    const name = await promptDialog({ title: `Rename ${label}`, label: "Name", initial: t.name, message: t.count ? `${t.count} item(s) will be updated automatically.` : undefined, confirmLabel: "Rename" });
    if (!name || name === t.name) return;
    api.put(`/terms/${t.id}`, { name, description: t.description }).then(() => (toast.success("Renamed"), reload())).catch(toast.error);
  };
  const remove = async (t: Term) => {
    if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: "Items keep the label, but it won't be suggested any more.", confirmLabel: "Delete", danger: true }))) return;
    api.del(`/terms/${t.id}`).then(reload).catch(toast.error);
  };
  const list = (data ?? []).filter((t) => t.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Tags & categories</h1>
          <div className="page-sub">Shared labels for organising content. Content lists can filter by them.</div>
        </div>
        {can("content.edit") && <Button variant="primary" icon="Plus" onClick={add}>New {label}</Button>}
      </div>
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="tabs">
          <button className={`tab ${tax === "tags" ? "active" : ""}`} onClick={() => setTax("tags")}><Icon name="Tags" size={14} /> Tags</button>
          <button className={`tab ${tax === "categories" ? "active" : ""}`} onClick={() => setTax("categories")}><Icon name="Folder" size={14} /> Categories</button>
        </div>
        <div className="spacer" />
        <div className="search-input" style={{ width: 240 }}>
          <Icon name="Search" size={15} />
          <input className="input" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <div className="card" style={{ overflow: "hidden" }}>
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows />
        ) : !list.length ? (
          <Empty icon="Tags" title={`No ${tax} yet`}>Labels you type on content items also show up here as suggestions once added.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Used by</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.id}>
                  <td className="cell-title">{t.name}</td>
                  <td className="mono subtle">{t.slug}</td>
                  <td>{t.count} item{t.count === 1 ? "" : "s"}</td>
                  <td className="cell-actions">
                    {can("content.edit") && (
                      <>
                        <Button size="sm" variant="ghost" icon="Pencil" onClick={() => rename(t)}>Rename</Button>
                        <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Delete" onClick={() => remove(t)} />
                      </>
                    )}
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
