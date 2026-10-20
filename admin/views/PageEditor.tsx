import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { CustomWidget, FieldDef, Page, PageLayout, PageSeo, Revision, SectionNode, Template, WidgetNode } from "../../shared/types";
import { BUILTIN_WIDGETS, COLUMN_LAYOUTS, COMMON_WIDGET_FIELDS, SECTION_FIELDS, getWidgetDef, makeWidget, cloneWithNewIds } from "../../shared/widgets";
import { api, ApiError } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { timeAgo, slugify } from "../lib/format";
import * as L from "../lib/layout";
import { Button, confirmDialog, Drawer, Field, Menu, Spinner, StatusBadge, Switch, toast, ErrorState, useProChrome, press } from "../components/ui";
import { FieldsForm, ImageField } from "../components/FieldEditor";
import { CodeEditor } from "../components/CodeEditor";

interface Doc {
  title: string;
  slug: string;
  parentId: number | null;
  templateId: number | null;
  showInNav: boolean;
  seo: PageSeo;
  layout: PageLayout;
  customCss: string;
  customJs: string;
  customHead: string;
  publishAt: string | null;
}

type SaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
type Device = "desktop" | "tablet" | "mobile";

const docOf = (p: Page): Doc => ({
  title: p.title,
  slug: p.slug,
  parentId: p.parentId,
  templateId: p.templateId,
  showInNav: p.showInNav,
  seo: p.seo ?? {},
  layout: p.layout ?? { sections: [] },
  customCss: p.customCss ?? "",
  customJs: p.customJs ?? "",
  customHead: p.customHead ?? "",
  publishAt: p.publishAt,
});

