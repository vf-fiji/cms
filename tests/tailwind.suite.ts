import "./env";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { seedIfEmpty } from "../server/seed";
import { buildTailwind, checkTailwindInput, classesFromHtml, classesFromSource, LAYER_ORDER } from "../server/tailwind";
import { renderPageSnapshot } from "../server/render/site";
import { getSettings, saveSettings, get, json } from "../server/db";
import { makeSection, makeWidget } from "../shared/widgets";
import type { PageLayout } from "../shared/types";

before(() => {
  seedIfEmpty();
});

const on = { tailwindEnabled: true, tailwindPreflight: false, tailwindCss: "" };

describe("class extraction", () => {
  it("reads class attributes, decoding HTML entities", () => {
    assert.deepEqual(classesFromHtml(`<div class="p-6 md:p-10"><span class='bg-[url(&#39;/a.png&#39;)] text-red-500'></span></div>`), ["p-6", "md:p-10", "bg-[url('/a.png')]", "text-red-500"]);
  });

  it("reads class names from string literals in JS and JSX", () => {
    const src = `export default () => <a className="rounded-full px-6" onClick={() => go(ok ? 'bg-primary text-white' : \`border border-white/30\`)} />;`;
    const found = classesFromSource(src);
    for (const c of ["rounded-full", "px-6", "bg-primary", "text-white", "border", "border-white/30"]) assert.ok(found.includes(c), c);
  });
});

describe("compiling", () => {
  it("emits only the utilities that are used", async () => {
    const css = await buildTailwind(on, ["p-6", "md:grid-cols-3", "definitely-not-a-utility-xyz"]);
    assert.match(css, /\.p-6\s*\{/);
    assert.match(css, /\.md\\:grid-cols-3/);
    assert.doesNotMatch(css, /definitely-not-a-utility-xyz/);
    assert.doesNotMatch(css, /\.p-7\s*\{/);
  });

  it("supports arbitrary values, variants and brand colours", async () => {
    const css = await buildTailwind(on, ["bg-[#00b0ca]", "hover:shadow-xl", "bg-primary/20", "text-accent"]);
    assert.match(css, /#00b0ca/);
    assert.match(css, /\.hover\\:shadow-xl:hover/);
    assert.match(css, /--color-primary:\s*var\(--rf-primary\)/);
    assert.match(css, /\.text-accent/);
  });

  it("leaves Preflight out unless it's switched on", async () => {
    const without = await buildTailwind(on, ["p-4"]);
    assert.doesNotMatch(without, /@layer base\s*\{/);
    const withPreflight = await buildTailwind({ ...on, tailwindPreflight: true }, ["p-4"]);
    assert.match(withPreflight, /@layer base\s*\{/);
  });

  it("applies custom @theme and @utility CSS", async () => {
    const css = await buildTailwind({ ...on, tailwindCss: "@theme { --color-ocean: #00b0ca; }\n@utility card { border-radius: 2rem; padding: 2rem; }" }, ["bg-ocean", "card"]);
    assert.match(css, /--color-ocean:\s*#00b0ca/);
    assert.match(css, /\.card\s*\{/);
  });

  it("returns nothing when Tailwind is off", async () => {
    assert.equal(await buildTailwind({ ...on, tailwindEnabled: false }, ["p-4"]), "");
  });

  it("rejects custom CSS that can't compile, with a readable message", async () => {
    await assert.rejects(checkTailwindInput({ tailwindPreflight: false, tailwindCss: "@apply no-such-utility-zzz;" }), /Tailwind couldn't compile/);
    await checkTailwindInput({ tailwindPreflight: false, tailwindCss: "@theme { --color-brand: red; }" });
  });
});

describe("pages", () => {
  const render = async (layout: PageLayout, editor = false) =>
    renderPageSnapshot({ id: 999, parentId: null, slug: "tw", path: "/tw" }, { title: "TW", layout, seo: {}, customCss: "", customJs: "", customHead: "", templateId: null }, { editor });

  it("generates utilities used in Code blocks and block class fields", async () => {
    const html = await render({
      sections: [makeSection([12], [[makeWidget("html", { html: '<div class="grid gap-6 md:grid-cols-3">x</div>', css: "", js: "" }), makeWidget("heading", { text: "Hi", _class: "rounded-3xl shadow-xl" })]])],
    });
    const tw = html.match(/<style data-tailwind>([\s\S]*?)<\/style>/)?.[1] ?? "";
    for (const c of ["gap-6", "md\\\\:grid-cols-3", "rounded-3xl", "shadow-xl"]) assert.match(tw, new RegExp(`\\.${c}`), c);
  });

  it("generates utilities for client-only React blocks from their source", async () => {
    const html = await render({
      sections: [makeSection([12], [[makeWidget("react", { code: 'export default () => <p className="tracking-widest text-emerald-600">hi</p>;', props: "{}", css: "" })]])],
    });
    const tw = html.match(/<style data-tailwind>([\s\S]*?)<\/style>/)?.[1] ?? "";
    assert.match(tw, /\.tracking-widest/);
    assert.match(tw, /\.text-emerald-600/);
  });

  it("server-renders the seeded React + Tailwind widget with its utilities", async () => {
    const about = get("SELECT published FROM pages WHERE slug = 'about'");
    const snap = json<any>(about.published, null);
    const html = await renderPageSnapshot({ id: 2, parentId: null, slug: "about", path: "/about" }, snap, {});
    assert.match(html, /data-reef-react="[^"]+"[^>]*data-ssr/);
    assert.match(html, /Built with React \+ Tailwind/);
    const tw = html.match(/<style data-tailwind>([\s\S]*?)<\/style>/)?.[1] ?? "";
    assert.match(tw, /\.bg-neutral-950/);
    assert.match(tw, /\.size-80/);
    assert.match(tw, /\.border-primary/, "classes only used after a click are included too");
  });

  it("declares the cascade layer order before any stylesheet", async () => {
    const html = await render({ sections: [] });
    const order = html.indexOf(`<style>${LAYER_ORDER}</style>`);
    assert.ok(order > -1);
    assert.ok(order < html.indexOf("/_reef/site.css"));
    const siteCss = fs.readFileSync(path.resolve("static/site.css"), "utf8");
    assert.match(siteCss, /@layer reef \{/);
  });

  it("omits the Tailwind stylesheet when switched off in Settings", async () => {
    saveSettings({ tailwindEnabled: false });
    const html = await render({ sections: [makeSection([12], [[makeWidget("heading", { text: "x", _class: "p-6" })]])] });
    assert.doesNotMatch(html, /data-tailwind/);
    saveSettings({ tailwindEnabled: true });
    assert.equal(getSettings().tailwindEnabled, true);
  });
});
