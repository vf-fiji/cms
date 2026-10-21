// React support: JSX widgets compiled by esbuild, optionally server-rendered,
// then hydrated in the browser with a shared React runtime served by VodaForge.
import { build, transform } from "esbuild";
import crypto from "node:crypto";
import vm from "node:vm";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const React = require("react");
const ReactJsx = require("react/jsx-runtime");
const ReactDOMServer = require("react-dom/server");

export const REACT_RUNTIME_URL = "/_reef/react.js";
const REACT_SPECIFIERS = ["react", "react/jsx-runtime", "react/jsx-dev-runtime", "react-dom", "react-dom/client"];

export const IMPORT_MAP = `<script type="importmap">${JSON.stringify({ imports: Object.fromEntries(REACT_SPECIFIERS.map((s) => [s, REACT_RUNTIME_URL])) })}</script>`;

// ---------- browser runtime (React + ReactDOM + mount helper), built once ----------
const VENDOR_ENTRY = `
import * as R from "react";
import * as J from "react/jsx-runtime";
import * as C from "react-dom/client";
import * as D from "react-dom";
export default R;
export const { Children, Component, Fragment, PureComponent, StrictMode, Suspense, cloneElement, createContext, createElement, createRef, forwardRef, isValidElement, lazy, memo, startTransition, use, useActionState, useCallback, useContext, useDebugValue, useDeferredValue, useEffect, useId, useImperativeHandle, useInsertionEffect, useLayoutEffect, useMemo, useOptimistic, useReducer, useRef, useState, useSyncExternalStore, useTransition, version } = R;
export const { jsx, jsxs } = J;
export const jsxDEV = J.jsx;
export const { createRoot, hydrateRoot } = C;
export const { createPortal, flushSync } = D;

class VodaForgeBoundary extends R.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  render() {
    if (this.state.error) return R.createElement("div", { className: "rf-error" }, "This React widget crashed: " + (this.state.error.message || this.state.error));
    return this.props.children;
  }
}
const registry = new Map();
const roots = new WeakMap();
function mountOne(id) {
  const Comp = registry.get(id);
  const el = document.querySelector('[data-reef-react="' + id + '"]');
  if (!Comp || !el) return;
  let props = {};
  try { props = JSON.parse(el.getAttribute("data-props") || "{}"); } catch (e) {}
  const node = R.createElement(VodaForgeBoundary, null, R.createElement(Comp, props));
  const existing = roots.get(el);
  if (existing) return existing.render(node);
  const editing = document.body.classList.contains("rf-editing");
  if (!editing && el.hasAttribute("data-ssr")) roots.set(el, C.hydrateRoot(el, node));
  else { const root = C.createRoot(el); root.render(node); roots.set(el, root); }
}
/** Called by each widget's mount script. */
export function mount(Comp, id) { registry.set(id, Comp); mountOne(id); }
document.addEventListener("reef:rendered", () => registry.forEach((_, id) => mountOne(id)));
`;

let vendorPromise: Promise<string> | null = null;
export function reactRuntime(): Promise<string> {
  vendorPromise ??= build({
    stdin: { contents: VENDOR_ENTRY, resolveDir: ROOT, loader: "js", sourcefile: "reef-react-runtime.js" },
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    platform: "browser",
    target: "es2020",
    define: { "process.env.NODE_ENV": '"production"' },
    legalComments: "none",
  }).then((r) => r.outputFiles[0].text);
  vendorPromise.catch(() => (vendorPromise = null));
  return vendorPromise;
}

// ---------- compile JSX for the browser ----------
const browserModules = new Map<string, string>(); // hash -> ESM source
const hashOf = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Bare imports other than React resolve through esm.sh, sharing VodaForge's React. */
function rewriteBareImports(code: string) {
  return code.replace(/(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'./][^"']*)\2/g, (m, pre, q, spec) => {
    if (REACT_SPECIFIERS.includes(spec) || /^(https?:|data:)/.test(spec)) return m;
    const url = `https://esm.sh/${spec}${spec.includes("?") ? "&" : "?"}external=react,react-dom`;
    return `${pre}${q}${url}${q}`;
  });
}

