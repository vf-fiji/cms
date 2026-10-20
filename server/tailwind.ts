// Tailwind CSS v4, compiled on the server per page. Classes are collected from
// the page's rendered HTML (so Liquid, widgets and server-rendered React all
// count) plus JS/JSX sources (classes that only exist in the browser).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "@tailwindcss/node";
import type { SiteSettings } from "../shared/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Cascade layers, lowest priority first. Reef's own site.css lives in `reef`,
 * above Tailwind's preflight (`base`) and below `utilities`, so utility classes
 * override Reef defaults. Template and page CSS stay unlayered and win over both.
 * This statement must come before any stylesheet that declares layers.
 */
export const LAYER_ORDER = "@layer theme, base, reef, components, utilities;";

export function tailwindInput(s: Pick<SiteSettings, "tailwindPreflight" | "tailwindCss">) {
  return [
    LAYER_ORDER,
    '@import "tailwindcss/theme.css" layer(theme);',
    s.tailwindPreflight ? '@import "tailwindcss/preflight.css" layer(base);' : "",
    '@import "tailwindcss/utilities.css" layer(utilities);',
    // brand colours from Settings, e.g. bg-primary, text-accent/80
    "@theme { --color-primary: var(--rf-primary); --color-accent: var(--rf-accent); }",
    s.tailwindCss ?? "",
  ]
    .filter(Boolean)
    .join("\n");
}

type Compiler = Awaited<ReturnType<typeof compile>>;
let cached: { input: string; compiler: Promise<Compiler>; seen: number } | null = null;

async function compilerFor(input: string): Promise<Compiler> {
  // the compiler accumulates every class it has seen; start fresh now and then
  if (!cached || cached.input !== input || cached.seen > 20_000) {
    cached = { input, compiler: compile(input, { base: ROOT, onDependency() {} }), seen: 0 };
    cached.compiler.catch(() => (cached = null));
  }
  return cached.compiler;
}

/** Throws a readable error if the custom Tailwind CSS can't be compiled. */
export async function checkTailwindInput(s: Pick<SiteSettings, "tailwindPreflight" | "tailwindCss">) {
  try {
    const c = await compile(tailwindInput(s), { base: ROOT, onDependency() {} });
    c.build(["p-4"]);
  } catch (e: any) {
    throw new Error(`Tailwind couldn't compile your CSS: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" };
const decode = (s: string) => s.replace(/&(amp|#39|quot|lt|gt);/g, (m) => ENTITIES[m]);

/** Class names from `class="…"` attributes in rendered HTML. */
export function classesFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out.push(...decode(m[1] ?? m[2]).split(/\s+/));
  return out;
}

/** Possible class names inside string literals of JS/JSX source. */
export function classesFromSource(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)) {
    const text = m[1] ?? m[2] ?? m[3] ?? "";
    for (const t of text.split(/\s+/)) if (t && t.length < 120 && !t.includes("${")) out.push(t);
  }
  return out;
}

/** CSS for the given candidates, or "" when there's nothing to emit or Tailwind fails. */
export async function buildTailwind(settings: Pick<SiteSettings, "tailwindEnabled" | "tailwindPreflight" | "tailwindCss">, candidates: Iterable<string>): Promise<string> {
  if (!settings.tailwindEnabled) return "";
  const list = [...new Set([...candidates].filter((c) => c && c.length < 200))];
  try {
    const compiler = await compilerFor(tailwindInput(settings));
    if (cached) cached.seen += list.length;
    return compiler.build(list);
  } catch (e: any) {
    console.error("[tailwind]", e?.message ?? e);
    return ""; // never break the page because of a Tailwind problem
  }
}
