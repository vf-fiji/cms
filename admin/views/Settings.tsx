import { useEffect, useState } from "react";
import type { Redirect, SiteSettings } from "../../shared/types";
import { api } from "../lib/api";
import { Icon } from "../lib/icons";
import { bus } from "../lib/auth";
import { Button, confirmDialog, Empty, Field, Spinner, Switch, toast, useLoad } from "../components/ui";
import { ImageField } from "../components/FieldEditor";
import { CodeField } from "../components/CodeEditor";

type Tab = "general" | "seo" | "redirects" | "tailwind" | "api";

export function Settings() {
  const [tab, setTab] = useState<Tab>("general");
  const [s, setS] = useState<SiteSettings | null>(null);
  const [orig, setOrig] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.get<SiteSettings>("/settings").then((x) => (setS(x), setOrig(JSON.stringify(x)))).catch(toast.error);
  }, []);
  if (!s) return <Spinner />;
  const dirty = JSON.stringify(s) !== orig;
  const set = (p: Partial<SiteSettings>) => setS({ ...s, ...p });
  const save = async () => {
    setBusy(true);
    try {
      const x = await api.put<SiteSettings>("/settings", s);
      setS(x);
      setOrig(JSON.stringify(x));
      bus.emit("settings-changed");
      toast.success("Settings saved — live on the site now");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <div className="page-header">
        <div>
          <h1 className="page-title">Settings</h1>
          <div className="page-sub">Site identity, search engines, redirects and the developer API.</div>
        </div>
        {tab !== "redirects" && <Button variant="primary" icon="Save" loading={busy} disabled={!dirty} onClick={save}>Save settings</Button>}
      </div>
      <div className="underline-tabs" style={{ marginBottom: 20 }}>
        {(
          [
            ["general", "General", "Settings"],
            ["seo", "SEO & tracking", "Globe"],
            ["redirects", "Redirects", "ArrowRight"],
            ["tailwind", "Tailwind CSS", "Wind"],
            ["api", "API & headless", "Braces"],
          ] as const
        ).map(([k, l, ic]) => (
          <button key={k} className={`underline-tab ${tab === k ? "active" : ""}`} onClick={() => setTab(k)}>
            <Icon name={ic} size={14} /> {l}
          </button>
        ))}
      </div>

      {tab === "general" && (
        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <div className="section-title">Identity</div>
            <div className="grid-2">
              <Field label="Site name"><input className="input" value={s.siteName} onChange={(e) => set({ siteName: e.target.value })} /></Field>
              <Field label="Tagline"><input className="input" value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
              <Field label="Logo" help="Shown in the header. SVG or PNG with a transparent background works best."><ImageField value={s.logo} onChange={(v) => set({ logo: v })} /></Field>
              <Field label="Favicon"><ImageField value={s.favicon} onChange={(v) => set({ favicon: v })} /></Field>
            </div>
          </div>
          <div className="card card-pad">
            <div className="section-title">Brand colours</div>
            <div className="grid-2">
              {(["primaryColor", "accentColor"] as const).map((k) => (
                <Field key={k} label={k === "primaryColor" ? "Primary" : "Accent"} help={k === "primaryColor" ? "Buttons, links and highlights." : "Gradients and secondary highlights."}>
                  <div className="color-input">
                    <input type="color" value={s[k]} onChange={(e) => set({ [k]: e.target.value })} aria-label={k} />
                    <input className="input mono" value={s[k]} onChange={(e) => set({ [k]: e.target.value })} />
                  </div>
                </Field>
              ))}
            </div>
            <div className="row" style={{ gap: 10, marginTop: 4 }}>
              <span className="btn" style={{ background: s.primaryColor, color: "#fff", borderColor: "transparent" }}>Primary button</span>
              <span className="btn" style={{ background: `linear-gradient(135deg, ${s.primaryColor}, ${s.accentColor})`, color: "#fff", borderColor: "transparent" }}>Gradient</span>
            </div>
          </div>
          <div className="card card-pad">
            <div className="section-title">Footer & social</div>
            <Field label="Footer text" help="Liquid is allowed, e.g. {{ 'now' | date: '%Y' }} for the current year.">
              <input className="input" value={s.footerText} onChange={(e) => set({ footerText: e.target.value })} />
            </Field>
            <Field label="Social links">
              <div className="col" style={{ gap: 6 }}>
                {s.socialLinks.map((l, i) => (
                  <div key={i} className="row">
                    <input className="input" style={{ width: 160 }} placeholder="Label" value={l.label} onChange={(e) => set({ socialLinks: s.socialLinks.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
                    <input className="input grow" placeholder="https://" value={l.url} onChange={(e) => set({ socialLinks: s.socialLinks.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
                    <Button iconOnly variant="ghost" icon="X" aria-label="Remove" onClick={() => set({ socialLinks: s.socialLinks.filter((_, j) => j !== i) })} />
                  </div>
                ))}
                <div><Button size="sm" icon="Plus" onClick={() => set({ socialLinks: [...s.socialLinks, { label: "", url: "" }] })}>Add link</Button></div>
              </div>
            </Field>
          </div>
        </div>
      )}

      {tab === "seo" && (
        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <Field label="Default meta description" help="Used when a page doesn't have its own.">
              <textarea className="textarea" rows={2} value={s.defaultMetaDescription} onChange={(e) => set({ defaultMetaDescription: e.target.value })} />
            </Field>
            <Field label="Sitemap" help={<>Lists every published page and content item at <a href="/sitemap.xml" target="_blank" rel="noreferrer">/sitemap.xml</a>.</>}>
              <Switch checked={s.sitemapEnabled} onChange={(v) => set({ sitemapEnabled: v })} label="Generate sitemap.xml automatically" />
            </Field>
            <Field label="robots.txt">
              <CodeField language="html" value={s.robotsTxt} onChange={(v) => set({ robotsTxt: v })} />
            </Field>
          </div>
          <div className="card card-pad">
            <Field label="Analytics & tracking code" help="Pasted into the <head> of every live page (not in the editor). Google Analytics, Plausible, Meta Pixel…">
              <CodeField language="html" value={s.analyticsHead} onChange={(v) => set({ analyticsHead: v })} minHeight="140px" />
            </Field>
          </div>
        </div>
      )}

      {tab === "redirects" && <Redirects />}

      {tab === "tailwind" && (
        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <Field label="Tailwind CSS" help="Use Tailwind utility classes anywhere: Code blocks, custom widgets (Liquid or React), templates and each block's CSS classes field. Only the classes a page uses are generated.">
              <Switch checked={s.tailwindEnabled} onChange={(v) => set({ tailwindEnabled: v })} label={s.tailwindEnabled ? "On — Tailwind v4" : "Off"} />
            </Field>
            <Field label="Preflight (CSS reset)" help="Tailwind's base reset. Leave off to keep Reef's typography and widget styles; turn on if you build pages entirely with Tailwind.">
              <Switch checked={s.tailwindPreflight} disabled={!s.tailwindEnabled} onChange={(v) => set({ tailwindPreflight: v })} label={s.tailwindPreflight ? "Included" : "Not included"} />
            </Field>
          </div>
          <div className="card card-pad">
            <Field
              label="Your Tailwind CSS"
              help={
                <>
                  Add <code className="mono">@theme</code> tokens, <code className="mono">@utility</code> classes or <code className="mono">@custom-variant</code>s. <code className="mono">bg-primary</code> and <code className="mono">text-accent</code> already follow your brand colours. Saved settings are checked before they go live.
                </>
              }
            >
              <CodeField language="css" value={s.tailwindCss} onChange={(v) => set({ tailwindCss: v })} minHeight="220px" />
            </Field>
          </div>
          <div className="card card-pad">
            <div className="section-title">Quick reference</div>
            <pre className="mono" style={{ margin: 0, padding: 14, borderRadius: 12, background: "#1e1e1e", color: "#d4d4d4", fontSize: 12.5, overflowX: "auto" }}>{`<!-- Code block or Liquid widget -->
<div class="grid gap-6 md:grid-cols-3">
  <div class="rounded-3xl bg-neutral-100 p-8 hover:shadow-xl transition">
    <h3 class="text-2xl font-semibold text-primary">Fast</h3>
  </div>
</div>

// React widget — className works the same way
export default function Badge({ label }) {
  return <span className="rounded-full bg-primary/10 px-3 py-1 text-sm text-primary">{label}</span>;
}`}</pre>
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Classes built from variables at runtime (for example <code className="mono">{"`text-${color}-500`"}</code>) can't be detected — write class names out in full.
            </div>
          </div>
        </div>
      )}

      {tab === "api" && (
        <div className="col" style={{ gap: 16 }}>
          <div className="card card-pad">
            <Field label="Headless content API" help="Read-only JSON for published content. Drafts are never exposed.">
              <Switch checked={s.headlessApiEnabled} onChange={(v) => set({ headlessApiEnabled: v })} label={s.headlessApiEnabled ? "Enabled" : "Disabled"} />
            </Field>
            <table className="table" style={{ border: "1px solid var(--border)", borderRadius: 12 }}>
              <tbody>
                {[
                  ["GET", "/api/public/content/{type}", "List published items (limit, offset, tag, category, sort)"],
                  ["GET", "/api/public/content/{type}/{slug}", "One item"],
                  ["GET", "/api/public/pages", "Published pages with their layout tree"],
                  ["GET", "/api/public/site", "Site name, logo and colours"],
                  ["ANY", "/api/fn/{route}", "Your server functions (Code Studio)"],
                  ["POST", "/api/public/forms/{key}/submit", "Submit a form as JSON"],
                ].map(([m, p, d]) => (
                  <tr key={p}>
                    <td><span className="badge badge-accent no-dot mono">{m}</span></td>
                    <td className="mono" style={{ fontSize: 12.5 }}>{p}</td>
                    <td className="muted">{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="card card-pad">
            <div className="section-title">Use Reef from a React or Next.js app</div>
            <pre className="mono" style={{ margin: 0, padding: 14, borderRadius: 10, background: "#1e1e1e", color: "#d4d4d4", fontSize: 12.5, overflowX: "auto" }}>{`// Any React app (Vite, Next.js, Remix…)
const REEF = "${location.origin}";

export async function getNews(limit = 6) {
  const res = await fetch(\`\${REEF}/api/public/content/news?limit=\${limit}\`);
  if (!res.ok) throw new Error("Couldn't load news");
  return (await res.json()).items; // [{ title, slug, url, date, image, summary, ... }]
}

export function NewsList({ items }) {
  return items.map((n) => <a key={n.id} href={n.url}>{n.title}</a>);
}`}</pre>
            <div className="muted" style={{ fontSize: 13, marginTop: 10 }}>
              Prefer building inside Reef? Write React components as <strong>custom widgets</strong> in Code Studio (server-rendered and hydrated), or drop a <strong>React block</strong> onto any page.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Redirects() {
  const { data, reload } = useLoad(() => api.get<Redirect[]>("/redirects"));
  const [form, setForm] = useState({ fromPath: "", toPath: "", code: 301 });
  const add = async () => {
    try {
      await api.post("/redirects", form);
      setForm({ fromPath: "", toPath: "", code: 301 });
      toast.success("Redirect added");
      reload();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <div className="card-body row" style={{ borderBottom: "1px solid var(--border)", alignItems: "flex-end" }}>
        <Field label="From"><input className="input mono" placeholder="/old-page" value={form.fromPath} onChange={(e) => setForm({ ...form, fromPath: e.target.value })} /></Field>
        <span className="subtle" style={{ marginBottom: 26 }}><Icon name="ArrowRight" size={16} /></span>
        <Field label="To"><input className="input mono" placeholder="/new-page or https://…" value={form.toPath} onChange={(e) => setForm({ ...form, toPath: e.target.value })} /></Field>
        <Field label="Type">
          <select className="select" value={form.code} onChange={(e) => setForm({ ...form, code: Number(e.target.value) })}>
            <option value={301}>301 Permanent</option>
            <option value={302}>302 Temporary</option>
          </select>
        </Field>
        <div className="field"><Button variant="primary" icon="Plus" onClick={add} disabled={!form.fromPath || !form.toPath}>Add</Button></div>
      </div>
      {!data?.length ? (
        <Empty icon="ArrowRight" title="No redirects">Add one when you move or rename a page, so old links keep working.</Empty>
      ) : (
        <table className="table">
          <thead><tr><th>From</th><th>To</th><th>Type</th><th>Hits</th><th /></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.fromPath}</td>
                <td className="mono">{r.toPath}</td>
                <td><span className="badge no-dot">{r.code}</span></td>
                <td>{r.hits}</td>
                <td className="cell-actions">
                  <Button size="sm" variant="ghost" iconOnly icon="Trash2" aria-label="Delete" onClick={async () => {
                    if (await confirmDialog({ title: "Delete redirect?", confirmLabel: "Delete", danger: true })) api.del(`/redirects/${r.id}`).then(reload).catch(toast.error);
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