export async function compileForBrowser(source: string): Promise<{ hash: string } | { error: string }> {
  const hash = hashOf(source);
  if (browserModules.has(hash)) return { hash };
  try {
    const out = await transform(source, { loader: "jsx", format: "esm", jsx: "automatic", target: "es2020", sourcefile: "widget.jsx", minifyWhitespace: false });
    if (!/export\s+default|export\s*\{[^}]*\bdefault\b/.test(out.code)) return { error: "Your component must be the default export, e.g. export default function MyWidget(props) { … }" };
    browserModules.set(hash, rewriteBareImports(out.code));
    return { hash };
  } catch (e: any) {
    return { error: formatEsbuildError(e) };
  }
}

export function getBrowserModule(hash: string) {
  return browserModules.get(hash);
}

function formatEsbuildError(e: any): string {
  const err = e?.errors?.[0];
  if (err) return `${err.text}${err.location ? ` (line ${err.location.line}, column ${err.location.column + 1})` : ""}`;
  return e?.message ?? String(e);
}

// ---------- server-side rendering ----------
const ssrModules = new Map<string, { fn?: unknown; error?: string }>();

async function loadForSsr(source: string) {
  const hash = hashOf(source);
  const cached = ssrModules.get(hash);
  if (cached) return cached;
  let entry: { fn?: unknown; error?: string };
  try {
    const out = await transform(source, { loader: "jsx", format: "cjs", jsx: "automatic", target: "es2022", sourcefile: "widget.jsx" });
    const mod = { exports: {} as any };
    const req = (spec: string) => {
      if (spec === "react") return React;
      if (spec === "react/jsx-runtime" || spec === "react/jsx-dev-runtime") return ReactJsx;
      throw new Error(`'${spec}' is only available in the browser`);
    };
    const context = vm.createContext({ module: mod, exports: mod.exports, require: req, console, URL, Intl, Date, Math, JSON }, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script(out.code, { filename: "widget.jsx" }).runInContext(context, { timeout: 250 });
    entry = { fn: mod.exports.default ?? mod.exports };
  } catch (e: any) {
    entry = { error: formatEsbuildError(e) };
  }
  ssrModules.set(hash, entry);
  return entry;
}

/** Returns HTML, or null when the component can't render on the server (it then renders in the browser only). */
export async function ssr(source: string, props: Record<string, unknown>): Promise<string | null> {
  const m = await loadForSsr(source);
  if (!m.fn || typeof m.fn !== "function") return null;
  try {
    const context = vm.createContext({ render: () => ReactDOMServer.renderToString(React.createElement(m.fn as any, props)) });
    return new vm.Script("render()").runInContext(context, { timeout: 300 }) as string;
  } catch {
    return null; // e.g. touches window/document at render time
  }
}

const escAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");

/** HTML for one React widget instance plus its mount script. */
export async function renderReactWidget(opts: { id: string; source: string; props: Record<string, unknown>; ssr: boolean; editor: boolean }) {
  const compiled = await compileForBrowser(opts.source);
  if ("error" in compiled) {
    return { html: opts.editor ? `<div class="rf-error"><strong>React compile error</strong><pre>${escAttr(compiled.error)}</pre></div>` : "", module: null };
  }
  const inner = opts.ssr && !opts.editor ? await ssr(opts.source, opts.props) : null;
  const html = `<div class="rf-react" data-reef-react="${opts.id}" data-props='${escAttr(JSON.stringify(opts.props))}'${inner !== null ? " data-ssr" : ""}>${inner ?? ""}</div>`;
  const module = `import C from "/_reef/rw/${compiled.hash}.js";\nimport { mount } from "react";\nmount(C, ${JSON.stringify(opts.id)});`;
  return { html, module };
}
