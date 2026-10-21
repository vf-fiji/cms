# VodaForge

**Where digital experiences are built.**

A visual, developer-friendly content management system in the spirit of Sitefinity, with a cleaner editing experience and live code editing. Editors build pages by dragging widgets onto a real preview of the site. Developers change templates, CSS, JavaScript, React components and server-side logic from inside the CMS. Nothing needs a rebuild or deploy.

Formerly called Reef CMS. Internal names still use `reef` (the `REEF_*` environment variables, `reef.db`, `/_reef/` asset paths, `rf-` CSS classes and `reef-backup-*` folders), so existing deployments, data and custom code keep working.

VodaForge is self-contained in this folder. It does not touch the FNRL application in the parent directory.

## Run it

Requires Node.js 22.5 or later (it uses the built-in `node:sqlite`). Tested on Node 26.

```sh
cd cms
npm install
npm run dev
```

- Website: http://127.0.0.1:4400/
- Admin: http://127.0.0.1:4400/admin

On first start VodaForge creates `data/reef.db`, a demo site, and an administrator account. The sign-in details are written to `data/admin-credentials.txt`. Change the password under **Account** and then delete that file. To choose the credentials yourself, set `REEF_ADMIN_EMAIL` and `REEF_ADMIN_PASSWORD` before the first start.

Production:

```sh
npm run build   # builds the admin app into dist/admin
npm start       # NODE_ENV=production, serves the built admin
```

