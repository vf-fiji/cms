import { HttpError } from "./auth";

export function str(v: unknown, label: string, opts: { required?: boolean; max?: number } = {}): string {
  if (v === undefined || v === null) {
    if (opts.required) throw new HttpError(400, `${label} is required.`);
    return "";
  }
  if (typeof v !== "string") throw new HttpError(400, `${label} must be text.`);
  const s = v.trim();
  if (opts.required && !s) throw new HttpError(400, `${label} is required.`);
  if (opts.max && s.length > opts.max) throw new HttpError(400, `${label} must be ${opts.max} characters or fewer.`);
  return s;
}

export function int(v: unknown, label: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${label} must be a whole number.`);
  return n;
}

export function key(v: unknown, label: string, allowUpper = false): string {
  const s = str(v, label, { required: true, max: 60 });
  const re = allowUpper ? /^[a-zA-Z][a-zA-Z0-9_]*$/ : /^[a-z][a-z0-9_-]*$/;
  if (!re.test(s)) {
    throw new HttpError(400, allowUpper ? `${label} must start with a letter and use only letters, numbers or underscores.` : `${label} must start with a letter and use only lowercase letters, numbers, dashes or underscores.`);
  }
  return s;
}

export function idParam(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, "Not found.");
  return n;
}

export function notFound(what = "That item"): never {
  throw new HttpError(404, `${what} could not be found. It may have been deleted.`);
}

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const cell = (v: unknown) => {
    let s = Array.isArray(v) ? v.join("; ") : v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // spreadsheet formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n");
}

/**
 * REEF_TRUST_PROXY → Express "trust proxy". Unset keeps the safe default (only a proxy on
 * this machine). "true"/"false", a hop count ("1") or addresses/subnets/presets
 * ("10.0.0.0/8, uniquelocal") are passed through.
 */
export function parseTrustProxy(v: string | undefined): boolean | number | string {
  const s = v?.trim();
  if (!s) return "loopback";
  if (/^(true|yes)$/i.test(s)) return true;
  if (/^(false|no)$/i.test(s)) return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}
