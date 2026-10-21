// Builds the square VodaForge mark from brand/vodaforge-logo-source.webp (symbol only, no wordmark).
//   node brand/make-logo.mjs
// Writes static/brand/*.png and static/favicon.png. The white around the mark becomes transparent
// (edges un-blended from white, so it looks clean on any background); the white hammer stays white.
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

// Background vs. white inside the mark: flood-fill light pixels from the crop's edges. What the fill
// reaches is background and becomes transparent; light pixels it can't reach (the hammer) stay white.
const LIGHT = 200;
const isLight = (x, y) => {
  const i = ((y + y0) * W + (x + x0)) * 3;
  return Math.min(data[i], data[i + 1], data[i + 2]) >= LIGHT;
};
// The hammer's white is open to the outside in two places: the strip above its head between the V
// and the F, and the end of its handle between the V's tip and the F's lower stroke. These lines
// (source-image coordinates) close those openings for the fill only; they're never drawn.
const BARRIERS = [
  [[690, 358], [748, 330]], // top of the hammer head
  [[604, 596], [646, 659]], // end of the handle
];
const blocked = new Uint8Array(w * h);
for (const [[ax, ay], [bx, by]] of BARRIERS) {
  const steps = Math.ceil(Math.hypot(bx - ax, by - ay) * 2);
  for (let t = 0; t <= steps; t++) {
    const cx = ax + ((bx - ax) * t) / steps - x0, cy = ay + ((by - ay) * t) / steps - y0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.round(cx + dx), yy = Math.round(cy + dy);
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) blocked[yy * w + xx] = 1;
    }
  }
}
const light = (x, y) => !blocked[y * w + x] && isLight(x, y);
const bg = new Uint8Array(w * h);
const stack = [];
for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
while (stack.length) {
  const [x, y] = stack.pop();
  if (x < 0 || y < 0 || x >= w || y >= h || bg[y * w + x] || !light(x, y)) continue;
  bg[y * w + x] = 1;
  stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
}
// pixels within 2px of the background are its anti-aliased edge: those get partial transparency
const edge = new Uint8Array(w * h);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    if (!bg[y * w + x]) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) edge[yy * w + xx] = 1;
    }
  }

let kept = 0;
const rgba = Buffer.alloc(w * h * 4);
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    const i = ((y + y0) * W + (x + x0)) * 3, o = (y * w + x) * 4;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    // the barrier lines themselves are background, so the hammer ends cleanly at them
    const hammer = !bg[y * w + x] && !blocked[y * w + x] && Math.min(r, g, b) >= LIGHT;
    if (blocked[y * w + x] && Math.min(r, g, b) >= LIGHT) bg[y * w + x] = 1;
    if (!edge[y * w + x] || hammer) {
      // inside the mark (red, shading or the white hammer): fully opaque, colour as drawn
      rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255;
      if (hammer) kept++;
      continue;
    }
    // background and its edge: alpha from how far the pixel is from white, colour un-blended
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
console.log(`symbol ${w}x${h} at ${x0},${y0} → square ${side}px; ${kept} white pixels kept inside the mark`);
