import { useState } from "react";
import type { Activity as ActivityRow } from "../../shared/types";
import { api } from "../lib/api";
import { formatDate, timeAgo, initials } from "../lib/format";
import { Button, ErrorState, SkeletonRows, useLoad } from "../components/ui";

export function Activity() {
  const [limit, setLimit] = useState(50);
  const { data, error, reload } = useLoad(() => api.get<{ items: ActivityRow[]; total: number }>(`/activity?limit=${limit}`), [limit]);
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Activity</h1>
          <div className="page-sub">An audit trail of who changed what, and when.</div>
        </div>
      </div>
      <div className="card">
        {error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <SkeletonRows rows={8} />
        ) : (
          <div className="list">
            {data.items.map((a) => (
              <div key={a.id} className="list-item" style={{ cursor: "default" }}>
                <span className="avatar avatar-sm">{initials(a.userName ?? "System")}</span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <strong>{a.userName ?? "System"}</strong> <span className="muted">{a.action}</span> <span className="badge no-dot">{a.entity}</span> <span className="truncate">{a.label}</span>
                </div>
                <span className="subtle" style={{ fontSize: 12.5, whiteSpace: "nowrap" }} title={formatDate(a.createdAt, true)}>{timeAgo(a.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {data && data.total > data.items.length && (
        <div style={{ textAlign: "center", marginTop: 16 }}>
          <Button onClick={() => setLimit((l) => l + 50)}>Load more</Button>
        </div>
      )}
    </div>
  );
}
