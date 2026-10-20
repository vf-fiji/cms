import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { createBrowserRouter, Navigate, NavLink, Route, RouterProvider, Routes, useLocation, useNavigate, useRouteError } from "react-router-dom";
import { AuthProvider, useAuth, bus } from "./lib/auth";
import { Icon } from "./lib/icons";
import { api } from "./lib/api";
import { useTheme } from "./lib/theme";
import { initials } from "./lib/format";
import { Dialogs, Toasts, Spinner, Menu, useHotkey } from "./components/ui";
import { CommandPalette } from "./components/CommandPalette";
import { Login, ForgotPassword, ResetPassword } from "./views/Login";
import { Dashboard } from "./views/Dashboard";
import type { ContentType, Permission } from "../shared/types";

const Pages = lazy(() => import("./views/Pages").then((m) => ({ default: m.Pages })));
const SiteMap = lazy(() => import("./views/SiteMap").then((m) => ({ default: m.SiteMap })));
const PageEditor = lazy(() => import("./views/PageEditor").then((m) => ({ default: m.PageEditor })));
const ContentHome = lazy(() => import("./views/Content").then((m) => ({ default: m.ContentHome })));
const ContentList = lazy(() => import("./views/Content").then((m) => ({ default: m.ContentList })));
const ItemEditor = lazy(() => import("./views/ItemEditor").then((m) => ({ default: m.ItemEditor })));
const TypeBuilder = lazy(() => import("./views/TypeBuilder").then((m) => ({ default: m.TypeBuilder })));
const Media = lazy(() => import("./views/Media").then((m) => ({ default: m.Media })));
const Forms = lazy(() => import("./views/Forms").then((m) => ({ default: m.Forms })));
const FormBuilder = lazy(() => import("./views/Forms").then((m) => ({ default: m.FormBuilder })));
const Templates = lazy(() => import("./views/Templates").then((m) => ({ default: m.Templates })));
const CodeStudio = lazy(() => import("./views/CodeStudio").then((m) => ({ default: m.CodeStudio })));
const Taxonomies = lazy(() => import("./views/Taxonomies").then((m) => ({ default: m.Taxonomies })));
const Users = lazy(() => import("./views/Users").then((m) => ({ default: m.Users })));
const SettingsView = lazy(() => import("./views/Settings").then((m) => ({ default: m.Settings })));
const Activity = lazy(() => import("./views/Activity").then((m) => ({ default: m.Activity })));
const Account = lazy(() => import("./views/Account").then((m) => ({ default: m.Account })));

// A data router is required for useBlocker (unsaved-changes prompts).
const router = createBrowserRouter(
  [
    {
      path: "*",
      errorElement: <RouteError />,
      element: (
        <AuthProvider>
          <Gate />
          <Toasts />
          <Dialogs />
        </AuthProvider>
      ),
    },
  ],
  { basename: "/admin" },
);

/**
 * Friendly fallback for render errors. A failed code-chunk download (e.g. after
 * a deploy, or Vite re-optimising dependencies) is fixed by one automatic reload.
 */
function RouteError() {
  const error = useRouteError() as Error | undefined;
  const chunk = /dynamically imported module|Importing a module script failed|error loading dynamically/i.test(String(error?.message ?? error));
  useEffect(() => {
    if (!chunk) return;
    try {
      if (sessionStorage.getItem("reef-chunk-reload")) return;
      sessionStorage.setItem("reef-chunk-reload", "1");
    } catch {
      return;
    }
    window.location.reload();
  }, [chunk]);
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        sessionStorage.removeItem("reef-chunk-reload");
      } catch {
        /* ignore */
      }
    }, 10_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="center-fill" style={{ minHeight: "100vh" }}>
      <div className="card" style={{ maxWidth: 440, width: "100%" }}>
        <div className="empty">
          <div className="empty-icon">
            <Icon name={chunk ? "RotateCcw" : "CircleAlert"} size={24} />
          </div>
          <div className="empty-title">{chunk ? "Reef was updated" : "Something went wrong on this screen"}</div>
          <p>{chunk ? "Part of the app changed while it was open. Reload to get the latest version." : "Your work is saved. Reload to try again; if it keeps happening, the details below will help a developer."}</p>
          {!chunk && error?.message && <pre className="mono subtle" style={{ whiteSpace: "pre-wrap", fontSize: 12, maxWidth: "100%" }}>{error.message}</pre>}
          <button className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  return <RouterProvider router={router} />;
}