Forgot your password? Use **Forgot password?** on the sign-in screen. In development, without SMTP set up, the reset link is printed in the terminal running `npm run dev`. See [Password recovery](#password-recovery).

## Deploying

VodaForge is one Node process with a SQLite database and an uploads folder, both in `REEF_DATA_DIR`. Run a single instance (sessions, sign-in throttles and rate limits are per process) behind a reverse proxy that handles TLS.

### Docker

```sh
cd cms
cp .env.example .env      # set REEF_PUBLIC_URL, SMTP_* and optionally REEF_ADMIN_*
docker compose up -d --build
docker compose ps         # STATUS should become "healthy"
```

- The image builds the admin app (`npm run build`) and runs the production server, which is what `npm start` runs. It starts Node directly rather than through npm so that `docker stop` reaches VodaForge, which then closes the database cleanly.
- `compose.yaml` keeps data in two named volumes: `reef-data` mounted at `/data` (database and uploads) and `reef-backups` at `/backups`. It publishes the app only on `127.0.0.1:4400` (change with `REEF_HOST_PORT`), so it's reachable from your reverse proxy on the same host and not from the internet.
- The healthcheck calls `GET /api/health`, which also queries the database.
- First sign-in: set `REEF_ADMIN_EMAIL`/`REEF_ADMIN_PASSWORD` in `.env` before the first start, or read the generated details with `docker compose exec reef cat /data/admin-credentials.txt`. Then change the password and delete the file (`docker compose exec reef rm /data/admin-credentials.txt`).
- Update: `docker compose up -d --build`. The volumes are kept, and database migrations run on start. Take a backup first.

Without Docker, use Node 22.5 or later (Node 26 is tested), `npm ci && npm run build`, then run `npm start` under a process manager such as systemd with `HOST=127.0.0.1`.

### Behind a TLS reverse proxy

In production, session cookies are `Secure`, so the admin only works over HTTPS. Browsers make one exception for `http://localhost`. Point your proxy at VodaForge and forward the usual headers.

Caddy (gets certificates automatically and sends `X-Forwarded-*` by default):

```caddyfile
cms.example.com {
    reverse_proxy 127.0.0.1:4400
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name cms.example.com;
    ssl_certificate     /etc/letsencrypt/live/cms.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/cms.example.com/privkey.pem;
    client_max_body_size 60m;   # media uploads allow 50 MB per file

    location / {
        proxy_pass http://127.0.0.1:4400;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
server {
    listen 80;
    server_name cms.example.com;
    return 301 https://$host$request_uri;
}
```

**`REEF_TRUST_PROXY`** decides which proxies VodaForge believes about the visitor's real IP address and protocol. It matters because sign-in throttling and rate limits count requests per IP. If the proxy isn't trusted, every visitor shares the proxy's address and one busy visitor can lock everyone out. If too much is trusted, visitors can fake their address with an `X-Forwarded-For` header and get around the limits.

| Setup | Value |
|---|---|
| Proxy on the same machine, VodaForge run with `npm start` | leave unset (default `loopback`) |
| Proxy on the host, VodaForge in Docker via `compose.yaml` | leave unset (compose sets `loopback, uniquelocal`) |
| Proxy on another machine | its address or subnet, e.g. `10.0.0.5` or `10.0.0.0/24` |
| A CDN in front of your proxy | the number of hops, e.g. `2`, or the CDN's address ranges |
| No proxy at all | `false` |

The value is passed to Express's [`trust proxy`](https://expressjs.com/en/guide/behind-proxies.html) setting, so `true`, a hop count, comma-separated addresses/subnets and the presets `loopback`, `linklocal` and `uniquelocal` all work.

### Environment variables

| Variable | Default | |
|---|---|---|
| `PORT` / `HOST` | `4400` / `127.0.0.1` | Listen address. The Docker image uses `0.0.0.0`. |
| `REEF_DATA_DIR` | `./data` | Database (`reef.db`) and `uploads/`. `/data` in Docker. |
| `REEF_PUBLIC_URL` | (none) | Public `https://` address, used in password reset links and the inbox link in form notification emails. **Required in production for resets.** Links are never built from the request's `Host` header, which anyone can forge. |
| `REEF_TRUST_PROXY` | `loopback` | See above. |
| `REEF_ADMIN_EMAIL` / `REEF_ADMIN_PASSWORD` | random | First administrator, used only when the database is created. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | (none), `587`, `true` on port 465 | Outgoing email (password resets, form notifications). See [Password recovery](#password-recovery). |
| `REEF_RESET_TTL_MINUTES` | `60` | How long a reset link works. |
| `REEF_RATE_LIMIT_FORMS` / `REEF_RATE_LIMIT_FN` / `REEF_RATE_LIMIT_RESET` / `REEF_RATE_LIMIT_SEARCH` | `10` / `120` / `5` / `60` | See [Rate limits](#rate-limits). `0` turns a limit off. |
| `REEF_BACKUP_DIR` / `REEF_BACKUP_KEEP` | `./backups` / keep all | See [Backups and restore](#backups-and-restore). `/backups` in Docker. |
| `REEF_BACKUP_AT` | (none) | Daily backup time(s) run by VodaForge itself, e.g. `03:15` or `03:15,15:15` (server time). |
| `REEF_BACKUP_AFTER` | (none) | Command run after each backup to copy it off-site. The new folder is in `$REEF_BACKUP_PATH`. |
| `REEF_ALERT_WEBHOOK` | (none) | Slack, Teams, Discord or custom webhook for errors, crashes and failed backups. See [Monitoring](#monitoring-and-alerts). |
| `REEF_LOG_KEEP_DAYS` | `14` | How long `data/logs/errors-*.jsonl` files are kept. |
| `REEF_PAGE_CACHE_SECONDS` | `300` | Longest a cached public page is reused. Edits show immediately regardless; this only bounds time-based output. `0` turns the cache off. See [Performance](#performance). |
| `REEF_FN_WORKERS` / `REEF_FN_MEMORY_MB` / `REEF_FN_TIMEOUT_MS` | `4` / `256` / `10000` | Server function worker pool size, memory cap per worker, and time limit per call. |

`.env.example` lists them all.

## Backups and restore

```sh
npm run backup                                  # → backups/reef-backup-<timestamp>/
npm run backup -- --out /mnt/nas/reef --keep 14 # keep only the newest 14 there
npm run restore -- backups/reef-backup-<timestamp>   # VodaForge must be stopped; see below
docker compose exec reef npm run backup         # in Docker → the reef-backups volume
```

Each backup folder holds:

- `reef.db`: a consistent snapshot made with SQLite's `VACUUM INTO`. It's safe to run while VodaForge is serving and editing, and it's checked with `PRAGMA integrity_check` before it counts as done.
- `uploads/`: a copy of every uploaded file, made after the snapshot so every file the snapshot refers to is included.
- `manifest.json`: time, sizes and the integrity result.

A half-finished backup is named `*.partial` and removed if it fails, so any `reef-backup-*` folder with a `manifest.json` is complete. Backups contain password hashes and form responses, so store them as carefully as the server.

**Schedule it and copy it off the machine.** VodaForge can do both itself:

```sh
REEF_BACKUP_AT=03:15
REEF_BACKUP_KEEP=14
# any command; the new backup folder is in $REEF_BACKUP_PATH (and its name in $REEF_BACKUP_NAME)
REEF_BACKUP_AFTER='rclone copy "$REEF_BACKUP_PATH" offsite:reef/"$REEF_BACKUP_NAME"'
# or: aws s3 sync "$REEF_BACKUP_PATH" "s3://my-bucket/reef/$REEF_BACKUP_NAME"
```

In Docker the command runs inside the container, so add the tool it needs (e.g. `rclone`) in an image built `FROM vodaforge`, or write the backups volume to a mounted network share instead. Scheduled backups run in a separate process, so they never slow the site down. If the backup or the off-site command fails, it's logged, sent to `REEF_ALERT_WEBHOOK`, and shown on **Settings → System health**, which also has a **Back up now** button. `npm run backup` exits with code 1 if the backup fails and 3 if only the off-site copy fails. If you prefer host cron, that still works:

```cron
15 3 * * *  cd /srv/reef/cms && docker compose exec -T reef npm run backup --silent -- --keep 14
```

### Restore

Restoring replaces the whole site, including users and passwords, with the backup's contents. `npm run restore` refuses to run while VodaForge has the database open, and it never deletes anything: the current database and uploads are moved to `data/pre-restore-<time>/` first.

**Without Docker**

```sh
# 1. stop VodaForge (systemctl stop reef, or Ctrl+C on npm start)
npm run restore -- backups/reef-backup-2026-10-21T03-15-00-000Z
# 2. start VodaForge again (npm start)
```

**With Docker Compose**

```sh
docker compose exec reef ls /backups                  # pick a backup
docker compose stop reef
docker compose run --rm --no-deps reef npm run restore -- /backups/reef-backup-2026-10-21T03-15-00-000Z
docker compose start reef
```

To restore a copy kept outside the server, copy it into the volume first: `docker compose cp ./reef-backup-<timestamp> reef:/backups/`.

After the restore:

- Sign in and check the site. Sessions and passwords are as they were at backup time. Anyone who signed in or changed their password since then must sign in again with their old password, or use **Forgot password?**.
- When you're satisfied, delete the `pre-restore-*` folder inside the data folder. In Docker: `docker compose exec reef ls /data`, then remove it the same way. To undo the restore instead, stop VodaForge and restore from that folder's files.

You can also restore by hand. With VodaForge stopped, copy the backup's `reef.db` and `uploads/` into an empty data folder. Don't leave old `reef.db-wal` or `reef.db-shm` files next to the restored database, because they belong to the old one.

The test suite backs up a running server with `npm run backup`, checks that `npm run restore` refuses while a server is using the target folder, restores into it, and checks that pages, the reset password and media come back.

## Performance

Public pages are cached in memory after their first render. SQLite triggers bump a version number on every write to anything a page is built from (pages, content, templates, widgets, media, forms, settings…), so a publish or edit shows on the next request, including changes made by server functions or another process. Saving a draft doesn't clear the cache. Pages that call a server function (the Liquid `fn` filter) are never cached. The `X-VodaForge-Cache: hit|miss` response header shows what happened.

Page views are counted in memory and written every 5 seconds, so a busy page doesn't cost a database write per visit.

Measured with `autocannon -c 50` against the seeded demo site, production mode, one Node process on a laptop:

| | Before | After |
|---|---|---|
| Home page | 134 req/s, p50 374 ms | 7,300 req/s, p50 6 ms |
| News list / article | ~210 req/s, p50 ~245 ms | ~10,000 req/s, p50 4 ms |
| `/api/public/search` | 977 req/s | 2,365 req/s |

Put the reverse proxy's compression (gzip/brotli) in front, and let it cache `/_reef/*` and `/media/*`, which are static.

## Monitoring and alerts

- **Health check:** `GET /api/health` returns `200 {"ok":true}` once the database answers. Docker uses it, and it's the URL to give an external uptime monitor (UptimeRobot, Better Stack, Pingdom…).
- **Error log:** server errors, failed emails, failed backups and crashes are written to `data/logs/errors-YYYY-MM-DD.jsonl` (one JSON object per line, kept `REEF_LOG_KEEP_DAYS` days) and listed on **Settings → System health**.
- **Alerts:** set `REEF_ALERT_WEBHOOK` and each new kind of error is POSTed as JSON with `text` (Slack, Teams workflows) and `content` (Discord) fields. The same error alerts at most once every 15 minutes, and no more than 20 alerts go out per hour. **Settings → System health → Send a test alert** checks the setup.
- **Crashes:** an uncaught exception is logged and alerted, then VodaForge exits so Docker's `restart: unless-stopped` (or your process manager) starts a clean process.

## Password recovery

**Forgot password?** on the sign-in screen asks for an email address and always gives the same answer, so it can't be used to find out who has an account. If an active account matches, VodaForge emails a link to `/admin/reset-password`.

- The token is 256 bits of randomness. Only its SHA-256 hash is stored (table `password_resets`).
- A link works **once** and **expires** after `REEF_RESET_TTL_MINUTES` (60). Asking again cancels earlier links. A link also stops working if the password is changed any other way, for example by an administrator under Users.
- The token travels in the URL fragment (`#token=…`), so it never appears in server or proxy logs or in `Referer` headers. The page removes it from the address bar straight away.
- Resetting signs the account out on every device. New passwords need at least 10 characters.
- Requests are rate-limited per IP (`REEF_RATE_LIMIT_RESET`, 5 per 15 minutes) and per email address (3 per hour).

**Email setup.** Set `SMTP_HOST` and usually `SMTP_USER`, `SMTP_PASS` and `SMTP_FROM`. Port 587 upgrades to TLS with STARTTLS. For port 465 (implicit TLS), set `SMTP_PORT=465`. The start-up log shows which transport is active (`Email: SMTP smtp.example.com:587`). Any provider with SMTP works, including Microsoft 365, Google Workspace, SendGrid, Mailgun, Postmark and SES.

- **Development without SMTP:** emails, links included, are printed to the console.
- **Production without SMTP:** nothing is sent and links are never logged. The server logs a warning instead. Administrators can still reset someone's password under **Users**.

**Form notifications.** Under **Forms → (form) → Settings → Notification email**, enter one address or several separated by commas. Each accepted response is then emailed there as plain text: the form name, the page it was sent from, every field's label and value, and a link to the responses inbox (`REEF_PUBLIC_URL/admin/forms/<id>?tab=responses`). Forms that don't store responses still send the email, which is then the only copy. Addresses are checked when the form is saved (plain addresses only, at most 10), and nothing a visitor types goes into an email header. Sending happens after the visitor gets their answer, so a slow or broken mail server never fails or delays a submission; failures are logged with `[forms]`. Honeypot hits and rate-limited requests send nothing. The `form.submitted` hook still runs and still receives `notifyEmail`.

The sender is pluggable. `server/mail.ts` defines a `MailTransport` interface (`send({ to, subject, text, html })`). Call `setMailTransport()` at start-up to use an HTTP email API instead of SMTP.

## Rate limits

Per client IP, in memory, in fixed one-minute windows. A blocked request gets `429 Too Many Requests` with a `Retry-After` header.

| What | Default | Variable |
|---|---|---|
| Public form submissions (`POST /api/public/forms/:key/submit`) | 10 per minute | `REEF_RATE_LIMIT_FORMS` |
| Server function endpoints (`/api/fn/*`) | 120 per minute | `REEF_RATE_LIMIT_FN` |
| "Forgot password" requests | 5 per 15 minutes, plus 3 per hour per email | `REEF_RATE_LIMIT_RESET` |
| Site search (`GET /api/public/search`) | 60 per minute | `REEF_RATE_LIMIT_SEARCH` |
| Sign-in | 5 failed attempts per IP and email within a minute, then a wait | (built in) |

Form posts made without JavaScript get a short HTML page instead of JSON. Many mobile users can share one public IP address (carrier-grade NAT). If real visitors get blocked, raise the limits rather than turning them off. Put the limits on the proxy as well if you need more, for example nginx's `limit_req`.

## What's in it

| Area | VodaForge | Sitefinity equivalent |
|---|---|---|
| **Page editor** | Drag widgets and column layouts onto a live, server-rendered canvas. Click to select, double-click to type inline, plus undo/redo, copy/paste, keyboard shortcuts, desktop/tablet/phone preview and autosave. On a phone the canvas fills the screen and the panels open as bottom sheets. | Page editor + layout widgets |
| **Widgets** | 22 built in: heading, text, button, image, hero, card, feature grid, stats, quote, gallery (lightbox), video, map, accordion, tabs, content list, form, navigation, search, spacer, divider, code block, React block. | Built-in widgets |
| **Custom widgets** | Written in Code Studio as **Liquid templates** or **React components**. Fields defined as JSON become an editor-friendly inspector. | Custom widgets / MVC widgets |
| **React** | JSX compiled on the server by esbuild. Custom React widgets are server-rendered for SEO, then hydrated. React blocks can go on any page. Any npm package can be imported (resolved via esm.sh, sharing VodaForge's React). | .NET Core / Next.js renderer |
| **Content types** | Visual builder with 19 field types (text, rich text, image, gallery, reference, repeater, code…), optional detail pages at `/prefix/slug` with a Liquid template, and drag-to-reorder fields. | Module Builder |
| **Content** | Search, status filters, bulk publish/unpublish/delete, manual drag ordering, tags and categories, scheduling, revisions with restore. | Content modules |
| **Media** | Folders, drag-and-drop upload anywhere on screen, alt-text prompts, usage check before delete. Files are validated by signature. Images get WebP copies at 480–2400px, served with `srcset`/`sizes`, and a focal point you click to set keeps the subject in frame when images are cropped. | Libraries + image thumbnails |
| **Forms** | Visual builder, responses inbox (read/unread), CSV export, honeypot spam check, email notifications, hooks. | Forms |
| **Templates** | Liquid HTML/CSS/JS/head, one default plus any number of alternates. | Page templates |
| **Code Studio** | IDE with tabs, syntax highlighting, Ctrl+S, site-wide CSS/JS/HTML files, widgets, and **server functions**: API endpoints (`/api/fn/<route>`), event hooks (before/after content save, publish, form submit, upload) and scheduled jobs, with a test runner and logs. | Custom code + deployment |
| **Workflow** | Draft → Publish, "Changes pending" on live pages, discard changes, Authors' publishes go to review, scheduled publishing, full revision history. | Workflow + revision history |
| **Users & roles** | 13 permissions, 4 built-in roles, custom roles, temporary-password onboarding, two-factor sign-in with an authenticator app and recovery codes (optionally required for everyone), password reset by email. | Roles & permissions |
| **Site search** | Full-text search (SQLite FTS5) over published pages and content with ranked, highlighted results: a Search widget for pages and `/api/public/search` for headless sites. | Site search |
| **Operations** | Docker image, health check, consistent online backups with a schedule and off-site copy, restore, error log, webhook alerts, page cache, Settings → System health. | Hosting / system status |
| **SEO** | Meta title/description, social image, canonical, noindex, search-result preview, sitemap.xml, robots.txt, redirects with hit counts. | SEO + redirects |
| **Headless** | `/api/public/content/:type`, `/api/public/pages`, `/api/public/site`, `/api/public/search?q=`. | Web services |
| **Tailwind CSS** | Tailwind v4 utilities work in Code blocks, Liquid and React widgets, templates and every block's class field. The server compiles only the classes each page uses, including ones in React/JS sources, and the editor canvas updates as you type. Brand colours are `bg-primary` / `text-accent`. Add `@theme` tokens and `@utility` classes in Settings → Tailwind CSS (checked before saving). Preflight is optional. | Custom CSS / themes |
| **3D site map** | The whole site as an interactive three.js web: pages by depth, content types and items, forms, and internal links. Hover to trace connections, click to fly to a node, double-click to edit. Has search, filters and an accessible outline view. | Site map / page tree |
| **Everything else** | ⌘K command palette, dashboard with page views, activity/audit log, dark mode, plain-language error messages. | — |

## For developers

**Liquid in templates and widgets**

```liquid
{% assign news = 'news' | content: 3 %}
{% for n in news %}<a href="{{ n.url }}">{{ n.title }}</a>{% endfor %}

{% assign data = 'headlines' | fn %}   {# calls a public server function #}
```

`{{ }}` output is HTML-escaped, so a title like `<b>Hi</b>` shows as text. Page `{{ content }}` and rich text fields (already cleaned of scripts) print as HTML. To print other HTML you trust, add `| raw`, e.g. `<script>const data = {{ data | json | raw }};</script>` (`json` always writes `<` as `\u003c`, so it can't close the script tag). The `fn` filter only calls **public** endpoints, so signed-in-only data can't end up on a public page.

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
npm test          # about 245 tests, under 30 seconds
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
- `images.suite.ts`: responsive image variants, `srcset`/`sizes`, focal points and clean-up.
- `twofa.suite.ts`: TOTP (RFC 6238 vectors), recovery codes, the two-step sign-in, replay and lockout, required 2FA and admin resets.
- `search.suite.ts`: indexing published pages and items, ranking, highlighting, escaping, the widget and the rate limit.
- `cache.suite.ts`: the page cache (hits, invalidation from the API and from another database connection, drafts, uncacheable renders).
- `security.suite.ts`: rich text cleaning, the "Add code to pages" permission, publish-rights rules, escaping, form redirects, role escalation, limits, private endpoints, session revocation and per-account lockout.
- `logging.suite.ts`: the error log, webhook alerts and throttling, scheduled backups and the off-site copy hook, System health.
- `ops.suite.ts`: deployment features. Reset tokens (hashed storage, single use, expiry, invalidation), the full forgot/reset flow over HTTP against a fake SMTP server, form notification emails (address checks, header injection, forms that don't store responses, a slow and failing mail server), `npm run backup` on a running server followed by a restore, rate limits on forms, `/api/fn` and reset requests, and per-visitor counting behind a trusted proxy.

## Architecture

- `server/`: Express 5 API, SQLite (`node:sqlite`), Liquid rendering (`render/`), React SSR (`react.ts`) and the functions runtime (`functions.ts`).
- `static/`: the public site's base CSS/JS and the editor canvas script.
- `shared/`: types and the widget catalogue used by both server and admin.
- `admin/`: the React admin app (Vite), served at `/admin`.
- `brand/`: the logo source and `make-logo.mjs`, which builds the square mark, favicons and app icon from it (`node brand/make-logo.mjs`).

The editor canvas is the real server-rendered page in an iframe, with an overlay script for selection and drag-and-drop. What editors see is what visitors get, including custom CSS, templates and React widgets.

## Styling order

Every page declares cascade layers up front: `theme, base, reef, components, utilities`. VodaForge's widget styles (`/_reef/site.css`) live in the `reef` layer, so Tailwind utilities override them, while template, code-asset, widget and page CSS stay unlayered and override both. Tailwind's Preflight reset (`base`) is off by default because it would restyle VodaForge's typography.

## Security notes

- Passwords use scrypt. Sessions use HTTP-only SameSite cookies (`Secure` in production) and writes require a CSRF token. Sign-in is throttled per client (5 tries a minute; IPv6 counted per /64) **and per account** (10 wrong passwords or codes in 15 minutes pauses that account, and alerts). Changing your password or turning on 2FA signs out your other sessions.
- Two-factor sign-in (TOTP) can be required for everyone. Codes can't be reused, and recovery codes are single-use and stored hashed.
- **Who can add code:** scripts on pages (Code and React blocks, page JavaScript, `<head>` tags) need the **Add code to pages** permission. Administrators, Developers and Editors have it; Authors don't. Without it, people can still edit text, move existing code blocks and edit everything else. Rich text is cleaned of scripts, event handlers and `javascript:` links for everyone.
- **Publishing:** without publish rights, people can't schedule a page or item to publish, change the address of a live page, delete live pages or items, or edit live content items (items have no separate draft copy yet; unpublish first or ask an editor).
- **Users and roles:** someone with "Manage users and roles" can't create a role, or give someone a role, with permissions they don't have themselves, and can't reset the password or 2FA of someone with more access.
- Liquid escapes output by default (see [For developers](#for-developers)). Form "redirect after submit" must be a path on the site or an http(s) address.
- Public pages have one address each: `/About/` redirects to `/about`, so views, the page cache and search engines agree.
- Headers: `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `X-Frame-Options: SAMEORIGIN` plus `frame-ancestors 'self'`, and HSTS in production over HTTPS. Uploaded SVGs are served with a script-blocking CSP. `/sitemap.xml` and `robots.txt` use `REEF_PUBLIC_URL`, not the Host header.
- **Same origin:** the admin, the editor canvas, draft previews and the public site share one origin, so code that runs on a page (added by someone with "Add code to pages", or a developer) runs with the session of an admin who views it. That's why code access is a separate permission. For stronger isolation, serve the public site and the admin from different hostnames.
- Password reset links are single-use, expire, are stored only as hashes, and are built from `REEF_PUBLIC_URL`, never the request's Host header. See [Password recovery](#password-recovery).
- Public form submissions, `/api/fn/*`, search and reset requests are rate-limited per IP. See [Rate limits](#rate-limits), and set `REEF_TRUST_PROXY` correctly behind a proxy. Signed-in-only `/api/fn/*` endpoints need the CSRF token for writes and respect "require 2FA".
- Server functions run in a pool of worker threads with a memory cap (`REEF_FN_MEMORY_MB`) and a time limit (`REEF_FN_TIMEOUT_MS`); a function that runs too long or uses too much memory is stopped and its worker replaced, so it can't stall the site. **This is not a security sandbox:** functions can read and write the database. Only give `code.edit` to people you'd trust with server access. React *blocks* placed by page editors render in the browser only; server-side rendering is limited to developer-authored widgets.
- `npm audit` reports no known vulnerabilities in dependencies (checked October 2026).

## Not built yet

These are honest gaps against Sitefinity: multilingual content, personalization/A-B testing, multi-site, SSO (SAML/OIDC), and importing content from another CMS. Form notification emails are plain text with no per-form template or HTML version; use a `form.submitted` hook if you need more. Image cropping is by focal point only (no free-form crop tool).

Drag-and-drop in the page editor has been checked by hand with a real mouse. The admin and public site pass an axe-core scan (WCAG 2.1 AA rules) in light and dark themes, but no one has tested them with a screen reader yet.
