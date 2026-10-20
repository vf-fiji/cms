import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../lib/icons";
import { ApiError } from "../lib/api";

// ---------- Button ----------
type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger" | "danger-solid" | "dark";
  size?: "sm" | "md" | "lg";
  icon?: string;
  iconRight?: string;
  loading?: boolean;
  iconOnly?: boolean;
};
export function Button({ variant = "default", size = "md", icon, iconRight, loading, iconOnly, className = "", children, disabled, ...rest }: BtnProps) {
  const cls = ["btn", variant !== "default" && `btn-${variant}`, size !== "md" && `btn-${size}`, iconOnly && "btn-icon", className].filter(Boolean).join(" ");
  const s = size === "sm" ? 14 : 16;
  return (
    <button type="button" className={cls} disabled={disabled || loading} {...rest}>
      {loading ? <Icon name="LoaderCircle" size={s} className="spin" /> : icon ? <Icon name={icon} size={s} /> : null}
      {children}
      {iconRight && <Icon name={iconRight} size={s} />}
    </button>
  );
}

// ---------- Field ----------
export function Field({ label, help, error, required, children, htmlFor, action }: { label?: ReactNode; help?: ReactNode; error?: string | null; required?: boolean; children: ReactNode; htmlFor?: string; action?: ReactNode }) {
  return (
    <div className="field">
      {label && (
        <div className="row">
          <label className="label grow" htmlFor={htmlFor}>
            {label}
            {required && <span className="req">*</span>}
          </label>
          {action}
        </div>
      )}
      {children}
      {error ? <div className="error-text">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch" style={disabled ? { opacity: 0.5 } : undefined}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch-track" />
      {label && <span>{label}</span>}
    </label>
  );
}

// ---------- Status ----------
export function StatusBadge({ status, dirty }: { status: string; dirty?: boolean }) {
  const map: Record<string, [string, string]> = {
    published: ["badge-success", "Published"],
    draft: ["", "Draft"],
    review: ["badge-warn", "In review"],
    scheduled: ["badge-info", "Scheduled"],
  };
  const [cls, label] = map[status] ?? ["", status];
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={`badge ${cls}`}>{label}</span>
      {dirty && status === "published" && <span className="badge badge-warn no-dot" title="There are saved changes that aren't live yet">Changes pending</span>}
    </span>
  );
}

export function Empty({ icon = "Sparkles", title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={24} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center-fill">
      <div className="row muted">
        <Icon name="LoaderCircle" className="spin" size={18} /> {label ?? "Loading…"}
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 5 }: { rows?: number }) {
  return (
    <div className="col" style={{ padding: 16, gap: 12 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 22, width: `${90 - ((i * 13) % 40)}%` }} />
      ))}
    </div>
  );
}

