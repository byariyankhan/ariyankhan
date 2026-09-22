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

**Never commit:** `.env`, `mail-config.local.php` (credentials) — both in `.gitignore`

---

## VPS deployment (Docker)

The site runs as one self-contained Docker Compose project on the shared
Hostinger KVM VPS, next to the other sites already there. It binds **no public
port**: `ariyankhan-web` listens on `127.0.0.1:${WEB_PORT:-8081}` and the VPS's
existing reverse proxy routes `ariyankhan.com` to it (Traefik labels are on the
container for proxies that read them). The site is stateless (static pages plus
the PHP contact form), so moving it to its own VPS later is: run the same
compose there, flip DNS.

| File | Purpose |
|------|---------|
| `deploy/docker-compose.yml` | Shared-VPS project: one `web` container (php:8.4-apache) that downloads the branch tarball from GitHub on start |
| `deploy/docker-compose.standalone.yml` | Same, plus Caddy on :80/:443 with automatic TLS — only for a VPS where nothing else uses those ports |
| `deploy/nginx-ariyankhan.conf` | Host nginx server block that proxies the domain to the container (the VPS's other sites are plain nginx vhosts too) |
| `deploy/web-entrypoint.sh` | Enables Apache modules, `AllowOverride All`, and writes `mail-config.local.php` from env vars |

**Live project:** VPS `srv1918310` (ID 1918310, IP 187.52.122.99), Docker
project `ariyankhan`, container `ariyankhan-web` on `127.0.0.1:8747`.

**Deploy / redeploy:** push to `main`, then re-run the project in hPanel → VPS →
Docker Manager (or the Hostinger API `VPS_createNewProject` with
`deploy/docker-compose.yml`). The container restarts and re-downloads `main`.

**Secrets** are never in git: set them as the project's environment in Docker
Manager. `deploy/web-entrypoint.sh` turns them into the gitignored PHP config
file on every start:

| Env var | Ends up in |
|---------|-----------|
| `TO_EMAIL`, `FROM_EMAIL`, `FROM_NAME`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `SITE_URL` | `mail-config.local.php` (contact form) |

`FROM_EMAIL` is the address the message is *from* and `SMTP_USER` is the account the relay signs in as:
two different things, and the relay refuses a sender it has not been told about. The visitor's own
address is the `Reply-To`, so replying to an enquiry goes to them and not to this site.

| `WEB_PORT` (default 8081), `SITE_BRANCH` (default `main`) | compose itself |

**Proxy note:** `.htaccess` forces HTTPS via `%{HTTPS}` *or*
`X-Forwarded-Proto`, so any proxy that sets that header (all of them do) works
without a redirect loop. `RedirectMatch 404 ^/(deploy|tests)` keeps the tooling
directories unreachable over the web.

---

## youtube.ariyankhan.com (the channel's smart link)

The subdomain is **the same container as the main site**, not a second server.
`/youtube` in this repo is its document root: `index.php` is the smart opener
that hands a visitor to the YouTube app, `spain.php` is a page per video, plus
that subdomain's own `robots.txt`, `sitemap.xml` and `assets/`.

It is live. Three pieces line up:

| Piece | Where | State |
|-------|-------|-------|
| DNS record `youtube` | **Cloudflare** (`algin`/`meiling.ns.cloudflare.com` are the domain's nameservers — the Hostinger zone for ariyankhan.com is not authoritative and editing it does nothing) | `CNAME youtube → ariyankhan.com`, proxied |
| Reaching the container | the VPS's nginx passes the Host through as it stands, so the extra `server_name` in `deploy/nginx-ariyankhan.conf` turned out not to be needed to bring it up; it is there for the day the host stops guessing | live |
| Routing and headers | root `.htaccess` | live |

Verified on the live subdomain: `/` and `/spain` answer 200, `/spain.php` and
`/index.php` 301 to their canonical forms, the thumbnail, `robots.txt` and
`sitemap.xml` resolve, anything else is a 404, `/youtube` on the main site is a
404, exactly one of each security header comes back, and each page's nonce
matches its own `Content-Security-Policy`.

The `.htaccess` block does four things for any host starting `youtube.`:
serves `/` from `/youtube/index.php`; serves a real file out of `/youtube` when
one exists (so `/assets/spain-thumbnail.png`, `/robots.txt` and `/sitemap.xml`
resolve); maps an extensionless path to the `.php` beside it, because the pages'
own canonical URLs read `/spain`; and 404s everything else, so nothing from the
main site is reachable through the subdomain. `/spain.php` and `/index.php`
301 to their canonical forms, and **on the main site `/youtube` is a 404**, so
the same pages are never indexed at two addresses. `[END]` (not `[L]`) is what
stops an internal rewrite from looping back through the block.

The pages send their own security headers, including a stricter nonce-based
Content-Security-Policy than the main site's. Two `Content-Security-Policy`
headers would be enforced as the intersection of both, and the other four would
simply contradict each other, so the `<If "%{HTTP_HOST} =~ /^youtube\./i">`
block unsets the main site's CSP, `X-Frame-Options`, `Referrer-Policy` and
`Permissions-Policy` and lets the pages speak. Static files there keep `nosniff`
and HSTS.

Adding another video page: drop `whatever.php` in `/youtube` and it is live at
`https://youtube.ariyankhan.com/whatever` on the next deploy. **Put it in
`/youtube`** — the folder was once called `Youtube Ariyan Khan`, and a file
uploaded to that old name is not served.

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
| `js/review-card.js` | Auto-rotating testimonial card behavior — see "Review Card" section below |
| `js/reviews-data.js` | Curated review text (`window.CURATED_REVIEWS`), single source of truth |
| `css/review-card.css` | Review card + testimonial section design, shared across pages |
| `ai-metadata-remover.html` | Free SEO tool page: strips C2PA/XMP/IPTC/EXIF/PNG-text metadata from images in the browser — see "AI Metadata Remover" section below |
| `js/ai-metadata-remover.js` | The byte-level JPEG/PNG/WebP metadata stripper + page UI (no server, no upload) |
| `css/ai-metadata-remover.css` | Tool page layout, drop zone, result cards, content sections |
| `map-maker.html` | Free SEO tool page: highlight countries on a world map, export PNG/SVG — see "Map Maker" section below |
| `js/map-maker.js`, `css/map-maker.css` | Map Maker engine (d3-geo projections, export, share links) + page styles |
| `piece-the-world.html` | Geography jigsaw game page — see "Piece the World" section below |
| `js/piece-the-world.js`, `css/piece-the-world.css` | Game engine (drag/snap, modes, timer, stars, bests) + page styles |
| `games/data/*.json`, `games/build-data.mjs` | Level data (piece paths per continent) and the script that builds it from Natural Earth |
| `games/piece-the-world.webmanifest`, `piece-the-world-sw.js` | PWA manifest + service worker for both games (offline levels, installable) |
| `puzzle/index.html`, `js/puzzle.js`, `css/puzzle.css` | Tap-away arrow puzzle game on country maps, served at `/puzzle/` — see "Puzzle – Train Your Brain" section below |
| `games/data/puzzle.json`, `games/build-puzzle-boards.mjs`, `puzzle/app.webmanifest` | Its level data (outlines + tier scales for 197 countries; masks are rasterised in the browser), build script and PWA manifest |
| `games/puzzle/` | Its backend service, which is a project of its own: Node 22 + TypeScript + Fastify, PostgreSQL, Redis and a WebSocket, with its migrations, test suites, compose file, backup and restore scripts and nginx snippet — see `games/puzzle/README.md` |
| `js/vendor/` | Local copies of d3-array, d3-geo, d3-geo-projection, topojson-client and Natural Earth country data (`countries-110m.json`, `countries-50m.json`); the site CSP forbids CDNs |

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

## Removed features

The client Project Tracker (`track.html`, `/admin/`, SQLite), the inbox, the
self-service review submission (`review.html`, `reviews.php`) and the `mcp.php`
endpoint were removed in September 2026. The review card now shows curated
quotes only. If any of it is ever needed again, it lives in git history before
that removal.

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
  and optionally shuffles the list when `data-shuffle="true"` is set

**Load order** (`reviews-data.js` must come before `review-card.js`):
```html
<link rel="stylesheet" href="css/review-card.css?v=1" />
...
<script src="js/reviews-data.js?v=1"></script>
<script src="js/review-card.js?v=5"></script>
```

**How it works:** shows one review at a time, cross-fades to the next every
5s, with clickable dot indicators so it's clear more exist. Pauses on
hover/focus, skipped entirely for `prefers-reduced-motion`. Only the curated
quotes named in `data-curated` are shown; there is no live review feed.

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
       data-curated="talking-head" aria-live="polite" aria-busy="true">
    <div class="review-card-face" id="reviewCardFace"></div>
    <div class="review-card-dots" id="reviewCardDots"></div>
  </div>
</div>
```

To add a new service key: add an entry to `CURATED_REVIEWS` in
`js/reviews-data.js` and use that key in the new page's `data-curated`. Do not
put reviews in JSON-LD (see the note above). Never link out to
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

## Map Maker (free tool page)

`map-maker.html` is the second organic-traffic tool: highlight countries in colour
groups, pick a projection, zoom to a region/selection, export PNG (1×/2×/4×) or
SVG, share by link. All client-side.

- **Libraries** live in `js/vendor/` (UMD builds; they attach to `window.d3` /
  `window.topojson`). Load order in the page: d3-array → d3-geo →
  d3-geo-projection → topojson-client → `js/map-maker.js`. No CDN: the CSP is
  `script-src 'self'`.
- **Data**: `countries-110m.json` (default, ~40 KB gzipped, 177 countries) and
  `countries-50m.json` ("High-detail borders" toggle, ~240 KB gzipped, 241
  territories) from the `world-atlas` npm package (Natural Earth, public domain).
  Abbreviated Natural Earth names are expanded in `NAME_FIX`; search aliases
  (UK, USA, Burma…) in `ALIASES`; region presets are lon/lat boxes in `REGIONS`.
- **Share links** put the whole state in `#m=<base64url JSON>`; nothing is
  stored server-side. `loadHash()` validates every field, so a malformed link
  just falls back to defaults.
- **Export** serialises a fresh non-interactive SVG (`render(target, {interactive:false})`)
  and rasterises it through an `<img>` + canvas. Labels use `Inter, Segoe UI,
  Arial` so the PNG matches what the browser has.
- **Rule**: keep the disputed-borders FAQ honest (Natural Earth de facto policy)
  and never call the maps "official".

## Piece the World (geography jigsaw game)

`piece-the-world.html` is the first game: drag continents (World level) or
countries (Europe, Asia, Africa, North America, South America, Oceania) onto an
outline board against the clock. Easy / Normal / Hard, misses + hints → accuracy →
1–3 stars, personal bests per level+mode in `localStorage` (`ptw:v1:*`), share
text, `#level-mode` deep links (`#africa-hard`). English only, continuous play
(no daily challenge), transcontinental countries filed by capital.

- **Engine**: `js/piece-the-world.js` (no libraries), styles in
  `css/piece-the-world.css` (`.ptw-` prefix). The board is one `<svg>` with the
  level's `viewBox`; every piece path is already in board coordinates, so a
  piece is "home" at translate(0,0). Dragging draws a ghost at true board scale
  in a fixed full-viewport `<svg>` and converts the drop point through
  `getScreenCTM()`; a drop within `tolerance(piece)` of the centroid snaps.
  Mobile also supports tap-piece-then-tap-board.
- **Data**: `games/data/<level>.json` (`{ board, pieces[], auto[], sphere? }`),
  ~1.1 MB total, built by `games/build-data.mjs` from Natural Earth 1:50m on an
  azimuthal equal-area projection (so piece sizes are honest). `auto` = countries
  under 14 board units in either direction, drawn pre-placed. IDs are ISO numeric
  codes, or a name slug where Natural Earth has `-99` (France, Norway, Kosovo…).
  Files are requested with `?v=<DATA_VERSION>` and `games/data/.htaccess` marks
  them immutable — bump `DATA_VERSION` in the JS (and the preload in the HTML)
  whenever you rebuild.
- **Adding a level** (e.g. states of a country): add an entry to `LEVELS` in
  `games/build-data.mjs` (or write the JSON by hand in the same shape), rebuild,
  then add `{ id, name, pieces, tag, blurb }` to `LEVELS` in the JS and a row to
  the levels table in the HTML. No engine changes needed.
- **PWA**: `games/piece-the-world.webmanifest` + `piece-the-world-sw.js` (root
  scope, but its fetch handler only answers for the game's own files; everything
  else passes through untouched). `.htaccess` serves the worker with `no-cache`
  so edges never pin an old version. Wrap it as an Android app later with
  Bubblewrap/PWABuilder (Trusted Web Activity) — no code changes.
- **Tests**: `node tests/piece-the-world.test.mjs` validates the data against the
  level cards and page copy. Browser drag/tap/finish flow was checked with
  Playwright on desktop and a Pixel 5 profile.

## Puzzle – Train Your Brain (tap-away arrow puzzle on country maps)

`puzzle/index.html` is the second game: the casual, addictive one. It is a
standalone game, not a site page: it does not load `css/style.css`, the nav or the
footer, and has its own look (`css/puzzle.css`: Nunito, cream “paper” theme
plus “night” and “mint” via `data-theme` on `<html>`, picked in Settings or with
the palette button). Home = purse chip, settings, a card carousel (Today's
Country, World Tour progress, Mode), title, a level path and a Continue button;
game = back / Level + difficulty / palette + settings, hearts + arrows left + hint,
the board (its outline is made of arrow pieces, see below; optional guideline dots),
Restart. The level grid is a bottom sheet; Settings is a full page like the
reference apps: Sound / Vibration / Guideline switches, Colours, How to play,
Feedback, Privacy Policy, Terms, and an About fold with the FAQ. Music is a
slow ambient pad synthesised with WebAudio on the device (Am9 · Fmaj7 · Cmaj7 ·
G6, low-passed, delayed, ~0.11 gain) — no audio file, no licence, works
offline; it starts on the first tap and stops when the tab is hidden. This is the
same shell we will wrap for Android/iOS (TWA / Capacitor). Each level is a
country's outline filled with arrows; tap an arrow to shoot it off the board if its
run to the edge is clear, a blocked tap costs one heart, no clock (time is still recorded for the result card), 4 hearts and 3 hints per
level (`LIVES_OF`, `HINTS_OF`: the same on every tier; fewer hearts or hints is not how the game gets hard), difficulty that follows the player and never the level number (one
tier 0 Easy / 1 Normal / 2 Hard / 3 Expert / 4 Master lives in `aa:v1:form` as
`{tier, wins, losses}`; `nextForm` moves it on form alone: a cleared board earns
`clearPoints` towards the next step, 2 for a flawless fast first-try clear (no
heart, no hint, ≤ `FAST_SEC_PER_ARROW` 1.2 s per arrow) so a strong player steps
up after a single level, 1 for any other first-try clear so two in a row step up
whatever hearts and hints were spent, 0 after a retry (resets); two lost boards
in a row step it down;
`TIER_OF()`; Try again keeps the same board, New layout takes the new tier; the
tier is never explained on the win card, only shown on the Next button and in
the start toast), combo counter (taps within 1.8 s), a win streak (still counted, no longer
announced on the card), milestones every 10 levels, a Today's Country bonus board (date-seeded, same for
everyone, reached by `#daily` rather than from Settings), and clearing the board reveals the country for a
3-option quiz plus capital/population/region. 197-country World Tour (every UN member state, plus Palestine, the Vatican, Kosovo and Taiwan: world-atlas 110m plus the 29 small states from the 10m file, minus dependencies and disputed areas) with sequential
unlock (skip allowed after two fails), stars, best times and progress in
`localStorage` (`aa:v1:*`) and, once signed in, on the account as well, so a new
phone picks the tour up where the last one left it; share text, `#level-N` deep
links.

- **Engine**: `js/puzzle.js` (no libraries), styles in `css/puzzle.css`
  (`.aa-` prefix). Puzzles are generated in the browser from a fixed seed per level
  and tier (`mulberry32`), in two stages, like a maze that is drawn first and
  signposted after. (1) Layout: a share of inland cells (`HOLE_OF`) is carved out
  as straight lanes of 1..`LANE_OF` cells (never on the coast, never beside another
  gap); then the shape is covered with long snakes (`MAXLEN_OF`): each walk starts
  at the most hemmed-in free cell, prefers straight runs (`RAIL_OF`), hugs the
  coast when it starts there, steps into any nook it passes, and lone leftovers
  join a neighbouring snake's end. (2) Signposting: "A blocks B" when A's cells lie
  on B's run; orientations are legal as long as that graph stays acyclic, checked
  by a path search when each snake picks its head end (snakes with the fewest
  legal ends go first; one with none is split in two; a lone inland cell that fits
  nowhere becomes a gap). Among legal ends: never one that is free from the start
  when the other can point at something, then (`FAR_OF`) the end with a gap right
  ahead — the arrow it frees when it goes is that far away — then (`NARROW_OF`)
  the end with more pieces on its run. Ords come from a topological order, so the
  solution removes newest-first and any other order stays solvable. ~10-40 ms a
  board; the whole thing is why play is a search rather than trail-following.
- **Board choice**: `bestBoard()` generates `CANDIDATES_OF[tier]` boards (4/6/8/8/8)
  from the level seed and keeps the best by `boardScore()`, a simulated player who
  always takes the free arrow nearest the one just tapped: mean arrows free at any
  moment + 2 × share of freed arrows within two cells of the tap + 0.15 × free at
  the start + 0.03 × lone arrowheads. `startLevel` shows the game screen with
  "Drawing the board…" and yields a frame first (~0.1-0.3 s per level on desktop).
  Measured on the tour (trail player): arrows free at any moment ~4-5 (was ~17),
  freed arrow within two cells of the tap 23-32% (was ~60%), five or more cells
  away 34-51%, snakes 4.6-5.6 cells long, lone arrowheads 2-8%.
- **Lobby world map**: `games/data/world-map.json` (built by
  `games/build-world-map.mjs` from world-atlas 110m, Natural Earth projection,
  1000×520, Antarctica dropped, label point = centroid of the main landmass) is
  drawn on the second card of the home deck by `renderWorld()`: every country faint, the tour
  countries outlined and tappable (opens that level), cleared ones filled green
  and numbered with their level, the next level pulsing purple. The map sits in a
  panel of its own and takes the height it needs; before the first country is
  cleared its caption reads "197 countries ahead of you" rather than "0 of 197
  discovered".
  Features world-atlas leaves without an id (Kosovo) get `n:<slug>` ids in both
  data files. Versioned with `MAP_VERSION`. There is no Restart button in the game any more (back out or
  fail and retry).
- **Notifications** (`games/puzzle/backend/src/push.ts`, `migrations/008_push.sql`,
  the `push` handlers at the end of `piece-the-world-sw.js`, and the switch in
  Settings): Web Push, for the two things that happen to somebody who is not
  looking at the game — a friend asking them to a match, and the league paying
  out on Sunday night. Nothing else is ever sent. An invitation only pushes when
  the player is **not** online (`online.is`), because somebody with the game open
  already has it on their screen; the league pushes after the settlement
  transaction has committed, so a push that fails cannot take a prize with it.
  Both are fire-and-forget: `sendToUser` never throws into the caller. Endpoints:
  `GET /v1/push/key` (the public key, or `enabled:false`), and
  `POST /v1/push/subscribe` / `unsubscribe`, rate limited by `push_write`. One
  row per browser endpoint, moved to whoever signs in on it, deleted with the
  account, and deleted the moment a push service answers 404 or 410. The client
  asks for permission **only** when the switch is turned on, hides the switch
  entirely where the browser cannot do it or the server has no keys, and drops
  the subscription on sign-out. **The VAPID keypair is generated on the VPS** by
  the `push-keys` mode of `puzzle-ops.yml`: it writes both halves into the
  project's `.env`, patches the compose file to pass them through, recreates the
  API, and prints only the public one. The private key is never in the repository
  and never in a log.

- **Lobby layout**: purse, title, tagline ("Train your brain."), **the deck**, then
  Play & Discover and Play with Friends. The old cards carousel, the level-path
  dots and the compact Today's Country / All levels buttons are all gone.
- **The deck** (`.aa-deck`, `deckGo`/`deckStart`/`deckStop`): the brain and the
  world map are two cards and only one is on screen. It turns itself every 4.5 s;
  the moment the player turns it themselves — a swipe, a dot, an arrow key — it
  stops turning and stays where they put it. A drag decides on its first 8 px
  whether it is a swipe or the page scrolling and never does both; a swipe never
  becomes a tap (a capture-phase click listener swallows the one that ends it), so
  a country under the finger is not opened by accident, while a plain tap on a
  country still opens it (only the click within 400 ms of the release is
  swallowed, so the next real tap — or Enter on a country — is not eaten).
  Manual turns stop at the ends, the timer wraps. The thresholds are the ones a
  thumb needs: under 15 px sideways is a tap, not a swipe, so a country under a
  finger that slid a little still opens; a finger down stops the clock, so the
  card can never turn out from under a tap; and while a drag is live every card
  is visible, because the one arriving is still marked hidden until the release. Keyboard and screen reader: the
  dots come before the card in the DOM (Tab reaches the dots, then the card they
  choose) and the CSS `order` puts them back underneath; arriving in the deck
  stops it turning (`focusin`), so nothing moves under somebody reading it; the
  card leaving is made `inert`, `aria-hidden` and — once the slide is over, which
  is also how a browser without `inert` keeps Tab out of it — `visibility:hidden`;
  focus is moved to the dot before a card holding it is hidden; the view is
  `aria-live` only once the player has taken the deck over; and Alt/Cmd+Arrow is
  left to the browser. The deck's height
  is `min(calc(100dvh - 296px), 560px)` — "whatever is left once the top row, the
  title and the two buttons have had theirs" — which is what keeps the whole home
  screen on one screen from a 360×560 phone to a tablet, and the two buttons at
  the bottom where a thumb is. The three tiles under the map (boards, countries,
  day streak — days this player cleared any board, not days they opened the daily
  board, which is what it counted at first and why somebody a hundred boards in
  was told zero; it counts only while it is alive, played today or yesterday,
  because nothing decays the stored record; all three counted in
  `renderHomeStats` so a map that failed to load does not leave a hundred-board
  player looking at three zeroes) are the win card's own
  tiles. Clearing a board sets `showBrainNext`, so the player comes home to the
  brain they have just lit rather than to whichever card they left on.
- **The brain on the home screen** (`renderBrain`, `emblemFor`): a board of this
  game and nothing else — the same rasteriser, the same generator, the same
  arrows in the same line weights — drawn at the difficulty the player is
  actually being dealt (`TIER_OF()`), from `emblem` in
  `games/data/focus-boards.json` (the brain outline plus five scales of its own,
  ~31 arrows on Easy to ~90 on Master). The silhouette itself is drawn under the
  arrows as a path (`.aa-brain-wash`), at the resolution it was designed at: a
  cortical fold is smaller than a cell at twenty-odd arrows, so rasterising alone
  leaves a lumpy blob, and the wash is what makes it a brain. The transform is the
  mask's own — cell `(c, r)` has its centre at `(c + 0.5) / k` in the path's
  100-unit box, cropped to the bounding box `mask.x`/`mask.y`.
  So the brain a player comes home to gets
  finer and busier as they get better. Every board cleared lights another tenth
  of it, **from the bottom up**, and the tenth lights the lot in green — the same
  ten that makes a milestone. Under it: `Level <n>`, the difficulty in its own
  colour, and one line saying how many boards are left to light it. Redrawn only
  when the tier or the lit count changes (`brainKey`), and the fade-in wave is
  skipped under `prefers-reduced-motion`.
- **Every mode gets the same board**: what the game offers on a board does not
  depend on which mode dealt it. Advertisements used to be switched off outright
  in a challenge (`adCanOffer` returned false for `state.daily.race`), which
  meant the one place in the game where a board actually costs something was the
  one place a player could not buy a heart back; the reason behind it is real but
  it is the player's to weigh, so the offer is there and it says **"The match
  clock keeps running while it plays."** And a cleared challenge used to end on a
  bare "Sending your time…", so the reading — the stars, what the board cost, the
  focus bar — never appeared. It is kept on `state.raceReading` (keyed by match
  code, cleared with every new board) and drawn on the result sheet under the
  purse, with `runFocusBar(value, root, animate)` filling it once and the
  four-second refreshes only restoring where it ended. The one thing left out
  there is a second clock: the race time is already on every line above it, and
  two different times on one sheet is how a race stops making sense.
- **Android** (`android/`, and `android/README.md` for the whole of it): the Play
  Store app is a **Trusted Web Activity** — the site itself, in the phone's own
  Chrome engine, with no browser around it. Not a rewrite, because the game is a
  web game: a TWA runs the same code on the same engine at the same speed, with
  no WebView penalty and no bridge, and a native port would mean a second board
  generator, a second economy client and a second set of bugs without drawing one
  arrow faster. One activity, one dependency
  (`androidbrowserhelper`), a 180 KB bundle. Icons and splash come from the
  game's own mark (`games/build-android-assets.mjs`), so there is nothing drawn
  by hand to fall out of step. The address bar only disappears once
  `.well-known/assetlinks.json` carries the SHA-256 of the certificate Play App
  Signing holds — `games/build-assetlinks.mjs <fingerprint>` writes it, and the
  fingerprint is only knowable after the first upload. **No keystore is in this
  repository and none should be.**
- **A cold start is not somebody else's JavaScript**: `puzzle/index.html` used to
  carry a bare AdSense tag in its head — 655 KB fetched and parsed on every cold
  start of a page with no ad units on it and no Auto ads enabled, more than the
  whole game weighs. It is gone from the game page (the rest of the site keeps
  it, which is where the site review reads), and `adsConfigure()` fetches the
  same script itself the moment advertising is actually switched on. First load
  went from 1,354 KB to 698 KB. On Android this is not a nicety: cold start time
  is one of the vitals Play measures, and a demoted app is one nobody is shown.
- **What a board pays** (`placePrizes`, `standings`, `settleMatch` in
  `rooms.ts`): first took the whole pot, which is a good rule for two players and
  a bad one for five — the moment somebody clears it everybody else is playing for
  nothing, and they stop. From **three players up** a board pays three places:
  **second gets its stake back** (finish second and the board cost you nothing,
  which is the whole reason to keep going after somebody has won), **third a tenth
  of its stake**, and first takes everything else — on any room bigger than three,
  still the great majority of the pot. Two players is a duel and a duel has one
  winner, so nothing changes there.
  A place is earned by **clearing the board**, in the order they were cleared, and
  never by ranking above somebody who gave up — otherwise giving up would pay.
  First is paid its share the instant it clears (the gold still lands on the win);
  second and third are paid as they arrive, each with its own idempotency key; and
  a place nobody claims goes to first **when the room closes**, which is the one
  moment it is certain nobody is coming. All of it is the `payout` reason, so the
  ledger and the league count it exactly as before.
  `standings` reads the places *behind the recorded winner* rather than off the
  head of the list: an account deleted mid-match takes its seat row with it, and
  reading the list alone would promote everybody by one and pay second place
  twice. With the winner gone there is no first to pay, and what first would have
  taken is not invented.
  The client is told per row (`prize`) what that player took, so second is told
  its stake came back rather than that it lost, and per table (`prizes`) what the
  places pay. A room being invited into does not know how many will sit down, so
  the sentence there says "with three or more at the table" until three actually
  are.
- **Asking** (`ask({title, body, ok, cancel, danger})` → a promise for true or
  false): the browser's `confirm()` is a modal from another world — it says
  "ariyankhan.com says", it cannot be styled, and on a phone it looks like the
  site has been taken over. All four places the game stops to ask (leaving a
  board, leaving a challenge, giving a board up, deleting an account) are about
  losing something, which is exactly where the dialog should belong to the game.
  Escape and the backdrop both mean no, one question can be open at a time, and
  on a destructive question **the safe button holds focus** — a native confirm
  puts OK under the thumb that opened it, which is how an account gets deleted by
  a double tap. The destructive button is tinted rather than solid, because
  `--bad` is a light red in the dark themes and white on it cannot be read.
  Leaving a board is asked about whenever one is live; it used to be asked only
  once an arrow had been cleared, so walking out of a board somebody had been
  staring at for a minute took one tap and said nothing.
- **Gave up, or ran out of hearts** (`009_gave_up.sql`): `ms = -1` used to mean
  only "did not clear it", and every result sheet read that one value out as "ran
  out of hearts" — so a player who left the room was told, on everybody's screen,
  that the board had beaten them. `match_players.gave_up` remembers which it was;
  the client sends `gave_up` with the result (from the back button and from the
  card's "Give the board up"), `orderPlayers` passes it through, and the row reads
  "gave the board up". Nothing else changes: `ms` still decides the order and who
  is paid, and rows written before the column existed read false, which is the
  meaning they actually had.
- **Upright, always**: the game is a column — a square board, a status bar, a map
  under it — and it stays one however the phone is held. An installed copy is held
  there by `"orientation": "portrait"` in `puzzle/app.webmanifest`, and
  `screen.orientation.lock('portrait')` is asked for on load, which an installed
  or fullscreen window grants (the screen then never turns at all) and a plain tab
  rejects, swallowed.
  No browser lets a plain tab lock rotation, and that case used to be a notice
  asking for the phone back — the wrong answer for somebody lying on their side,
  who did not turn the phone but turned themselves. **The page turns back
  instead**: `body` is given the portrait box it wants (`width:100dvh;
  height:100dvw`) and rotated by exactly the angle the browser rotated it, the
  other way, so the game stays on the same glass it was on a moment ago. Nothing
  moves under the thumb and nothing is interrupted.
  The direction comes from `screen.orientation.angle` (90 means the device was
  turned counter-clockwise, so the page is turned clockwise back — `is-turned-ccw`
  — and 270 the other way), because CSS cannot tell landscape-left from
  landscape-right. The three media conditions are unchanged:
  `(orientation:landscape) and (max-height:560px) and (pointer:coarse)` — all
  three, because a laptop window is landscape too and a tablet in landscape is
  tall enough to play in as it is. `--app-h` carries the column's height (`100dvh`
  upright, `100dvw` turned) so every height in the stylesheet follows.
  A rotated page is still handed screen coordinates, so **`ptOf(e)` and
  `rectOf(node)`** put a finger and a box back into the page's own frame — the
  identity while upright, which is every desktop and every phone held the usual
  way. Directions and rectangles needed it (the deck swipe, the board's pan and
  pinch, the confetti canvas); distances did not, because a quarter turn does not
  change one.

- **SEO**: title/description/keywords around "puzzle", "train your brain", "arrow puzzle" and
  "arrow game"; Open Graph/Twitter card `images/puzzle-og.jpg` (1200×630,
  drawn by `games/build-puzzle-og.mjs`; the app icon by `games/build-puzzle-icon.mjs`); schema.org WebPage +
  VideoGame/WebApplication (alternateNames, keywords, image, PlayAction) +
  BreadcrumbList + FAQPage; the About / how-to / FAQ copy is a visible
  `#aaAbout` section under the app (the settings "How to play" and "About"
  rows scroll to it); the homepage has a "Games" section linking both games
  with keyword anchor text; sitemap priority 1.0 with an image entry.
- **Scale and feel** (matched to the reference apps): boards are at most 32 cells
  across on Easy to Hard (46 tall / 38 wide for elongated shapes) and up to 36/40
  on Expert/Master (`MAX_DIM_OF`, `MAX_TALL_OF`, `MAX_WIDE_OF`; `TARGETS` 110/240/400/540/680
  cells), so phones show ~12 px cells; strokes are 0.2 of a cell with 0.5-cell
  arrowheads; snakes run up to 7-16 cells (`MAXLEN_OF`). Every tap has feedback:
  pressing thickens the arrow; a blocked arrow lunges forward, hits and comes
  back (`bounce()`, WAAPI) with a thud; a shot arrow lights up with a three-colour
  gradient of three success-green shades that streams along it (`#aaGrad`: a 5-cell
  diagonal period, repeated, slid by SMIL `animateTransform`; static under reduced
  motion); the head rides the body's exact curve so the two never part. Hard boards: ~55-65 arrows, ~3.4 free at any moment, freed arrow
  within two cells of the tap 24%, five or more cells away 44%.
- **Cheers** (as in the reference apps): shots closer than `COMBO_WINDOW_MS`
  (1.8 s) chain into a combo and a wrong tap breaks it; only when the combo
  *reaches* a step (`comboStep`: x3, x5, x8, x12, then every fifth) a shot fires
  `sideBurst(level)` (streamers from both screen edges on the shared particle
  canvas, level 0-3 from `comboLevel`: Good / Great / Amazing / Unstoppable)
  with `SFX.cheer(level)`, a jingle that rises three semitones per level, and a
  short 1.4 s toast; after a cheer the next `CHEER_HOLD` (3) shots stay quiet.
  Long shots on their own never cheer. `fxEmit()` runs one animation loop for every emitter, including the win
  fountain `confetti()`; nothing is drawn under reduced motion.
- **No zoom**: the viewport meta sets `maximum-scale=1, user-scalable=no` and
  `html, body, .aa-app` carry `touch-action: manipulation`, so fast double taps
  and stray pinches can no longer zoom the page and push the board off screen.
- **Why not a "one or two free arrows" rule**: the geometry of a country board
  leaves ~11 arrows free at the start and 3-4 at any moment, and no orientation
  search moves that floor (annealing, locality objectives, straight snakes and
  two rewritten generators were all measured against it). Freezing the excess
  and thawing it on a schedule was built and rejected: a visible thaw reveals
  the next free arrow, an invisible one just adds fruitless taps. The levers
  that do add time are board size and where the free arrows sit: Expert/Master
  boards grow to 700/900 cells (~84/113 arrows). Measured next: every arrow free
  at the start is a coast arrow pointing straight out to sea (100% on Hard and
  Master), i.e. the one kind of free arrow a player spots without tracing. A
  coast-aware layout (no snake end pointing to sea, coast tips eroded, sea-safe
  split points, corridors carved from the coast inland, splitting instead of
  taking a sea exit) moved the sources onto short coastal fragments without
  lowering their number: the dependency graph needs one source per coast chain.
  Hiding the exits therefore needs a signposting redesign that chooses the
  sources deliberately (corridor exits only, coast closed), not more tuning.
- **Discovery boards** (`games/data/discover-boards.json`, `games/build-discover-boards.mjs`,
  `discLevelFor`, `nextStep`, `renderDiscoveries`): after a country's outline the tour
  plays a second board shaped like something a traveller finds there: its animal,
  its bird or a landmark. Shapes are Twemoji glyphs (graphics CC-BY 4.0, credited
  on the page) traced to one silhouette with potrace at 240 px, flattened to
  straight segments (the game's parser reads M/L/Z only), centred in the same
  100-unit box as the country outlines and given one scale per tier by the same
  `rasterise`, so the generator, tiers, hearts and hints are untouched; the
  pyramids are drawn by hand (`CUSTOM`). Which glyph a country gets comes from
  keyword rules over `games/data/discover.json` (the hand-written animal, bird,
  place and dish per country, the build input), with `PLACE` overrides where a
  landmark says more and `LABEL` names for place boards (the glyph shows one
  landmark, the text often names two). 59 shapes for 197 countries, 55 KB.
  In the game a discovery level is `{ id: 'd:<id>', name, kind, hex, d, k,
  country, disc: true }` and sits in the one tour list right after its country
  (`tourFor`: 197 countries → 394 levels, plus a scene board after every
  fourth country), so it unlocks, seeds, saves (`lv:d:<id>`) and deep-links (`#b-<id>`)
  exactly like a country.
- **Scene boards** (`games/build-scene-boards.mjs` → `games/data/scene-boards.json`,
  fetched once per session with `SCENE_VERSION`): twelve geometric shapes — The
  Tower, Twin Towers, The Arena, The Cross, The Diamond, The Ziggurat, The Hive,
  The Frame, The Bridge, The Comb, The Gate, The Spiral — rasterised at five sizes
  (`TARGETS` 160/330/540/950/1250 cells) like the focus boards, and drawn like the
  reference pages: a tall shape filled edge to edge with long winding arrows. In the
  game one is `{ id: 's:<id>', name, d, k, scene: true }`; `tourFor` puts one after
  every fourth country (`SCENE_EVERY`), in order, and it is played **one tier
  harder** than the player's form (`clampTier(TIER_OF() + 1)`), so a Hard player
  meets The Tower at Expert (~140 arrows) and an Expert player Twin Towers at Master
  (~160). The result card has no fact box and no YouTube line, as on focus boards,
  and the HUD reads `Level N · The Tower`.
- **Expert and Master are harder** than they were: snakes run to 14 and 16 cells
  (`MAXLEN_OF`), nearly every arrow points far (`FAR_OF` 0.85/0.95), runs are
  straighter and longer (`RAIL_OF`), and the country outline is rasterised on a
  finer grid (`KSCALE_OF` 1.18 on Expert, 1.5 on Master, applied only to countries
  and discovery boards; scene and focus boards are sized for their tiers already),
  so a Master country holds ~120 long arrows instead of ~90, and the tightening
  pass runs more flips (`TIGHTEN_OF` 380/420). The finer grid has a budget
  (`CELL_CAP_OF` 800/1100 cells, `SIDE_CAP` 66): Brazil at 1.5 would be two
  thousand cells and three hundred five-pixel arrows, so `maskFor` trims the scale
  to what fits, and a big country stays nearer the size its level data gave it. A
  board still generates in about two seconds on a phone-sized Chromium.
- **In the app, Back is the page's.** The game has no history for the WebView to
  walk (it routes with `replaceState`; a sheet is an element that is shown), so the
  shell hands Android's Back over the bridge as `{event:"back"}` and `backPressed()`
  closes what is open one layer at a time — the open `ask()` question (answered No),
  the Home page, a sheet, the board (with its "Leave this board?" where that
  applies) — and when nothing is open sends `leave`, on which the app steps into the
  background. The page says `hello` as it loads (`shellListen`) so the app holds a
  reply channel to it; `shell.ask` ignores `{event}` messages, and a timed-out
  question no longer clears the next question's handler. `share <text>` opens the
  phone's own share sheet, which is what `navigator.share` is in a browser.
- **Analytics after the gate, never in the app.** The gtag snippet is gone from the
  HTML; `analyticsOn()` loads it once `welcomed` is set (the Terms and Privacy
  gate accepted) and not when the page runs inside the shell, whose store listing
  declares what the app collects. The `typeof gtag === 'function'` guards mean a
  page without it simply sends nothing. The gate sits above every sheet
  (`z-index` 60), so a first open through `#m=` or `#league` cannot skip it.
- **One tour on every device.** Every board syncs now, the focus boards included: they
  used to be kept on the device alone (`isLocalOnly`), so one phone stood on level
  106 with the brain and the key behind it while the tablet, with the same countries
  from the server, met the brain again at level 81. And the sync runs at more than
  sign-in and each clear: a push that failed (a board cleared on the train) is owed
  and made whole on the `online` event, the game syncs whenever it comes back on
  screen (`syncIfStale`, at most once a minute) and every five minutes while it is
  looked at — each of those pulls as well as pushes, which is how the other device's
  clears arrive without a restart. The server keeps `tier` up to 4 (Master was being
  clamped to 3).
- **Home clarity, and the brain's colour.** The two home buttons are drawn as designed: an icon
  (wifi-off for the solo tour, wifi for friends) | a thin divider | the label with a short line under it
  ("Solo · works offline", "Online · for gold") | a chevron; the first one is a rose-to-coral gradient with a
  faint white brain of arrows riding its right edge (`.aa-play::after`,
  `images/puzzle-brain-mark-white.svg`). Paper stays the default theme and keeps its cream and brown, but
  its purple is gone: `--accent2` is the brain's rose `#DB3A5E` (the arrows that light the brain up on the
  home card, the slogan's colour), the Hard tier is magenta rather than purple, the primary buttons wear
  the same rose-to-coral gradient, a faint rose brain sits behind the home screen in every theme, and the
  splash mark is the rose one (`images/puzzle-brain-mark-rose.svg`) everywhere but Night. There is no
  separate Brain theme: the brain is in Paper.
- **The out-of-hearts card, as drawn:** "Get a free life" first and biggest, orange with the play icon
  and an AD pill on the right when it is a real advertisement (no pill in free mode); "Try again" under it
  in a soft rose tint; nothing under them (`.aa-actions--out`, `.aa-btn--big`, `.aa-btn--soft`,
  `.aa-ad-pill`): the corner arrow is the way back to the tour. A challenge keeps "Give the board up". The
  home buttons carry no subtitle: the icon says it.
- **The tutorial** (`COACH_STEPS`, `coachStart`, `#aaCoach`): on the first board somebody opens, five
  things one at a time, each under a spotlight cut out of a dark scrim by one enormous box-shadow, with a card
  pinned to the bottom and Skip on every step. Step one glows a free arrow (`.is-coach`, the hint's glow) and
  waits for the tap (`coachShot` from `shoot`); then the hearts and what a blocked arrow costs, the lamp, the
  press-and-hold check, and what clearing the board does. The layer lets taps through, so the board is playable
  under it. Shown once (`coached`), never in a race or on the daily board, closed by winning, losing or
  leaving the board, and Settings → Help → "Show the tutorial again" brings it back on the next board.
- **The developer switch exists only where a developer is.** Seven taps on the build line reveal the
  Developer group (Default / Test / Mock / Live, and the last advertisement's report), stored as `adsdev`
  on that device, but only on a page served from localhost or inside the app's debug build, which says
  `debug` on its agent string (`shell.debug`, `devAllowed()`). On the site and in the release build the
  taps do nothing and a flag left over from before is ignored: a switch anybody could find was handing
  out free lifelines (Test) and mock advertisements that the server pays gold for (Mock). "Hide
  developer settings" (`#aaDevHide`) forgets the flag and reloads.
- **No interstitials.** Nothing in the game shows an advertisement of its own accord: not between
  boards, not after a clear, not on a timer. The only advertisements are the rewarded ones a player
  chooses (a heart, a hint, a check, gold); the ads layer knows one AdMob unit, the rewarded one, and
  has no interstitial slot.
- **Advertisements are on in the app** (`data-give="ad"`: a real rewarded advertisement, granted only on
  `adViewed`) **and free lifelines stay on the site** (`data-give-web="free"`) until H5 Games Ads approves
  the domain — a button that asks a network that has not approved the site yet would give nothing. The
  day approval lands, drop `data-give-web` and the site is strict too.
- **Pre-publish audit fixes** (September 2026): a tap on the world map looks the
  board up by id when tapped, and a clear is saved under `state.level.id`, because
  choosing a home country reorders the tour under both; "Auto" home rebuilds the
  whole tour (`tourFor`, not `orderFor`); the home row and the toast name the first
  *country*, not the brain focus board; scene boards are not counted as countries
  (`isCountry`); a discover-boards or map fetch that failed is forgotten so the next
  Play tries again; the confetti canvas goes back with `appendChild` (the toast it
  used to be inserted before had moved out of the board wrap, which threw on every
  win with reduced motion on); the sign-in sheet's line returns to its own words;
  the hint and check labels only mention an advertisement when there is one; the
  League sheet says when it could not be reached; the coin is versioned; the
  service worker precaches the brain mark, serves the cached page over a 5xx and
  lists `/puzzle` without the slash.
- **Focus boards** (`games/build-focus-boards.mjs` → `games/data/focus-boards.json`,
  26 boards, 18 KB) are the boards the game opens on: a brain, a lightbulb, a
  key, a cog, a puzzle piece, a labyrinth, a knight — the game's own language
  rather than a country's, drawn here as M/L/Z outlines in the same 100-unit box
  and scaled per tier by the same `rasterise`. The brain among them is **the
  logo's brain** and not a second drawing of one: the same outline the splash mark
  and the app icon are built from (`images/puzzle-brain-mark.svg` — that mark is
  this outline filled with this game's arrows), a brain seen from above, narrower
  at the front and fuller at the back, split into two hemispheres. Two things
  differ from the logo's own code, both so it survives being a board: the outline
  is sampled into straight segments rather than left as quadratics, because that
  is the one form `parsePath` reads; and the channel between the hemispheres is
  cut out of the **shape** — two rings with a gap — rather than masked out of the
  grid afterwards, so the split is there at every size, the home screen's outline
  included. In the game one is `{ id:
  'f:<id>', name, d, k, focus: true }`. `tourFor` puts the whole block at the
  **frontier**, in front of the first board the player has not cleared: a new
  player's level 1 is the brain, and a player who has already cleared a hundred
  countries meets them next rather than never (appending) or behind a wall
  (putting them first would lock the country they were on). Their progress stays
  on the device (`isLocalOnly`): the account's progress is a list of country ids
  and a board that is not a country has no place in it. They are counted out of
  "N countries discovered" on the map, and the win card gives them **no facts
  line and no YouTube line** — a country has something to tell you when you clear
  it and a lightbulb has not. **Level numbers are the player's own progress**
  (`levelNo`): cleared boards ranked by clear time, then the board in hand is
  cleared-count + 1. The list only decides what comes next; a player who cleared
  63 countries before the discovery boards existed is on level 65, not back on
  level 4 because Bhutan's animal sits fourth in their list. Milestones (every
  10th) and the share text use that number; `#level-n` (position in the list)
  is still read for old links. The win card is deliberately short: kicker, name,
  the subtitle under it (what the find is, or capital, population and region for
  a country, and nothing at all on a focus board), stars, the four stats, the fact box on discovery boards, then Next,
  Play again and Share. No World Tour button: the back arrow in the HUD already
  leads there. The best-time line and
  the paragraph explaining what the player's form did to the next tier were both
  dropped as noise; the record is still kept and the tier still shows on the
  Next button. The result card's Next button and Skip go to the
  next *open* board (`nextOpen`: first uncleared, unlocked level further down
  the list, else from the top), never to a replay of a cleared one. The boards file is loaded with the level
  data, not in the background. The HUD says only `Level n`; the start toast
  ("Bangladesh's animal · 104 arrows · what is it?") is the one hint. No quiz after a
  discovery board (a quiz after every board wears thin, and guessing "Karabakh
  horse" from a horse silhouette is unfair): the card says what it was and why
  it belongs to that country, then one odd fact about it, both hand-written per
  country in the build script's `ABOUT` table and carried in the boards file as
  `rel` and `fact` ("Royal Bengal tiger · Bangladesh's national animal" / "The
  tigers of the Sundarbans swim between islands and drink slightly salty
  water."). Only country boards keep the three-option quiz. The lobby map marks the country whose step (outline or
  discovery) is next and is the only level picker: the All levels sheet, the
  Discoveries collection and the "You discovered" facts list are all gone. The
  tour unlocks itself from the player's play and location. **Tapping a country
  starts that country's board** — a cleared one replays, and a country nobody has
  reached yet says so rather than starting. It used to divert a tap on a cleared
  country to that country's discovery board whenever that board was still open,
  so the tap opened a board other than the one under the player's finger; the
  discovery board is what Play & Discover offers next instead.
- **Accounts** (`puzzle-api`: `backend/src/auth.ts`, `auth` in the engine):
  the lobby's second button gates on sign-in. Signed out it opens the sign-in
  sheet, signed in it opens the dashboard (name, stats, Challenge a friend, the
  two live modes marked Soon, sign out, delete account). The server keeps only
  the provider's opaque user id and the display name, in the `users` table of the
  game's own PostgreSQL database; sessions are random tokens stored hashed behind
  an HttpOnly, SameSite=Lax cookie, or sent as `Authorization: Bearer` by a phone
  app, which is the same session either way.
  `GET /api/puzzle/v1/auth/me` also reports which providers the server can actually use:
  Google sign-in is live only when `GOOGLE_CLIENT_ID` is set in the container's
  environment, otherwise the sheet says so. The OAuth client's **Authorized
  JavaScript origins** must list `https://ariyankhan.com`, or Google's library
  refuses to show the button on the live site. `puzzle/.htaccess` gives the folder its own
  slightly wider CSP in `.htaccess` for Google's sign-in library. Deleting the
  account is in the dashboard because Google Play requires it. A new account is
  created with `PUZZLE_SIGNUP_GOLD` (10,000), written as a `signup` row in
  the gold ledger, so the welcome purse lands exactly once: signing out and back
  in never tops it up. The balance rides along in every `user` object and shows
  on the dashboard.
  `games/puzzle/tests/` covers the security-critical half against a real
  PostgreSQL: which ID tokens are accepted (audience, issuer, expiry, unverified
  accounts, junk answers), that one Google account makes exactly one player, that
  session tokens are stored hashed and expire, that deleting an account takes its
  sessions with it, and that a link cannot reach anything that changes state. The
  one step no test can do is Google actually signing a token, so a real sign-in
  has to be tried by hand once.
- **Gold matches** (`puzzle-api`: `backend/src/rooms.ts`,
  `openStakes`/`showRoom`/`showConfirm`, `#m=<code>`): the lobby's second button asks for a sign-in, then shows the
  player's strip (name, provider, purse) and three coins side by side: 500,
  1,000 and 7,000, with nothing else on the screen. **The stake never touches the
  board.** Each player sends their own difficulty when they open or join a room,
  and `roomTier` sets the board to the middle of everyone's, at the moment
  the host starts, so gold buys a bigger pot and never an easier board.
  Under the coins sits one switch, **Fill from online** (on by default, kept in
  `aa:v1:fillOnline`), and under each coin the number of players waiting at that
  stake (`lobbyCounts`, cached in Redis for a second so a busy lobby does not ask
  PostgreSQL the same question a hundred times), so nobody sits at an empty one.
  Picking a coin holds the stake and opens a
  **room** on the game screen: how many of the seven seats are filled, the faces
  of who is in, the invitation link, **Invite**, **Start** (host only, dead until
  someone else is in) and **Cancel**. Friends open the link, confirm the stake
  and wait in the same room; the host starts when everyone is in, and the board
  is dealt only then (`matchView` hands out the country, tier and seed once the
  match is `playing`), so nobody can study it while the room fills up.
  **Leave** is everyone's, and it hands back your own stake and nothing else
  (`leaveRoom`, which checks the caller actually holds a seat before paying
  anybody — the route checks too, but a helper that hands out gold must not
  depend on every caller remembering). The room closes only behind the last one out, killing the
  link; if the host walks away from a room with people still in it, **the next of
  them by joining order takes the crown and the room carries on**, told by a
  toast rather than a Start button appearing out of nowhere. A room back down to
  one player stops its clock and starts its wait over, so whoever is left is not
  swept up a moment later for a wait somebody else did.
  **With the switch on the room fills itself and starts itself** (`open_to_all`),
  which is the one mechanism behind all three ways to play: two friends and
  nobody else (switch off), two friends with the rest brought in from online, or
  no friends at all. Picking a coin then walks you into the room already waiting
  at that stake (`openRoom`, longest-waiting first) instead of opening a
  second one, so a queue and a room are the same object and there is no
  matchmaking service to run. The stake *is* the queue — 500, 1,000 and 7,000 are
  three lines — and `roomTier` already sets the board from whoever turned up,
  so a room of strangers needs no rating system.
  Two players tapping the same coin in the same second would each open a room and
  sit in it alone, never meeting, so while a player is still the only one in a
  room that fills itself, **every read looks for an older room to walk into**
  (`requeue`, from `matchView` — behind `requeueWorthTrying`, so the common case
  opens no transaction at all): the seat moves across with the stake already on it,
  the room left behind closes with nobody in it to refund, and the client follows
  the new code, link and all. Only ever towards an older room, so two of them
  cannot swap places forever.
  **The clock (`AA_FILL_SECONDS`, 63 seconds) runs from the second player sitting
  down** (`fills_at`), not from the room opening, or the host would have no time
  to send the link; a third player joining does not push it back. A
  full room of seven does not wait for it at all. **In a room that fills itself
  there is no Start button**: the clock alone begins it (`clock_starts_it`), or a
  host could shut the door on everyone else the moment the second player sat
  down. The host's **Start** is only for an invite-only room. `sweep` runs on a
  timer in the service rather than on the back of somebody's request: it starts
  the rooms whose clock has run out with more than one player in them, and hands
  the stake back to anyone still sitting alone after two minutes
  (`PUZZLE_LONELY_SECONDS`) rather than leaving them to wait out the day. With the
  switch off none of this applies: no clock, no strangers, nothing at all until
  the host says go.
  **The first player to clear the board takes the whole pot, and is paid the
  instant their result lands** — no waiting on anybody else. Not the shortest
  clock: the server stamps the moment each result arrives and ranks by that, so
  finishing first is what wins. `settleMatch` pays that first clear straight
  into the purse (once only: the `paid_at IS NULL` guard on the row is what makes
  it a race, and the payout's `idem_key` in the gold ledger is a unique index, so
  paying twice is not a bug to find but a constraint violation) and leaves the
  match `playing`, because **the rest play on for
  second, third, fourth place — the places are still theirs to win, the gold is
  not.** The match itself closes only when everyone has reported. A player who
  runs out of hearts loses to anyone who clears; a board nobody cleared refunds
  every stake. Everything
  about gold happens on the server, which also picks the country, the tier and
  the seed; the client only shows what the API says. A result can only be
  reported once, so a retry cannot improve a time. A room nobody joins, or one
  the host never starts, is refunded after a day, and a match where someone never
  finishes is closed out a day later with the missing run counted as a loss.
  While they play, each player's percentage goes up the WebSocket and the line-up
  comes back in order, drawn over the top left of the board as circles numbered 1
  upwards (`renderRanks`). With the socket up the client polls every 15 seconds
  instead of every 2, and falls back to polling alone if the socket cannot be had
  — which is why an unreliable network costs a player nothing but freshness.
  `match_players` is a row per player, so three to seven in a room needs no new
  shape.
  **The room answers back** (`SFX`): every button in the game plays a short `tap`
  on `pointerdown` (one delegated listener; the board's arrows are not buttons,
  so they keep their own shot), a player arriving plays `join` and a buzz, one
  leaving plays `left`, the last three seconds of the clock `tick`, and the board
  being dealt plays `go`. All of it goes through the same `beep`, so the sound
  switch silences the lot. The countdown is counted down on the device between
  polls and pulled back to the server's number whenever the two drift two seconds
  apart, which is what a backgrounded tab does to it.
  **Coming back to a race board puts the player back in the match**, not just back
  on the board: `startLevel` restores the line-up and the progress poll whenever
  `daily.race` has a match on it. It has to live there rather than in `playMatch`,
  because **Try again** after losing your hearts re-enters through `startLevel`
  alone — and used to leave the player on the right board with the line-up hidden
  and nothing reported to the server, which is a match in name only.
  **A time that cannot reach the server is not lost** (`sendResult`,
  `flushResult`): the result is tried three times with a growing pause, and if it
  still will not go it is kept on the device (`aa:v1:pendingResult`) and sent
  again the moment the game is next opened, or when the player taps **Send it
  again**. Only a straight refusal from the server stops the retrying, because
  asking again cannot change that answer — and the card now names the real reason
  (signed out, not your match, gone) instead of blaming the network for
  everything. The server takes the first result per player and no other, so
  sending it twice is safe.
  **Faces** (`faceInner`, `faceClass`, `wireFaces`): a player is their Google
  profile picture where there is one, and their initial on one of eight colours
  picked from a hash of their name where there is not — two players called Ariyan
  and Anik cannot both be a grey A, or the line-up over the board says nothing.
  The picture is stored as a URL only, never copied to us, and `aa_pic` keeps it
  **only when the host is googleusercontent.com over https**, so a token cannot
  talk the game into displaying an image from anywhere else; `img-src` on the
  game page allows that host and no other new one. Google links do expire, so a
  picture that fails to load removes itself and the letter underneath shows
  through. The picture follows the Google account on every sign-in, while the
  name stays the player's to change.
  **Settings** is seven short captioned lists rather than one pile: Account
  (name, purse, sign out — only when signed in), Game (home country, today's
  country, guideline), Sound, Colours, Help, About (with the two legal pages),
  and Starting over, where the two rows that throw something away sit together.
  `renderAccountRow` runs on the first paint and again whenever Settings opens,
  so the account section is there every time rather than only after the dashboard
  has been opened once.
  **The gold badge follows the number, not the other way round** (`goldFit`): past
  nine characters the type steps down, past twelve it steps down again, and the
  name beside it is allowed to give way, so a purse of a billion sits in the lobby
  chip, the dashboard strip and the Settings row without pushing anything off the
  page. The count-up resizes as it climbs.
  The lobby chip (top left, where the daily streak used to be) is the **purse**:
  `renderPurse` fills it from `authLoad` on the first paint and from every
  `setGold`, and it is hidden when nobody is signed in.
  **Leaving a challenge is an option, not an escape** (`leaveMatch`): during a
  match the corner arrow says "Leave the challenge", asks first, and reports the
  board as given up, so the stake stays in the pot and nobody waits a day for a
  player who walked away.
  **A challenge is a run of boards**, so a game takes five to ten minutes rather
  than one or two: the dashboard's "How long" row offers one, three or five boards
  (`LENGTHS` from `/lobby`, the pick kept in `matchLen`), the room card and the
  invite sheet say the shape ("3 boards in a row"), and the server deals the
  boards when the seats fill. In the engine `raceFor(m, boards, bi, …)` builds
  `state.daily` for board `bi` with its own seed (`seed + bi*7919`); the HUD reads
  "Board 2 of 3"; clearing a board that is not the last shows "Board 2 of 3
  cleared!" and moves on with hearts back, while `elapsedBase` carries the
  clock across boards; the progress poll reports `(bi + fraction)/n`; the run
  snapshot carries `bi`, so a device resuming lands on the right board and a
  stale tab jumps forward when the phone is a board ahead (`takeBack`,
  `runAhead`).
  Winning pays off properly and immediately: the win card, the `SFX.win` fanfare,
  gold raining over the card, the purse badge popping and counting up from the old
  balance (`goldRain`, `countTo`), with the canvas lifted above the sheet for the
  duration (`.aa-confetti.is-over`) — all of it the moment the last arrow goes,
  with the other six still playing. For them the poll says the pot is gone once
  (`SFX.taken`, one toast) and rings the winner's circle in gold
  (`.aa-rank.is-won`); their board carries on. Closing the win card drops the
  winner back in the lobby and the gold lands **again** there: the purse chip
  counts up from the old balance, pops, and the coins rain over the whole page
  (`goldRain` lifts the canvas out of the hidden board and on to `document.body`
  for the duration).
  **Deleting an account** releases what it was sitting in first
  (`releasePlayer`): every room that has not started is left properly, so the
  crown passes on and nothing is left pointing at an account that is gone; a seat
  in a match still being played stays, so the pot keeps the size of the stakes
  that went in (`matches.stakes_in`, stored when the match starts rather than
  counted from the players it can still name). A match whose every account has
  since gone is closed rather than swept again.
  The suites in `games/puzzle/tests/` cover the stakes, the room rules, a room of
  seven, the finish-order rule against a shorter clock, the instant payout and
  that it never pays twice, that second place wins a place and no gold, that a 500
  room of beginners gets an easy board while a 7,000 room of strong players gets a
  master one, that no gold is made or lost, and the whole of the
  fills-itself path: the second player starting the clock and a third not
  resetting it, seven starting at once, the clock running out into a match, the
  lonely refund, a dead heat between two players ending with one of them walking
  into the other's room, and an invite-only room being offered to nobody and
  moved by nothing, the handover when a leader walks out, and a room that fills
  itself refusing to be started by hand, and — because the ledger is checked
  against every balance at the end of each suite — that no run of any of it makes
  or loses a single gold. Signing out and deleting the account live in Settings.
- **Home country first** (`homeCountry`, `orderFor`): the first board is the
  player's own country, so level 1 is the United States for somebody in the
  United States and Bangladesh for somebody in Bangladesh, and the tour radiates
  out from there by distance (US → Canada, Mexico, Bahamas…; Japan → South Korea,
  North Korea, Taiwan…). The lobby map marks that first country and pulses it,
  which is why its caption says only how many countries have been discovered and
  nothing about where to tap. `games/geo.php` passes on
  Cloudflare's `CF-IPCountry` (nothing stored); the browser language region is
  the fallback. The tour order is the player's country, then every other country
  by great-circle distance from it (`c` = centroid per level, `a2` = ISO code).
  The first answer is kept in `aa:v1:home` (Settings → Home country changes it,
  "World order" switches it off). Progress is keyed by country id (`lv:<id>`,
  skips likewise), migrated once from the old level-number keys; the
  daily board is picked from the canonical list so everyone gets the same one.
- **Flag boards, tried and removed**: the same generator on a plain 4:3
  rectangle leaves half the free arrows of a coast outline (Hard 2.6 vs 5.7 at
  the start, Master 4.5 vs 11), but every flag board is the same rectangle, so
  the boards stopped looking like anything. Removed; the numbers stay here for
  the record. The discovery boards above are the replacement: a different
  silhouette per country. Level data keeps `a2` (ISO code) and `c` (centroid) for the
  home-country order.
- **Tightening** (generate stage 3, Hard and up, `TIGHTEN_OF` iterations): a local
  search over head ends after signposting. Flip one arrow to its other end, or,
  when that closes a cycle, also one arrow on its new run, and keep the flip when
  a simulated nearest-free player then sees fewer free arrows (mean over the game
  plus 0.3 × free at the start). Acyclicity is re-checked (Kahn), so boards stay
  solvable. (Measured on the earlier Master boards, with 10-cell snakes and ~90
  arrows: free at any moment 5.0 → 4.1, free at start 11 → 10.)
- **Armed arrows and lane preview** (as in the reference apps): a blocked tap
  costs a heart once and leaves the arrow *armed* (it just turns red);
  after every shot `releaseArmed()` fires any armed arrow whose lane is now clear
  (`shoot(p, true)`: no combo/milestone chatter), one at a time so cascades chain.
  Tapping an armed arrow again costs nothing. Pressing and holding an arrow for
  260 ms (`peek()`) draws its lane, green if it can go and red if not, and marks
  the arrow; the next tap anywhere clears it (`clearPeek()`). Taps are handled on
  pointerdown/pointerup with a 12 px move tolerance; keyboard: Enter/Space tap,
  L peeks. Lanes live in the `.aa-lanes` group above the pieces.
- **Legal**: the game has its own `puzzle/privacy.html` and
  `puzzle/terms.html` (what is stored on the device, Google Analytics, fonts,
  permissions, children, playing without an account), linked from the welcome gate
  and Settings. Clearing the site data wipes every `aa:v1:*` key; Settings →
  Delete account removes the account copy.
- **First open / launch**: `#aaGate` (welcome, Terms + Privacy links, Accept,
  stored in `aa:v1:welcomed`), then `#aaSplash` (logo + one line from `QUOTES`,
  rotating per launch in `aa:v1:launches`, tap or 2.4 s to dismiss, skipped for
  `#level-N`/`#daily` deep links and once per browser session).
- **Data**: `games/data/puzzle.json` (112 KB for 168 countries) built by
  `games/build-puzzle-boards.mjs` from world-atlas 110m + Natural Earth 50m
  properties: per country the outline (`d`, in a 100×100 box) and five tier
  scales `k` (cells per unit). The grid mask is rasterised in the browser by
  `rasterise()` (even-odd point-in-polygon at cell centres, specks under 4 cells
  dropped); the build script extracts that very function from the game JS to pick
  each `k`, so boards are identical everywhere. Tiers are sized by land-cell count
  (140/380/620/880/1150 cells — about 40/100/145/180/250 arrows — at most 46
  cells across, 64 tall for tall shapes and 56 wide for wide ones; elongated
  countries such as Chile or Cuba cap out smaller). `TOUR` and `CAPITALS` in the build
  script define the level order and quiz facts. Versioned with `?v=` +
  `DATA_VERSION`; served immutable by `games/data/.htaccess`.
- **Adding countries**: append to `TOUR` and `CAPITALS`, rebuild, bump
  `DATA_VERSION`. Tiers by level index are in `TIER_OF` in the JS.
- **PWA**: `puzzle/app.webmanifest` (and `games/arrow-atlas.webmanifest`, kept so copies installed under the old name update in place); the shared worker
  `piece-the-world-sw.js` also caches this game's files.
- **Tests**: `node tests/puzzle.test.mjs` runs the production `generate()` on
  every level (and 100 random seeds on the hardest tier), checks solvability, full
  coverage, determinism and data shape.

## Do Not

- Do not commit `mail-config.local.php`
- Do not add self-links in explore pills
- Do not create duplicate content across SEO pages (Google penalty)
- Do not add `site-config.js`
- Do not load JS/CSS from a CDN — the CSP only allows `'self'`; vendor it under `js/vendor/`

### Google AdSense (verification only)

Every public page carries the AdSense loader in `<head>`, right after the
opening tag and before the gtag block:

```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-1570944160084395" crossorigin="anonymous"></script>
```

It is there so Google can verify the site. **No ad units, no Auto ads**: there
is no `<ins class="adsbygoogle">` anywhere and nothing calls
`adsbygoogle.push`. The `.htaccess` CSP was widened only as far as that loader
needs: `https://*.googlesyndication.com` in `script-src`, `img-src`,
`frame-src` and `connect-src`, plus `https://*.g.doubleclick.net` in `img-src`
and `https://*.adtrafficquality.google` in `frame-src`/`connect-src` (the
loader's beacons and its invisible traffic-quality frame). Turning ads on later
needs more hosts and a privacy-policy update, not just an `<ins>` tag.

