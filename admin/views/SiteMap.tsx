import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { SiteGraph, SiteGraphNode } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { BRAND_RED, GROUP_COLORS, groupOf, SiteMapScene, type SceneOptions } from "../lib/sitemap3d";
import { Button, Spinner, ErrorState, useLoad } from "../components/ui";

const KIND_LABEL: Record<SiteGraphNode["kind"], string> = { home: "Homepage", page: "Page", type: "Content type", item: "Content item", form: "Form" };
const KIND_ICON: Record<SiteGraphNode["kind"], string> = { home: "Home", page: "FileText", type: "Layers", item: "Bookmark", form: "ClipboardList" };

function statusText(n: SiteGraphNode) {
  if (n.kind === "form") return n.live ? "On a page" : "Not used on any page";
  if (n.kind === "type") return `${n.size ?? 0} items`;
  if (!n.live) return n.status === "review" ? "In review" : n.status === "scheduled" ? "Scheduled" : "Draft";
  return n.changesPending ? "Live · changes pending" : "Live";
}

export function SiteMap() {
  const nav = useNavigate();
  const host = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SiteMapScene | null>(null);
  const { data: graph, error, reload } = useLoad(() => api.get<SiteGraph>("/site-graph"));
  const [opts, setOpts] = useState<SceneOptions>(() => ({
    showItems: true,
    showForms: true,
    showLinks: true,
    showLabels: true,
    autoRotate: !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  }));
  const [hover, setHover] = useState<{ n: SiteGraphNode; x: number; y: number } | null>(null);
  const [selected, setSelected] = useState<SiteGraphNode | null>(null);
  const [q, setQ] = useState("");
  const [listOpen, setListOpen] = useState(false);
  const [webglError, setWebglError] = useState(false);

  // create the scene once
  useEffect(() => {
    if (!host.current || !graph) return;
    let scene: SiteMapScene;
    try {
      scene = new SiteMapScene(host.current);
    } catch {
      setWebglError(true);
      return;
    }
    sceneRef.current = scene;
    scene.onHover = (n, x, y) => setHover(n ? { n, x, y } : null);
    scene.onSelect = (n) => setSelected(n);
    scene.onOpen = (n) => nav(n.href);
    scene.setData(graph, opts);
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  useEffect(() => {
    sceneRef.current?.setOptions(opts);
  }, [opts]);

  const focus = (n: SiteGraphNode) => {
    setSelected(n);
    sceneRef.current?.focus(n.id);
  };

  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s || !graph) return [];
    return graph.nodes.filter((n) => n.label.toLowerCase().includes(s) || n.path?.toLowerCase().includes(s)).slice(0, 8);
  }, [q, graph]);

  const tree = useMemo(() => {
    if (!graph) return [];
    const kids = new Map<string, string[]>();
    for (const e of graph.edges) if (e.kind === "child") (kids.get(e.source) ?? kids.set(e.source, []).get(e.source)!).push(e.target);
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const rows: { n: SiteGraphNode; depth: number }[] = [];
    const walk = (id: string, depth: number) => {
      const n = byId.get(id);
      if (!n) return;
      rows.push({ n, depth });
      for (const k of kids.get(id) ?? []) walk(k, depth + 1);
    };
    const home = graph.nodes.find((n) => n.kind === "home");
    if (home) walk(home.id, 0);
    for (const n of graph.nodes) if (n.kind === "type" || n.kind === "form") rows.push({ n, depth: 0 });
    return rows;
  }, [graph]);

  const toggle = (k: keyof SceneOptions) => setOpts((o) => ({ ...o, [k]: !o[k] }));
  const connections = selected && graph ? graph.edges.filter((e) => e.source === selected.id || e.target === selected.id).length : 0;

  return (
    <div className="sitemap">
      <div ref={host} className="sitemap-stage" role="img" aria-label="3D map of the website's pages, content and forms. Use the list view for an accessible outline." />
      {!graph && !error && <div className="sitemap-center"><Spinner label="Mapping your site…" /></div>}
      {error && <div className="sitemap-center"><ErrorState message={error} onRetry={reload} /></div>}
      {webglError && (
        <div className="sitemap-center">
          <ErrorState message="Your browser couldn't start 3D graphics (WebGL). The list view still shows every page." />
        </div>
      )}

      {/* header */}
      <div className="sitemap-panel sitemap-head">
        <div className="row" style={{ gap: 10 }}>
          <span className="sitemap-logo"><Icon name="Globe" size={16} /></span>
          <div>
            <h1 className="sitemap-title" style={{ margin: 0 }}>Site map</h1>
            {graph && (
              <div className="sitemap-sub">
                {graph.stats.pages} pages · {graph.stats.types} content types · {graph.stats.totalItems} items · {graph.stats.forms} forms
              </div>
            )}
          </div>
        </div>
        <div className="sitemap-search">
          <Icon name="Search" size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a page…" aria-label="Find a page or content" onKeyDown={(e) => e.key === "Enter" && matches[0] && (focus(matches[0]), setQ(""))} />
          {matches.length > 0 && (
            <div className="sitemap-results" role="listbox">
              {matches.map((n) => (
                <button key={n.id} role="option" aria-selected="false" onClick={() => (focus(n), setQ(""))}>
                  <Shape n={n} />
                  <span className="grow truncate">{n.label}</span>
                  <span className="sitemap-dim">{KIND_LABEL[n.kind]}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* filters */}
      <div className="sitemap-panel sitemap-tools" role="toolbar" aria-label="Map options">
        {(
          [
            ["showItems", "Items", "Bookmark"],
            ["showForms", "Forms", "ClipboardList"],
            ["showLinks", "Links", "Link"],
            ["showLabels", "Labels", "Type"],
            ["autoRotate", "Orbit", "RotateCcw"],
          ] as const
        ).map(([k, label, icon]) => (
          <button key={k} className={`sitemap-chip ${opts[k] ? "on" : ""}`} aria-pressed={opts[k]} onClick={() => toggle(k)}>
            <Icon name={icon} size={13} /> {label}
          </button>
        ))}
        <span className="sitemap-sep" />
        <button className="sitemap-chip" onClick={() => (setSelected(null), sceneRef.current?.resetView())}>
          <Icon name="Home" size={13} /> Reset
        </button>
        <button className={`sitemap-chip ${listOpen ? "on" : ""}`} aria-pressed={listOpen} onClick={() => setListOpen((v) => !v)}>
          <Icon name="List" size={13} /> List
        </button>
      </div>

      {/* hover tooltip */}
      {hover && hover.n.id !== selected?.id && (
        <div className="sitemap-tip" style={{ left: hover.x + 16, top: hover.y + 16 }}>
          <div className="row" style={{ gap: 8 }}>
            <Shape n={hover.n} />
            <strong className="truncate">{hover.n.label}</strong>
          </div>
          <div className="sitemap-dim">{KIND_LABEL[hover.n.kind]} · {statusText(hover.n)}</div>
          {hover.n.path && <div className="mono sitemap-dim">{hover.n.path}</div>}
          <div className="sitemap-hint">Click to focus · double-click to edit</div>
        </div>
      )}

      {/* selection panel */}
      {selected && (
        <div className="sitemap-panel sitemap-detail" aria-live="polite">
          <div className="row" style={{ gap: 10, alignItems: "flex-start" }}>
            <span className="sitemap-detail-icon" style={{ background: `${selected.kind === "home" ? BRAND_RED : GROUP_COLORS[groupOf(selected)]}2e`, color: selected.kind === "home" ? "#ff6961" : GROUP_COLORS[groupOf(selected)] }}>
              <Icon name={KIND_ICON[selected.kind]} size={18} />
            </span>
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="sitemap-dim" style={{ fontSize: 12 }}>{KIND_LABEL[selected.kind]}</div>
              <div className="sitemap-title truncate">{selected.label}</div>
              {selected.path && <div className="mono sitemap-dim truncate" style={{ fontSize: 12 }}>{selected.path}</div>}
            </div>
            <button className="sitemap-x" aria-label="Close" onClick={() => (setSelected(null), sceneRef.current?.focus(null))}>
              <Icon name="X" size={15} />
            </button>
          </div>
          <div className="sitemap-facts">
            <div><span>Status</span><strong>{statusText(selected)}</strong></div>
            {(selected.kind === "page" || selected.kind === "home") && <div><span>Views (30 days)</span><strong>{selected.views ?? 0}</strong></div>}
            {(selected.kind === "page" || selected.kind === "home") && <div><span>Blocks</span><strong>{selected.size ?? 0}</strong></div>}
            {selected.kind === "form" && <div><span>Responses</span><strong>{selected.size ?? 0}</strong></div>}
            <div><span>Connections</span><strong>{connections}</strong></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Button size="sm" variant="primary" icon="Pencil" onClick={() => nav(selected.href)}>
              {selected.kind === "type" ? "Open list" : selected.kind === "form" ? "Open form" : "Edit"}
            </Button>
            {selected.live && selected.path && (
              <Button size="sm" icon="ExternalLink" onClick={() => window.open(selected.path, "_blank")}>View live</Button>
            )}
          </div>
        </div>
      )}

      {/* legend */}
      <div className="sitemap-panel sitemap-legend" aria-label="Legend">
        <div className="sitemap-legend-row"><span className="lg-shape sphere" style={{ background: GROUP_COLORS.page }} /> Page <span className="sitemap-dim">· size = views</span></div>
        <div className="sitemap-legend-row"><span className="lg-shape sphere home" style={{ background: GROUP_COLORS.page, boxShadow: `0 0 0 3px ${BRAND_RED}88` }} /> Homepage</div>
        <div className="sitemap-legend-row"><span className="lg-shape octa" style={{ background: GROUP_COLORS.content }} /> Content type</div>
        <div className="sitemap-legend-row"><span className="lg-shape small" style={{ background: GROUP_COLORS.content }} /> Content item</div>
        <div className="sitemap-legend-row"><span className="lg-shape cube" style={{ background: GROUP_COLORS.form }} /> Form</div>
        <div className="sitemap-legend-sep" />
        <div className="sitemap-legend-row"><span className="lg-line" /> Sub-page / shows</div>
        <div className="sitemap-legend-row"><span className="lg-line dashed" /> Internal link</div>
        <div className="sitemap-legend-row"><span className="lg-shape sphere hollow" /> Draft (hollow)</div>
        <div className="sitemap-legend-row"><span className="lg-shape sphere ringed" /> Unpublished changes</div>
      </div>

      {/* list view: an accessible outline of the same data */}
      <nav className={`sitemap-panel sitemap-list ${listOpen ? "open" : ""}`} aria-label="Site outline">
        <div className="sitemap-title" style={{ marginBottom: 8 }}>Outline</div>
        <ul>
          {tree.map(({ n, depth }) => (
            <li key={n.id} style={{ paddingLeft: depth * 14 }}>
              <button onClick={() => focus(n)}>
                <Shape n={n} />
                <span className="grow truncate">{n.label}</span>
                <span className="sitemap-dim">{n.kind === "type" ? `${n.size} items` : n.kind === "form" ? "form" : n.live ? "" : "draft"}</span>
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {graph && !graph.nodes.length && (
        <div className="sitemap-center">
          <div className="sitemap-panel" style={{ padding: 24, textAlign: "center" }}>
            Nothing to map yet. <Button size="sm" variant="primary" onClick={() => nav("/pages?new=1")}>Create a page</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Shape({ n }: { n: SiteGraphNode }) {
  const cls = n.kind === "type" ? "octa" : n.kind === "item" ? "small" : n.kind === "form" ? "cube" : "sphere";
  return <span className={`lg-shape ${cls}${n.live ? "" : " hollow"}`} style={n.live ? { background: GROUP_COLORS[groupOf(n)] } : { borderColor: GROUP_COLORS[groupOf(n)] }} aria-hidden="true" />;
}
