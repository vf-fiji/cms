// Applies the Vodafone / Apple-style theme to an existing Reef database.
// New installs get it from the seed automatically; this updates sites created earlier.
//
//   npm run theme:vodafone
//
// Safe to run more than once. The current Default template CSS is backed up to
// data/backups/ before it is replaced, and demo artwork keeps its file names so
// pages that use it keep working.
import fs from "node:fs";
import path from "node:path";
import { all, get, run, now, saveSettings, DATA_DIR, UPLOAD_DIR } from "../server/db";
import { ART_PALETTES, artSvg, DEFAULT_TEMPLATE_CSS, LANDING_TEMPLATE_CSS } from "../server/seed";

const done: string[] = [];

// 1. Brand colours
saveSettings({ primaryColor: "#e60000", accentColor: "#820000" });
done.push("Brand colours set to Vodafone red (#E60000) and dark red (#820000)");

// 2. Templates (back up first)
const backups = path.join(DATA_DIR, "backups");
fs.mkdirSync(backups, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
for (const [name, css] of [
  ["Default", DEFAULT_TEMPLATE_CSS],
  ["Landing (no navigation)", LANDING_TEMPLATE_CSS],
] as const) {
  const t = get<{ id: number; css: string }>("SELECT id, css FROM templates WHERE name = ?", name);
  if (!t) continue;
  if (t.css === css) {
    done.push(`Template “${name}” already themed`);
    continue;
  }
  const file = path.join(backups, `template-${t.id}-${stamp}.css`);
  fs.writeFileSync(file, t.css);
  run("UPDATE templates SET css = ?, updated_at = ? WHERE id = ?", css, now(), t.id);
  done.push(`Template “${name}” restyled (previous CSS saved to ${path.relative(process.cwd(), file)})`);
}

// 3. Content type colours, only where they still have the original demo colours
const typeColors: Record<string, [string, string]> = { news: ["#4f46e5", "#e60000"], events: ["#db2777", "#9c2aa0"], team: ["#059669", "#007c92"] };
for (const [key, [from, to]] of Object.entries(typeColors)) {
  if (run("UPDATE content_types SET color = ? WHERE key = ? AND color = ?", to, key, from).changes) done.push(`Content type “${key}” recoloured`);
}

// 4. Demo artwork: recolour with Vodafone palettes. Media is served with a long
// immutable cache, so each file gets a new name and every reference is updated.
const OLD_NAMES = ["Lagoon", "Sunset", "Rainforest", "Coral", "Night reef", "Sand"];
const REFERENCES: [table: string, column: string][] = [
  ["pages", "layout"],
  ["pages", "published"],
  ["pages", "seo"],
  ["content_items", "data"],
  ["templates", "html"],
  ["templates", "css"],
  ["code_assets", "content"],
  ["custom_widgets", "template"],
  ["settings", "value"],
];
for (const m of all<{ id: number; filename: string; original_name: string }>("SELECT id, filename, original_name FROM media WHERE folder = 'Artwork'")) {
  const i = OLD_NAMES.findIndex((n) => m.original_name === `${n}.svg`);
  if (i < 0) continue;
  const [name, a, b, c] = ART_PALETTES[i];
  const svg = artSvg(i + 1, a, b, c);
  const filename = `${name.toLowerCase().replace(/\s+/g, "-")}-${Math.random().toString(16).slice(2, 8)}.svg`;
  fs.writeFileSync(path.join(UPLOAD_DIR, filename), svg);
  const [from, to] = [`/media/${m.filename}`, `/media/${filename}`];
  let refs = 0;
  for (const [table, col] of REFERENCES) refs += run(`UPDATE ${table} SET ${col} = replace(${col}, ?, ?) WHERE instr(${col}, ?) > 0`, from, to, from).changes;
  run(
    "UPDATE media SET filename = ?, original_name = ?, title = ?, alt = ?, size = ? WHERE id = ?",
    filename,
    `${name}.svg`,
    `${name} artwork`,
    `Abstract ${name.toLowerCase()} gradient artwork`,
    Buffer.byteLength(svg),
    m.id,
  );
  fs.rmSync(path.join(UPLOAD_DIR, m.filename), { force: true });
  done.push(`Artwork “${OLD_NAMES[i]}” → “${name}” (${refs} reference${refs === 1 ? "" : "s"} updated)`);
}

console.log("\nVodafone theme applied:\n" + done.map((d) => `  • ${d}`).join("\n") + "\n");
