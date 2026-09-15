# ariyankhan.com — Project Guide

Static HTML/CSS/JS + PHP site. No build framework. Namecheap shared hosting.

---

## Deploy

> **Moving to the Hostinger KVM VPS (in progress):** see "VPS deployment
> (Docker)" below. The Namecheap options here are the legacy path.

### Option 1 — Git Push (preferred)

```bash
git add .
git commit -m "description"
git push live master        # auto-deploys to public_html via git hook
```

`live` remote = `ariymndk@server350.web-hosting.com:~/repos/portfolio.git`  
SSH key: `~/.ssh/namecheap_ariyankhan` (port 21098)  
Hook auto-copies files to `/home/ariymndk/public_html/` on push.

### Option 2 — FTP Script (fallback — no SSH key needed)

Credentials are stored in `.env` (gitignored — never commit).

```powershell
# Windows (PowerShell)
.\deploy.ps1                            # deploy all site files
.\deploy.ps1 index.html                 # deploy one file
.\deploy.ps1 index.html about.html      # deploy multiple files
.\deploy.ps1 -DryRun                    # preview without uploading
```

```bash
# Mac / Linux / Git Bash
bash deploy.sh                          # deploy all site files
bash deploy.sh index.html              # deploy one file
bash deploy.sh --dry-run               # preview without uploading
```

**Never commit:** `.env`, `mail-config.local.php`, `admin-config.local.php` (credentials), `data/` (tracker database) — all in `.gitignore`

---

## VPS deployment (Docker)

The site runs as one self-contained Docker Compose project on the shared
Hostinger KVM VPS, next to the other sites already there. It binds **no public
port**: `ariyankhan-web` listens on `127.0.0.1:${WEB_PORT:-8081}` and the VPS's
existing reverse proxy routes `ariyankhan.com` to it (Traefik labels are on the
container for proxies that read them). All state is in this project's own named
volumes (`site`, `site_data`), so moving the site to its own VPS later is: run
the same compose there, copy the `site_data` volume, flip DNS.