function Gate() {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <Spinner label="Starting Reef…" />;
  // Password recovery works whether or not someone is signed in on this browser.
  if (loc.pathname === "/forgot-password") return <ForgotPassword />;
  if (loc.pathname === "/reset-password") return <ResetPassword />;
  if (!user) {
    if (loc.pathname !== "/login") return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return <Login />;
  }
  if (loc.pathname === "/login") {
    const next = new URLSearchParams(loc.search).get("next");
    if (next?.startsWith("/preview/")) {
      window.location.href = next;
      return null;
    }
    return <Navigate to={next && next.startsWith("/") ? next : "/"} replace />;
  }
  return (
    <Suspense fallback={<Spinner />}>
      <Routes>
        {/* full-screen workspaces */}
        <Route path="/pages/:id" element={<Guard perm="pages.edit"><PageEditor /></Guard>} />
        <Route path="/code" element={<Guard perm="code.edit" alt="templates.edit"><CodeStudio /></Guard>} />
        <Route path="*" element={<Shell />} />
      </Routes>
    </Suspense>
  );
}

function Guard({ perm, alt, children }: { perm: Permission; alt?: Permission; children: ReactNode }) {
  const { can } = useAuth();
  if (!can(perm) && !(alt && can(alt)))
    return (
      <div className="page">
        <div className="card">
          <div className="empty">
            <div className="empty-icon">
              <Icon name="Lock" size={24} />
            </div>
            <div className="empty-title">You don't have access to this area</div>
            <p>Ask an administrator to add this permission to your role.</p>
          </div>
        </div>
      </div>
    );
  return <>{children}</>;
}

function Shell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const loc = useLocation();
  useHotkey("mod+k", (e) => {
    e.preventDefault();
    setPaletteOpen((o) => !o);
  });
  useEffect(() => setMobileNav(false), [loc.pathname]);
  return (
    <div className="app">
      <Sidebar open={mobileNav} onSearch={() => setPaletteOpen(true)} />
      <main className="main">
        <div className="mobile-bar">
          <button className="btn btn-ghost btn-icon" onClick={() => setMobileNav(true)} aria-label="Open navigation">
            <Icon name="Menu" />
          </button>
          <strong>Reef</strong>
        </div>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pages" element={<Guard perm="pages.edit"><Pages /></Guard>} />
            <Route path="/sitemap" element={<SiteMap />} />
            <Route path="/content" element={<ContentHome />} />
            <Route path="/content/:type" element={<ContentList />} />
            <Route path="/content/:type/:id" element={<Guard perm="content.edit"><ItemEditor /></Guard>} />
            <Route path="/types/:key" element={<Guard perm="content.types"><TypeBuilder /></Guard>} />
            <Route path="/media" element={<Media />} />
            <Route path="/forms" element={<Forms />} />
            <Route path="/forms/:id" element={<Guard perm="forms.manage" alt="forms.submissions"><FormBuilder /></Guard>} />
            <Route path="/templates" element={<Guard perm="templates.edit"><Templates /></Guard>} />
            <Route path="/taxonomies" element={<Taxonomies />} />
            <Route path="/users" element={<Guard perm="users.manage"><Users /></Guard>} />
            <Route path="/settings" element={<Guard perm="settings.manage"><SettingsView /></Guard>} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/account" element={<Account />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>
      {mobileNav && <div className="drawer-overlay" style={{ zIndex: 55 }} onClick={() => setMobileNav(false)} />}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}

function NotFound() {
  const nav = useNavigate();
  return (
    <div className="page">
      <div className="card">
        <div className="empty">
          <div className="empty-icon">
            <Icon name="CircleHelp" size={24} />
          </div>
          <div className="empty-title">That screen doesn't exist</div>
          <p>The link may be out of date.</p>
          <button className="btn btn-primary" onClick={() => nav("/")}>
            Go to dashboard
          </button>
        </div>
      </div>
    </div>
  );
}

