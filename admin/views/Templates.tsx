import { useNavigate } from "react-router-dom";
import type { Template } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { timeAgo } from "../lib/format";
import { Button, confirmDialog, ErrorState, Menu, promptDialog, SkeletonRows, toast, useLoad } from "../components/ui";

export function Templates() {
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<(Template & { pageCount: number })[]>("/templates"));
  const create = async (copyFrom?: number) => {
    const name = await promptDialog({ title: copyFrom ? "Duplicate template" : "New template", label: "Template name", confirmLabel: "Create" });
    if (!name) return;
    try {
      const t = await api.post<Template>("/templates", { name, copyFrom });
      nav(`/code?tpl=${t.id}`);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">Templates</h1>
          <div className="page-sub">Templates wrap every page with your header, navigation and footer. Each page chooses one.</div>
        </div>
        <Button variant="primary" icon="Plus" onClick={() => create()}>New template</Button>
      </div>
      {error ? (
        <ErrorState message={error} onRetry={reload} />
      ) : !data ? (
        <SkeletonRows />
      ) : (
        <div className="cards-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))" }}>
          {data.map((t) => (
            <div key={t.id} className="card" style={{ overflow: "hidden" }}>
              <div style={{ height: 170, background: "var(--panel-3)", position: "relative", overflow: "hidden", borderBottom: "1px solid var(--border)" }}>
                <TemplateSketch />
                {t.isDefault && <span className="badge badge-success" style={{ position: "absolute", top: 12, left: 12 }}>Default</span>}
              </div>
              <div className="card-body row">
                <div className="grow">
                  <div style={{ fontWeight: 650 }}>{t.name}</div>
                  <div className="subtle" style={{ fontSize: 12.5 }}>Used by {t.pageCount} page{t.pageCount === 1 ? "" : "s"} · edited {timeAgo(t.updatedAt)}</div>
                </div>
                <Button size="sm" icon="CodeXml" onClick={() => nav(`/code?tpl=${t.id}`)}>Edit code</Button>
                <Menu
                  trigger={(o) => <Button size="sm" variant="ghost" iconOnly icon="MoreHorizontal" onClick={o} aria-label="More" />}
                  items={[
                    { label: "Duplicate", icon: "Copy", onClick: () => create(t.id) },
                    { label: "Make default", icon: "Star", hidden: t.isDefault, onClick: () => api.post(`/templates/${t.id}/default`).then(() => (toast.success(`“${t.name}” is now the default`), reload())).catch(toast.error) },
                    { separator: true, hidden: t.isDefault },
                    {
                      label: "Delete",
                      icon: "Trash2",
                      danger: true,
                      hidden: t.isDefault,
                      onClick: async () => {
                        if (!(await confirmDialog({ title: `Delete “${t.name}”?`, message: t.pageCount ? `${t.pageCount} page(s) use it and will switch to the default template.` : undefined, confirmLabel: "Delete", danger: true }))) return;
                        api.del(`/templates/${t.id}`).then(() => (toast.success("Template deleted"), reload())).catch(toast.error);
                      },
                    },
                  ]}
                />
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="alert alert-info" style={{ marginTop: 20 }}>
        <Icon name="Info" size={16} />
        <div>
          Templates are Liquid HTML. Put <code className="mono">{"{{ content }}"}</code> where the page body should go. Variables include <code className="mono">site</code>, <code className="mono">page</code> and <code className="mono">nav</code>.
        </div>
      </div>
    </div>
  );
}

function TemplateSketch() {
  return (
    <svg viewBox="0 0 320 170" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <rect x="24" y="18" width="272" height="160" rx="10" fill="var(--panel)" stroke="var(--border)" />
      <rect x="36" y="30" width="40" height="8" rx="4" fill="var(--accent)" opacity=".8" />
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={170 + i * 30} y="31" width="22" height="6" rx="3" fill="var(--border-strong)" />
      ))}
      <rect x="36" y="50" width="248" height="56" rx="8" fill="var(--accent-soft)" />
      <rect x="48" y="64" width="110" height="10" rx="5" fill="var(--accent)" opacity=".55" />
      <rect x="48" y="80" width="80" height="6" rx="3" fill="var(--accent)" opacity=".3" />
      <rect x="36" y="116" width="78" height="40" rx="6" fill="var(--panel-3)" />
      <rect x="121" y="116" width="78" height="40" rx="6" fill="var(--panel-3)" />
      <rect x="206" y="116" width="78" height="40" rx="6" fill="var(--panel-3)" />
    </svg>
  );
}
