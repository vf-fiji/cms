import { Router } from "express";
import multer from "multer";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { imageSize } from "image-size";
import { all, get, run, now, logActivity, UPLOAD_DIR } from "../db";
import { requirePerm, HttpError } from "../auth";
import { str, idParam, notFound } from "../http";
import { mapMedia, ALLOWED_UPLOADS } from "../media";
import { emit } from "../functions";
import { invalidateMediaCache, isRaster, makeVariants, removeVariants } from "../images";

export const media = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 20 },
});

function sniff(buf: Buffer, declared: string): string | null {
  const hex = buf.subarray(0, 12).toString("hex");
  if (hex.startsWith("89504e47")) return "image/png";
  if (hex.startsWith("ffd8ff")) return "image/jpeg";
  if (hex.startsWith("47494638")) return "image/gif";
  if (hex.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.subarray(4, 12).toString().startsWith("ftypavif")) return "image/avif";
  if (buf.subarray(4, 8).toString() === "ftyp") return "video/mp4";
  if (hex.startsWith("25504446")) return "application/pdf";
  if (hex.startsWith("504b0304")) return declared.includes("openxmlformats") ? declared : "application/zip";
  if (hex.startsWith("494433") || hex.startsWith("fffb")) return "audio/mpeg";
  if (declared === "image/svg+xml") {
    const text = buf.toString("utf8");
    // SVGs are served with a strict CSP, but refuse obvious script content anyway.
    if (!/<svg[\s>]/i.test(text) || /<script|on\w+\s*=|javascript:/i.test(text)) return null;
    return declared;
  }
  if (declared === "text/csv") return declared;
  return null;
}

media.get("/media", (req, res) => {
  const where: string[] = [];
  const params: any[] = [];
  if (req.query.folder !== undefined && req.query.folder !== "__all") {
    where.push("folder = ?");
    params.push(String(req.query.folder));
  }
  const q = String(req.query.q ?? "").trim();
  if (q) {
    where.push("(original_name LIKE ? OR title LIKE ? OR alt LIKE ?)");
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (req.query.type === "image") where.push("mime LIKE 'image/%'");
  if (req.query.type === "document") where.push("mime NOT LIKE 'image/%' AND mime NOT LIKE 'video/%'");
  if (req.query.type === "video") where.push("mime LIKE 'video/%'");
  const sql = `SELECT * FROM media ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT 500`;
  const folders = [
    ...new Set([...all("SELECT name FROM media_folders").map((r) => r.name), ...all("SELECT DISTINCT folder FROM media WHERE folder != ''").map((r) => r.folder)]),
  ].sort();
  const counts = Object.fromEntries(all("SELECT folder, COUNT(*) n FROM media GROUP BY folder").map((r) => [r.folder, r.n]));
  res.json({ items: all(sql, ...params).map(mapMedia), folders, counts, total: get("SELECT COUNT(*) n FROM media")!.n });
});

media.post("/media", requirePerm("media.manage"), upload.array("files", 20), async (req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw new HttpError(400, "Choose at least one file to upload.");
  const folder = str(req.body?.folder, "Folder", { max: 80 });
  const created: any[] = [];
  const rejected: string[] = [];
  for (const f of files) {
    const mime = sniff(f.buffer, f.mimetype);
    if (!mime || !ALLOWED_UPLOADS[mime]) {
      rejected.push(`${f.originalname}: this file type isn't supported`);
      continue;
    }
    const ext = ALLOWED_UPLOADS[mime];
    const base = path
      .parse(f.originalname)
      .name.toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "file";
    const filename = `${base}-${crypto.randomBytes(4).toString("hex")}.${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), f.buffer);
    let width: number | null = null;
    let height: number | null = null;
    if (mime.startsWith("image/")) {
      try {
        const d = imageSize(f.buffer);
        width = d.width ?? null;
        height = d.height ?? null;
      } catch {
        /* dimensions are optional */
      }
    }
    let variants: Awaited<ReturnType<typeof makeVariants>> = [];
    if (isRaster(mime)) {
      try {
        variants = await makeVariants(filename, mime, width);
      } catch (e: any) {
        console.error(`[images] couldn't resize ${filename}:`, e?.message ?? e); // the original still works
      }
    }
    const title = path.parse(f.originalname).name.replace(/[-_]+/g, " ");
    const r = run(
      "INSERT INTO media(folder, filename, original_name, mime, size, width, height, alt, title, variants, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      folder,
      filename,
      f.originalname.slice(0, 200),
      mime,
      f.size,
      width,
      height,
      "",
      title,
      JSON.stringify(variants),
      now(),
    );
    const item = mapMedia(get("SELECT * FROM media WHERE id = ?", r.lastId));
    created.push(item);
    emit("media.uploaded", item);
  }
  invalidateMediaCache();
  if (created.length) logActivity(req.user!.id, "uploaded", "media", null, created.length === 1 ? created[0].originalName : `${created.length} files`);
  res.json({ items: created, rejected });
});

