import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Icon } from "../lib/icons";
import { timeAgo, bytes } from "../lib/format";
import { Button, ErrorState, SkeletonRows, useLoad } from "../components/ui";

interface Dash {
  stats: Record<string, number>;
  views: { day: string; views: number }[];
  submissionsByDay: { day: string; count: number }[];
  topPages: { path: string; views: number }[];
  review: { kind: "page" | "item"; id: number; title: string; updatedAt: string; typeKey?: string; typeName?: string }[];
  drafts: { id: number; title: string; updatedAt: string; live: boolean; path: string }[];
  recentSubmissions: { id: number; formId: number; formName: string; data: Record<string, any>; createdAt: string; isRead: boolean }[];
  activity: { id: number; userName: string | null; action: string; entity: string; label: string; createdAt: string }[];
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
}

export function Dashboard() {
  const { user, can } = useAuth();
  const nav = useNavigate();
  const { data, error, reload } = useLoad(() => api.get<Dash>("/dashboard"));
  if (error) return <div className="page"><ErrorState message={error} onRetry={reload} /></div>;
  const s = data?.stats;
  const stat = (icon: string, color: string, label: string, value: React.ReactNode, meta: React.ReactNode, to?: string) => (
    <div className="card stat" style={{ cursor: to ? "pointer" : undefined }} onClick={() => to && nav(to)}>
      <div className="stat-label">
        <span className="stat-icon" style={{ background: `${color}1a`, color }}>
          <Icon name={icon} size={15} />
        </span>
        {label}
      </div>
      <div className="stat-value">{data ? value : <span className="skeleton" style={{ display: "inline-block", width: 60, height: 28 }} />}</div>
      <div className="stat-meta">{data ? meta : " "}</div>
    </div>
  );
  return (
    <div className="page">
      <div className="hero-card">
        <h2>
          {greeting()}, {user?.name.split(" ")[0]} 👋
        </h2>
        <p>Here's what's happening on your website. Jump back in or start something new.</p>
        <div className="row row-wrap">
          {can("pages.edit") && <Button className="btn-white" icon="FilePlus2" onClick={() => nav("/pages?new=1")}>New page</Button>}
          {can("content.edit") && <Button icon="Newspaper" onClick={() => nav("/content/news/new")}>Write news</Button>}
          <Button icon="Upload" onClick={() => nav("/media?upload=1")}>Upload media</Button>
          {can("code.edit") && <Button icon="CodeXml" onClick={() => nav("/code")}>Code Studio</Button>}
          <Button icon="Globe" onClick={() => window.open("/", "_blank")}>View site</Button>
        </div>
      </div>

      <div className="stat-grid">
        {stat("Files", "#e60000", "Pages", s?.pages, `${s?.livePages ?? 0} live`, "/pages")}
        {stat("Layers", "#9c2aa0", "Content items", s?.items, `${s?.liveItems ?? 0} published`, "/content")}
        {stat("Images", "#007c92", "Media files", s?.media, bytes(s?.mediaBytes ?? 0), "/media")}
        {stat("Inbox", "#248a3d", "Form responses", s?.submissions, s?.unread ? `${s.unread} unread` : "All caught up", "/forms")}
      </div>

      <div className="dash-grid">
        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Page views</div>
                <div className="subtle" style={{ fontSize: 12.5 }}>Last 14 days · {s?.views14 ?? 0} total</div>
              </div>
            </div>
            <div className="card-body">{data ? <AreaChart points={data.views.map((v) => ({ x: v.day, y: v.views }))} label="Page views" /> : <div className="skeleton" style={{ height: 150 }} />}</div>
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Needs your attention</div>
              {data && data.review.length > 0 && <span className="badge badge-warn">{data.review.length} in review</span>}
            </div>
            {!data ? (
              <SkeletonRows rows={3} />
            ) : data.review.length + data.drafts.length === 0 ? (
              <div className="empty" style={{ padding: 32 }}>
                <div className="empty-icon" style={{ background: "var(--success-soft)", color: "var(--success)" }}>
                  <Icon name="CircleCheck" size={22} />
                </div>
                <div className="empty-title">Everything is published</div>
              </div>
            ) : (
              <div className="list">
                {data.review.map((r) => (
                  <div key={`r${r.kind}${r.id}`} className="list-item" onClick={() => nav(r.kind === "page" ? `/pages/${r.id}` : `/content/${r.typeKey}/${r.id}`)}>
                    <span className="list-icon" style={{ background: "var(--warn-soft)", color: "var(--warn)" }}>
                      <Icon name="Eye" size={15} />
                    </span>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{r.title}</div>
                      <div className="subtle" style={{ fontSize: 12.5 }}>
                        {r.kind === "page" ? "Page" : r.typeName} waiting for approval · {timeAgo(r.updatedAt)}
                      </div>
                    </div>
                    <Button size="sm">Review</Button>
                  </div>
                ))}
                {data.drafts.map((d) => (
                  <div key={`d${d.id}`} className="list-item" onClick={() => nav(`/pages/${d.id}`)}>
                    <span className="list-icon">
                      <Icon name="FileText" size={15} />
                    </span>
                    <div className="grow">
                      <div style={{ fontWeight: 600 }}>{d.title}</div>
                      <div className="subtle" style={{ fontSize: 12.5 }}>
                        <span className="mono">{d.path}</span> · {d.live ? "unpublished changes" : "never published"} · {timeAgo(d.updatedAt)}
                      </div>
                    </div>
                    <Icon name="ChevronRight" size={16} className="subtle" />
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Latest form responses</div>
              <Button size="sm" variant="ghost" iconRight="ArrowRight" onClick={() => nav("/forms")}>All forms</Button>
            </div>
            {!data ? (
              <SkeletonRows rows={3} />
            ) : !data.recentSubmissions.length ? (
              <div className="empty" style={{ padding: 28 }}>No responses yet. Add a Form widget to a page to start collecting them.</div>
            ) : (
              <div className="list">
                {data.recentSubmissions.map((r) => {
                  const first = Object.values(r.data).find((v) => typeof v === "string" && v) as string | undefined;
                  return (
                    <div key={r.id} className="list-item" onClick={() => nav(`/forms/${r.formId}?tab=responses`)}>
                      <span className="list-icon" style={!r.isRead ? { background: "var(--accent-soft)", color: "var(--accent-text)" } : undefined}>
                        <Icon name="Mail" size={15} />
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="truncate" style={{ fontWeight: r.isRead ? 500 : 650 }}>{first ?? "(empty)"}</div>
                        <div className="subtle" style={{ fontSize: 12.5 }}>{r.formName}</div>
                      </div>
                      <span className="subtle" style={{ fontSize: 12 }}>{timeAgo(r.createdAt)}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="col" style={{ gap: 16 }}>
          <div className="card">
            <div className="card-header">
              <div className="card-title">Top pages</div>
              <span className="subtle" style={{ fontSize: 12.5 }}>14 days</span>
            </div>
            {!data ? (
              <SkeletonRows rows={4} />
            ) : !data.topPages.length ? (
              <div className="empty" style={{ padding: 28 }}>Views will appear here once people visit your site.</div>
            ) : (
              <div style={{ padding: "8px 18px 14px" }}>
                {data.topPages.map((p) => {
                  const max = data.topPages[0].views || 1;
                  return (
                    <div key={p.path} style={{ padding: "7px 0" }}>
                      <div className="row" style={{ fontSize: 13, marginBottom: 5 }}>
                        <a className="mono grow truncate" href={p.path} target="_blank" rel="noreferrer" style={{ color: "var(--text)" }}>{p.path}</a>
                        <strong>{p.views}</strong>
                      </div>
                      <div style={{ height: 6, borderRadius: 4, background: "var(--panel-3)" }}>
                        <div style={{ width: `${(p.views / max) * 100}%`, height: "100%", borderRadius: 4, background: "var(--accent)" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header">
              <div className="card-title">Recent activity</div>
              <Button size="sm" variant="ghost" iconRight="ArrowRight" onClick={() => nav("/activity")}>All</Button>
            </div>
            {!data ? (
              <SkeletonRows rows={6} />
            ) : (
              <div style={{ padding: "6px 0" }}>
                {data.activity.map((a) => (
                  <div key={a.id} className="timeline-item">
                    <span className="avatar avatar-sm">{(a.userName ?? "S")[0]}</span>
                    <div style={{ minWidth: 0 }}>
                      <strong>{a.userName ?? "System"}</strong> <span className="muted">{a.action}</span> <span className="truncate">{a.label}</span>
                    </div>
                    <time>{timeAgo(a.createdAt)}</time>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Single-series area chart with a hover crosshair and an accessible table. */
function AreaChart({ points, label }: { points: { x: string; y: number }[]; label: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 150;
  const pad = { l: 8, r: 8, t: 12, b: 22 };
  const max = Math.max(4, ...points.map((p) => p.y));
  const xs = (i: number) => pad.l + (i * (W - pad.l - pad.r)) / Math.max(1, points.length - 1);
  const ys = (v: number) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const line = points.map((p, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(p.y).toFixed(1)}`).join(" ");
  const area = `${line} L${xs(points.length - 1)},${H - pad.b} L${xs(0)},${H - pad.b} Z`;
  const fmt = (d: string) => new Date(d + "T00:00:00").toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const h = hover !== null ? points[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="chart"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label} per day for the last ${points.length} days`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(points.length - 1, Math.round(((x - pad.l) / (W - pad.l - pad.r)) * (points.length - 1)))));
        }}
      >
        <defs>
          <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
            <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1={pad.l} x2={W - pad.r} y1={H - pad.b} y2={H - pad.b} stroke="var(--border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        <path d={area} fill="url(#area-fill)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        {hover !== null && <line x1={xs(hover)} x2={xs(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--text-3)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
        {[0, Math.floor(points.length / 2), points.length - 1].map((i) => (
          <text key={i} x={xs(i)} y={H - 6} fontSize="10.5" fill="var(--text-3)" textAnchor={i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"}>
            {fmt(points[i].x)}
          </text>
        ))}
      </svg>
      {h && hover !== null && (
        <>
          <span style={{ position: "absolute", left: `${(xs(hover) / W) * 100}%`, top: `${(ys(h.y) / H) * 100}%`, width: 10, height: 10, borderRadius: "50%", background: "var(--accent)", border: "2px solid var(--panel)", transform: "translate(-50%,-50%)", pointerEvents: "none" }} />
          <div
            style={{
              position: "absolute",
              top: 0,
              left: `${(xs(hover) / W) * 100}%`,
              transform: `translateX(${hover > points.length / 2 ? "-105%" : "5%"})`,
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 9,
              padding: "6px 10px",
              boxShadow: "var(--shadow-md)",
              fontSize: 12.5,
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            <div className="subtle">{fmt(h.x)}</div>
            <strong>{h.y}</strong> <span className="muted">{label.toLowerCase()}</span>
          </div>
        </>
      )}
      <table className="sr-only">
        <caption>{label} per day</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.x}>
              <th>{p.x}</th>
              <td>{p.y}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
