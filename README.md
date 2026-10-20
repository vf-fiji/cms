# Reef CMS

A visual, developer-friendly content management system in the spirit of Sitefinity, with a cleaner editing experience and live code editing. Editors build pages by dragging widgets onto a real preview of the site. Developers change templates, CSS, JavaScript, React components and server-side logic from inside the CMS. Nothing needs a rebuild or deploy.

Reef is self-contained in this folder. It does not touch the FNRL application in the parent directory.

## Run it

Requires Node.js 22.5 or later (it uses the built-in `node:sqlite`). Tested on Node 26.

```sh
cd cms
npm install
npm run dev
```

- Website: http://127.0.0.1:4400/
- Admin: http://127.0.0.1:4400/admin

On first start Reef creates `data/reef.db`, a demo site, and an administrator account. The sign-in details are written to `data/admin-credentials.txt`. Change the password under **Account** and then delete that file. To choose the credentials yourself, set `REEF_ADMIN_EMAIL` and `REEF_ADMIN_PASSWORD` before the first start.

Production:

```sh
npm run build   # builds the admin app into dist/admin
npm start       # NODE_ENV=production, serves the built admin
```

Environment variables: `PORT` (default 4400), `HOST` (default 127.0.0.1), `REEF_DATA_DIR` (default `./data`).

## What's in it

