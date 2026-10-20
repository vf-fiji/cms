// Responsive images: uploads get resized WebP copies, and the renderer emits
// srcset/sizes so phones download small files. Media can also carry a focal
// point that crops (object-position / background-position) respect.
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { all, get, json, run, UPLOAD_DIR } from "./db";

// libvips' file cache keeps handles open, which on Windows blocks overwriting
// or deleting files it has touched. Work from buffers and keep no cache.
sharp.cache(false);

export const VARIANT_WIDTHS = [480, 960, 1600, 2400];
const RASTER = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"]);

export interface Variant {
  w: number;
  file: string;
}

interface MediaInfo {
  width: number | null;
  height: number | null;
  variants: Variant[];
  focal: string;
}

export const isRaster = (mime: string) => RASTER.has(mime);

/** Creates WebP copies narrower than the original. Returns what was written. */
export async function makeVariants(filename: string, mime: string, width: number | null): Promise<Variant[]> {
  if (!isRaster(mime) || !width) return [];
  const src = fs.readFileSync(path.join(UPLOAD_DIR, filename));
  const base = filename.replace(/\.[^.]+$/, "");
  const out: Variant[] = [];
  for (const w of VARIANT_WIDTHS.filter((x) => x < width)) {
    const file = `${base}-w${w}.webp`;
    const buf = await sharp(src).rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 78, effort: 4 }).toBuffer();
    fs.writeFileSync(path.join(UPLOAD_DIR, file), buf);
    out.push({ w, file });
  }
  return out;
}

export function removeVariants(variants: Variant[]) {
  for (const v of variants) fs.rmSync(path.join(UPLOAD_DIR, v.file), { force: true });
}

// filename → info, so rendering doesn't hit the database for every image
const cache = new Map<string, MediaInfo | null>();
export function invalidateMediaCache() {
  cache.clear();
}

function infoFor(url: string): MediaInfo | null {
  const m = /^\/media\/([^/?#]+)$/.exec(url ?? "");
  if (!m) return null;
  const filename = decodeURIComponent(m[1]);
  if (!cache.has(filename)) {
    const r = get<{ width: number | null; height: number | null; variants: string; focal: string }>("SELECT width, height, variants, focal FROM media WHERE filename = ?", filename);
    cache.set(filename, r ? { width: r.width, height: r.height, variants: json<Variant[]>(r.variants, []), focal: r.focal || "" } : null);
  }
  return cache.get(filename) ?? null;
}

/** `srcset` value for an uploaded image, or "" when there are no smaller copies. */
export function srcsetFor(url: string): string {
  const info = infoFor(url);
  if (!info?.variants.length) return "";
  const parts = info.variants.map((v) => `/media/${encodeURIComponent(v.file)} ${v.w}w`);
  if (info.width) parts.push(`${url} ${info.width}w`);
  return parts.join(", ");
}

/** The smallest copy at least `target` px wide (falls back to the original). */
export function bestVariant(url: string, target = 1600): string {
  const info = infoFor(url);
  const v = info?.variants.find((x) => x.w >= target) ?? info?.variants.at(-1);
  return v && (!info?.width || info.width > target * 1.25) ? `/media/${encodeURIComponent(v.file)}` : url;
}

/** CSS position for the image's focal point, e.g. "30% 20%", or "". */
export function focalFor(url: string): string {
  return infoFor(url)?.focal ?? "";
}

export function dimensionsFor(url: string) {
  const info = infoFor(url);
  return info?.width && info.height ? { width: info.width, height: info.height } : null;
}

/** Fills in copies for raster images uploaded before variants existed. */
export async function backfillVariants(log = false) {
  const rows = all<{ id: number; filename: string; mime: string; width: number | null }>("SELECT id, filename, mime, width FROM media WHERE variants = '[]' AND width > ?", VARIANT_WIDTHS[0]);
  let done = 0;
  for (const r of rows) {
    if (!isRaster(r.mime) || !fs.existsSync(path.join(UPLOAD_DIR, r.filename))) continue;
    try {
      const v = await makeVariants(r.filename, r.mime, r.width);
      run("UPDATE media SET variants = ? WHERE id = ?", JSON.stringify(v), r.id);
      done++;
    } catch (e: any) {
      console.error(`[images] couldn't resize ${r.filename}:`, e?.message ?? e);
    }
  }
  if (done) invalidateMediaCache();
  if (log) console.log(`[images] created responsive copies for ${done} image${done === 1 ? "" : "s"}`);
  return done;
}
