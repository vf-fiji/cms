import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { useTheme } from "../lib/theme";

interface Row {
  id: string;
  section: string;
  icon: string;
  title: string;
  sub?: string;
  run: () => void;
}

const KIND_ICON: Record<string, string> = { page: "FileText", item: "Layers", media: "Image", form: "ClipboardList", code: "CodeXml" };

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { can } = useAuth();
  const { toggle } = useTheme();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<any[]>([]);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const go = (to: string) => {
    onClose();
    nav(to);
  };

  const actions: Row[] = useMemo(
    () =>
      [
        { id: "a-dash", icon: "LayoutDashboard", title: "Go to dashboard", run: () => go("/") },
        can("pages.edit") && { id: "a-pages", icon: "Files", title: "Go to pages", run: () => go("/pages") },
        can("pages.edit") && { id: "a-newpage", icon: "FilePlus2", title: "Create a new page", run: () => go("/pages?new=1") },
        { id: "a-sitemap", icon: "Map", title: "Open the 3D site map", run: () => go("/sitemap") },
        { id: "a-content", icon: "Layers", title: "Go to content", run: () => go("/content") },
        { id: "a-media", icon: "Images", title: "Open media library", run: () => go("/media") },
        { id: "a-forms", icon: "ClipboardList", title: "Go to forms", run: () => go("/forms") },
        can("content.types") && { id: "a-type", icon: "Box", title: "Create a content type", run: () => go("/types/new") },
        can("code.edit") && { id: "a-code", icon: "CodeXml", title: "Open Code Studio", run: () => go("/code") },
        can("templates.edit") && { id: "a-tpl", icon: "LayoutTemplate", title: "Edit templates", run: () => go("/templates") },
        can("settings.manage") && { id: "a-settings", icon: "Settings", title: "Site settings", run: () => go("/settings") },
        can("users.manage") && { id: "a-users", icon: "Users", title: "Manage users & roles", run: () => go("/users") },
        { id: "a-theme", icon: "Moon", title: "Toggle dark mode", run: () => (toggle(), onClose()) },
        { id: "a-site", icon: "Globe", title: "View live site", run: () => (window.open("/", "_blank"), onClose()) },
      ]
        .filter(Boolean)
        .map((a) => ({ ...(a as Row), section: "Actions" })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  useEffect(() => {
    if (!q.trim()) return setResults([]);
    const t = setTimeout(() => {
      api.get<{ results: any[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => setResults(r.results)).catch(() => {});
    }, 120);
    return () => clearTimeout(t);
  }, [q]);

  const rows: Row[] = useMemo(() => {
    const ql = q.toLowerCase();
    const acts = actions.filter((a) => !ql || a.title.toLowerCase().includes(ql));
    const found = results.map((r) => ({
      id: `${r.kind}-${r.id}`,
      section: "Results",
      icon: KIND_ICON[r.kind] ?? "FileText",
      title: r.title,
      sub: r.subtitle,
      run: () => go(r.href),
    }));
    return [...found, ...acts];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, q, actions]);

  useEffect(() => setActive(0), [rows.length]);
  useEffect(() => {
    listRef.current?.querySelector(".palette-row.active")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") (e.preventDefault(), setActive((a) => Math.min(rows.length - 1, a + 1)));
    else if (e.key === "ArrowUp") (e.preventDefault(), setActive((a) => Math.max(0, a - 1)));
    else if (e.key === "Enter") rows[active]?.run();
    else if (e.key === "Escape") onClose();
  };

  let lastSection = "";
  return createPortal(
    <div className="overlay" style={{ paddingTop: "12vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="Search" size={18} className="subtle" />
          <input autoFocus placeholder="Search pages, content, media… or type a command" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
          <span className="kbd">Esc</span>
        </div>
        <div className="palette-list" ref={listRef}>
          {rows.length === 0 && <div className="empty" style={{ padding: 32 }}>No matches for “{q}”</div>}
          {rows.map((r, i) => {
            const header = r.section !== lastSection ? <div className="palette-section">{r.section}</div> : null;
            lastSection = r.section;
            return (
              <div key={r.id}>
                {header}
                <div className={`palette-row ${i === active ? "active" : ""}`} onMouseMove={() => setActive(i)} onClick={r.run}>
                  <span className="palette-row-icon">
                    <Icon name={r.icon} size={15} />
                  </span>
                  <span className="palette-row-title truncate">{r.title}</span>
                  {r.sub && <span className="palette-row-sub truncate">{r.sub}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="palette-foot">
          <span>
            <span className="kbd">↑</span> <span className="kbd">↓</span> to navigate
          </span>
          <span>
            <span className="kbd">Enter</span> to open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