| Area | Reef | Sitefinity equivalent |
|---|---|---|
| **Page editor** | Drag widgets and column layouts onto a live, server-rendered canvas. Click to select, double-click to type inline, plus undo/redo, copy/paste, keyboard shortcuts, desktop/tablet/phone preview and autosave. | Page editor + layout widgets |
| **Widgets** | 20 built in: heading, text, button, image, hero, card, feature grid, stats, quote, gallery (lightbox), video, map, accordion, tabs, content list, form, navigation, spacer, divider, code block, React block. | Built-in widgets |
| **Custom widgets** | Written in Code Studio as **Liquid templates** or **React components**. Fields defined as JSON become an editor-friendly inspector. | Custom widgets / MVC widgets |
| **React** | JSX compiled on the server by esbuild. Custom React widgets are server-rendered for SEO, then hydrated. React blocks can go on any page. Any npm package can be imported (resolved via esm.sh, sharing Reef's React). | .NET Core / Next.js renderer |
| **Content types** | Visual builder with 19 field types (text, rich text, image, gallery, reference, repeater, code…), optional detail pages at `/prefix/slug` with a Liquid template, and drag-to-reorder fields. | Module Builder |
| **Content** | Search, status filters, bulk publish/unpublish/delete, manual drag ordering, tags and categories, scheduling, revisions with restore. | Content modules |
| **Media** | Folders, drag-and-drop upload anywhere on screen, alt-text prompts, usage check before delete. Files are validated by signature. | Libraries |
| **Forms** | Visual builder, responses inbox (read/unread), CSV export, honeypot spam check, hooks. | Forms |
| **Templates** | Liquid HTML/CSS/JS/head, one default plus any number of alternates. | Page templates |
| **Code Studio** | IDE with tabs, syntax highlighting, Ctrl+S, site-wide CSS/JS/HTML files, widgets, and **server functions**: API endpoints (`/api/fn/<route>`), event hooks (before/after content save, publish, form submit, upload) and scheduled jobs, with a test runner and logs. | Custom code + deployment |
| **Workflow** | Draft → Publish, "Changes pending" on live pages, discard changes, Authors' publishes go to review, scheduled publishing, full revision history. | Workflow + revision history |
| **Users & roles** | 12 permissions, 4 built-in roles, custom roles, temporary-password onboarding. | Roles & permissions |
| **SEO** | Meta title/description, social image, canonical, noindex, search-result preview, sitemap.xml, robots.txt, redirects with hit counts. | SEO + redirects |
| **Headless** | `/api/public/content/:type`, `/api/public/pages`, `/api/public/site`. | Web services |
| **Tailwind CSS** | Tailwind v4 utilities work in Code blocks, Liquid and React widgets, templates and every block's class field. The server compiles only the classes each page uses, including ones in React/JS sources, and the editor canvas updates as you type. Brand colours are `bg-primary` / `text-accent`. Add `@theme` tokens and `@utility` classes in Settings → Tailwind CSS (checked before saving). Preflight is optional. | Custom CSS / themes |
| **3D site map** | The whole site as an interactive three.js web: pages by depth, content types and items, forms, and internal links. Hover to trace connections, click to fly to a node, double-click to edit. Has search, filters and an accessible outline view. | Site map / page tree |
| **Everything else** | ⌘K command palette, dashboard with page views, activity/audit log, dark mode, plain-language error messages. | — |

## For developers

**Liquid in templates and widgets**

```liquid
{% assign news = 'news' | content: 3 %}
{% for n in news %}<a href="{{ n.url }}">{{ n.title }}</a>{% endfor %}

{% assign data = 'headlines' | fn %}   {# calls a server function #}
```

**React custom widget** (Code Studio → Widgets → +, choose React). The widget's fields arrive as props.

```jsx
import { useState } from "react";
export default function Counter({ title }) {
  const [n, setN] = useState(0);
  return <button onClick={() => setN(n + 1)}>{title}: {n}</button>;
}
```

**Server function** (Code Studio → Server functions → +)

```js
export default async ({ request, cms }) => {
  const items = cms.content.list("news", { limit: 5 });
  return { count: items.length };
};
```

The `cms` object provides `content.list/get/create/update`, `forms.submissions`, `kv.get/set/delete/list`, `db.query/run`, `settings()` and `respond(body, { status, headers })`. `fetch` and `console` are also available. Output from `console` appears in the function's Logs tab.

## Tests

```sh
npm test          # 147 tests, about 3 seconds
npm run typecheck
```

Tests use Node's built-in runner and live in `tests/*.suite.ts`. The `.suite.ts` suffix keeps them out of the parent FNRL project's vitest run. Every suite gets a throwaway database in the OS temp folder, so your `data/` folder is never touched.

- `api.suite.ts` starts a real server on a free port and drives it over HTTP: sign-in, CSRF, page draft/publish/discard/restore and edit conflicts, content types and required-field validation, forms (validation, honeypot, spam hook, CSV export), upload checks, role permissions, redirects, sitemap, server functions and React SSR.
- `render.suite.ts`: every built-in widget, escaping, Liquid filters and public routing.
- `react.suite.ts`: JSX compilation, SSR, fallbacks and timeouts.
- `functions.suite.ts`: the functions runtime, the `cms` API, hooks and schedules.
- `tailwind.suite.ts`: class extraction, per-page compilation, brand colours, custom theme CSS, Preflight, cascade layers.
- `layout.suite.ts`: the page editor's layout-tree operations.
- `sitegraph.suite.ts`: the site map graph (hierarchy, content, forms, link detection, de-duplication).

## Architecture

- `server/`: Express 5 API, SQLite (`node:sqlite`), Liquid rendering (`render/`), React SSR (`react.ts`) and the functions runtime (`functions.ts`).
- `static/`: the public site's base CSS/JS and the editor canvas script.
- `shared/`: types and the widget catalogue used by both server and admin.
- `admin/`: the React admin app (Vite), served at `/admin`.

The editor canvas is the real server-rendered page in an iframe, with an overlay script for selection and drag-and-drop. What editors see is what visitors get, including custom CSS, templates and React widgets.

## Styling order

Every page declares cascade layers up front: `theme, base, reef, components, utilities`. Reef's widget styles (`/_reef/site.css`) live in the `reef` layer, so Tailwind utilities override them, while template, code-asset, widget and page CSS stay unlayered and override both. Tailwind's Preflight reset (`base`) is off by default because it would restyle Reef's typography.

## Security notes

- Passwords use scrypt. Sessions use HTTP-only SameSite cookies, writes require a CSRF token, and sign-in is throttled.
- Server functions and React SSR run in a separate V8 context with CPU timeouts. Synchronous work is cut off after 1 second. Work after an `await` only has a 10-second wall-clock limit, which can't interrupt a busy loop. **This is not a security sandbox.** Only give the `code.edit` permission to people you'd trust with server access. React *blocks* placed by page editors render in the browser only. Server-side rendering is limited to developer-authored widgets.
- Page editors can add client-side HTML/JS through the Code block, as in most CMSs. Remove `pages.edit` from roles that shouldn't.

## Not built yet

These are honest gaps against Sitefinity: multilingual content, personalization/A-B testing, multi-site, image resizing/cropping and responsive `srcset`, a full-text search index, outbound email (use a `form.submitted` hook with your mail provider), and SSO. Drag-and-drop in the page editor was verified with synthetic drag events, not a physical mouse.
