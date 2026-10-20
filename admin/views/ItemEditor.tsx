import { useEffect, useRef, useState } from "react";
import { useBlocker, useNavigate, useParams } from "react-router-dom";
import type { ContentItem, ContentType, Revision } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth, bus } from "../lib/auth";
import { timeAgo, formatDate, slugify } from "../lib/format";
import { Button, confirmDialog, ErrorState, Field, Spinner, StatusBadge, toast, useHotkey } from "../components/ui";
import { FieldsForm, TagInput } from "../components/FieldEditor";

interface Draft {
  title: string;
  slug: string;
  data: Record<string, any>;
  tags: string[];
  categories: string[];
  publishAt: string | null;
}

export function ItemEditor() {
  const { type: typeKey, id } = useParams();
  const isNew = id === "new";
  const nav = useNavigate();
  const { can } = useAuth();
  const [type, setType] = useState<ContentType | null>(null);
  const [item, setItem] = useState<ContentItem | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<"" | "save" | "publish">("");
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [slugTouched, setSlugTouched] = useState(!isNew);
  const [revisions, setRevisions] = useState<Revision[] | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setError(null);
    const load = async () => {
      const t = await api.get<ContentType>(`/types/${typeKey}`);
      setType(t);
      if (isNew) {
        setItem(null);
        setDraft({ title: "", slug: "", data: Object.fromEntries(t.fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])), tags: [], categories: [], publishAt: null });
        setTimeout(() => titleRef.current?.focus(), 50);
      } else {
        const i = await api.get<ContentItem>(`/items/${id}`);
        setItem(i);
        setDraft({ title: i.title, slug: i.slug, data: i.data, tags: i.tags, categories: i.categories, publishAt: i.publishAt });
        api.get<Revision[]>(`/revisions/item/${i.id}`).then(setRevisions).catch(() => {});
      }
      setDirty(false);
    };
    load().catch((e) => setError(e.message));
  }, [typeKey, id, isNew]);

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useEffect(() => {
    if (blocker.state === "blocked") {
      confirmDialog({ title: "Leave without saving?", message: "Your changes to this item haven't been saved.", confirmLabel: "Leave", danger: true }).then((ok) => (ok ? blocker.proceed() : blocker.reset()));
    }
  }, [blocker]);
  useEffect(() => {
    const h = (e: BeforeUnloadEvent) => dirty && e.preventDefault();
    window.addEventListener("beforeunload", h);
    return () => window.removeEventListener("beforeunload", h);
  }, [dirty]);

  const patch = (p: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...p } : d));
    setDirty(true);
  };

  const save = async (): Promise<ContentItem | null> => {
    if (!draft || !type) return null;
    if (!draft.title.trim()) {
      toast.error("Add a title before saving.");
      titleRef.current?.focus();
      return null;
    }
    setBusy("save");
    setFieldErrors({});
    try {
      let saved: ContentItem;
      if (isNew) {
        saved = await api.post<ContentItem>(`/types/${type.key}/items`, { ...draft, slug: draft.slug || slugify(draft.title) });
        if (draft.publishAt) saved = await api.put<ContentItem>(`/items/${saved.id}`, { publishAt: draft.publishAt });
      } else {
        saved = await api.put<ContentItem>(`/items/${item!.id}`, { ...draft, baseUpdatedAt: item!.updatedAt });
      }
      setItem(saved);
      setDraft({ title: saved.title, slug: saved.slug, data: saved.data, tags: saved.tags, categories: saved.categories, publishAt: saved.publishAt });
      setDirty(false);
      bus.emit("types-changed");
      if (isNew) {
        // let the blocker see a clean state before navigating
        setTimeout(() => nav(`/content/${type.key}/${saved.id}`, { replace: true }), 0);
      } else api.get<Revision[]>(`/revisions/item/${saved.id}`).then(setRevisions).catch(() => {});
      return saved;
    } catch (e) {
      if (e instanceof ApiError && e.details?.field) setFieldErrors({ [e.details.field]: e.message });
      if (e instanceof ApiError && e.status === 409) {
        if (await confirmDialog({ title: "Someone else changed this item", message: e.message, confirmLabel: "Overwrite their changes", danger: true })) {
          const saved = await api.put<ContentItem>(`/items/${item!.id}`, { ...draft, force: true });
          setItem(saved);
          setDirty(false);
          return saved;
        }
      } else toast.error(e);
      return null;
    } finally {
      setBusy("");
    }
  };

  useHotkey("mod+s", (e) => {
    e.preventDefault();
    save().then((s) => s && toast.success("Saved"));
  });

  const publish = async () => {
    const saved = dirty || isNew ? await save() : item;
    if (!saved) return;
    setBusy("publish");
    try {
      const r = await api.post<ContentItem & { sentForReview?: boolean }>(`/items/${saved.id}/publish`);
      setItem(r);
      toast.success(r.sentForReview ? "Sent to an editor for review" : "Published");
      bus.emit("types-changed");
    } catch (e) {
      if (e instanceof ApiError && e.details?.field) setFieldErrors({ [e.details.field]: e.message });
      toast.error(e);
    } finally {
      setBusy("");
    }
  };
  const unpublish = async () => {
    try {
      setItem(await api.post<ContentItem>(`/items/${item!.id}/unpublish`));
      toast.success("Unpublished");
    } catch (e) {
      toast.error(e);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete “${item!.title}”?`, message: "This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    await api.del(`/items/${item!.id}`);
    setDirty(false);
    toast.success("Deleted");
    bus.emit("types-changed");
    setTimeout(() => nav(`/content/${typeKey}`), 0);
  };
  const restore = async (r: Revision) => {
    if (!(await confirmDialog({ title: "Restore this version?", message: `Content will go back to how it was ${timeAgo(r.createdAt)}.`, confirmLabel: "Restore" }))) return;
    try {
      const i = await api.post<ContentItem>(`/items/${item!.id}/restore/${r.id}`);
      setItem(i);
      setDraft({ title: i.title, slug: i.slug, data: i.data, tags: i.tags, categories: i.categories, publishAt: i.publishAt });
      setDirty(false);
      toast.success("Version restored");
    } catch (e) {
      toast.error(e);
    }
  };

  if (error) return <div className="page"><ErrorState message={error} /></div>;
  if (!type || !draft) return <Spinner />;
  const canPublish = can("content.publish");
  const status = item?.status ?? "draft";

  return (
    <div className="page">
      <div className="crumbs">
        <a style={{ cursor: "pointer" }} onClick={() => nav("/content")}>Content</a>
        <Icon name="ChevronRight" size={13} />
        <a style={{ cursor: "pointer" }} onClick={() => nav(`/content/${type.key}`)}>{type.name}</a>
        <Icon name="ChevronRight" size={13} />
        <span>{isNew ? `New ${type.singular.toLowerCase()}` : draft.title || "Untitled"}</span>
      </div>
      <h1 className="sr-only">{item ? `Edit ${type.singular.toLowerCase()}: ${draft.title}` : `New ${type.singular.toLowerCase()}`}</h1>
      <div className="item-editor">
        <div className="card card-pad">
          <input
            ref={titleRef}
            className="title-input"
            aria-label={`${type.singular} title`}
            placeholder={`${type.singular} title`}
            value={draft.title}
            onChange={(e) => patch({ title: e.target.value, ...(slugTouched ? {} : { slug: slugify(e.target.value) }) })}
          />
          <div className="row subtle" style={{ fontSize: 13, marginBottom: 20 }}>
            <Icon name="Link" size={13} />
            {type.hasDetailPages ? <span className="mono">/{type.urlPrefix}/</span> : <span>Slug:</span>}
            <input
              className="input input-sm mono"
              style={{ maxWidth: 320, height: 26 }}
              value={draft.slug}
              placeholder={slugify(draft.title) || "auto"}
              onChange={(e) => {
                setSlugTouched(true);
                patch({ slug: slugify(e.target.value) || e.target.value.toLowerCase() });
              }}
              aria-label="URL slug"
            />
          </div>
          <FieldsForm fields={type.fields} values={draft.data} errors={fieldErrors} onChange={(k, v) => patch({ data: { ...draft.data, [k]: v } })} />
        </div>

        <div className="sticky-side">
          <div className="card">
            <div className="card-header">
              <div className="card-title">Publishing</div>
              <StatusBadge status={status} />
            </div>
            <div className="card-body">
              {dirty && (
                <div className="alert alert-warn" style={{ marginBottom: 12, padding: "8px 12px" }}>
                  <Icon name="CircleAlert" size={15} /> Unsaved changes
                </div>
              )}
              <div className="col" style={{ gap: 8 }}>
                <Button variant="primary" icon={canPublish ? "Send" : "Eye"} loading={busy === "publish"} onClick={publish} disabled={status === "published" && !dirty}>
                  {canPublish ? (status === "published" ? (dirty ? "Save & update live" : "Published") : "Publish") : "Submit for review"}
                </Button>
                <Button icon="Save" loading={busy === "save"} onClick={() => save().then((s) => s && toast.success("Saved"))} disabled={!dirty && !isNew}>
                  {status === "published" ? "Save" : "Save draft"} <span className="kbd" style={{ marginLeft: 4 }}>Ctrl S</span>
                </Button>
                {type.hasDetailPages && item && (
                  <Button variant="ghost" icon="Eye" onClick={() => window.open(`/preview/item/${item.id}`, "_blank")}>
                    Preview
                  </Button>
                )}
              </div>
              <div className="divider" />
              <Field label="Schedule" help="Publishes automatically at this time.">
                <input
                  className="input"
                  type="datetime-local"
                  value={draft.publishAt ? new Date(new Date(draft.publishAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ""}
                  onChange={(e) => patch({ publishAt: e.target.value ? new Date(e.target.value).toISOString() : null })}
                />
              </Field>
              {item && (
                <div className="col subtle" style={{ gap: 4, fontSize: 12.5, marginTop: 12 }}>
                  <span>Created {formatDate(item.createdAt)}{item.authorName ? ` by ${item.authorName}` : ""}</span>
                  <span>Last edited {timeAgo(item.updatedAt)}</span>
                  {item.publishedAt && <span>First published {formatDate(item.publishedAt)}</span>}
                </div>
              )}
            </div>
            {item && (
              <div className="card-footer" style={{ justifyContent: "space-between" }}>
                {status === "published" && canPublish ? <Button size="sm" variant="ghost" icon="EyeOff" onClick={unpublish}>Unpublish</Button> : <span />}
                <Button size="sm" variant="danger" icon="Trash2" onClick={remove}>Delete</Button>
              </div>
            )}
          </div>

          <div className="card card-pad">
            <Field label="Tags">
              <TagInput value={draft.tags} onChange={(v) => patch({ tags: v })} />
            </Field>
            <Field label="Categories">
              <TagInput taxonomy="categories" value={draft.categories} onChange={(v) => patch({ categories: v })} placeholder="Type a category" />
            </Field>
          </div>

          {item && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">History</div>
              </div>
              <div className="card-body" style={{ maxHeight: 280, overflowY: "auto", paddingTop: 4 }}>
                {!revisions?.length ? (
                  <div className="subtle" style={{ fontSize: 13 }}>Versions appear here each time you save.</div>
                ) : (
                  revisions.map((r, i) => (
                    <div key={r.id} className="revision">
                      <span className="dot" style={{ marginTop: 7, background: i === 0 ? "var(--accent)" : "var(--border-strong)" }} />
                      <div className="grow" style={{ fontSize: 13 }}>
                        <div style={{ fontWeight: 560 }}>{r.userName ?? "System"}</div>
                        <div className="subtle" style={{ fontSize: 12 }}>{timeAgo(r.createdAt)}</div>
                      </div>
                      {i > 0 && <Button size="sm" variant="ghost" onClick={() => restore(r)}>Restore</Button>}
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