media.put("/media/:id", requirePerm("media.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const m = get("SELECT * FROM media WHERE id = ?", id) ?? notFound("File");
  let focal = m.focal ?? "";
  if (req.body?.focal !== undefined) {
    const f = String(req.body.focal ?? "").trim();
    if (f && !/^\d{1,3}(\.\d+)?% \d{1,3}(\.\d+)?%$/.test(f)) throw new HttpError(400, "Focal point must look like “30% 60%”.");
    focal = f;
  }
  run(
    "UPDATE media SET alt = ?, title = ?, folder = ?, focal = ? WHERE id = ?",
    str(req.body?.alt ?? m.alt, "Alt text", { max: 300 }),
    str(req.body?.title ?? m.title, "Title", { max: 200 }),
    str(req.body?.folder ?? m.folder, "Folder", { max: 80 }),
    focal,
    id,
  );
  invalidateMediaCache();
  res.json(mapMedia(get("SELECT * FROM media WHERE id = ?", id)));
});

media.delete("/media/:id", requirePerm("media.manage"), (req, res) => {
  const id = idParam(req.params.id);
  const m = get("SELECT * FROM media WHERE id = ?", id) ?? notFound("File");
  const url = `/media/${m.filename}`;
  const usedBy = [
    ...all("SELECT title FROM pages WHERE layout LIKE ? OR published LIKE ? LIMIT 5", `%${url}%`, `%${url}%`).map((r) => `page “${r.title}”`),
    ...all("SELECT title FROM content_items WHERE data LIKE ? LIMIT 5", `%${url}%`).map((r) => `“${r.title}”`),
  ];
  if (usedBy.length && req.query.force !== "1") throw new HttpError(409, `This file is used on ${usedBy.join(", ")}. Delete it anyway?`, { usedBy });
  run("DELETE FROM media WHERE id = ?", id);
  fs.rmSync(path.join(UPLOAD_DIR, m.filename), { force: true });
  try {
    removeVariants(JSON.parse(m.variants || "[]"));
  } catch {
    /* nothing to clean up */
  }
  invalidateMediaCache();
  logActivity(req.user!.id, "deleted", "media", id, m.original_name);
  res.json({ ok: true });
});

media.post("/media-folders", requirePerm("media.manage"), (req, res) => {
  const name = str(req.body?.name, "Folder name", { required: true, max: 80 });
  run("INSERT OR IGNORE INTO media_folders(name) VALUES(?)", name);
  res.json({ ok: true });
});

media.delete("/media-folders/:name", requirePerm("media.manage"), (req, res) => {
  const name = String(req.params.name);
  run("UPDATE media SET folder = '' WHERE folder = ?", name);
  run("DELETE FROM media_folders WHERE name = ?", name);
  res.json({ ok: true });
});
