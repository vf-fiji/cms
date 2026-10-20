import "./env";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileForBrowser, getBrowserModule, renderReactWidget, ssr, reactRuntime } from "../server/react";

const COUNTER = `import { useState } from "react";
export default function Counter({ label }) {
  const [n] = useState(3);
  return <p className="c">{label}: {n}</p>;
}`;

describe("JSX compilation", () => {
  it("compiles a component and caches it by content hash", async () => {
    const a = await compileForBrowser(COUNTER);
    const b = await compileForBrowser(COUNTER);
    assert.ok("hash" in a && "hash" in b);
    assert.equal(a.hash, b.hash);
    const code = getBrowserModule(a.hash)!;
    assert.match(code, /from "react\/jsx-runtime"/);
    assert.match(code, /from "react"/);
  });

  it("reports syntax errors with a location", async () => {
    const r = await compileForBrowser("export default function X() { return <div>; }");
    assert.ok("error" in r);
    assert.match(r.error, /line \d+/);
  });

  it("requires a default export", async () => {
    const r = await compileForBrowser("export function X() { return <div />; }");
    assert.ok("error" in r);
    assert.match(r.error, /default export/);
  });

  it("routes other npm imports through esm.sh while sharing React", async () => {
    const r = await compileForBrowser(`import confetti from "canvas-confetti";\nimport { useEffect } from "react";\nexport default function C() { useEffect(() => confetti(), []); return null; }`);
    assert.ok("hash" in r);
    const code = getBrowserModule(r.hash)!;
    assert.match(code, /https:\/\/esm\.sh\/canvas-confetti\?external=react,react-dom/);
    assert.doesNotMatch(code, /esm\.sh\/react/);
  });
});

describe("server-side rendering", () => {
  it("renders a component to HTML", async () => {
    assert.equal(await ssr(COUNTER, { label: "Count" }), '<p class="c">Count<!-- -->: <!-- -->3</p>');
  });

  it("falls back to browser-only rendering when a component needs window", async () => {
    assert.equal(await ssr("export default function W() { return <p>{window.innerWidth}</p>; }", {}), null);
  });

  it("falls back when a component imports a browser-only package", async () => {
    assert.equal(await ssr(`import x from "some-lib";\nexport default function W() { return <p>{String(x)}</p>; }`, {}), null);
  });

  it("stops a component that never finishes rendering", async () => {
    const started = Date.now();
    assert.equal(await ssr("export default function Loop() { for (;;) {} }", {}), null);
    assert.ok(Date.now() - started < 3000, "SSR should be cut off by its timeout");
  });

  it("escapes props in the hydration attribute", async () => {
    const out = await renderReactWidget({ id: "w1", source: COUNTER, props: { label: "It's <b>" }, ssr: true, editor: false });
    assert.match(out.html, /data-props='\{"label":"It&#39;s &lt;b>"\}'/);
    assert.match(out.html, /data-ssr/);
    assert.match(out.module!, /mount\(C, "w1"\)/);
  });

  it("skips SSR inside the editor and shows compile errors there only", async () => {
    const editor = await renderReactWidget({ id: "w2", source: COUNTER, props: {}, ssr: true, editor: true });
    assert.doesNotMatch(editor.html, /data-ssr/);
    const broken = await renderReactWidget({ id: "w3", source: "export default () => <div>", props: {}, ssr: true, editor: true });
    assert.match(broken.html, /React compile error/);
    const brokenLive = await renderReactWidget({ id: "w3", source: "export default () => <div>", props: {}, ssr: true, editor: false });
    assert.equal(brokenLive.html, "");
    assert.equal(brokenLive.module, null);
  });
});

describe("browser runtime", () => {
  it("bundles React with the mount helper", async () => {
    const js = await reactRuntime();
    for (const name of ["mount", "useState", "hydrateRoot", "createRoot", "jsx"]) assert.match(js, new RegExp(`\\b${name}\\b`));
  });
});
