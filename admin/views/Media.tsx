import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { MediaItem } from "../../shared/types";
import { api, ApiError } from "../lib/api";
import { Icon } from "../lib/icons";
import { useAuth } from "../lib/auth";
import { bytes, formatDate } from "../lib/format";
import { Button, confirmDialog, Drawer, Empty, ErrorState, Field, promptDialog, SkeletonRows, toast, useLoad, press } from "../components/ui";
import { MediaThumb, uploadFiles } from "../components/MediaPicker";

export function Media() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [folder, setFolder] = useState("__all");
  const [q, setQ] = useState("");
  const [kind, setKind] = useState("all");
  const [focus, setFocus] = useState<MediaItem | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data, error, reload, setData } = useLoad(
    () => api.get<{ items: MediaItem[]; folders: string[]; counts: Record<string, number>; total: number }>(`/media?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q)}${kind !== "all" ? `&type=${kind}` : ""}`),
    [folder, q, kind],
  );

  useEffect(() => {
    if (params.get("upload")) {
      params.delete("upload");
      setParams(params, { replace: true });
      setTimeout(() => input.current?.click(), 200);
    }
    const f = params.get("focus");
    if (f && data) {
      const m = data.items.find((x) => x.id === Number(f));
      if (m) setFocus(m);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // page-wide drag & drop upload
  useEffect(() => {
    if (!can("media.manage")) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      depth++;
      setDragging(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDragging(false);
    };
    const over = (e: DragEvent) => e.dataTransfer?.types.includes("Files") && e.preventDefault();
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      depth = 0;
      setDragging(false);
      upload(e.dataTransfer.files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  });

  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      await uploadFiles(files, folder === "__all" ? "" : folder);
      reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };

  const newFolder = async () => {
    const name = await promptDialog({ title: "New folder", label: "Folder name", confirmLabel: "Create folder" });
    if (!name) return;
    await api.post("/media-folders", { name }).catch(toast.error);
    setFolder(name);
    reload();
  };

  const folders = data?.folders ?? [];
  return (
    <div className="page page-wide" style={{ maxWidth: 1480 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Media</h1>
          <div className="page-sub">Images, documents and video. Drop files anywhere on this screen to upload.</div>
        </div>
        {can("media.manage") && (
          <>
            <input ref={input} type="file" multiple hidden onChange={(e) => (upload(e.target.files), (e.target.value = ""))} />
            <Button variant="primary" icon="Upload" loading={uploading} onClick={() => input.current?.click()}>
              Upload files
            </Button>
          </>
        )}
      </div>
      <div className="media-layout">
        <div>
          <div className="col" style={{ gap: 2 }}>
            <div className={`folder-item ${folder === "__all" ? "active" : ""}`} {...press(() => setFolder("__all"))}>
              <Icon name="Images" size={16} /> All files <span className="count">{data?.total ?? ""}</span>
            </div>
            <div className={`folder-item ${folder === "" ? "active" : ""}`} {...press(() => setFolder(""))}>
              <Icon name="Inbox" size={16} /> Unfiled <span className="count">{data?.counts[""] ?? 0}</span>
            </div>
            {folders.map((f) => (
              <div key={f} className={`folder-item ${folder === f ? "active" : ""}`} {...press(() => setFolder(f))}>
                <Icon name={folder === f ? "FolderOpen" : "Folder"} size={16} /> <span className="truncate">{f}</span> <span className="count">{data?.counts[f] ?? 0}</span>
              </div>
            ))}
            {can("media.manage") && (
              <button className="folder-item" style={{ border: 0, background: "none", font: "inherit" }} onClick={newFolder}>
                <Icon name="FolderPlus" size={16} /> New folder
              </button>
            )}
          </div>
        </div>
        <div>
          <div className="row" style={{ marginBottom: 14 }}>
            <div className="search-input grow" style={{ maxWidth: 360 }}>
              <Icon name="Search" size={15} />
              <input className="input" placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <div className="tabs">
              {[
                ["all", "All"],
                ["image", "Images"],
                ["document", "Documents"],
                ["video", "Video"],
              ].map(([k, l]) => (
                <button key={k} className={`tab ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          {error ? (
            <ErrorState message={error} onRetry={reload} />
          ) : !data ? (
            <SkeletonRows />
          ) : !data.items.length ? (
            <div className="card">
              <Empty icon="Upload" title={q ? "No files match" : "Nothing here yet"} action={can("media.manage") ? <Button variant="primary" icon="Upload" onClick={() => input.current?.click()}>Upload files</Button> : undefined}>
                Drag and drop images, PDFs or videos onto this page.
              </Empty>
            </div>
          ) : (
            <div className="media-grid">
              {data.items.map((m) => (
                <button key={m.id} type="button" className={`media-tile ${focus?.id === m.id ? "selected" : ""}`} onClick={() => setFocus(m)} style={{ padding: 0, textAlign: "left" }}>
                  <div className="media-thumb">
                    <MediaThumb m={m} />
                  </div>
                  <div className="media-meta">
                    <div className="media-name truncate">{m.title || m.originalName}</div>
                    <div className="media-sub">
                      {m.width ? `${m.width}×${m.height} · ` : ""}
                      {bytes(m.size)}
                      {!m.alt && m.mime.startsWith("image/") && <span title="Missing alt text" style={{ color: "var(--warn)", marginLeft: 6 }}>● no alt</span>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {dragging && <div className="drop-veil">Drop to upload{folder !== "__all" && folder ? ` to “${folder}”` : ""}</div>}
      {focus && (
        <MediaDetails
          m={focus}
          folders={folders}
          onClose={() => setFocus(null)}
          onSaved={(m) => {
            setFocus(m);
            setData(data ? { ...data, items: data.items.map((x) => (x.id === m.id ? m : x)) } : data);
          }}
          onDeleted={() => {
            setFocus(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function MediaDetails({ m, folders, onClose, onSaved, onDeleted }: { m: MediaItem; folders: string[]; onClose: () => void; onSaved: (m: MediaItem) => void; onDeleted: () => void }) {
  const { can } = useAuth();
  const [form, setForm] = useState({ title: m.title, alt: m.alt, folder: m.folder, focal: m.focal });
  const [busy, setBusy] = useState(false);
  useEffect(() => setForm({ title: m.title, alt: m.alt, folder: m.folder, focal: m.focal }), [m]);
  const dirty = form.title !== m.title || form.alt !== m.alt || form.folder !== m.folder || form.focal !== m.focal;
  const isImage = m.mime.startsWith("image/");
  const [fx, fy] = (form.focal || "50% 50%").split(" ").map((v) => parseFloat(v));
  const pickFocal = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!can("media.manage")) return;
    // the preview is object-fit: contain, so map the click onto the image itself
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    const scale = Math.min(r.width / el.naturalWidth, r.height / el.naturalHeight);
    const w = el.naturalWidth * scale;
    const h = el.naturalHeight * scale;
    const x = ((e.clientX - r.left - (r.width - w) / 2) / w) * 100;
    const y = ((e.clientY - r.top - (r.height - h) / 2) / h) * 100;
    if (x < 0 || x > 100 || y < 0 || y > 100) return;
    setForm({ ...form, focal: `${Math.round(x)}% ${Math.round(y)}%` });
  };
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.put<MediaItem>(`/media/${m.id}`, form));
      toast.success("Saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: `Delete ${m.originalName}?`, message: "The file is removed from the server. Pages using it will show a broken image.", confirmLabel: "Delete file", danger: true }))) return;
    try {
      await api.del(`/media/${m.id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        if (!(await confirmDialog({ title: "This file is in use", message: e.message, confirmLabel: "Delete anyway", danger: true }))) return;
        await api.del(`/media/${m.id}?force=1`);
      } else return toast.error(e);
    }
    toast.success("File deleted");
    onDeleted();
  };
  const fullUrl = `${location.origin}${m.url}`;
  return (
    <Drawer
      title="File details"
      onClose={onClose}
      footer={
        can("media.manage") ? (
          <>
            <Button variant="danger" icon="Trash2" onClick={remove}>Delete</Button>
            <div className="spacer" />
            <Button onClick={onClose}>Close</Button>
            <Button variant="primary" loading={busy} disabled={!dirty} onClick={save}>Save</Button>
          </>
        ) : undefined
      }
    >
      <div className="media-thumb" style={{ borderRadius: 14, aspectRatio: "16/10", marginBottom: 18, border: "1px solid var(--border)" }}>
        {isImage ? (
          <div className="focal-picker">
            <img src={m.url} alt={m.alt} style={{ objectFit: "contain", cursor: can("media.manage") ? "crosshair" : undefined }} onClick={pickFocal} />
            <FocalDot x={fx} y={fy} imgUrl={m.url} />
          </div>
        ) : m.mime.startsWith("video/") ? <video src={m.url} controls style={{ width: "100%", height: "100%" }} /> : <MediaThumb m={m} />}
      </div>
      {isImage && (
        <div className="row subtle" style={{ fontSize: 12.5, marginTop: -8, marginBottom: 16 }}>
          <Icon name="MousePointerClick" size={13} />
          <span className="grow">{form.focal ? `Focal point ${form.focal}. Crops keep this spot in view.` : "Click the image to set a focal point for crops."}</span>
          {form.focal && can("media.manage") && <Button size="sm" variant="ghost" onClick={() => setForm({ ...form, focal: "" })}>Reset</Button>}
        </div>
      )}
      <Field label="Title">
        <input className="input" value={form.title} disabled={!can("media.manage")} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      {m.mime.startsWith("image/") && (
        <Field label="Alt text" help="Describe the image for people using screen readers and for search engines.">
          <textarea className="textarea" rows={2} value={form.alt} disabled={!can("media.manage")} onChange={(e) => setForm({ ...form, alt: e.target.value })} />
        </Field>
      )}
      <Field label="Folder">
        <select className="select" value={form.folder} disabled={!can("media.manage")} onChange={(e) => setForm({ ...form, folder: e.target.value })}>
          <option value="">Unfiled</option>
          {folders.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </Field>
      <Field label="URL">
        <div className="input-group">
          <input className="input mono" readOnly value={m.url} onFocus={(e) => e.target.select()} />
          <Button icon="Copy" onClick={() => navigator.clipboard.writeText(fullUrl).then(() => toast.success("Link copied"))}>Copy</Button>
        </div>
      </Field>
      <div className="grid-2" style={{ fontSize: 13 }}>
        <div><div className="subtle">File name</div><div className="truncate">{m.originalName}</div></div>
        <div><div className="subtle">Type</div><div>{m.mime}</div></div>
        <div><div className="subtle">Size</div><div>{bytes(m.size)}</div></div>
        <div><div className="subtle">Dimensions</div><div>{m.width ? `${m.width} × ${m.height}px` : "—"}</div></div>
        <div style={{ gridColumn: "1 / -1" }}>
          <div className="subtle">Responsive sizes</div>
          <div>{m.variants.length ? `${m.variants.map((v) => `${v.w}px`).join(", ")} WebP copies, used automatically on smaller screens` : isImage && m.mime !== "image/svg+xml" && m.mime !== "image/gif" ? "Original only (already small)" : "Not needed for this file type"}</div>
        </div>
        <div><div className="subtle">Uploaded</div><div>{formatDate(m.createdAt, true)}</div></div>
        <div><a href={m.url} target="_blank" rel="noreferrer" className="row" style={{ gap: 4 }}>Open original <Icon name="ExternalLink" size={13} /></a></div>
      </div>
    </Drawer>
  );
}

/** Marker over the preview, positioned on the image (which is letterboxed inside the frame). */
function FocalDot({ x, y, imgUrl }: { x: number; y: number; imgUrl: string }) {
  const [box, setBox] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  useEffect(() => {
    const probe = new Image();
    probe.onload = () => {
      const frame = document.querySelector(".focal-picker") as HTMLElement | null;
      if (!frame) return;
      const fw = frame.clientWidth;
      const fh = frame.clientHeight;
      const s = Math.min(fw / probe.naturalWidth, fh / probe.naturalHeight);
      const w = probe.naturalWidth * s;
      const h = probe.naturalHeight * s;
      setBox({ l: (fw - w) / 2, t: (fh - h) / 2, w, h });
    };
    probe.src = imgUrl;
  }, [imgUrl]);
  if (!box || Number.isNaN(x) || Number.isNaN(y)) return null;
  return <span className="focal-dot" style={{ left: box.l + (box.w * x) / 100, top: box.t + (box.h * y) / 100 }} aria-hidden="true" />;
}
