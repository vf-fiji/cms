import type { MediaItem } from "../shared/types";

export function mediaUrl(v: string): string {
  return v || "";
}

export function mapMedia(r: any): MediaItem {
  return {
    id: r.id,
    folder: r.folder,
    filename: r.filename,
    originalName: r.original_name,
    mime: r.mime,
    size: r.size,
    width: r.width,
    height: r.height,
    alt: r.alt,
    title: r.title,
    url: `/media/${r.filename}`,
    createdAt: r.created_at,
  };
}

export const ALLOWED_UPLOADS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "audio/mpeg": "mp3",
  "text/csv": "csv",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};
