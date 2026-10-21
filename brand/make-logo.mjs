// Builds the square VodaForge mark from brand/vodaforge-logo-source.webp (symbol only, no wordmark).
//   node brand/make-logo.mjs
// Writes static/brand/*.png and static/favicon.png. The white background becomes transparent,
// with edge pixels un-blended from white so the mark looks clean on any background.
import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("./vodaforge-logo-source.webp", import.meta.url));
const OUT = new URL("../static/brand/", import.meta.url);
const out = (name) => fileURLToPath(new URL(name, OUT));
const SYMBOL_ROWS = [150, 670]; // the symbol sits above the wordmark (which starts at row 682)

const { data, info } = await sharp(SRC).removeAlpha().raw().toBuffer({ resolveWithObject: true });
const W = info.width;

// bounding box of the symbol's ink within its rows
let x0 = W, x1 = 0, y0 = Infinity, y1 = 0;
for (let y = SYMBOL_ROWS[0]; y <= SYMBOL_ROWS[1]; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    if (Math.min(data[i], data[i + 1], data[i + 2]) < 245) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
const w = x1 - x0 + 1, h = y1 - y0 + 1;

// white → transparent: alpha from how far the pixel is from white, colour un-blended
const rgba = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = ((y + y0) * W + (x + x0)) * 3, o = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    let a = (255 - Math.min(r, g, b)) / 255;
    if (a < 0.04) a = 0;
    const un = (c) => (a ? Math.max(0, Math.min(255, Math.round((c - 255 * (1 - a)) / a))) : 0);
    rgba[o] = un(r); rgba[o + 1] = un(g); rgba[o + 2] = un(b); rgba[o + 3] = Math.round(a * 255);
  }

// square canvas with a little breathing room
const side = Math.round(Math.max(w, h) * 1.08);
const square = await sharp({ create: { width: side, height: side, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
  .composite([{ input: rgba, raw: { width: w, height: h, channels: 4 }, left: Math.round((side - w) / 2), top: Math.round((side - h) / 2) }])
  .png()
  .toBuffer();

fs.mkdirSync(fileURLToPath(OUT), { recursive: true });
for (const size of [1024, 512, 192, 64]) await sharp(square).resize(size, size).png({ compressionLevel: 9 }).toFile(out(`vodaforge-mark-${size}.png`));
// app icon: the mark on white, for home screens and anywhere a transparent icon would vanish
await sharp({ create: { width: 180, height: 180, channels: 4, background: "#ffffff" } })
  .composite([{ input: await sharp(square).resize(150, 150).toBuffer(), left: 15, top: 15 }])
  .png()
  .toFile(out("apple-touch-icon.png"));
await sharp(square).resize(48, 48).png({ compressionLevel: 9 }).toFile(out("../favicon.png"));
// the admin app's own copies (Vite serves admin/public under /admin/ in dev and build)
const adminPublic = fileURLToPath(new URL("../admin/public/", import.meta.url));
fs.mkdirSync(adminPublic, { recursive: true });
fs.copyFileSync(out("../favicon.png"), `${adminPublic}favicon.png`);
fs.copyFileSync(out("apple-touch-icon.png"), `${adminPublic}apple-touch-icon.png`);
console.log(`symbol ${w}x${h} at ${x0},${y0} → square ${side}px`);