const PHONE_QUERY = "(max-width: 760px)";
const isPhone = () => window.matchMedia?.(PHONE_QUERY).matches ?? false;
function usePhone() {
  const [phone, setPhone] = useState(isPhone);
  useEffect(() => {
    const m = window.matchMedia?.(PHONE_QUERY);
    if (!m) return;
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

export function PageEditor() {
  useProChrome();
  const { id } = useParams();
  const pageId = Number(id);
  const nav = useNavigate();
  const { can } = useAuth();
  const [page, setPage] = useState<Page | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [device, setDevice] = useState<Device>("desktop");
  const [leftTab, setLeftTab] = useState<"add" | "outline">("add");
  const phone = usePhone();
  const [showLeft, setShowLeft] = useState(() => !isPhone());
  const [showRight, setShowRight] = useState(() => !isPhone());
  // phone: leaving or entering phone width resets the panels; picking a block opens its properties
  useEffect(() => {
    setShowLeft(!phone);
    setShowRight(!phone);
  }, [phone]);
  useEffect(() => {
    if (phone && selected) {
      setShowLeft(false);
      setShowRight(true);
    }
  }, [phone, selected]);
  const [settingsOpen, setSettingsOpen] = useState<null | "general" | "seo" | "code" | "history">(null);
  const [customWidgets, setCustomWidgets] = useState<CustomWidget[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [allPages, setAllPages] = useState<{ id: number; title: string; path: string }[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [canvasReady, setCanvasReady] = useState(false);

  const history = useRef<{ past: Doc[]; future: Doc[]; lastKey: string | null; lastAt: number }>({ past: [], future: [], lastKey: null, lastAt: 0 });
  const [, forceHistory] = useState(0);
  const docRef = useRef<Doc | null>(null);
  docRef.current = doc;
  const baseUpdatedAt = useRef<string>("");
  const saveTimer = useRef<number | undefined>(undefined);
  const iframe = useRef<HTMLIFrameElement>(null);
  const shellKey = useRef<string>("");
  const clipboard = useRef<WidgetNode | SectionNode | null>(null);

  // ---------- load ----------
  useEffect(() => {
    let alive = true;
    Promise.all([api.get<Page>(`/pages/${pageId}`), api.get<CustomWidget[]>("/widgets"), api.get<Template[]>("/templates"), api.get<any[]>("/pages")])
      .then(([p, cw, tpl, pages]) => {
        if (!alive) return;
        setPage(p);
        setDoc(docOf(p));
        baseUpdatedAt.current = p.updatedAt;
        setCustomWidgets(cw);
        setTemplates(tpl);
        setAllPages(pages.map((x) => ({ id: x.id, title: x.title, path: x.path })));
      })
      .catch((e) => setLoadError(e.message));
    return () => {
      alive = false;
    };
  }, [pageId]);

  const widgetNames = useMemo(() => Object.fromEntries([...BUILTIN_WIDGETS.map((w) => [w.type, w.name]), ...customWidgets.map((w) => [w.key, w.name])]), [customWidgets]);

  // ---------- saving ----------
  const save = useCallback(
    async (opts: { force?: boolean; note?: string } = {}) => {
      const d = docRef.current;
      if (!d) return null;
      window.clearTimeout(saveTimer.current);
      setSaveState("saving");
      try {
        const p = await api.put<Page>(`/pages/${pageId}`, { ...d, baseUpdatedAt: baseUpdatedAt.current, force: opts.force, note: opts.note });
        baseUpdatedAt.current = p.updatedAt;
        setPage(p);
        // keep the server-normalised slug, but don't clobber edits made while saving
        if (docRef.current === d) setSaveState("saved");
        else setSaveState("dirty");
        if (p.slug !== d.slug) setDoc((cur) => (cur ? { ...cur, slug: p.slug } : cur));
        return p;
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          setSaveState("conflict");
          const overwrite = await confirmDialog({ title: "This page changed elsewhere", message: e.message, confirmLabel: "Overwrite with my version", danger: true });
          if (overwrite) return save({ force: true });
          return null;
        }
        setSaveState("error");
        toast.error(e);
        return null;
      }
    },
    [pageId],
  );

  const scheduleSave = useCallback(() => {
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => save(), 1800);
  }, [save]);

  // flush on unmount / tab close
  useEffect(() => {
    const before = (e: BeforeUnloadEvent) => {
      if (saveState === "dirty" || saveState === "saving") {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [saveState]);

  // ---------- document changes with undo ----------
  const commit = useCallback(
    (next: Doc, coalesceKey?: string) => {
      const prev = docRef.current;
      if (!prev) return;
      const h = history.current;
      const now = Date.now();
      if (!(coalesceKey && coalesceKey === h.lastKey && now - h.lastAt < 900)) {
        h.past.push(prev);
        if (h.past.length > 100) h.past.shift();
      }
      h.future = [];
      h.lastKey = coalesceKey ?? null;
      h.lastAt = now;
      docRef.current = next;
      setDoc(next);
      setSaveState("dirty");
      scheduleSave();
      forceHistory((n) => n + 1);
    },
    [scheduleSave],
  );
  const setLayout = useCallback((layout: PageLayout, key?: string) => docRef.current && commit({ ...docRef.current, layout }, key), [commit]);

  const undo = useCallback(() => {
    const h = history.current;
    const prev = h.past.pop();
    if (!prev || !docRef.current) return;
    h.future.push(docRef.current);
    h.lastKey = null;
    setDoc(prev);
    setSaveState("dirty");
    scheduleSave();
    forceHistory((n) => n + 1);
  }, [scheduleSave]);
  const redo = useCallback(() => {
    const h = history.current;
    const next = h.future.pop();
    if (!next || !docRef.current) return;
    h.past.push(docRef.current);
    setDoc(next);
    setSaveState("dirty");
    scheduleSave();
    forceHistory((n) => n + 1);
  }, [scheduleSave]);

  // ---------- canvas rendering ----------
  const postToCanvas = useCallback((msg: Record<string, unknown>) => {
    iframe.current?.contentWindow?.postMessage({ source: "reef-editor", ...msg }, "*");
  }, []);

  useEffect(() => {
    if (!doc) return;
    const t = window.setTimeout(async () => {
      try {
        const html = await api.html(`/render/page/${pageId}`, doc);
        const key = `${doc.templateId}|${doc.customHead}`;
        if (!canvasReady || key !== shellKey.current || !iframe.current?.contentWindow) {
          shellKey.current = key;
          setCanvasReady(false);
          if (iframe.current) iframe.current.srcdoc = html;
        } else {
          postToCanvas({ type: "update", html });
        }
      } catch (e) {
        toast.error(e);
      }
    }, 140);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.layout, doc?.title, doc?.templateId, doc?.customCss, doc?.customHead, pageId]);

  useEffect(() => {
    // "nearest" scrolling only moves the canvas when the block is off-screen (e.g. just added)
    if (canvasReady) postToCanvas({ type: "select", id: selected, scroll: true });
  }, [selected, canvasReady, postToCanvas]);

  // ---------- operations ----------
  const ops = useMemo(
    () => ({
      remove(id: string | null) {
        const d = docRef.current;
        if (!d || !id) return;
        const l = L.locate(d.layout, id);
        if (!l) return;
        setLayout(L.removeNode(d.layout, id));
        setSelected(null);
        const name = l.kind === "widget" ? widgetNames[L.getWidget(d.layout, id)!.type] ?? "Block" : l.kind === "section" ? "Section" : "Column";
        toast.success(`${name} deleted`, { label: "Undo", onClick: undo });
      },
      duplicate(id: string | null) {
        const d = docRef.current;
        if (!d || !id) return;
        const r = L.duplicateNode(d.layout, id);
        if (r.newId) {
          setLayout(r.layout);
          setSelected(r.newId);
        }
      },
      move(id: string | null, dir: -1 | 1) {
        const d = docRef.current;
        if (!d || !id) return;
        setLayout(L.moveNode(d.layout, id, dir));
      },
      add(type: string) {
        const d = docRef.current;
        if (!d) return;
        const def = getWidgetDef(type);
        const cw = customWidgets.find((c) => c.key === type);
        const w = makeWidget(type, def?.defaults ?? Object.fromEntries((cw?.fields ?? []).map((f) => [f.key, f.default ?? ""])));
        setLayout(L.insertNearSelection(d.layout, w, selected));
        setSelected(w.id);
      },
      addSection(widths: number[]) {
        const d = docRef.current;
        if (!d) return;
        const l = L.locate(d.layout, selected);
        const idx = l ? l.s + 1 : d.layout.sections.length;
        const r = L.insertSection(d.layout, widths, idx);
        setLayout(r.layout);
        setSelected(r.id);
      },
      copy(id: string | null) {
        const d = docRef.current;
        if (!d || !id) return;
        const l = L.locate(d.layout, id);
        if (l?.kind === "widget") clipboard.current = L.getWidget(d.layout, id);
        else if (l?.kind === "section") clipboard.current = d.layout.sections[l.s];
        if (clipboard.current) toast.info("Copied. Press Ctrl+V to paste.");
      },
      paste() {
        const d = docRef.current;
        if (!d || !clipboard.current) return;
        const node = cloneWithNewIds(clipboard.current as any);
        if ("columns" in node) {
          const l = L.locate(d.layout, selected);
          const next = structuredClone(d.layout);
          next.sections.splice(l ? l.s + 1 : next.sections.length, 0, node as SectionNode);
          setLayout(next);
        } else setLayout(L.insertNearSelection(d.layout, node as WidgetNode, selected));
        setSelected(node.id);
      },
    }),
    [selected, setLayout, customWidgets, widgetNames, undo],
  );

  // ---------- messages from canvas ----------
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== iframe.current?.contentWindow || e.data?.source !== "reef-canvas") return;
      const m = e.data;
      const d = docRef.current;
      if (!d) return;
      switch (m.type) {
        case "ready":
          setCanvasReady(true);
          postToCanvas({ type: "init", names: widgetNames });
          postToCanvas({ type: "select", id: selected });
          break;
        case "select":
          setSelected(m.id);
          if (m.id) setShowRight(true);
          break;
        case "action":
          if (m.action === "delete") ops.remove(m.id);
          if (m.action === "duplicate") ops.duplicate(m.id);
          if (m.action === "up") ops.move(m.id, -1);
          if (m.action === "down") ops.move(m.id, 1);
          break;
        case "inline":
          setLayout(L.updateNodeProps(d.layout, m.id, { [m.field]: m.value }));
          break;
        case "drop": {
          if (m.kind === "new-widget") {
            const def = getWidgetDef(m.payload);
            const cw = customWidgets.find((c) => c.key === m.payload);
            const w = makeWidget(m.payload, def?.defaults ?? Object.fromEntries((cw?.fields ?? []).map((f) => [f.key, f.default ?? ""])));
            setLayout(L.insertWidget(d.layout, w, m.columnId, m.index, m.sectionIndex));
            setSelected(w.id);
          } else if (m.kind === "new-section") {
            const widths = String(m.payload).split(",").map(Number);
            const r = L.insertSection(d.layout, widths, m.sectionIndex);
            setLayout(r.layout);
            setSelected(r.id);
          } else if (m.kind === "move-widget") {
            setLayout(L.moveWidgetTo(d.layout, m.payload, m.columnId, m.index, m.sectionIndex));
          } else if (m.kind === "move-section") {
            setLayout(L.moveSectionTo(d.layout, m.payload, m.sectionIndex));
          }
          break;
        }
        case "key":
          handleKey(m.key, m.ctrl, m.shift);
          break;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  });

  const handleKey = (key: string, ctrl: boolean, shift: boolean) => {
    const k = key.toLowerCase();
    if (ctrl && k === "z" && !shift) undo();
    else if (ctrl && (k === "y" || (k === "z" && shift))) redo();
    else if (ctrl && k === "s") save().then((p) => p && toast.success("Saved"));
    else if (ctrl && k === "d") ops.duplicate(selected);
    else if (ctrl && k === "c") ops.copy(selected);
    else if (ctrl && k === "v") ops.paste();
    else if (key === "Delete" || key === "Backspace") ops.remove(selected);
    else if (key === "Escape") setSelected(null);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.closest("input, textarea, select, [contenteditable=true], .cm-editor, .ProseMirror");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        return handleKey("s", true, false);
      }
      if (typing) return;
      if ((mod && ["z", "y", "d", "c", "v"].includes(e.key.toLowerCase())) || ["Delete", "Backspace", "Escape"].includes(e.key)) {
        e.preventDefault();
        handleKey(e.key, mod, e.shiftKey);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  // ---------- publish ----------
  const publish = async () => {
    setPublishing(true);
    try {
      if (saveState !== "saved") await save();
      const p = await api.post<Page & { sentForReview?: boolean }>(`/pages/${pageId}/publish`);
      baseUpdatedAt.current = p.updatedAt;
      setPage(p);
      toast.success(p.sentForReview ? "Sent to an editor for review" : "Published — your changes are live", p.sentForReview ? undefined : { label: "View", onClick: () => window.open(p.path, "_blank") });
    } catch (e) {
      toast.error(e);
    } finally {
      setPublishing(false);
    }
  };
  const discard = async () => {
    if (!(await confirmDialog({ title: "Discard unpublished changes?", message: "The page will go back to the version that's currently live.", confirmLabel: "Discard changes", danger: true }))) return;
    window.clearTimeout(saveTimer.current);
    try {
      const p = await api.post<Page>(`/pages/${pageId}/discard`);
      baseUpdatedAt.current = p.updatedAt;
      setPage(p);
      setDoc(docOf(p));
      history.current = { past: [], future: [], lastKey: null, lastAt: 0 };
      setSaveState("saved");
      toast.success("Reverted to the live version");
    } catch (e) {
      toast.error(e);
    }
  };
  const unpublish = async () => {
    if (!(await confirmDialog({ title: "Unpublish this page?", message: "Visitors will get a 'page not found' message until you publish it again.", confirmLabel: "Unpublish", danger: true }))) return;
    try {
      const p = await api.post<Page>(`/pages/${pageId}/unpublish`);
      setPage(p);
      toast.success("Page unpublished");
    } catch (e) {
      toast.error(e);
    }
  };
  const preview = async () => {
    if (saveState !== "saved") await save();
    window.open(`/preview/page/${pageId}`, "_blank");
  };
  const back = async () => {
    if (saveState === "dirty") await save();
    nav("/pages");
  };

  if (loadError) return <div className="page"><ErrorState message={loadError} /></div>;
  if (!doc || !page) return <Spinner label="Opening page editor…" />;

  const selLoc = L.locate(doc.layout, selected);
  // on a phone the panels are bottom sheets: one at a time, closed after adding a widget
  const openSheet = (which: "add" | "outline" | "edit") => {
    if (which === "edit") {
      setShowLeft(false);
      setShowRight((v) => !v);
    } else {
      setShowRight(false);
      setShowLeft((v) => !(v && leftTab === which));
      setLeftTab(which);
    }
  };
  const addWidget = (type: string) => {
    ops.add(type);
    if (phone) setShowLeft(false);
  };
  const addSection = (w: number[]) => {
    ops.addSection(w);
    if (phone) setShowLeft(false);
  };
  const hasChanges = page.hasUnpublishedChanges || saveState !== "saved";
  const isLive = !!page.publishedAt;

  return (
    <div className={`editor ${showLeft ? "" : "hide-left"} ${showRight ? "" : "hide-right"}${phone ? " is-phone" : ""}`}>
      {/* ---------- top bar ---------- */}
      <header className="editor-top">
        <Button variant="ghost" iconOnly icon="ArrowLeft" onClick={back} aria-label="Back to pages" title="Back to pages" />
        <div className="editor-title">
          <strong className="truncate" style={{ maxWidth: 260 }}>{doc.title}</strong>
          <span className="mono truncate">{page.path}</span>
        </div>
        <span className="hide-phone"><StatusBadge status={page.status} dirty={page.hasUnpublishedChanges} /></span>
        <span className="save-state hide-phone" aria-live="polite">
          {saveState === "saving" && (
            <>
              <Icon name="LoaderCircle" size={13} className="spin" /> Saving…
            </>
          )}
          {saveState === "saved" && (
            <>
              <Icon name="Check" size={13} /> Draft saved
            </>
          )}
          {saveState === "dirty" && <>Unsaved changes</>}
          {saveState === "error" && <span style={{ color: "var(--danger)" }}>Couldn't save — retrying when you edit</span>}
          {saveState === "conflict" && <span style={{ color: "var(--warn)" }}>Edit conflict</span>}
        </span>
        <div className="spacer" />
        <div className="btn-group">
          <Button size="sm" iconOnly icon="Undo2" onClick={undo} disabled={!history.current.past.length} title="Undo (Ctrl+Z)" aria-label="Undo" />
          <Button size="sm" iconOnly icon="Redo2" onClick={redo} disabled={!history.current.future.length} title="Redo (Ctrl+Y)" aria-label="Redo" />
        </div>
        <div className="tabs hide-phone" role="group" aria-label="Preview size">
          {(
            [
              ["desktop", "Monitor"],
              ["tablet", "Tablet"],
              ["mobile", "Smartphone"],
            ] as const
          ).map(([d, ic]) => (
            <button key={d} className={`tab ${device === d ? "active" : ""}`} onClick={() => setDevice(d)} title={`${d[0].toUpperCase()}${d.slice(1)} preview`} aria-pressed={device === d}>
              <Icon name={ic} size={15} />
            </button>
          ))}
        </div>
        <div className="spacer hide-phone" />
        <Button className="hide-phone" size="sm" variant="ghost" iconOnly icon="PanelLeft" onClick={() => setShowLeft((v) => !v)} title="Toggle left panel" aria-label="Toggle left panel" />
        <Button className="hide-phone" size="sm" variant="ghost" iconOnly icon="PanelRight" onClick={() => setShowRight((v) => !v)} title="Toggle right panel" aria-label="Toggle right panel" />
        <Button className="hide-phone" size="sm" icon="History" onClick={() => setSettingsOpen("history")}>History</Button>
        {phone ? (
          <Button size="sm" iconOnly icon="Settings" onClick={() => setSettingsOpen("general")} aria-label="Page settings" title="Page settings" />
        ) : (
          <Button size="sm" icon="Settings" onClick={() => setSettingsOpen("general")}>Settings</Button>
        )}
        <Button className="hide-phone" size="sm" icon="Eye" onClick={preview}>Preview</Button>
        <div className="btn-group">
          <Button size="sm" variant="primary" icon={can("pages.publish") ? "Send" : "Eye"} loading={publishing} onClick={publish} disabled={!hasChanges && isLive && page.status === "published"}>
            {can("pages.publish") ? (isLive ? (hasChanges ? (phone ? "Publish" : "Publish changes") : "Published") : "Publish") : phone ? "Submit" : "Submit for review"}
          </Button>
          <Menu
            trigger={(open) => <Button size="sm" variant="primary" iconOnly icon="ChevronDown" onClick={open} aria-label="More publishing options" style={{ borderLeft: "1px solid rgb(255 255 255 / .25)" }} />}
            items={[
              { label: "Schedule publishing…", icon: "Clock", onClick: () => setSettingsOpen("general") },
              { label: "View live page", icon: "ExternalLink", hidden: !isLive, onClick: () => window.open(page.path, "_blank") },
              { label: "Discard unpublished changes", icon: "RotateCcw", hidden: !isLive || !page.hasUnpublishedChanges, onClick: discard },
              { separator: true, hidden: !isLive || !can("pages.publish") },
              { label: "Unpublish", icon: "EyeOff", danger: true, hidden: !isLive || !can("pages.publish"), onClick: unpublish },
            ]}
          />
        </div>
      </header>

      {/* ---------- left: add / outline ---------- */}
      <aside className={`editor-left${showLeft ? " open" : ""}`} aria-label="Widgets and layers">
        {showLeft && (
          <>
            <div className="panel-tabs">
              <button className={`panel-tab ${leftTab === "add" ? "active" : ""}`} onClick={() => setLeftTab("add")}>
                <Icon name="Plus" size={15} /> Add
              </button>
              <button className={`panel-tab ${leftTab === "outline" ? "active" : ""}`} onClick={() => setLeftTab("outline")}>
                <Icon name="Layers" size={15} /> Outline
              </button>
            </div>
            <div className="panel-scroll">
              {leftTab === "add" ? <AddPanel customWidgets={customWidgets} onAdd={addWidget} onAddSection={addSection} /> : <Outline layout={doc.layout} names={widgetNames} selected={selected} onSelect={setSelected} onMove={ops.move} />}
            </div>
          </>
        )}
      </aside>

      {/* ---------- canvas ---------- */}
      <div className="canvas-wrap" onClick={(e) => e.target === e.currentTarget && setSelected(null)}>
        <iframe ref={iframe} title="Page canvas" className={`canvas-frame ${device}`} />
      </div>

      {/* ---------- right: inspector ---------- */}
      <aside className={`editor-right${showRight ? " open" : ""}`} aria-label="Properties">
        {showRight && (
          <Inspector
            doc={doc}
            selected={selected}
            selLoc={selLoc}
            customWidgets={customWidgets}
            names={widgetNames}
            onSelect={setSelected}
            onLayout={setLayout}
            onDoc={commit}
            ops={ops}
            openSettings={setSettingsOpen}
          />
        )}
      </aside>

      {phone && (
        <nav className="editor-phone-bar" aria-label="Editor panels">
          <button className={showLeft && leftTab === "add" ? "active" : ""} aria-pressed={showLeft && leftTab === "add"} onClick={() => openSheet("add")}>
            <Icon name="Plus" size={19} /> Add
          </button>
          <button className={showLeft && leftTab === "outline" ? "active" : ""} aria-pressed={showLeft && leftTab === "outline"} onClick={() => openSheet("outline")}>
            <Icon name="Layers" size={19} /> Outline
          </button>
          <button className={showRight ? "active" : ""} aria-pressed={showRight} onClick={() => openSheet("edit")}>
            <Icon name="SquarePen" size={19} /> {selected ? "Edit block" : "Page"}
          </button>
          <button onClick={preview}>
            <Icon name="Eye" size={19} /> Preview
          </button>
        </nav>
      )}

      {settingsOpen && (
        <PageSettings
          tab={settingsOpen}
          setTab={setSettingsOpen}
          doc={doc}
          page={page}
          templates={templates}
          pages={allPages.filter((p) => p.id !== pageId)}
          onChange={(patch, key) => commit({ ...doc, ...patch }, key)}
          onClose={() => setSettingsOpen(null)}
          onRestored={(p) => {
            baseUpdatedAt.current = p.updatedAt;
            setPage(p);
            setDoc(docOf(p));
            setSaveState("saved");
          }}
          flush={save}
        />
      )}
    </div>
  );
}

// =====================================================================
function AddPanel({ customWidgets, onAdd, onAddSection }: { customWidgets: CustomWidget[]; onAdd: (type: string) => void; onAddSection: (w: number[]) => void }) {
  const [q, setQ] = useState("");
  const all = [
    ...BUILTIN_WIDGETS.map((w) => ({ type: w.type, name: w.name, icon: w.icon, category: w.category as string, description: w.description })),
    ...customWidgets.map((w) => ({ type: w.key, name: w.name, icon: w.icon, category: "Custom", description: w.description })),
  ].filter((w) => !q || `${w.name} ${w.description}`.toLowerCase().includes(q.toLowerCase()));
  const groups = ["Basic", "Layout", "Media", "Content", "Interactive", "Developer", "Custom"];
  return (
    <>
      <div className="search-input" style={{ marginBottom: 14 }}>
        <Icon name="Search" size={15} />
        <input className="input input-sm" placeholder="Search widgets" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!q && (
        <div className="palette-group">
          <div className="palette-group-title">Sections</div>
          <div className="layout-grid">
            {COLUMN_LAYOUTS.map((l) => (
              <div
                key={l.label}
                className="layout-item"
                title={`${l.label} — drag onto the page or click to add`}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("application/x-reef-layout", l.widths.join(","));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onClick={() => onAddSection(l.widths)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => e.key === "Enter" && onAddSection(l.widths)}
                aria-label={`Add section: ${l.label}`}
              >
                {l.widths.map((w, i) => (
                  <span key={i} style={{ flex: w }} />
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
      {groups.map((g) => {
        const items = all.filter((w) => w.category === g);
        if (!items.length) return null;
        return (
          <div key={g} className="palette-group">
            <div className="palette-group-title">{g}</div>
            <div className="palette-grid">
              {items.map((w) => (
                <div
                  key={w.type}
                  className="palette-item"
                  title={`${w.description} — drag onto the page or click to add`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData("application/x-reef-widget", w.type);
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={() => onAdd(w.type)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => e.key === "Enter" && onAdd(w.type)}
                >
                  <Icon name={w.icon} size={19} />
                  {w.name}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {!all.length && <div className="subtle" style={{ textAlign: "center", padding: 20 }}>No widgets match “{q}”.</div>}
    </>
  );
}

function Outline({ layout, names, selected, onSelect, onMove }: { layout: PageLayout; names: Record<string, string>; selected: string | null; onSelect: (id: string) => void; onMove: (id: string, d: -1 | 1) => void }) {
  if (!layout.sections.length) return <div className="subtle" style={{ padding: 12 }}>Nothing on this page yet.</div>;
  const widgetLabel = (w: WidgetNode) => {
    const p = w.props ?? {};
    const text = p.text || p.title || p.label || p.heading || (typeof p.html === "string" ? p.html.replace(/<[^>]+>/g, "") : "");
    return String(text || "").slice(0, 28);
  };
  return (
    <div>
      {layout.sections.map((s, si) => (
        <div key={s.id}>
          <div className={`outline-node ${selected === s.id ? "active" : ""}`} {...press(() => onSelect(s.id))}>
            <Icon name="Rows3" size={14} />
            <span className="grow">Section {si + 1}</span>
            <span className="col-widths" style={{ width: 54 }}>
              {s.columns.map((c) => (
                <span key={c.id} style={{ flex: c.width, height: 10 }} />
              ))}
            </span>
          </div>
          <div className="outline-children">
            {s.columns.map((c, ci) => (
              <div key={c.id}>
                {s.columns.length > 1 && (
                  <div className={`outline-node ${selected === c.id ? "active" : ""}`} {...press(() => onSelect(c.id))} style={{ height: 26, fontSize: 12 }}>
                    <Icon name="Columns2" size={13} /> Column {ci + 1} <span className="subtle">({c.width}/12)</span>
                  </div>
                )}
                <div className={s.columns.length > 1 ? "outline-children" : ""}>
                  {c.widgets.map((w) => (
                    <div key={w.id} className={`outline-node ${selected === w.id ? "active" : ""}`} {...press(() => onSelect(w.id))}>
                      <Icon name={getWidgetDef(w.type)?.icon ?? "Puzzle"} size={14} />
                      <span style={{ fontWeight: 560 }}>{names[w.type] ?? w.type}</span>
                      <span className="subtle truncate grow" style={{ fontSize: 12 }}>
                        {widgetLabel(w)}
                      </span>
                      {selected === w.id && (
                        <>
                          <Button size="sm" variant="ghost" iconOnly icon="ArrowUp" aria-label="Move up" onClick={(e) => (e.stopPropagation(), onMove(w.id, -1))} style={{ width: 22, height: 22 }} />
                          <Button size="sm" variant="ghost" iconOnly icon="ArrowDown" aria-label="Move down" onClick={(e) => (e.stopPropagation(), onMove(w.id, 1))} style={{ width: 22, height: 22 }} />
                        </>
                      )}
                    </div>
                  ))}
                  {!c.widgets.length && <div className="subtle" style={{ fontSize: 12, padding: "4px 8px" }}>Empty column</div>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// =====================================================================
function Inspector({
  doc,
  selected,
  selLoc,
  customWidgets,
  names,
  onSelect,
  onLayout,
  onDoc,
  ops,
  openSettings,
}: {
  doc: Doc;
  selected: string | null;
  selLoc: L.Loc | null;
  customWidgets: CustomWidget[];
  names: Record<string, string>;
  onSelect: (id: string | null) => void;
  onLayout: (l: PageLayout, key?: string) => void;
  onDoc: (d: Doc, key?: string) => void;
  ops: { remove: (id: string) => void; duplicate: (id: string) => void };
  openSettings: (t: "general" | "seo" | "code" | "history") => void;
}) {
  const [tab, setTab] = useState<"content" | "style" | "advanced">("content");
  useEffect(() => setTab("content"), [selected]);

  if (!selected || !selLoc) {
    return (
      <div className="panel-scroll">
        <div className="section-title">Page</div>
        <Field label="Title">
          <input className="input" value={doc.title} onChange={(e) => onDoc({ ...doc, title: e.target.value }, "title")} />
        </Field>
        <Field label="Search engine description" help={`${(doc.seo.metaDescription ?? "").length}/160 characters`}>
          <textarea className="textarea" rows={3} value={doc.seo.metaDescription ?? ""} onChange={(e) => onDoc({ ...doc, seo: { ...doc.seo, metaDescription: e.target.value } }, "seo-desc")} />
        </Field>
        <div className="col" style={{ gap: 6 }}>
          <Button icon="Settings" onClick={() => openSettings("general")}>All page settings</Button>
          <Button icon="Globe" onClick={() => openSettings("seo")}>SEO & social sharing</Button>
          <Button icon="CodeXml" onClick={() => openSettings("code")}>Page CSS, JS & head</Button>
        </div>
        <div className="alert alert-info" style={{ marginTop: 18 }}>
          <Icon name="MousePointerClick" size={16} />
          <div>
            Click any block on the page to edit it. Double-click text to type directly on the canvas. Drag widgets from the left panel to add them.
          </div>
        </div>
        <div className="section-title" style={{ marginTop: 20 }}>Shortcuts</div>
        <div className="col" style={{ gap: 6, fontSize: 12.5 }}>
          {[
            ["Ctrl S", "Save now"],
            ["Ctrl Z / Ctrl Y", "Undo / redo"],
            ["Ctrl D", "Duplicate block"],
            ["Ctrl C / Ctrl V", "Copy / paste block"],
            ["Delete", "Delete block"],
            ["Esc", "Deselect"],
          ].map(([k, l]) => (
            <div key={k} className="row">
              <span className="grow muted">{l}</span>
              <span className="kbd">{k}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const section = doc.layout.sections[selLoc.s];

  // ----- section -----
  if (selLoc.kind === "section" || selLoc.kind === "column") {
    const col = selLoc.kind === "column" ? section.columns[selLoc.c] : null;
    const fields = SECTION_FIELDS.filter((f) => (tab === "advanced" ? f.group === "advanced" : f.group !== "advanced"));
    return (
      <>
        <div className="inspector-head">
          <span className="inspector-icon section">
            <Icon name={col ? "Columns2" : "Rows3"} size={17} />
          </span>
          <div className="grow">
            <strong>{col ? `Column ${selLoc.c + 1}` : `Section ${selLoc.s + 1}`}</strong>
            <div className="subtle" style={{ fontSize: 12 }}>{col ? `${col.width}/12 width` : `${section.columns.length} column${section.columns.length > 1 ? "s" : ""}`}</div>
          </div>
          {col && <Button size="sm" variant="ghost" onClick={() => onSelect(section.id)}>Section</Button>}
          {!col && <Button size="sm" variant="ghost" iconOnly icon="Copy" aria-label="Duplicate section" title="Duplicate section" onClick={() => ops.duplicate(section.id)} />}
          <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Delete" title="Delete" onClick={() => ops.remove(selected)} />
        </div>
        <div className="panel-scroll">
          {col ? (
            <>
              <Field label="Column width" help="Out of 12. On phones, columns stack vertically.">
                <input type="range" min={1} max={12} value={col.width} onChange={(e) => {
                  const s2 = structuredClone(section);
                  s2.columns[selLoc.c].width = Number(e.target.value);
                  onLayout(L.replaceSection(doc.layout, s2), `colw-${col.id}`);
                }} />
              </Field>
              <div className="subtle" style={{ fontSize: 12.5 }}>Section total: {section.columns.reduce((a, c) => a + c.width, 0)}/12</div>
            </>
          ) : (
            <>
              <Field label="Columns">
                <div className="layout-grid">
                  {COLUMN_LAYOUTS.map((l) => {
                    const active = l.widths.join() === section.columns.map((c) => c.width).join();
                    return (
                      <div key={l.label} className="layout-item" style={{ cursor: "pointer", ...(active ? { borderColor: "#e60000", boxShadow: "0 0 0 2px rgb(230 0 0 / .3)" } : {}) }} title={l.label} {...press(() => onLayout(L.replaceSection(doc.layout, L.setSectionColumns(section, l.widths))))}>
                        {l.widths.map((w, i) => (
                          <span key={i} style={{ flex: w }} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </Field>
              <div className="tabs" style={{ marginBottom: 14, width: "100%" }}>
                <button className={`tab grow ${tab !== "advanced" ? "active" : ""}`} onClick={() => setTab("content")}>Design</button>
                <button className={`tab grow ${tab === "advanced" ? "active" : ""}`} onClick={() => setTab("advanced")}>Advanced</button>
              </div>
              <FieldsForm fields={fields.filter((f) => f.key !== "bgColor" || section.props.background === "custom").filter((f) => f.key !== "overlay" || section.props.bgImage)} values={section.props} onChange={(k, v) => onLayout(L.updateNodeProps(doc.layout, section.id, { [k]: v }), `sec-${section.id}-${k}`)} />
            </>
          )}
        </div>
      </>
    );
  }

  // ----- widget -----
  const widget = section.columns[selLoc.c].widgets[selLoc.w];
  const def = getWidgetDef(widget.type);
  const cw = customWidgets.find((c) => c.key === widget.type);
  const baseFields: FieldDef[] = def?.fields ?? cw?.fields ?? [];
  const grouped = {
    content: baseFields.filter((f) => !f.group || f.group === "content"),
    style: baseFields.filter((f) => f.group === "style"),
    advanced: [...baseFields.filter((f) => f.group === "advanced"), ...COMMON_WIDGET_FIELDS],
  };
  const fields = grouped[tab];
  return (
    <>
      <div className="inspector-head">
        <span className="inspector-icon">
          <Icon name={def?.icon ?? cw?.icon ?? "Puzzle"} size={17} />
        </span>
        <div className="grow" style={{ minWidth: 0 }}>
          <strong>{names[widget.type] ?? widget.type}</strong>
          <div className="subtle truncate" style={{ fontSize: 12 }}>{def?.description ?? cw?.description ?? "Custom widget"}</div>
        </div>
        <Button size="sm" variant="ghost" iconOnly icon="Copy" aria-label="Duplicate" title="Duplicate (Ctrl+D)" onClick={() => ops.duplicate(widget.id)} />
        <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Delete" title="Delete" onClick={() => ops.remove(widget.id)} />
      </div>
      <div style={{ padding: "12px 14px 0" }}>
        <div className="tabs" style={{ width: "100%" }}>
          {(["content", "style", "advanced"] as const).map((t) => (
            <button key={t} className={`tab grow ${tab === t ? "active" : ""}`} onClick={() => setTab(t)} disabled={!grouped[t].length} style={!grouped[t].length ? { opacity: 0.4 } : undefined}>
              {t === "content" ? "Content" : t === "style" ? "Style" : "Advanced"}
            </button>
          ))}
        </div>
      </div>
      <div className="panel-scroll">
        {fields.length ? (
          <FieldsForm fields={fields} values={widget.props} onChange={(k, v) => onLayout(L.updateNodeProps(doc.layout, widget.id, { [k]: v }), `w-${widget.id}-${k}`)} />
        ) : (
          <div className="subtle">No options here.</div>
        )}
        {cw && tab === "content" && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            <Icon name="CodeXml" size={16} />
            <div>
              This is a custom widget. Developers can change its template and fields in <a href={`/admin/code?widget=${cw.id}`}>Code Studio</a>.
            </div>
          </div>
        )}
        <div className="divider" />
        <div className="row">
          <Button size="sm" variant="ghost" icon="Rows3" onClick={() => onSelect(section.id)}>Select section</Button>
          {section.columns.length > 1 && <Button size="sm" variant="ghost" icon="Columns2" onClick={() => onSelect(section.columns[selLoc.c].id)}>Column</Button>}
        </div>
      </div>
    </>
  );
}

// =====================================================================
function PageSettings({
  tab,
  setTab,
  doc,
  page,
  templates,
  pages,
  onChange,
  onClose,
  onRestored,
  flush,
}: {
  tab: "general" | "seo" | "code" | "history";
  setTab: (t: "general" | "seo" | "code" | "history") => void;
  doc: Doc;
  page: Page;
  templates: Template[];
  pages: { id: number; title: string; path: string }[];
  onChange: (patch: Partial<Doc>, key?: string) => void;
  onClose: () => void;
  onRestored: (p: Page) => void;
  flush: () => Promise<Page | null>;
}) {
  const [codeTab, setCodeTab] = useState<"css" | "js" | "head">("css");
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  useEffect(() => {
    if (tab === "history") {
      flush().then(() => api.get<Revision[]>(`/revisions/page/${page.id}`).then(setRevisions));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  const parentPath = doc.parentId ? pages.find((p) => p.id === doc.parentId)?.path.replace(/\/$/, "") ?? "" : "";
  const seoTitle = doc.seo.metaTitle || doc.title;
  const restore = async (r: Revision) => {
    if (!(await confirmDialog({ title: "Restore this version?", message: `The page content will go back to how it was ${timeAgo(r.createdAt)}. Your current draft is kept in history, so you can undo this.`, confirmLabel: "Restore version" }))) return;
    try {
      const p = await api.post<Page>(`/pages/${page.id}/restore/${r.id}`);
      onRestored(p);
      toast.success("Version restored as a draft");
      onClose();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Drawer title="Page settings" onClose={onClose} width={tab === "code" ? 760 : 560}>
      <div className="underline-tabs" role="tablist" style={{ marginBottom: 20 }}>
        {(
          [
            ["general", "General", "Settings"],
            ["seo", "SEO & sharing", "Globe"],
            ["code", "Code", "CodeXml"],
            ["history", "History", "History"],
          ] as const
        ).map(([k, l, ic]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={`underline-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            <Icon name={ic} size={14} /> {l}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <>
          <Field label="Page title" required>
            <input className="input" value={doc.title} onChange={(e) => onChange({ title: e.target.value }, "title")} />
          </Field>
          <Field label="URL" help={page.isHome ? "This is the homepage, so it's served at /." : `Full address: ${parentPath}/${doc.slug}`}>
            <div className="input-group">
              <span className="input-prefix">{parentPath}/</span>
              <input className="input" value={doc.slug} disabled={page.isHome} onChange={(e) => onChange({ slug: slugify(e.target.value) || e.target.value.toLowerCase() }, "slug")} />
            </div>
          </Field>
          <div className="grid-2">
            <Field label="Parent page">
              <select className="select" value={doc.parentId ?? ""} disabled={page.isHome} onChange={(e) => onChange({ parentId: e.target.value ? Number(e.target.value) : null })}>
                <option value="">None (top level)</option>
                {pages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.path} — {p.title}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Template">
              <select className="select" value={doc.templateId ?? ""} onChange={(e) => onChange({ templateId: e.target.value ? Number(e.target.value) : null })}>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="Navigation">
            <Switch checked={doc.showInNav} onChange={(v) => onChange({ showInNav: v })} label="Show this page in menus" />
          </Field>
          <Field label="Scheduled publishing" help={doc.publishAt ? `Will publish automatically ${timeAgo(new Date(doc.publishAt).toISOString())}.` : "Leave empty to publish manually."}>
            <div className="row">
              <input
                className="input"
                type="datetime-local"
                value={doc.publishAt ? toLocalInput(doc.publishAt) : ""}
                onChange={(e) => onChange({ publishAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
              />
              {doc.publishAt && <Button iconOnly icon="X" aria-label="Clear schedule" onClick={() => onChange({ publishAt: null })} />}
            </div>
          </Field>
        </>
      )}

      {tab === "seo" && (
        <>
          <div className="card card-pad" style={{ marginBottom: 20, boxShadow: "none" }}>
            <div className="subtle" style={{ fontSize: 12, marginBottom: 6 }}>Search result preview</div>
            <div style={{ fontSize: 13, color: "var(--text-2)" }}>{location.host}{page.path}</div>
            <div style={{ fontSize: 19, color: "#1a0dab", margin: "2px 0", lineHeight: 1.3 }} className="truncate">{seoTitle}</div>
            <div style={{ fontSize: 13.5, color: "var(--text-2)" }}>{doc.seo.metaDescription || <span className="subtle">Add a description so search engines don't have to guess.</span>}</div>
          </div>
          <Field label="SEO title" help={`${seoTitle.length}/60 characters. Defaults to the page title.`}>
            <input className="input" value={doc.seo.metaTitle ?? ""} placeholder={doc.title} onChange={(e) => onChange({ seo: { ...doc.seo, metaTitle: e.target.value } }, "seo-title")} />
          </Field>
          <Field label="Meta description" help={`${(doc.seo.metaDescription ?? "").length}/160 characters`}>
            <textarea className="textarea" rows={3} value={doc.seo.metaDescription ?? ""} onChange={(e) => onChange({ seo: { ...doc.seo, metaDescription: e.target.value } }, "seo-desc")} />
          </Field>
          <Field label="Social sharing image" help="Shown when the page is shared on social media. 1200×630 works best.">
            <ImageField value={doc.seo.ogImage ?? ""} onChange={(v) => onChange({ seo: { ...doc.seo, ogImage: v } })} />
          </Field>
          <Field label="Canonical URL" help="Only needed if this content also lives at another address.">
            <input className="input" value={doc.seo.canonical ?? ""} onChange={(e) => onChange({ seo: { ...doc.seo, canonical: e.target.value } }, "seo-canon")} />
          </Field>
          <Switch checked={!!doc.seo.noIndex} onChange={(v) => onChange({ seo: { ...doc.seo, noIndex: v } })} label="Hide from search engines (noindex)" />
        </>
      )}

      {tab === "code" && (
        <>
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            <Icon name="Info" size={16} />
            <div>
              Code here applies to this page only. For site-wide code, use <a href="/admin/code">Code Studio</a>. JavaScript runs on the live site and in previews, not inside the editor canvas.
            </div>
          </div>
          <div className="tabs" style={{ marginBottom: 12 }}>
            {(
              [
                ["css", "CSS"],
                ["js", "JavaScript"],
                ["head", "<head> HTML"],
              ] as const
            ).map(([k, l]) => (
              <button key={k} className={`tab ${codeTab === k ? "active" : ""}`} onClick={() => setCodeTab(k)}>
                {l}
              </button>
            ))}
          </div>
          <div className="code-field">
            {codeTab === "css" && <CodeEditor language="css" value={doc.customCss} onChange={(v) => onChange({ customCss: v }, "css")} minHeight="420px" />}
            {codeTab === "js" && <CodeEditor language="javascript" value={doc.customJs} onChange={(v) => onChange({ customJs: v }, "js")} minHeight="420px" />}
            {codeTab === "head" && <CodeEditor language="html" value={doc.customHead} onChange={(v) => onChange({ customHead: v }, "head")} minHeight="420px" />}
          </div>
        </>
      )}

      {tab === "history" && (
        <>
          <p className="muted" style={{ marginTop: 0 }}>Every save and publish is kept. Restoring a version replaces the draft; it doesn't go live until you publish.</p>
          {!revisions ? (
            <Spinner />
          ) : !revisions.length ? (
            <div className="subtle">No history yet.</div>
          ) : (
            revisions.map((r, i) => (
              <div key={r.id} className="revision">
                <span className="dot" style={{ marginTop: 7, background: r.note === "Published" ? "var(--success)" : r.note.startsWith("Restored") ? "var(--info)" : "var(--border-strong)" }} />
                <div className="grow">
                  <div style={{ fontWeight: 600 }}>
                    {r.note || "Saved"} {i === 0 && <span className="badge badge-accent no-dot">Latest</span>}
                  </div>
                  <div className="subtle" style={{ fontSize: 12.5 }}>
                    {r.userName ?? "System"} · {timeAgo(r.createdAt)}
                  </div>
                </div>
                {i > 0 && <Button size="sm" icon="RotateCcw" onClick={() => restore(r)}>Restore</Button>}
              </div>
            ))
          )}
        </>
      )}
    </Drawer>
  );
}

function toLocalInput(iso: string) {
  const d = new Date(iso);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