// ---------- Modal & Drawer ----------
function useEscape(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

export function Modal({ title, description, onClose, children, footer, size }: { title: ReactNode; description?: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: "lg" | "xl" }) {
  useEscape(onClose);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${size ? `modal-${size}` : ""}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div>
            <div className="modal-title">{title}</div>
            {description && <div className="modal-desc">{description}</div>}
          </div>
          <Button variant="ghost" size="sm" iconOnly icon="X" onClick={onClose} aria-label="Close" />
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Drawer({ title, onClose, children, footer, width }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; width?: number }) {
  useEscape(onClose);
  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className="drawer" style={width ? { width: `min(${width}px, 100vw)` } : undefined} role="dialog" aria-modal="true">
        <div className="drawer-header">
          <div className="modal-title">{title}</div>
          <Button variant="ghost" size="sm" iconOnly icon="X" onClick={onClose} aria-label="Close" />
        </div>
        <div className="drawer-body">{children}</div>
        {footer && <div className="drawer-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

// ---------- Dropdown menu ----------
export interface MenuItem {
  label?: string;
  icon?: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  heading?: string;
  hidden?: boolean;
}
export function Menu({ trigger, items, align = "right" }: { trigger: (open: () => void, isOpen: boolean) => ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  const [pos, setPos] = useState<{ x: number; y: number; up: boolean } | null>(null);
  const anchor = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const open = () => {
    const r = anchor.current!.getBoundingClientRect();
    setPos({ x: align === "right" ? r.right : r.left, y: r.bottom + 6, up: r.bottom > window.innerHeight - 260 });
  };
  useEffect(() => {
    if (!pos) return;
    const close = (e: MouseEvent) => !menuRef.current?.contains(e.target as Node) && setPos(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    setTimeout(() => window.addEventListener("mousedown", close));
    window.addEventListener("keydown", esc);
    window.addEventListener("scroll", () => setPos(null), { once: true, capture: true });
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [pos]);
  useLayoutEffect(() => {
    if (pos && menuRef.current) menuRef.current.querySelector<HTMLButtonElement>(".menu-item")?.focus();
  }, [pos]);
  return (
    <>
      <span ref={anchor} style={{ display: "inline-flex" }}>
        {trigger(open, !!pos)}
      </span>
      {pos &&
        createPortal(
          <div
            ref={menuRef}
            className="menu"
            role="menu"
            style={{
              left: align === "right" ? undefined : pos.x,
              right: align === "right" ? window.innerWidth - pos.x : undefined,
              top: pos.up ? undefined : pos.y,
              bottom: pos.up ? window.innerHeight - pos.y + 40 : undefined,
            }}
          >
            {items
              .filter((i) => !i.hidden)
              .map((it, i) =>
                it.separator ? (
                  <div key={i} className="menu-sep" />
                ) : it.heading ? (
                  <div key={i} className="menu-label">
                    {it.heading}
                  </div>
                ) : (
                  <button
                    key={i}
                    role="menuitem"
                    className={`menu-item ${it.danger ? "danger" : ""}`}
                    onClick={() => {
                      setPos(null);
                      it.onClick?.();
                    }}
                  >
                    {it.icon && <Icon name={it.icon} size={15} />}
                    {it.label}
                  </button>
                ),
              )}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------- Toasts ----------
type ToastT = { id: number; kind: "success" | "error" | "info"; message: string; action?: { label: string; onClick: () => void } };
let toasts: ToastT[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let nextId = 1;
function push(kind: ToastT["kind"], message: string, action?: ToastT["action"]) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, message, action }].slice(-4);
  emit();
  setTimeout(() => dismiss(id), kind === "error" ? 7000 : 3800);
}
function dismiss(id: number) {
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}
export const toast = {
  success: (m: string, action?: ToastT["action"]) => push("success", m, action),
  info: (m: string) => push("info", m),
  error: (e: unknown) => push("error", e instanceof ApiError || e instanceof Error ? e.message : String(e)),
};
export function Toasts() {
  const list = useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => toasts,
  );
  return createPortal(
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon name={t.kind === "success" ? "CircleCheck" : t.kind === "error" ? "CircleAlert" : "Info"} size={17} className="toast-icon" />
          <div>
            {t.message}
            {t.action && (
              <button className="toast-action" onClick={() => (t.action!.onClick(), dismiss(t.id))}>
                {t.action.label}
              </button>
            )}
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <Icon name="X" size={14} />
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

// ---------- Confirm / prompt dialogs ----------
type DialogReq =
  | { kind: "confirm"; title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean; resolve: (v: boolean) => void }
  | { kind: "prompt"; title: string; message?: ReactNode; label?: string; initial?: string; confirmLabel?: string; placeholder?: string; inputType?: "text" | "password"; resolve: (v: string | null) => void };
let dialog: DialogReq | null = null;
const dListeners = new Set<() => void>();
const setDialog = (d: DialogReq | null) => ((dialog = d), dListeners.forEach((l) => l()));

export function confirmDialog(opts: { title: string; message?: ReactNode; confirmLabel?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => setDialog({ kind: "confirm", ...opts, resolve }));
}
export function promptDialog(opts: { title: string; message?: ReactNode; label?: string; initial?: string; confirmLabel?: string; placeholder?: string; inputType?: "text" | "password" }) {
  return new Promise<string | null>((resolve) => setDialog({ kind: "prompt", ...opts, resolve }));
}
export function Dialogs() {
  const d = useSyncExternalStore(
    (l) => (dListeners.add(l), () => dListeners.delete(l)),
    () => dialog,
  );
  const [value, setValue] = useState("");
  useEffect(() => {
    if (d?.kind === "prompt") setValue(d.initial ?? "");
  }, [d]);
  if (!d) return null;
  const close = (v: any) => {
    setDialog(null);
    (d.resolve as (x: any) => void)(v);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => close(d.kind === "confirm" ? false : null)}
      footer={
        <>
          <Button onClick={() => close(d.kind === "confirm" ? false : null)}>Cancel</Button>
          <Button variant={d.kind === "confirm" && d.danger ? "danger-solid" : "primary"} onClick={() => close(d.kind === "confirm" ? true : value.trim() || null)} autoFocus={d.kind === "confirm"}>
            {d.confirmLabel ?? (d.kind === "confirm" ? "Confirm" : "Save")}
          </Button>
        </>
      }
    >
      {d.message && <div className="muted" style={{ marginBottom: d.kind === "prompt" ? 14 : 0 }}>{d.message}</div>}
      {d.kind === "prompt" && (
        <Field label={d.label}>
          <input className="input" type={d.inputType ?? "text"} autoComplete={d.inputType === "password" ? "current-password" : undefined} autoFocus value={value} placeholder={d.placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && close(value.trim() || null)} />
        </Field>
      )}
    </Modal>
  );
}

// ---------- data loading ----------
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const d = await fnRef.current();
      setData(d);
      setError(null);
      return d;
    } catch (e: any) {
      setError(e?.message ?? String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, setData, error, loading, reload };
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Empty icon="CircleAlert" title="Couldn't load this" action={onRetry && <Button icon="RotateCcw" onClick={onRetry}>Try again</Button>}>
      {message}
    </Empty>
  );
}

/** Switches the whole UI (including dialogs and menus) to the graphite "pro" chrome while mounted. */
export function useProChrome() {
  useEffect(() => {
    document.body.classList.add("reef-pro");
    return () => document.body.classList.remove("reef-pro");
  }, []);
}

export function useHotkey(combo: string, handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const [mod, key] = combo.includes("+") ? combo.split("+") : ["", combo];
    const h = (e: KeyboardEvent) => {
      const modOk = mod === "mod" ? e.ctrlKey || e.metaKey : !e.ctrlKey && !e.metaKey;
      if (modOk && e.key.toLowerCase() === key.toLowerCase()) ref.current(e);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [combo, enabled]);
}