function Sidebar({ open, onSearch }: { open: boolean; onSearch: () => void }) {
  const { user, can, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const loc = useLocation();
  const [types, setTypes] = useState<ContentType[]>([]);
  const [siteName, setSiteName] = useState("");
  const [unread, setUnread] = useState(0);
  const [contentOpen, setContentOpen] = useState(true);
  useEffect(() => {
    const load = () => {
      api.get<ContentType[]>("/types").then(setTypes).catch(() => {});
      api.get<any>("/settings").then((s) => setSiteName(s.siteName)).catch(() => {});
      api.get<any[]>("/forms").then((fs) => setUnread(fs.reduce((a, f) => a + (f.unread || 0), 0))).catch(() => {});
    };
    load();
    const offs = [bus.on("types-changed", load), bus.on("settings-changed", load), bus.on("forms-changed", load)];
    return () => offs.forEach((o) => o());
  }, []);
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const item = (to: string, icon: string, label: string, extra?: ReactNode, end = false) => (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`}>
      <Icon name={icon} size={17} />
      {label}
      {extra}
    </NavLink>
  );
  return (
    <aside className={`sidebar ${open ? "open" : ""}`}>
      <div className="brand">
        <div className="brand-mark">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M3 16c3-7 6.5-10 9-10s3.5 5 9 5" />
          </svg>
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="brand-name">Reef</div>
          <div className="brand-site truncate">{siteName || "Content management"}</div>
        </div>
        <a className="btn btn-ghost btn-icon btn-sm" href="/" target="_blank" rel="noreferrer" title="View live site">
          <Icon name="ExternalLink" size={15} />
        </a>
      </div>
      <button className="search-trigger" onClick={onSearch}>
        <Icon name="Search" size={15} />
        Search or jump to…
        <span className="kbd">{isMac ? "⌘" : "Ctrl"} K</span>
      </button>
      <nav className="nav" aria-label="Admin">
        {item("/", "LayoutDashboard", "Dashboard", null, true)}
        <div className="nav-group">
          <div className="nav-group-label">Website</div>
          {can("pages.edit") && item("/pages", "Files", "Pages")}
          {item("/sitemap", "Map", "Site map")}
          <button className={`nav-item ${loc.pathname.startsWith("/content") ? "active" : ""}`} onClick={() => (setContentOpen(true), nav("/content"))}>
            <Icon name="Layers" size={17} />
            Content
            <span
              className="count"
              role="button"
              aria-label={contentOpen ? "Collapse" : "Expand"}
              onClick={(e) => {
                e.stopPropagation();
                setContentOpen((o) => !o);
              }}
            >
              <Icon name={contentOpen ? "ChevronDown" : "ChevronRight"} size={14} />
            </span>
          </button>
          {contentOpen && types.length > 0 && (
            <div className="nav-sub">
              {types.map((t) => (
                <NavLink key={t.key} to={`/content/${t.key}`} className={({ isActive }) => `nav-item ${isActive || loc.pathname.startsWith(`/content/${t.key}/`) ? "active" : ""}`}>
                  <span className="nav-dot" style={{ background: t.color }} />
                  <span className="truncate">{t.name}</span>
                  <span className="count">{t.itemCount}</span>
                </NavLink>
              ))}
            </div>
          )}
          {item("/media", "Images", "Media")}
          {item("/forms", "ClipboardList", "Forms", unread ? <span className="count hot">{unread}</span> : null)}
          {item("/taxonomies", "Tags", "Tags & categories")}
        </div>
        {(can("templates.edit") || can("code.edit") || can("content.types")) && (
          <div className="nav-group">
            <div className="nav-group-label">Build</div>
            {can("templates.edit") && item("/templates", "LayoutTemplate", "Templates")}
            {can("code.edit") && item("/code", "CodeXml", "Code Studio")}
            {can("content.types") && (
              <NavLink to="/types/new" className={({ isActive }) => `nav-item ${isActive || loc.pathname.startsWith("/types") ? "active" : ""}`}>
                <Icon name="Box" size={17} />
                Content types
              </NavLink>
            )}
          </div>
        )}
        <div className="nav-group">
          <div className="nav-group-label">Admin</div>
          {can("users.manage") && item("/users", "Users", "Users & roles")}
          {can("settings.manage") && item("/settings", "Settings", "Settings")}
          {item("/activity", "History", "Activity")}
        </div>
      </nav>
      <div className="sidebar-footer">
        <Menu
          align="left"
          trigger={(openMenu) => (
            <button className="user-chip" onClick={openMenu}>
              <span className="avatar">{initials(user?.name ?? "?")}</span>
              <span className="grow" style={{ minWidth: 0 }}>
                <div className="truncate" style={{ fontWeight: 600, fontSize: 13 }}>
                  {user?.name}
                </div>
                <div className="truncate subtle" style={{ fontSize: 12 }}>
                  {user?.roleName}
                </div>
              </span>
              <Icon name="MoreHorizontal" size={16} className="subtle" />
            </button>
          )}
          items={[
            { heading: user?.email },
            { label: "Account & password", icon: "KeyRound", onClick: () => nav("/account") },
            { label: theme === "dark" ? "Light mode" : "Dark mode", icon: theme === "dark" ? "Sun" : "Moon", onClick: toggle },
            { label: "View live site", icon: "Globe", onClick: () => window.open("/", "_blank") },
            { separator: true },
            { label: "Sign out", icon: "LogOut", danger: true, onClick: logout },
          ]}
        />
      </div>
    </aside>
  );
}