| File | Purpose |
|------|---------|
| `deploy/docker-compose.yml` | Shared-VPS project: `fetch` (clones this repo into the `site` volume) + `web` (php:8.4-apache) |
| `deploy/docker-compose.standalone.yml` | Same, plus Caddy on :80/:443 with automatic TLS — only for a VPS where nothing else uses those ports |
| `deploy/nginx-ariyankhan.conf` | Host nginx server block that proxies the domain to the container (the VPS's other sites are plain nginx vhosts too) |
| `deploy/web-entrypoint.sh` | Enables Apache modules, `AllowOverride All`, and writes `mail-config.local.php` / `admin-config.local.php` from env vars |

**Live project:** VPS `srv1918310` (ID 1918310, IP 187.52.122.99), Docker
project `ariyankhan`, container `ariyankhan-web` on `127.0.0.1:8747`.

**Deploy / redeploy:** push to `main`, then re-run the project in hPanel → VPS →
Docker Manager (or the Hostinger API `VPS_createNewProject` with
`deploy/docker-compose.yml`). `fetch` re-clones `main`; `data/` (SQLite: tracker,
inbox, reviews) is untouched because it lives on `site_data`.

**Secrets** are never in git: set them as the project's environment in Docker
Manager. `deploy/web-entrypoint.sh` turns them into the two gitignored PHP files
on every start:

| Env var | Ends up in |
|---------|-----------|
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `TO_EMAIL`, `SITE_URL` | `mail-config.local.php` (contact form, tracker + inbox mail) |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASS` | `mail-config.local.php` (inbox) |
| `MCP_TOKEN` | `mail-config.local.php` → `mcp.php` auth |
| `ADMIN_PASSWORD` | `admin-config.local.php` → `/admin/` login |
| `WEB_PORT` (default 8081), `SITE_BRANCH` (default `main`) | compose itself |

**Migrating the old database from Namecheap:** download `data/tracker.sqlite`
(and `data/inbox.sqlite` if present) from cPanel File Manager, upload to the
VPS, then `docker cp tracker.sqlite ariyankhan-web:/var/www/html/data/` and
`docker exec ariyankhan-web chown www-data:www-data /var/www/html/data/tracker.sqlite`.

**Proxy note:** `.htaccess` forces HTTPS via `%{HTTPS}` *or*
`X-Forwarded-Proto`, so any proxy that sets that header (all of them do) works
without a redirect loop. `RedirectMatch 404 ^/(deploy|tests)` keeps the tooling
directories unreachable over the web.

---

## File Map

| File | Purpose |
|------|---------|
| `css/style.css` | Global styles, variables, homepage layout |
| `css/service.css` | Shared service page layout/styles |
| `js/service-profile.js` | Shared service profile component + shared profile data |
| `js/portfolio-data.js` | PORTFOLIO array — all video cards |
| `js/main.js` | Menu, FAQ, stars, contact form, `buildPortfolioGrid()` |
| `js/site-nav.js` | `<site-nav>` web component |
| `js/site-footer.js` | `<site-footer>` web component |
| `sitemap.xml` | All pages. Update when adding new pages |
| `send-mail.php` | Contact form handler (PHPMailer + SMTP) |
| `mail-config.local.php` | SMTP credentials — NOT in git, lives on server only |
| `track.html` | Public Project Tracker page (nav: "Track Order") |
| `track-lookup.php` | Public code → project status lookup endpoint |
| `lib/tracker-db.php` | SQLite helper shared by tracker + admin |
| `lib/tracker-mail.php` | Sends the order-confirmation email to clients on project creation |
| `admin/index.php`, `admin/login.php`, `admin/logout.php` | Password-gated dashboard to create projects and update stages |
| `admin-config.local.php` | Admin password — NOT in git, lives on server only |
| `data/tracker.sqlite` | Project tracker database — NOT in git, auto-created on server |
| `css/tracker.css`, `js/tracker.js` | Tracker page + admin styling/behavior |
| `review.html` | Public self-service review submission form (nav-hidden, `noindex`) |
| `js/review.js` | Submission form handler for `review.html` (separate from `js/review-card.js`) |
| `reviews.php` | GET published reviews / POST a new one — validates against `lib/tracker-db.php` |
| `js/review-card.js` | Auto-rotating testimonial card behavior — see "Review Card" section below |
| `js/reviews-data.js` | Curated review text (`window.CURATED_REVIEWS`), single source of truth |
| `css/review-card.css` | Review card + testimonial section design, shared across pages |
| `ai-metadata-remover.html` | Free SEO tool page: strips C2PA/XMP/IPTC/EXIF/PNG-text metadata from images in the browser — see "AI Metadata Remover" section below |
| `js/ai-metadata-remover.js` | The byte-level JPEG/PNG/WebP metadata stripper + page UI (no server, no upload) |
| `css/ai-metadata-remover.css` | Tool page layout, drop zone, result cards, content sections |

---

## Script Load Order (all service pages)

```html
<script src="js/service-profile.js?v=3"></script>
<script src="js/portfolio-data.js?v=2"></script>
<script src="js/site-nav.js?v=2"></script>
<script src="js/site-footer.js?v=2"></script>
<script src="js/main.js?v=12"></script>
<script>buildPortfolioGrid('service-key');</script>
```

---

## Service Pages

**4 main pages:** `talking-head-video-editing.html`, `documentary-video-editing.html`, `short-form-video-editing.html`, `map-animation.html`

**8 SEO landing pages:**

| File | Keyword | Portfolio feed |
|------|---------|----------------|
| `youtube-video-editor.html` | youtube video editor | talking-head |
| `hire-youtube-video-editor.html` | hire youtube video editor | talking-head |
| `freelance-video-editor.html` | freelance video editor | talking-head |
| `youtube-video-editing-services.html` | youtube video editing services | talking-head |
| `faceless-youtube-video-editor.html` | faceless youtube video editor | documentary |
| `podcast-video-editor.html` | podcast video editor | talking-head |
| `remote-video-editor.html` | remote video editor | talking-head |
| `video-editing-services-for-creators.html` | video editing for creators | short-form |

SEO pages are found via Google search only — not in site navigation.

---

## Entity Schema Rule

Use one canonical person entity across the whole site:

```json
"@id": "https://ariyankhan.com/about.html#person"
```

- `about.html` is the main profile/entity page
- Any page that describes Ariyan Khan as `Person`, `provider`, `author`, or `mainEntity` should reuse that exact `@id`
- Do not invent new person IDs on new service pages or future SEO pages
- When creating a new service page, point the schema `provider.url` to `https://ariyankhan.com/about.html`
- If a future page needs a full person object, keep the same `@id` and only add extra fields if they are true and public

---

## Page Structure (every service page)

```
<site-nav data-page="subpage">
.service-page
.service-breadcrumb
.service-introduction
  LEFT: about-this-service
  RIGHT: <service-profile ...>
.featured-work  →  buildPortfolioGrid('key')
.service-faq    →  FAQ accordion
.explore-services → exactly 4 explore pills, NO self-link
<site-footer>
```

---

## Explore Pills Rule

Every page: exactly **4 pills**, no self-link.  
Main service pages: 3 other main services + 1 SEO page  
SEO pages: 2 main services + 2 other SEO pages (unique mix per page)

---

## How to Add Portfolio Videos

Edit `js/portfolio-data.js`, add to PORTFOLIO array:

```js
{
  id:       'YOUTUBE_VIDEO_ID',
  service:  'talking-head',   // talking-head | documentary | short-form | map-animation
  platform: 'youtube',
  title:    'Optional title',
  views:    '1.2M views',     // optional
}
```

`service` key controls which page shows it. First 8 show by default, Load More for rest.

---

## How to Add a New SEO Page

1. Copy closest existing SEO page HTML
2. Change: `<title>`, meta description, canonical URL, OG/Twitter tags, schema, breadcrumb, H1, body text, offer list, stats, FAQ — all unique content
3. In the Service schema, reuse the canonical person entity:

```json
"provider": {
  "@id": "https://ariyankhan.com/about.html#person",
  "@type": "Person",
  "name": "Ariyan Khan",
  "jobTitle": "Freelance Video Editor",
  "url": "https://ariyankhan.com/about.html"
}
```

4. Set `buildPortfolioGrid('talking-head')` (or appropriate key)
5. Add 4 explore pills (2 main + 2 SEO, no self-link)
6. Add to `sitemap.xml` with `<priority>0.8</priority>`
7. Add link to new page from at least one existing page's explore pills

---

## Service Profile — How to Update

Edit `js/service-profile.js` for shared data and each service HTML for per-page values:

```js
const SITE = {
  name:         'Ariyan Khan',
  avatar:       'images/ariyan-khan-profile.webp?v=2',
  rating:       '4.9',
  heroReviews:  '81+',
};
```

Service-specific stats, role, image, and preview ID now live in each page's `<service-profile ...>` tag.

---

## Cache Busting

Bump `?v=` query string when editing CSS or JS files:

```html
<link rel="stylesheet" href="css/service.css?v=3">
<script src="js/main.js?v=3"></script>
```

Update ALL pages that load the changed file.

---

## Project Tracker

Lets clients check their project status themselves instead of messaging for
an update — nav button "Track Order" → `track.html`.

**How it works:**
1. Ariyan creates a project in `/admin/` (password-protected) with a short
   client-facing label and three other **required** fields: **service**
   (Talking Head / Documentary / Short Form / Map Animation —
   `TRACKER_SERVICE_KEYS` in `lib/tracker-db.php`), **delivery date**, and
   **project price**. The form (and `create_project` server-side) refuses to
   create a project missing any of these — creation generates a random
   8-character code like `7K4M-9XPQ` (confusable characters like `0/O/1/I/L`
   excluded). The service choice determines which page a review from this
   client publishes to later — see "Review Card" below.
2. Ariyan sends that code to the client (email/WhatsApp).
3. The client goes to `ariyankhan.com/track.html`, types the code, and sees
   a 6-stage horizontal progress stepper: Footage Received → Payment
   (Advance) → Editing In Progress → In Review → Payment (Full) → Delivered.
4. Ariyan updates the stage from the same `/admin/` dashboard as work
   progresses — the client's page reflects it immediately on next lookup
   (no notification is sent; the client checks on demand).
5. Payment status is **not** a free-text field — `/admin/` has a "Price" and
   an "Advance" number input per project (`price_amount`/`advance_amount`
   columns), and `tracker_payment_note()` (`lib/tracker-db.php`) derives the
   client-facing line from them, e.g. "50% advance ($150 of $300) received"
   or "Payment received in full ($300)". It's rendered as a small line under
   the *current* stage's label in the stepper whenever an advance is on
   file (blank before any payment). Editing the numbers is the only way to
   change that text — there's no separate note to type and it can never
   drift out of sync with the actual figures. Stage list lives in
   `TRACKER_STAGES` in `lib/tracker-db.php`.
6. Every time Ariyan changes a project's stage, today's date is auto-stamped
   for that stage (first time only, stored as JSON in `stage_dates`) and
   shown above that stage's dot on the stepper. The first dot falls back to
   the creation date and the last dot falls back to the admin-picked
   "delivery date" field whenever a stage has no stamped date of its own.
7. Creating a project can optionally take a client name + email. If an
   email is given, `lib/tracker-mail.php` sends an order-confirmation email
   (via the same PHPMailer/`mail-config.local.php` setup as the contact
   form) with the tracking link and code. Leaving the email blank just
   skips sending — the project is still created either way.
8. If a project has a client email, changing its stage from `/admin/` shows
   a "Notify client by email" checkbox (checked by default) next to the
   stage dropdown. When checked and the stage actually changes, the client
   gets a short update email naming the new stage, with the tracking link
   and code again. No email is sent if the stage is unchanged, if there's
   no client email on file, or if the checkbox is unchecked.

**Setup (one-time, done directly on the server — not via git):**
```bash
# SSH in, then create the admin password file (never commit this):
cat > admin-config.local.php <<'PHP'
<?php
return [
  'password' => 'choose-a-strong-password-here',
];
PHP
```
Same protection model as `mail-config.local.php`: plain-text in a gitignored
file, blocked from direct HTTP access by `.htaccess`. The SQLite database at
`data/tracker.sqlite` is created automatically the first time any tracker
script runs, and is also blocked from direct HTTP access by `.htaccess`.

**Stack:** PHP 8 (confirmed live on this host) + SQLite via PDO (built into
PHP, no separate database server or credentials needed). No new dependency.

---

## Review Card (Client Testimonials)

Single auto-rotating testimonial card. Live on the 4 main service pages
(`talking-head-video-editing.html`, `documentary-video-editing.html`,
`short-form-video-editing.html`, `map-animation-video-editing.html`) — each
showing that page's own niche reviews — and on `index.html`, which shows a
shuffled mix pulled from all 4. Not yet on the 10 SEO landing pages under
`/service/`.

**Files:**
- `css/review-card.css` → all visual design (both the `.service-testimonial`
  section layout and the `.review-card` component itself), shared by every
  page that uses it — service pages load this alongside `css/service.css`;
  `index.html` loads it alongside `css/style.css`
- `js/reviews-data.js` → `window.CURATED_REVIEWS`, the **single source of
  truth** for hand-picked review text, keyed by service (`talking-head`,
  `documentary`, `short-form`, `map-animation`). This is also what each
  service page's own JSON-LD `Review`/`AggregateRating` block was written
  from — if you edit a review's text here, update that page's `<head>`
  schema too, or they'll drift out of sync.
- `js/review-card.js` → all rotation/fade/dots behavior, shared. Reads
  `data-curated` off the `.review-card` element as a comma-separated list of
  `CURATED_REVIEWS` keys (one key on a service page, all 4 on the homepage)
  and optionally shuffles the combined list when `data-shuffle="true"` is set

**Load order** (`reviews-data.js` must come before `review-card.js`):
```html
<link rel="stylesheet" href="css/review-card.css?v=1" />
...
<script src="js/reviews-data.js?v=1"></script>
<script src="js/review-card.js?v=5"></script>
```

**How it works:** shows one review at a time, cross-fades to the next every
5s, with clickable dot indicators so it's clear more exist. Pauses on
hover/focus, skipped entirely for `prefers-reduced-motion`. Whatever
`CURATED_REVIEWS` keys are named in `data-curated` gets concatenated with
whatever's been self-submitted via `review.html` → `reviews.php` at load
time — so new client reviews appear automatically without a code change.

**Which page a self-submitted review publishes to:** every project has a
`service_key` (`talking-head` / `documentary` / `short-form` / `map-animation`)
set when it's created in `/admin/` or via the `create_project` MCP tool — it's
a required field precisely so a review can be routed correctly. When a client
submits a review, `review_submit()` (`lib/tracker-db.php`) copies that
project's `service_key` onto the review row. `reviews.php`'s GET response
includes it as `service`, and `js/review-card.js` filters the fetched list
against its own `data-curated` keys before merging — so a review from a
documentary project only shows on `documentary-video-editing.html` and the
homepage (which lists all 4 keys), never on `short-form-video-editing.html`.
A review with no `service` on file (shouldn't happen going forward, but
covers any pre-existing data) falls back to showing everywhere rather than
silently vanishing. To fix a project tagged with the wrong service after the
fact, use `update_project` with a new `service_key`.

**Markup shape** (copy this block into a new page — see
`talking-head-video-editing.html` for a full working single-service example,
or `index.html` for the multi-key + shuffled example):

```html
<div class="service-testimonial">
  <div class="service-section-header">
    <div class="tag-pill">Client Reviews</div>
    <h2 class="section-title">What Clients <span class="yl">Are Saying</span></h2>
    <p class="section-desc"><!-- one page-specific sentence, real stats only --></p>
  </div>
  <div class="review-card" id="reviewCard"
       data-curated="talking-head"
       data-api="reviews.php" aria-live="polite" aria-busy="true">
    <div class="review-card-face" id="reviewCardFace"></div>
    <div class="review-card-dots" id="reviewCardDots"></div>
  </div>
  <span class="service-testimonial-verify">
    Recently worked with me? <a href="review.html">Leave a review →</a>
  </span>
</div>
```

To add a new service key: add an entry to `CURATED_REVIEWS` in
`js/reviews-data.js`, use that key in the new page's `data-curated`, and add
a matching `Review`/`AggregateRating` block to the page's own JSON-LD
`Service` schema (same review text, kept in sync by hand). Never link out to
Fiverr itself from a service page — a past version did this and it was
deliberately removed (risk of sending the visitor to a cheaper competing
listing).

**Fixed-size design — do not reintroduce content-driven sizing:**
`.review-card` uses a fixed `height` (not `min-height`) so the box never
resizes as the rotation swaps in a shorter/longer quote — `.review-card-quote`
line-clamps to stay inside that budget instead.

**Two fragile spots, both already broken once during development — read
before touching avatar/ring CSS:**
1. The avatar ring is `position: absolute` directly against `.review-card`
   (which holds `position: relative` for exactly this). If ANY element
   between the ring and `.review-card` — `.review-card-face`,
   `.review-card-head`, etc. — ever gets its own `position` set, it silently
   becomes the ring's new offset anchor and the corner-overlap breaks with no
   error, just a wrong-looking result. Same logic applies to the `::before`
   cutout circle that makes the card surface "recede" around the ring.
2. The avatar element lives outside `#reviewCardFace` — `js/review-card.js`
   creates it once and only ever updates its `textContent` on rotation.
   `#reviewCardFace` is what gets `.is-fading` (`opacity: 0`) every 5s; if
   the avatar were a child of it (it was, originally), the ring would fade
   to nothing on every rotation instead of staying put.

---

## AI Metadata Remover (free tool page)

`ai-metadata-remover.html` is an organic-traffic page: a free, in-browser tool that
removes AI/provenance metadata from images, wrapped in SEO content (what it
removes, generator table, honest limits, FAQ with `FAQPage` schema, `WebApplication`
schema). Linked from the shared footer on every page, listed in `sitemap.xml`,
`llms.txt` and `llms-full.txt`.

**How it works (`js/ai-metadata-remover.js`):** the file is read with the File API
and the *container* is rewritten — pixel data is copied byte-for-byte, never
decoded or re-encoded, so quality is untouched and there is no server round-trip
at all (`.htaccess` CSP has `blob:` in `img-src` so the result thumbnails can render).

| Format | Kept | Removed |
|--------|------|---------|
| JPEG | SOI, APP0 JFIF, APP2 `ICC_PROFILE`, APP14 Adobe, DQT/DHT/SOF/DRI/SOS…EOI | APP1 EXIF (optional keep), APP1 XMP + extended XMP, APP2 MPF/FlashPix, APP11 JUMBF (C2PA), APP12 Ducky, APP13 IPTC/Photoshop, other APPn, COM, anything after EOI |
| PNG | IHDR, PLTE, IDAT, IEND, tRNS, gAMA, cHRM, sRGB, iCCP, sBIT, bKGD, pHYs, hIST, sPLT, APNG (acTL/fcTL/fdAT), cICP/mDCV/cLLI | eXIf (optional keep), tEXt/zTXt/iTXt (SD `parameters`, ComfyUI `prompt`/`workflow`, XMP), caBX (C2PA), tIME, unknown chunks, anything after IEND |
| WebP | VP8/VP8L/VP8X/ALPH/ANIM/ANMF/ICCP (VP8X EXIF/XMP flag bits cleared, RIFF size fixed) | EXIF (optional keep), `XMP `, `C2PA`, unknown chunks, trailing data |
| Anything else the browser can decode | — | Re-encoded from pixels to a fresh PNG via canvas (lossless but not byte-identical; animation lost) |

Every removed/kept block is scanned for generator signatures (`SIGNATURES` array)
so the result card can say "C2PA Content Credentials", "OpenAI / ChatGPT / DALL·E",
"Stable Diffusion / ComfyUI / A1111", etc. If the user chose "Keep camera EXIF" and
that EXIF block itself contains a signature, the card shows a warning.

**Testing:** `node tests/ai-metadata-remover.test.mjs` builds synthetic JPEG/PNG/WebP
fixtures with EXIF/XMP/C2PA/IPTC/text chunks, runs the stripper and asserts the
output parses clean. Needs Node only (no browser).

**Honest limits (keep the copy honest):** it cannot remove pixel watermarks
(SynthID etc.), cannot beat pixel-based detectors, and does nothing for video.
Don't market it as "make AI images undetectable".

## Do Not

- Do not commit `mail-config.local.php`
- Do not add self-links in explore pills
- Do not create duplicate content across SEO pages (Google penalty)
- Do not add `site-config.js`

