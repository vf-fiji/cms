import { useRef, useState } from "react";
import type { MediaItem } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { Button, Modal, toast, useLoad, Spinner } from "./ui";
import { bytes } from "../lib/format";

export async function uploadFiles(files: FileList | File[], folder = ""): Promise<MediaItem[]> {
  const fd = new FormData();
  for (const f of Array.from(files)) fd.append("files", f);
  fd.append("folder", folder);
  const res = await api.post<{ items: MediaItem[]; rejected: string[] }>("/media", fd);
  res.rejected.forEach((r) => toast.error(r));
  if (res.items.length) toast.success(res.items.length === 1 ? `Uploaded ${res.items[0].originalName}` : `Uploaded ${res.items.length} files`);
  return res.items;
}

export function MediaThumb({ m }: { m: MediaItem }) {
  if (m.mime.startsWith("image/")) return <img src={m.url} alt={m.alt} loading="lazy" />;
  const icon = m.mime.startsWith("video/") ? "Video" : m.mime === "application/pdf" ? "FileText" : "FileCode";
  return (
    <div className="col" style={{ alignItems: "center", gap: 4 }}>
      <Icon name={icon} size={28} />
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" }}>{m.filename.split(".").pop()}</span>
    </div>
  );
}

export function MediaPicker({
  onPick,
  onPickMany,
  onClose,
  accept = "any",
  multiple,
}: {
  onPick?: (m: MediaItem) => void;
  onPickMany?: (m: MediaItem[]) => void;
  onClose: () => void;
  accept?: "image" | "any";
  multiple?: boolean;
}) {
  const [q, setQ] = useState("");
  const [folder, setFolder] = useState("__all");
  const [selected, setSelected] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(false);
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { data, loading, reload } = useLoad(
    () => api.get<{ items: MediaItem[]; folders: string[] }>(`/media?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(q)}${accept === "image" ? "&type=image" : ""}`),
    [q, folder],
  );
  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const items = await uploadFiles(files, folder === "__all" ? "" : folder);
      await reload();
      if (items.length === 1 && !multiple) onPick?.(items[0]);
      else if (multiple) setSelected((s) => [...s, ...items]);
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };
  const toggle = (m: MediaItem) => {
    if (!multiple) return onPick?.(m);
    setSelected((s) => (s.some((x) => x.id === m.id) ? s.filter((x) => x.id !== m.id) : [...s, m]));
  };
  return (
    <Modal
      size="xl"
      title={multiple ? "Choose images" : accept === "image" ? "Choose an image" : "Choose a file"}
      description="Pick from your media library, or drop new files here to upload them."
      onClose={onClose}
      footer={
        multiple ? (
          <>
            <span className="muted grow">{selected.length} selected</span>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!selected.length} onClick={() => onPickMany?.(selected)}>
              Add {selected.length || ""} {selected.length === 1 ? "image" : "images"}
            </Button>
          </>
        ) : undefined
      }
    >
      <div
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          doUpload(e.dataTransfer.files);
        }}
      >
        <div className="row" style={{ marginBottom: 14 }}>
          <div className="search-input grow">
            <Icon name="Search" />
            <input className="input" placeholder="Search by name, title or alt text" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          </div>
          <select className="select" style={{ width: 180 }} value={folder} onChange={(e) => setFolder(e.target.value)}>
            <option value="__all">All folders</option>
            <option value="">Unfiled</option>
            {data?.folders.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <input ref={input} type="file" hidden multiple accept={accept === "image" ? "image/*" : undefined} onChange={(e) => doUpload(e.target.files)} />
          <Button variant="primary" icon="Upload" loading={uploading} onClick={() => input.current?.click()}>
            Upload
          </Button>
        </div>
        <div className={`dropzone ${drag ? "active" : ""}`} style={{ padding: drag ? 28 : 0, border: drag ? undefined : 0, background: drag ? undefined : "none", textAlign: "left" }}>
          {drag ? (
            <div style={{ textAlign: "center" }}>Drop to upload</div>
          ) : loading && !data ? (
            <Spinner />
          ) : !data?.items.length ? (
            <div className="empty">
              <div className="empty-icon">
                <Icon name="Image" size={24} />
              </div>
              <div className="empty-title">No files here yet</div>
              <p>Drag images onto this window, or use Upload.</p>
            </div>
          ) : (
            <div className="media-grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))" }}>
              {data.items.map((m) => {
                const isSel = selected.some((s) => s.id === m.id);
                return (
                  <button key={m.id} type="button" className={`media-tile ${isSel ? "selected" : ""}`} onClick={() => toggle(m)} style={{ padding: 0, textAlign: "left" }}>
                    <div className="media-thumb">
                      <MediaThumb m={m} />
                    </div>
                    {isSel && (
                      <span className="media-check">
                        <Icon name="Check" size={14} />
                      </span>
                    )}
                    <div className="media-meta">
                      <div className="media-name truncate">{m.title || m.originalName}</div>
                      <div className="media-sub">
                        {m.width ? `${m.width}×${m.height} · ` : ""}
                        {bytes(m.size)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
