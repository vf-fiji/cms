import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { Icon } from "../lib/icons";

/*
 * Code Studio's live preview: a page's draft with the open file's unsaved
 * changes (widget, template or code asset), refreshed as you type. The page is
 * loaded at its real address with ?reef_studio=<token>, so address-aware code
 * (navigation, detail templates) behaves as it will on the website.
 */

type PreviewKind = "widget" | "template" | "asset";
interface PreviewPage {
  id: number;
  title: string;
  path: string;
  live: boolean;
  uses: boolean;
}
type Device = "desktop" | "tablet" | "phone";
const WIDTHS: Record<Device, number> = { desktop: 1280, tablet: 834, phone: 390 };

/** What the preview needs from the open file: only the fields that change how pages render. */
function overridesOf(kind: PreviewKind, f: any) {
  if (kind === "widget") return { widget: { key: f.key, template: f.template, css: f.css, js: f.js, fields: f.fields, renderer: f.renderer, ssr: f.ssr } };
  if (kind === "template") return { template: { id: f.id, html: f.html, css: f.css, js: f.js, head: f.head } };
  return { asset: { id: f.id, content: f.content, kind: f.kind, location: f.location, enabled: f.enabled } };
}

const storeKey = (kind: PreviewKind, id: number) => `reef-studio-preview-page:${kind}:${id}`;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* preferences are optional */
  }
};

export function StudioPreview({ kind, file }: { kind: PreviewKind; file: any }) {
  const [pages, setPages] = useState<PreviewPage[] | null>(null);
  const [path, setPath] = useState<string | null>(() => read(storeKey(kind, file.id)));
  const [device, setDevice] = useState<Device>(() => (read("reef-studio-preview-device") as Device) || "desktop");
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<"updating" | "ready" | "error">("updating");
  const [error, setError] = useState<string | null>(null);
  const token = useRef<string | null>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const scrollY = useRef(0);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState({ width: 0, height: 0 });

  // Pages to choose from: the ones using this widget or template first.
  useEffect(() => {
    const q = kind === "widget" ? `?widget=${encodeURIComponent(file.key)}` : kind === "template" ? `?template=${file.id}` : "";
    api
      .get<PreviewPage[]>(`/studio-preview/pages${q}`)
      .then((list) => {
        setPages(list);
        setPath((p) => (p && list.some((x) => x.path === p) ? p : (list[0]?.path ?? "/")));
      })
      .catch(() => setPages([]));
  }, [kind, file.id]);

  // Send the unsaved changes (shortly after typing stops), then show them.
  const overrides = useMemo(() => JSON.stringify(overridesOf(kind, file)), [kind, file]);
  useEffect(() => {
    if (!path) return;
    setState("updating");
    const t = setTimeout(async () => {
      try {
        const r = await api.post<{ token: string }>("/studio-preview", { token: token.current, overrides: JSON.parse(overrides) });
        token.current = r.token;
        setError(null);
        const next = `${path}${path.includes("?") ? "&" : "?"}reef_studio=${encodeURIComponent(r.token)}`;
        const win = frame.current?.contentWindow;
        if (src === next && win) {
          // same page: reload in place and keep the scroll position
          try {
            scrollY.current = win.scrollY;
          } catch {
            scrollY.current = 0;
          }
          win.location.reload();
        } else {
          scrollY.current = 0;
          setSrc(next);
        }
      } catch (e) {
        setState("error");
        setError(e instanceof ApiError ? e.message : "The preview couldn't be updated.");
      }
    }, 450);
    return () => clearTimeout(t);
    // src is read, not watched: changing it is this effect's own doing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overrides, path]);

  // Lay the page out at the chosen device width, scaled to fit the pane.
  useEffect(() => {
    if (!box) return;
    const measure = () => setFit({ width: box.clientWidth, height: box.clientHeight });
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    measure();
    return () => ro.disconnect();
  }, [box]);
  const width = WIDTHS[device];
  const scale = fit.width ? Math.min(1, fit.width / width) : 1;

  const onLoad = () => {
    setState("ready");
    const win = frame.current?.contentWindow;
    if (!win || !scrollY.current) return;
    // widgets mount after the page loads, so restore the position once they have
    const y = scrollY.current;
    for (const ms of [50, 400, 1200]) setTimeout(() => win.scrollTo(0, y), ms);
  };

  const choosePath = (p: string) => {
    setPath(p);
    write(storeKey(kind, file.id), p);
  };
  const chooseDevice = (d: Device) => {
    setDevice(d);
    write("reef-studio-preview-device", d);
  };
  const using = pages?.filter((p) => p.uses) ?? [];
  const others = pages?.filter((p) => !p.uses) ?? [];

  return (
    <section className="studio-preview" aria-label="Live preview">
      <div className="studio-preview-bar">
        <span className={`studio-preview-dot is-${state}`} title={state === "updating" ? "Updating…" : state === "error" ? "Preview failed" : "Up to date"} />
        <select className="select" value={path ?? ""} onChange={(e) => choosePath(e.target.value)} aria-label="Page to preview">
          {using.length > 0 && (
            <optgroup label={kind === "widget" ? "Pages using this widget" : "Pages using this template"}>
              {using.map((p) => (
                <option key={p.id} value={p.path}>
                  {p.title} — {p.path}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label={using.length ? "Other pages" : "Pages"}>
            {others.map((p) => (
              <option key={p.id} value={p.path}>
                {p.title} — {p.path}
              </option>
            ))}
          </optgroup>
        </select>
        <div className="studio-preview-devices" role="group" aria-label="Preview width">
          {(
            [
              ["desktop", "Monitor"],
              ["tablet", "Tablet"],
              ["phone", "Smartphone"],
            ] as const
          ).map(([d, icon]) => (
            <button key={d} className={device === d ? "active" : ""} onClick={() => chooseDevice(d)} aria-pressed={device === d} title={`${d[0].toUpperCase()}${d.slice(1)} (${WIDTHS[d]} px)`}>
              <Icon name={icon} size={14} />
            </button>
          ))}
        </div>
        <button className="studio-preview-btn" onClick={() => frame.current?.contentWindow?.location.reload()} title="Reload" aria-label="Reload the preview">
          <Icon name="RotateCcw" size={14} />
        </button>
        <button className="studio-preview-btn" onClick={() => src && window.open(src, "_blank")} title="Open in a new tab" aria-label="Open the preview in a new tab">
          <Icon name="ExternalLink" size={14} />
        </button>
      </div>
      {error && <div className="studio-preview-error">{error}</div>}
      <div className="studio-preview-stage" ref={setBox}>
        {src && fit.width > 0 && (
          <div style={{ width: width * scale, height: fit.height, margin: "0 auto", overflow: "hidden" }}>
            <iframe
              ref={frame}
              title="Live preview"
              src={src}
              onLoad={onLoad}
              style={{ width, height: fit.height / scale, transform: `scale(${scale})`, transformOrigin: "0 0", border: 0, background: "#fff", display: "block" }}
            />
          </div>
        )}
      </div>
      <p className="studio-preview-note">
        The page’s current draft with your unsaved changes, shown only here. Saving puts this {kind === "asset" ? "file" : kind} live on every page that uses it.
      </p>
    </section>
  );
}
