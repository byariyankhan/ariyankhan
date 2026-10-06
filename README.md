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
directories unreachable over the web. Markdown files (every `README.md`,
any case) are a 404 on the web too: they are notes for this repository, not pages. Behind that proxy Apache only sees plain
HTTP, so its own slash redirect for a folder (mod_dir) answers `http://`: the
game's bare `/puzzle` therefore has a rule of its own that goes straight to
`https://…/puzzle/`, one hop, like the old `/arrow-atlas*.html` addresses.

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
| `ai-metadata-remover/` | AI Metadata Remover, its own product like `puzzle/`: `index.html` (the tool), `how-to-use.html`, `about.html` (About & FAQ), `privacy.html`, `icon.svg`, `og.png` — see "AI Metadata Remover" section below |
| `js/ai-metadata-remover.js` | The byte-level JPEG/PNG/WebP metadata stripper + page UI (no server, no upload) |
| `css/ai-metadata-remover.css` | The tool's whole look, self-contained (no `style.css`): header, drop zone, result cards, guide pages, footer |
| `map-maker/` | Map Maker, its own product like `puzzle/`: `index.html` (the tool), `how-to-use.html`, `about.html` (About & FAQ), `privacy.html`, `icon.svg`, `og.png` — see "Map Maker" section below |
| `js/map-maker.js`, `css/map-maker.css` | Map Maker engine (d3-geo projections, export, share links) + its whole look, self-contained (no `style.css`) |
| `puzzle/sw.js` | Puzzle's service worker, scope `/puzzle/` (offline boards, installable, web push). It replaced the root `piece-the-world-sw.js`, which `js/puzzle.js` unregisters where a device still has it (`swStart`) |
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

**The 4 main pages are the only service pages:** `talking-head-video-editing.html`, `documentary-video-editing.html`, `short-form-video-editing.html`, `map-animation-video-editing.html`

Everything that used to live under `/service/` (the 20 audience and SEO landing
pages and the folder's index) was deleted after AdSense rejected the site for low
value content. Each old URL 301-redirects, in one hop, to one of the four; the
rules are at the top of `.htaccess`, the full map is in `service/README.md`, and
`tests/service-redirects.test.mjs` checks both. Don't add service landing pages
back, and don't link to a `/service/` URL.

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

Piece the World, the geography jigsaw (`piece-the-world.html`, its JS, CSS,
manifest, test, `games/build-data.mjs` and the continent level data in
`games/data/`), was removed on 30 September 2026. `.htaccess` answers its old
addresses with 410 Gone, and the files were deleted from the live document root
with the `web-prune` ops mode (`deploy/retired-files.txt`). Its service worker file, which had become Puzzle's, moved to `puzzle/sw.js`.

---

## Review Card (Client Testimonials)

Single auto-rotating testimonial card. Live on the 4 main service pages
(`talking-head-video-editing.html`, `documentary-video-editing.html`,
`short-form-video-editing.html`, `map-animation-video-editing.html`) — each
showing that page's own niche reviews — and on `index.html`, which shows a
shuffled mix pulled from all 4.

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

## Two tools with identities of their own

Map Maker (`/map-maker/`), AI Metadata Remover (`/ai-metadata-remover/`), AI
Image Checker (`/ai-image-checker/`) and Travel Map (`/travel-map/`) are built like Puzzle: each is its own product, not a page of the portfolio. Each
folder holds the tool, a How to use guide, About & FAQ and Privacy; each has its
own logo (`icon.svg`, also the favicon), share image (`og.png`), colours, fonts,
header and footer, and loads only its own stylesheet. **The home page is the tool and
nothing else**: a title, then the tool (Map Maker shows countries, projection, region,
canvas, style presets and Download PNG, with everything else under "More options";
the remover is one Upload button and a Download per image; every file is cleaned with everything removed, the report details stay hidden).
The guide pages sit behind one settings-style icon in the header, like the game's. **No `<site-nav>`, no
`<site-footer>`, no `css/style.css`, no sales sections**: the footer's one line
"made by Ariyan Khan" is the only tie to the site.

| | Map Maker | AI Metadata Remover |
|---|---|---|
| Look | old atlas: paper `#F4EEE2`, sea blue `#1F5F8B`, ochre | clean lab: white, teal `#0B8A7A` |
| Type | Fraunces + Inter | IBM Plex Sans + IBM Plex Mono |
| Stylesheet | `css/map-maker.css` | `css/ai-metadata-remover.css` |

**AI Image Checker** (indigo `#4F46E5`, Inter + JetBrains Mono, `css/ai-image-checker.css`) reads an
image's metadata and says what it shows about how the image was made: an AI generator named in it, C2PA
Content Credentials (and the app in their `claim_generator`), the IPTC AI source type, Stable Diffusion
prompts, and EXIF camera, date and GPS. It loads `js/ai-metadata-remover.js` first and uses its parsers and
`SIGNATURES` through `window.AMRCore`, so the two tools always agree on what a file holds; add a generator
there and both learn it. Keep its wording honest: a clean result is "no AI metadata found", never "real".

**Travel Map** (`/travel-map/`; paper `#F7F3EA`, teal `#1E7A72`, coral; DM Serif Display + Inter;
`css/travel-map.css`, `js/travel-map.js`) is a "states I've visited" map maker aimed at readers in the US and
Europe. `/travel-map/` is the hub: every map, grouped (world and continents, countries by region, United States), and the logo on every page leads there; it also forwards old `/travel-map/#r=…` share links to the right map. The USA states map is `usa.html`. Each page's menu is its own: all maps, that map's RELATED maps, then the guides. Every map is its own page, with no tabs or region switcher on it; a "More travel maps" block under each tool links to the most related maps (RELATED in the generator), which is how readers and search engines move between them. The first three pages, each targeting its own search, were: `/travel-map/` (the 50 US states, AlbersUSA, from
`js/vendor/us-states-10m.json`, us-atlas, Census borders), `europe.html` (46 countries: the UN's 44 plus Cyprus
and Turkey, with Kosovo markable but counted on its own line) and `world.html` (195: the 193 UN members, the
Vatican and Palestine; territories and disputed places are markable and counted separately; Tuvalu is too small
for the 50m data and is list-only). `national-parks.html` tracks the 63 US national parks as dots on the
US map, from `js/data/national-parks.json` (id, name, states, year, lat/lon, one-line "known for"); the same
file builds the page's table of all 63 and its counts (most parks by state, oldest, newest), so the table,
the map and the prose cannot drift apart. American Samoa and the Virgin Islands, which AlbersUSA cannot
place, sit in two labelled boxes off the East Coast. The continents (`asia.html` 48, `africa.html` 54, `north-america.html` 23,
`south-america.html` 12, `oceania.html` 14) count the countries in `CONTINENTS` in `js/travel-map.js` and let
territories and disputed places be marked on their own line; Turkey and Cyprus are on both the Europe and Asia
maps. Countries too small to click at a map's scale get a dot (on the world map only the tiniest), so every
listed place can be marked from the map except Tuvalu, which the 50m data cannot draw. Countries by region (`canada.html` 13, `australia.html` 8, `uk.html` 12 = England's nine
regions plus Scotland, Wales and Northern Ireland, `germany.html` 16, `japan.html` 47, `mexico.html` 32, `brazil.html` 27, `spain.html` 17 + Ceuta and Melilla on their own line (property `extra`), `italy.html` 20, `france.html` the 13 European regions, `china.html` 31 + Hong Kong and Macau as `extra`, `south-korea.html` 17, `argentina.html` 24, `portugal.html` 18 districts + the Azores and Madeira as `inset`, `netherlands.html` 12 (Caribbean Netherlands left out), `switzerland.html` 26, `austria.html` 9, `poland.html` 16, `ireland.html` the Republic’s 26 counties, `sweden.html` 21, `new-zealand.html` 16 (Chatham and outlying islands left out), `colombia.html` 33 with San Andrés as `inset` and Malpelo left out, `south-africa.html` 9 with the Prince Edward Islands left out) use Natural Earth 10m admin-1
borders, filtered, dissolved and simplified with mapshaper into `js/data/admin1/<country>.json` (12–28 KB each,
object `regions`, properties `id` and `name`); each page's table of regions is checked against the names in its
file. The Canary Islands are moved closer in the data (+4° lon, +7° lat) and carry `inset`, which draws a dashed frame; Spain's file skips mapshaper's `-filter-slivers`, which would delete Ceuta and Melilla. India is left out for now: Natural Earth draws Kashmir along the line of control, not India's official
border, which Indian readers and Indian law treat differently. A click marks a place Visited or Want to go; marks live in localStorage
(`travel-map:v1`) and in the share link (`#r=us&v=06.36&w=02&t=Title&th=night`). Download makes a PNG card with
the title, the count, a legend and `ariyankhan.com/travel-map`, sized 1080×1350, 1080×1920, 1080×1080 or
1920×1080. Keep the counts and their wording neutral: the totals are stated, never "all the countries".

The old `map-maker.html` and `ai-metadata-remover.html` (and the bare folder
names) 301 to the folders in one hop from the top of `.htaccess`. Script, data
and stylesheet paths in these pages are root-absolute, because the pages are one
folder deep. `tests/tool-identity.test.mjs` guards all of it.

## AI Metadata Remover

A free, in-browser tool that removes AI/provenance metadata from images, with a
guide (what it removes, generator table, how to verify), About & FAQ (`FAQPage`
schema) and a privacy page. Listed in `sitemap.xml`, `llms.txt` and `llms-full.txt`,
linked from the site footer and the homepage's games and tools section.

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

## Map Maker

Highlight countries in colour
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
- **Swatch colours** are set from `data-color` by `paintSwatches()`: the CSP refuses a `style=""`
  attribute in markup (it left every colour square blank), but a CSSOM write is allowed.
- **Rule**: keep the disputed-borders FAQ honest (Natural Earth de facto policy)
  and never call the maps "official".

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
level on Easy and Normal, 3 hearts and 2 hints on Hard, 2 hearts and 2 hints on Expert, 2 hearts and 1 hint on Master (`LIVES_OF`, `HINTS_OF`: the top tiers are meant to be lost and taken again), difficulty that follows the player and never the level number (one
grade 0–14 lives in `aa:v1:form` as `{grade, tier}`: three grades a tier (0 Easy / 1 Normal /
2 Hard / 3 Expert / 4 Master, `tier = floor(grade / 3)`, written alongside for an older client),
and within the tier which of the board's candidate deals is dealt (`grade % 3`: 0 the widest, 1 the
middle one, 2 the narrowest, `bestBoard(mask, tier, seed, pick)`); `nextForm` moves it on every tour
board: **any clear, however many tries it took, is the next tier at its easiest deal** (Hard → Expert → Master;
on Master the next, harder deal), a heart-out holds the tier (Try again is the same board), and **every second
heart-out on the same board is a tier down** (`fails % 2 === 0`), so the New layout the card offers is a step
easier; a clear down there goes back up. Hard is the floor after the first two boards (`GRADE_FLOOR`), and there
is no count of boards to wait out before Expert (`GRADE_CAP` only holds the first two boards to Normal). The
Focus bar still reads the run but no longer moves the tier (`clearPoints` is kept for the scene breather). In
the simulation in `tests/puzzle-habits.test.mjs` a casual player fails about 62% of tries, an average one 53%
and a strong one 39%, and most clears are on Expert and Master: hard on purpose. A form from before grades is read
as its tier's hardest deal (`gradeOf`: `tier * 3 + 2`). Easy and Normal are dealt on the first two boards only: from the third board on nothing is
dealt below Hard's easiest deal, grade 6 (`GRADE_FLOOR`), and a heart-out stops there. A new player is never dealt past Normal before
2 boards are cleared nor past Hard before 12 (`GRADE_CAP`, on `boardsDone()`), and the ladder itself
is held there (a higher grade from elsewhere — the account, the old ladder — is left as it is by a win
under the ceiling). A race and the daily board are always the hardest deal, so a shared board is the same
board for everyone, and the pace line is shown only for a hardest deal. A board left mid-play is dealt
again at the deal its kept run was played at (`keptDeal`), whatever the ladder did since, so a heart-out,
a free life and leaving still carry on where they were;
`TIER_OF()`; Try again keeps the same board, New layout takes the new grade; the
tier is shown only on the Next button and in the start toast; the win card says nothing more about it), combo counter (taps within 1.8 s), a win streak (still counted, no longer
announced on the card), milestones every 10 levels (the Today's Country daily board is gone: an old `#daily` link opens
home, and records already kept stay), and clearing the board reveals the country for a
3-option quiz plus capital/population/region. 197-country World Tour (every UN member state, plus Palestine, the Vatican, Kosovo and Taiwan: world-atlas 110m plus the 29 small states from the 10m file, minus dependencies and disputed areas) with sequential
unlock (Skip for now from the third heart-out on a board), stars, best times and progress in
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
- **Hard, Expert and Master are big and tricky everywhere**, the way Italy's were by luck of its shape:
  the grid is drawn finer (`KSCALE_OF` 1.5/1.65/1.8 within `CELL_CAP_OF` 900/1100/1300 cells and a
  `SIDE_CAP` of 72), so Hard boards are ~110 arrows (were ~50), Expert ~130, Master ~145; snakes run to
  14/16/18 cells (`MAXLEN_OF`); every end points at something (`NARROW_OF` 1) across a gap (`FAR_OF`
  .9/.95/.98); lanes of up to 4/5/6 empty cells (`LANE_OF`, `HOLE_OF` .2) sit between arrows and their
  blockers; the tightening runs 400/500/600 iterations (`TIGHTEN_OF`) and its objective now also pays for
  **traps** (`TRAP_OF` 3/4/5, `trapw` in `generate`): arrows with two or more empty cells before the piece
  that blocks them, which look free at a glance and cost a heart. Measured with `scratchpad/hardness.mjs`
  (a nearest-free-arrow player over all 197 countries): Hard 111 arrows, ~3.3 free at any moment, a fifth
  of the remaining arrows a trap; Master 144 arrows, ~3.7 free, 22 % traps. Long thin countries (Chile,
  Japan) stay smaller because the long side is capped for the phone.
- **Board choice**: `bestBoard()` generates `CANDIDATES_OF[tier]` boards (4/6/8/8/6)
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
  the `push` handlers at the end of `puzzle/sw.js`, and the switch in
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
  day streak — the one streak, days with a board cleared or a training round
  scored, not days they opened the daily board, which is what it counted at first
  and why somebody a hundred boards in was told zero; it counts only while it is
  alive, played today or yesterday (or the day before, with a freeze to cover
  yesterday: `streakNow`), because nothing decays the stored record; all three counted in
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
  finer and busier as they get better. **The brain carries a rank** (`RANKS`,
  `arrowsShot`, `rankOf`), and the rank is earned in arrows: every arrow shot off a
  board the player cleared, on the tour or on the daily, summed from the `lv:` and
  `daily:` records the tour already syncs (`arrows` on each; a record from before
  boards remembered their arrows counts as a typical board of its tier,
  `ARROWS_GUESS`). So a phone and a tablet agree on it, a fresh device gets it back
  with the account, and clearing the same board twice does not count it twice.
  Fourteen titles: Newbie 0, Starter 160, Learner 480, Thinker 1,000, Solver 1,800,
  Skilled 2,800, Sharp 4,000, Ace 5,600, Mastermind 7,600, Genius 10,000, Grandmaster
  13,200, Legend 16,800, Immortal 20,800, **GOAT 25,000** — most of the tour (nearly
  300 boards, about a hundred arrows each from Hard on). No title shares a name with a
  difficulty: Normal, Expert and Master used to, and "Expert" beside a Hard board said
  two things with one word. The brain fills with the arrows of the
  rank in hand, **from the bottom up**, and GOAT lights the lot in green. Under it:
  the rank name and, under it, `Level n` — two words and no more; how far the next
  rank is, the brain itself shows, and the card after a board says what it added
  or cost. The rank is the headline and it is not the level — a level says where
  a player is on the tour, a rank says what they have done. **A rank is earned
  and kept:** a board cleared adds its arrows — the most it has ever paid, so a
  replay at a lower tier takes nothing away (`recordFor`; the server keeps
  `GREATEST(arrows)` too) — and a board lost takes nothing any more (`lossFor` is 0).
  It used to take some of the arrows still on it: only on the first loss since the board was started fresh
  (a retry of a board being fought for costs nothing more), never on a board already
  cleared, never on the daily board or in a race, at most half the board and never
  more than the rank holds (`loseArrows` clamps, so nobody owes arrows). The loss is
  **held** while the card still offers a free life (`holdLoss`, `lossHeld`): "Get a
  free life" carries the board on and gives the arrows back (`forgiveLoss`); Try
  again, another board or home takes them (`settleLoss`, also at the next start if
  the app was closed on the card). Held rather than taken and given back, because
  what was taken is kept per device
  (`loss`: device id → arrows, `lossMap`/`loseArrows`) and synced in the state
  blob: a device's own count only grows, so devices merge by the larger per
  device (`adoptTour`) and the total is the sum — a single shared number could
  not have been merged, and a refund would be undone by the next sync. The
  hold, settle and per-device count stay for a loss held before the change, which is
  still taken once; nothing new is held, so the out-of-hearts card has no rank line. Offline play counts the same and goes
  up with the next sync once the player is online and signed in. The win card
  has no rank line (it used to say `+N arrows · Rank`); the arrows still count and
  the brain on home shows the rank. The share text names the rank.
  Redrawn only when the tier or the lit count changes (`brainKey`), and the fade-in
  wave is skipped under `prefers-reduced-motion`.
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

- **SEO**: the head names what the game is today: Daily Training's four rounds by
  their names in `TRAIN_ROUNDS` (Restore the Canvas, The Forgery, Gallery Memory,
  The Curator's Eye) and the arrow puzzle on 197 countries. Title at most 60
  characters, description at most 160, a short keywords list of real phrases, Open
  Graph/Twitter card `images/puzzle-og.jpg` (1200×630, drawn by
  `games/build-puzzle-og.mjs`; the app icon by `games/build-puzzle-icon.mjs`).
  Every self-reference is `https://ariyankhan.com/puzzle/` **with the slash**
  (canonical, og:url, every JSON-LD `@id`, the breadcrumb, the sitemap), and the
  root `.htaccess` sends the bare `/puzzle` there in one https hop (mod_dir's own
  slash redirect answered `http://` from behind the proxy). No hreflang: one language.
  One JSON-LD block: WebPage, VideoGame + WebApplication (SinglePlayer and
  MultiPlayer, "nearly 300 boards", no ratings) and BreadcrumbList. There is
  no MobileApplication node and no "Android app" wording until the Play listing is
  public. The words a crawler reads are in the static HTML but nothing sits under the
  game: Settings > About links two pages of their own, laid out like the policies:
  **`/puzzle/about.html`** ("About Puzzle & FAQ": what Daily Training and the arrow
  puzzle are and six questions, with the FAQPage quoting them word for word) and
  **`/puzzle/how-to-play.html`** (the rules: arrows, hearts, hints, stars, Daily
  Training, streak, matches). `tests/puzzle-seo.test.mjs` fails if the FAQ and its
  FAQPage drift apart, if a round is renamed in `TRAIN_ROUNDS` without the pages
  following, or if a removed round comes
  back in the copy. A `<noscript>` line says the same in one sentence. The gate, the
  splash, the sign-in sheet and the session and developer groups carry
  `data-nosnippet`, so interface text is never the search snippet. The homepage has a
  "Games" section linking both games; `llms.txt` and `llms-full.txt` describe the
  game; sitemap priority 1.0. No hidden text, no bot-only markup, no health or
  memory-improvement claims: the Brain Score is a game score.
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
  in Settings > About, a Credits row that opens to the licence text (`.aa-about-credit`); nothing sits under the game any more, so no screen scrolls past its end) traced to one silhouette with potrace at 240 px, flattened to
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
  harder** than the player's form (`gradeFor`: three grades up, the same deal within the tier), so a Hard player
  meets The Tower at Expert (~140 arrows) and an Expert player Twin Towers at Master
  (~160); it says so as it starts ("One step harder: this scene is Expert."), and the
  board after it, cleared or skipped, is a **breather**: the easiest deal of the
  player's own tier (store `breather`, spent by the next new clear). There are 49 scene slots and 12 scenes, so the list comes round again, and
  **every lap is a board of its own**: the first lap keeps `s:<id>` (the clears already
  made stay valid), later laps are `s:<id>~2`, `s:<id>~3`, … (`sceneLevelFor`). One id in
  four slots used to count one clear as four levels and leave every scene slot after
  country 48 already cleared. Whatever looks the board up — its shape (`maskFor`), its
  stats (`countBoard`), the pace comparison, a shared `#b-` link — drops the lap
  (`baseId`); the record keeps the full id, and a `#b-s:<id>~N` link a tour does not
  have opens the scene itself. `tests/puzzle-levels.test.mjs` replays `tourFor` on the
  data files and checks every id is unique. The result card has no fact box and no
  YouTube line, as on focus boards, and the HUD reads `Level N` with `The Tower · Expert`
  on the line under it (in the big type the name was wider than a phone).
- **The board flow** (September 2026): a win is kept the moment the last arrow goes
  (`winLevel` → `keepWin`: the record, the ladder, the stats, the streak, the sync and
  a race's time); only the card waits the 700 ms of confetti (`showResult(run)`, drawn
  from that snapshot, on `state.resultTimer`, which `clearRun` and `startLevel`
  cancel). Back during the confetti used to save a 0-second, 0-arrow clear, step the
  ladder up for it and drop a race's time. A replay never promotes the ladder
  (`learnFrom` is told the board was cleared before). A board's record is its best
  run's time, stars and tier, the most arrows it ever paid, and its first clear's
  time (`recordFor`, and `mergeRec` for what a sync brings back). **A tour board is
  kept as it is played** (`keepRun` on every move, `run:<id>`: tier, seed, arrows gone,
  hearts, hints, checks, clock, retries): leaving it or the app being killed carries
  on from there when the same board is dealt at the same tier and seed (`resumeRun`;
  anything else is stale and deleted), so leaving on the last heart no longer
  refills them; a lost board's run goes (the free life keeps it again), Try again
  starts fresh, and the daily board, races and replays are not kept. The leave
  question says so. A board the generator cannot draw is drawn from the next seed,
  then a tier down, and then a card says so with a Back button (`dealSafe`,
  `boardFailed`); the last board drawn is kept, so Try again does not draw it again
  (`dealBoard`, a copy per deal). The pace comparison takes Master too (tier 0–4).
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
  opening's brain turns to the rose (`--mark-to`) as its line types, everywhere but Night. There is no
  separate Brain theme: the brain is in Paper.
- **The out-of-hearts card, as drawn:** how close it was, honestly — a bar and "91% cleared · 12 arrows
  to go" from the board's own counts, rounded down (`.aa-fail-bar`, `.aa-fail-lead`); then "Get a free life"
  first and biggest, orange with the play icon
  and an AD pill on the right when it is a real advertisement (no pill in free mode); "Try again" under it
  in a soft rose tint (`.aa-actions--out`, `.aa-btn--big`, `.aa-btn--soft`, `.aa-ad-pill`). On a tour
  board, from the second heart-out on it, **New layout** (the `shuffle` action: the same board dealt anew at
  the grade the ladder has just stepped down to, its tier named under it), and from the third **Skip for
  now** (the `skip` action: the slot after it opens, the board stays on the map to come back to), side by
  side under them (`.aa-actions--alt`); the corner arrow is the way back to the tour. A challenge keeps
  "Give the board up". The home buttons carry no subtitle: the icon says it.
- **The tutorial** (`COACH_STEPS`, `coachStart`, `#aaCoach`): on the first board somebody opens, five
  things one at a time, each under a spotlight cut out of a dark scrim by one enormous box-shadow, with a card
  at the bottom and Skip on every step. Step one glows a free arrow (`.is-coach`, the hint's glow) and
  waits for the tap (`coachShot` from `shoot`); then the hearts and what a blocked arrow costs, the lamp, the
  press-and-hold check, and what clearing the board does. The layer lets taps through, so the board is playable
  under it. The numbers are the board's own (`livesFor`/`hintsFor` of its tier, `CHECKS_PER_LEVEL`: "Two
  hearts on this board" on Expert), and the last step calls the lifeline an ad only where one plays
  (`ads.isAd()`: "take a free life" on the site, nothing at all where the offer is off). Step one's arrow is
  a free one clear of the card (`coachPick`; failing that the card moves to the top), and the hole is cut round
  the arrow's own cells, not the lane it flies out along (`pieceRect`). Shown once (`coached`), and counted as
  seen only when it is finished, skipped (Skip, Back, Escape) or the board is cleared under it: a board lost or
  left with it open brings it back on the next one. Never in a race or on the daily board. Settings → Help →
  "Show the arrow tutorial again" brings it back on the next board; "Show the Daily Training tips again" sets
  every round's `trainHow:<id>` to 0.
- **Every tutorial card, shared rules** (`spotOn`, `closeTutorial`, `toast`): the spotlight and the card are
  measured in the page's own frame (`rectOf`), so a phone browser held sideways — the page turned back upright
  — gets the hole on the thing; they are placed again a frame after a resize or a turn, after a zoom or a pan
  on the board, and after a scroll. The card is at the bottom unless that covers the thing, then at whichever
  end covers less (`.aa-coach.is-top`), and on a short screen (under 640px) it is a little smaller. Android's
  Back and Escape close an open card first — the home tour, the board's, a Daily Training round's — the way
  Skip does, before any sheet, "Leave this board?" or "Leave this round?". A toast raised while a card is open
  goes over it (`.aa-toast.is-over`, z-index 116, under a question's 120), at the other end of the screen. The
  step text is a polite live region and Next takes the focus. A sync that brings cleared boards to a phone
  marks the arrow tutorial seen, and a round with a score its tips (`adoptSeen`), unless they were asked for
  again in Settings.
- **The home tour** (`HOME_TOUR`, `tourStart`/`Show`/`Next`/`Place`/`End`, `.aa-home-tour`): the first time
  the app is opened on a phone that has played nothing (no `lv:`, `skip:`, `daily:` or `train:` record), the
  home screen is walked round once in the same spotlight and card: the brain, the world tour (the deck turned
  to each, and held still meanwhile), Daily Training, the league chip when it is showing, Play with Friends,
  Settings, and Play & Discover, whose "Let's play" starts the first board, where the arrow tutorial takes
  over. Its own layer on `document.body`, like the training coach. Only in the app (`shell.on`) on its own;
  Settings → Help → "Tour of the app" replays it anywhere, the website too (on a board it says it will start
  back on the home screen, and does). It waits for the opening to be over: the `aa:opened` event, or a poll
  every 400 ms for up to 30 s (a clock that stands still while the terms or the phone's notification
  question, `push.asking`, are open) for a drawn home screen with nothing over it (`homeFree`, which also asks
  the page what is under the header). Once (`homeTour: 'done'`): finished, skipped, Back, or walked out of
  into a sheet or a board. A header that changes under it (the league chip, the purse, a face) moves the
  spotlight (a `MutationObserver`), and on a short screen the page is scrolled by as little as clears the card.
- **The brain has a rank** (`RANKS`, `arrowsShot`, `rankOf`): Newbie to
  GOAT at 25,000 arrows, fourteen titles, earned by the arrows on cleared boards and never taken away, synced with the account, and separate from the level — see "The brain on the home screen"
  above. Under the brain: the rank and `Level n`, nothing else.
- **The home corner is the player** (`renderHomeCorner`, `.aa-home-face`): signed in, the settings button
  in the top-right corner shows the player's own picture (their initial without one) and still opens
  Settings; signed out, the settings mark.
- **The dashboard asks one thing less:** no "How long" (a match is one board, `matchLen()` is 1; the
  server still plays longer ones), and the list under the tables is "Recently played".
- **Every button is the brain's colour** (`.aa-btn`: the rose-to-coral gradient of Play & Discover, white
  text), the table tiles (`.aa-stake`) carry the same rose in their wash and edge, and the dashboard header
  is one row: the picture, the name, the gold to its right (`.aa-me-id`). "Get a free life" stays orange.
- **The app asks for notifications once** (`notifyFirstAsk`): the phone's own dialog, once (`pushAsked`);
  the answer is kept, and the switch in Settings stays. Never on the way in: it used to be the moment the app
  was up (Accept, and a timer at boot), over the opening; see "The opening". It is asked **after the first
  result** instead (`askAfterResult`: 1.2 s after a board's result card or a training round's result, and
  only while that result is still on screen), the first moment a reminder has something to remind about.
  Browsers are never asked unprompted. **No card before a system dialog**, in the app or the browser: the
  switch is the question.
- **Buttons carry the logo's brain** (`.aa-btn::after`: the white mark, faint, on the right, as Play &
  Discover does). **The home brain's arrows are always the rose** — GOAT is the whole brain lit, not a
  green one — and **lit arrows keep moving** (`aabrainflow`: a small step along each arrow's own direction
  and back, each on its own beat, off under `prefers-reduced-motion`).
- **Daily Brain Training** (`TRAIN_ROUNDS`, `openTrain`, `trainSave`, `#aaTrainSheet`, `.aa-train-*`): an icon
  in the top bar (`#aaTrainBtn`) with a pill (`0/4` today, or the day's score in green). Four rounds a day,
  each scored 0-100, the day's **Brain Score** their mean. (The arrow board was a fifth round for a while and
  is not any more: the daily board is its own thing.) **Every round is free once a day** (`trainFree`, `train:<day>.pp`
  per round and `p` in all, counted when a round starts), then locked for the day; playing it again is an
  advertisement the player chooses (`adOffer('trainplay')`, free where advertising is off) — the button says
  `Play · AD` for a round already started today. A round is played **full screen** (`trainScreen`: the sheet takes
  `aa-sheet--page`, the lobby is gone, the board music comes on with `musicBegin` and goes with the round).
  Every round carries a **long game**: a 30-day and then a 90-day challenge (`TRAIN_GOALS`, `trainRun`:
  consecutive days that round was played, ending today or yesterday), a bar under the round in the list. The
  painting's credit after a round sits behind a `?` (`data-train-info`), and so does the sheet's own
  explanation (`data-train-about`). The rounds are cards with **drawn icons** (`TRAIN_ICON`: line marks in the
  brain's colour, no emoji). **Every round is taught the way the board is** (`TRAIN_COACH`, `trainCoachStart`/`Show`/`Place`/`Event`/`End`): the first time a round is opened, a spotlight (`.aa-coach-spot`) sits on the thing to touch, a one-sentence card sits by it, and where the move is a drag a hand (`.aa-hand`, Web Animations) makes the move over and over until the player does; each step clears itself on the move it asked for (`wait`: `placed`, `found`, `answer`; such a step has no Next, only Skip) or on Next. The coach starts when the round's play does -- after Go and after the look, which is not spent reading -- and its numbers are the round's own level's (`p`, `tierParams`: "Three patches", "time past 1:30", "Three times over"). The card sits at the bottom unless what it points at reaches down into it, then at the top just under the sheet's head, so ← is never under it; a piece being carried sees through it (`body.aa-dragging`). A round played to its end counts as learned, whatever card was up; once through or skipped it is not shown again (`trainHow:<id>`). The three-step text stays behind the `?` beside the round's name (`trainHowCard`; the round holds while it is open, and Back or Escape close it first). **Restore the Canvas is drag and drop** (`canvasDragWire`, `canvasDrop`: pointer events, a carried copy `.aa-art-drag`, the slot under the finger lit `.is-over`, a swap when dropped on a full slot from another slot, `touch-action:none` so a drag never turns into a scroll; a piece dragged out of the frame goes back to the tray. Dragging is the only way a piece moves — the tap-then-tap way is gone, so there is one thing to learn; Gallery Memory is wired through the same `trainDragWire`, and its coach shows the hand carrying the first painting to place 1). **Every round is free once a day** (`trainPlay`, `trainFree`, `train:<day>.pp` counted once the round
  is on the screen, `trainBegun`). Once a round is scored its card, and its result, offer two things: **Play again**, the same puzzle
  for nothing, as often as the player likes, and **Play next**, a new puzzle of the same round (a new painting,
  a new deal: `train:<day>.nx` per round is the serial, moved on once the new puzzle is on the screen) for an
  advertisement the player chooses each time (`adOffer('trainplay')`); where advertising is off (the site) Play
  next is simply free and nothing says AD. An advertisement watched for a puzzle that never came -- the player
  went back or closed the sheet while it played, or the paintings would not load -- starts nothing behind their
  back and is owed (`train.owed`, `trainOwed`): that round's next Play next that day is free and says so. An
  advertisement that did not come says "No advertisement right now. Play again is free."
  Before a round is scored its card has one chip, Play (`trainCardState`, `.aa-train-cta`, `chipAgain`/`chipNext`); the card itself is a
  div with role button, the chips are buttons inside it carrying `data-train-mode`. The line above the list
  (`trainTally`) is "Four rounds, free every day", then "2 of 4 done today · 3 days in a row" -- never "done
  for today" while a round is still to play -- and with all four "Congratulations! Today's brain training is
  done. You can keep training by watching an ad." (on the site, where Play next is free: "…with Play next");
  the result says the same in short ("✓ 1 of 4 done today", "✓ Congratulations! Today's brain training is
  done."), and "Brain Score today" once there are two. With a streak alive and nothing played yet it says "3
  days in a row · play today" in rose. The streak is **the game's one streak** (`playStreak`, `streakNow`):
  a round scored counts its day (`trainSave` → `bumpDay`) exactly as a board cleared does, so the sheet and
  the flame on the home screen say the same number; `trainAll` is the bonus of all four, and the first time
  all four are scored in a day it earns a streak freeze; the per-round bar counts days that round was played, in all (`trainRun`: cumulative). The home pill is
  a dot until something is scored, then the day's Brain Score. In a round and on its result the corner button
  is ← back to the list (`trainScreen`, a capture-phase handler before `closeSheets`; the phone's back button
  does the same in `backPressed`); on the list it is ✕. **The round marks
  are paintings** (`trainIcon`, `.aa-train-art--r/f/g/e`): a canvas with a piece gone, the original beside a
  recoloured copy, three on a wall, one detail through a lens, from picks of their own (salt `icon-<id>`) so
  nothing of the day's rounds is given away; the drawn line marks (`TRAIN_ICON`) stand in until the gallery
  has loaded. **The gallery starts where the player is** (`artRanked`, `TRAD_OF`, `trainDays`): every work carries
  its country (`cc`) and tradition (`trad`: is / hb / ea / we); works are ranked home country → home
  tradition, nearest first → same continent → the rest by distance, and each day draws from a window at the
  top of that list that widens by seven works a training day, so a player in Dhaka begins with Mughal and
  Bengal and reaches Paris in a few weeks. Same home country, same day, same paintings. All four are **gallery
  rounds** on real paintings: 247 works from The Metropolitan Museum of Art's Open Access collection
  (CC0, public domain, every one in colour, nothing unclothed): European and American painting, East Asian
  scrolls, and a hundred Mughal, Deccani, Bengal, Rajput, Pahari, Jain, Persian, Ottoman, Tibetan, Nepalese
  and Burmese works, so the gallery has something near for most of the world, listed with title, painter, date and source in `games/data/art.json` (fetched once,
  `ART_VERSION`, `loadArt`) and kept resized (≤ 800 px, ~13 MB in all, fetched a painting at a time) in `images/art/`, cached forever by
  the worker. **No painting hangs twice in a day** while the gallery has one not yet seen (`artDay`,
  `artMains`, `artOthers`): the day has one order of works -- the player's window shuffled by the day, then the
  works past it, nearest first -- and each puzzle of the day (a serial) takes the next ones in a fixed order
  (the canvas, the forgery, the curator's painting, the gallery's wall), so a puzzle hangs the same paintings
  whenever it is played and later puzzles reach past the window; the Curator's other details come from works not
  yet shown whole that day. Same home country, same day, same history: same paintings. **A round starts as soon as it
  is opened**, once its paintings are fetched and decoded (`artReady`: `new Image()` and `decode()`, at most
  `ART_WAIT_MS` 7 s, "Hanging the paintings…" while it waits -- so no look or clock runs over an empty frame, and
  the Curator's four details all arrive before its painting is shown, where on a slow line the right one used to
  appear first). There is no 3, 2, 1 in front of it: the look's **last three seconds tick** instead (`trainLook`,
  `TRAIN_LOOK_TICKS`: `SFX.tick` and a buzz at 3, 2 and 1 seconds left, once each), the moment before the canvas
  comes apart, the gallery comes down or the Curator's painting goes. **A round holds** (`trainHold`/`trainRelease`,
  a set of reasons behind `train.paused`: the Leave question, the `?` card, a hint's advertisement, the app or tab
  in the background, the "Paused" veil after it): its timers skip, and when the last hold comes off the look's end
  and the play clock move on by the time held, so nothing is counted that was not played. While it is held its
  paintings are hidden (`#aaTrainGame.is-held`), so a look cannot be stretched under a question or a card. Going
  into the background veils the round at once; coming back, "Paused" stays over it a moment (`trainCount(g,
  true)`, `trainVeil`, `.aa-train-count`, `TRAIN_PAUSED_MS`), then the round and the music go on. Every start
  carries a token (`train.run`) checked after each wait, so a round left while its paintings loaded never runs
  behind the list, and a second finger or a round left mid-drag leaves no carried copy on the glass
  (`train.drag`, `trainDragClear`, `lostpointercapture`). A touch is captured by the piece it pressed, and
  handing it to the box takes it off the piece: that `lostpointercapture` is the drag starting, so only the box's
  own counts as an end (read as one, it dropped every piece the moment it moved on every phone). Drags, flights and the coach read the page's own
  coordinates (`ptOf`, `rectOf`), so they are right in a phone browser held sideways. **The round's bar**
  (`trainHud`, `trainStat`) is the level chip, then what is happening now with its mark -- an eye and "Look 3s"
  with a bar draining under the row (`trainLook`), a clock against the allowance ("0:12 / 1:30", `trainClock`),
  "2 of 5 placed", "Question 1 of 3" -- and the Hint, which looks disabled (`aria-disabled`, `trainHintSync`)
  whenever it could do nothing; the round's name and its `?` are the sheet's head (`trainHead`). Every round fits the screen (`trainFit`, run when a round draws and on resize): what a round draws under its line gets the room left below it, read from the layout (offsets up to the sheet, the panel's bottom padding, and a further safe strip, `TRAIN_SAFE`, 24 px, for a gesture bar or a toolbar coming back), and the paintings are as big as that room allows and no bigger, so both halves of the Forgery, the whole frame with its tray (the tray takes five to ten columns, whichever leaves the frame widest, then the pieces biggest, with a 30 px floor under a piece and 36 px under a place in the frame: where even that leaves no room for the whole frame the frame gives way, not the pieces, and on the shortest screens the tray's last row scrolls), the Curator's painting and then its four details are on the glass together, nothing to scroll for. **Restore the
  Canvas** (`canvasStart`) cuts one painting into pieces (`.aa-art-tile`, the picture as a background
  at n × 100 %): after Go the painting hangs whole in the frame for four seconds (`CANVAS_LOOK`, "Look 4s"
  draining in the bar, no dragging), then it comes apart and the pieces tumble into the tray
  (`canvasScatter`, `trainFly`: each piece flies from the slot it hung in to its place in the tray, one after
  another with a small tumble, `SFX.scatter`, nothing under reduced motion) and the clock starts; drag each
  piece home; scored on wrong tries and time over the allowance. A full frame with pieces out of place marks
  them (`.aa-art-slot.is-wrong`) and charges each wrong placing once, the first time the frame is full with it
  (`trainCharge`), so finding them costs nothing more. **The Forgery**
  (`forgeryStart`) shows the painting and a copy with patches wrong in it (`artPatch`: mirrored,
  recoloured, taken from elsewhere in the same work, cycling), each placed where it shows (`forgeLies`,
  `lieSeen`: the decoded painting read small into a canvas, and a spot refused where the copy would differ from
  the original by less than `LIE_SEEN` -- about the flattest fifth of the gallery's spots of each kind -- and a
  patch "from elsewhere" taken at least 1.5 patches away); the clock starts at Go, and finds in a row climb in
  pitch (`SFX.cheer`); tap them in the copy, under the original or beside it,
  whichever leaves the two bigger on that screen (`trainFit` decides and the line says which). **Gallery Memory**
  (`galleryStart`) hangs the paintings numbered for a few seconds, takes them down (the same `trainFly`
  flight, each painting falling from where it hung to where it lands in the tray, `SFX.scatter`), and deals
  them into a tray: the player **drags each one back to its number** (`galleryDragWire`, `galleryDrop`, `galleryDraw`,
  through the same `trainDragWire` as the canvas; a piece dropped on a full place swaps with it, one dragged
  out goes back to the tray). When every place is filled the wrong ones are outlined (`.is-wrong`,
  `galleryCheck`, ten points for each wrong placing, charged once) and the round goes on until all hang right; the hint hangs the first
  wrong one where it belongs and locks it. **Leaving a round is asked about** (`trainBack`, from the corner
  arrow, the app's Back, Escape, and a tap in the margin beside a round on a wide screen): "Leave this round? It
  is not scored, and it starts again from the beginning next time." -- Leave the round / Keep playing, the game's
  own `ask` dialog, as leaving a board is; the round holds while the question is open; from a result there is
  no question. **The Curator's Eye** (`curatorStart`) shows one painting for a
  few seconds, then, several times, four details — which is from it? Each detail is a square of its painting as
  it hangs (`curatorPatch`, `artPatch` with its own vertical fraction), so a wide or tall work is not squashed,
  and somewhere with something in it (`DETAIL_SEEN`); right answers in a row climb in pitch. **Every round gets harder the way the
  board does** (`TRAIN_TIERS`, `trainTier`, `TIER_OF_ROUND`, `tierParams`): five difficulty steps per round,
  not shown -- a player plays for levels, and those are the main count's, below; a day scored 85 or more takes
  the round up a step, a day under 50 takes it down, read off the days before today so the step holds still
  within a day and every device with the same history agrees, and off each day's first finish of its free
  puzzle (`train:<day>.f1`, `trainFirst`), not its best, so a puzzle replayed until it is known by heart cannot
  climb it; a day kept before first scores were is read by its best. Step 1 → 5: the canvas 3×3 → 5×5 pieces
  (allowance 90 s → 200 s), the forgery 3 → 5 patches, smaller and closer in colour, the gallery 5 → 8
  paintings shown for 5 → 4 seconds, the curator 3 → 5 questions with smaller details after 6 → 4 seconds.
  **Training puzzles are not levels**: the main count (`levelNo`, the home card's "Level N") is boards only.
  A puzzle is a round's serial of the day (0 the free one, then each
  Play next), its first clear is kept with its time (`train:<day>.cl`, round → serial → when; `trainSave`,
  `trainCleared`). A clear asks for a
  score of 50 (`TRAIN_PASS`): a round finished under it keeps its score but is no level, and its result says
  "Score 50 or more to clear this puzzle" with Play again first. Play again replays the same serial, so it is
  never a second level, and deals it anew (`trainSalt`: a new shuffle, new lies, new options, a new order on the
  wall, salted with the round's starts that day). A round scored before clears were kept counts its free puzzle,
  at the day's last save. Neither the round's bar nor its result shows a level. The clears sync with the rest of the day (the server keeps
  the union, the earliest time of each: `cleanTrainDay`, `mergeTrainDay`; the first scores `f1` by the lower per
  round, on the account and on the device, `trainMergeF1`). Every round ends with the work's credit (`artCredit`, behind the `?`). Every round has a **Hint**
  (`trainHint`): one free a day (`TRAIN_FREE_HINTS`, `train:<day>.h`, counted on the round's own day), then an
  advertisement the player chooses (`adOffer('trainhint')`, free where advertising is off; the round holds while
  it plays); only when it would do something (`g.canHint`, each round's `hint()` answering whether it acted), so
  a press before Go, in a look or with nothing left to show spends nothing; a hint costs ten points of that round
  (a piece put home and locked, a lie circled, the next painting marked, one more short look). Kept per day
  as `train:<day>` (best of the day per round, `h` hints used, `p` rounds played), pushed in the state blob
  as `train` and merged by the better score per round and the larger `h`/`p`, on the account
  (`combineState`) and on the device (`adoptTour`), so a round played on the phone shows on the website and a
  second device gets no second free round; the streaks merge as runs of days (`mergeStreak`; the freezes held
  are the later day's, the more of the two on the same day), and a push carries
  the last 120 days (`STATE_SEND_DAYS`), 400 after a long gap; the sheet shows the score, seven days of bars and the streak of days
  done. The page's title, description and keywords say brain training first.
- **A sweep for dead and doubled code** (September 2026): gone from `js/puzzle.js` are three icons nothing
  drew, `MODES`, `RUSH_SECONDS`, a second copy of `freeAtStart` (the test has its own), four `el.*` entries
  nothing read, and the `lastRun` record nothing read back; the six fetch wrappers (`authApi`,
  `progressApi`, `pushApi`, `matchApi`, `playersApi`, `leagueApi`) are one `apiCall`, and the phone's
  "let the token go" sequence is one `dropAppToken`. `css/puzzle.css` lost 57 rules for classes no markup
  or script produces (the old about/explore/minis/table/setting blocks, the brain pill, the How long
  options). A scan of every `${…}` in HTML found names and messages escaped or set as text; the session
  cookie is HttpOnly + SameSite=Lax and JSON bodies need a CORS preflight, so cross-site posts do not
  carry it. "Get a free life" is a button like the others now: the brain's colour.
- **Sign-in handed from the browser to the app** (`handoff*` in `js/puzzle.js`, `handoffStart`/`handoffRedeem`
  in the backend's `auth.ts`, `openInBrowser`/`handoffLink` in `MainActivity`): when the app's native Google
  sign-in fails for anything but a cancel — Google says "no credentials" for a build it has not been told
  about, and the same for a phone with no account — the app opens the game in a Custom Tab with
  `?handoff=<nonce>`; signed in there, the page gets a one-use, five-minute code (`POST /auth/handoff`) and
  opens `puzzle://signin?code=…`, which is the app; the app lands on `#handoff=<code>` and trades code and
  nonce for a session (`POST /auth/handoff/redeem`). The nonce never leaves the app, so the code is worth
  nothing to anything else answering the scheme. One button: the app's own way first, the browser by itself
  when that fails. The first notification ask no longer bails on "not granted", which on Android 13+ is
  what a permission never asked for looks like.
  The welcome screen shows the brain mark instead of the old arrows, and **the app asked for notifications the
  moment Accept was tapped** (`notifyFirstAsk` waits for `welcomed`, signed in or not: `notifyInitApp` no
  longer needs an account). No longer on the way in: see "The opening".
- **The invite flow, audited** (September 2026). Fixed: signing in from a challenge link now brings the
  lobby socket up too (`signedIn` calls `authLoad(true)` on both paths), so later invitations reach that
  player; the challenge link survives the app's browser sign-in, which comes back as a fresh page
  (`store 'pendingCode'`, `pendingLink`, good for an hour); the invitation sheet keeps its own `state.invite`
  instead of sharing `state.pendingMatch` with the room the player sits in (whose poll overwrote it, so
  Confirm joined their own room and Mute muted nobody); a player waiting in a room of their own is offered
  "Leave and join" instead of an error; people picked on the dashboard are always invited into a room of
  their own (`open_to_all:false` when there are picks — a public room can be walked into, moved or voided
  within minutes); the lobby socket keeps reconnecting with a backoff up to 30 s while it is wanted instead
  of giving up after four tries; `goldError` and `invitePlayer` name `room_full`, `no_match`,
  `rate_limited`, `not_yours` and `try_later`. Server: `room_full` at the invitation, mute checked before
  racing, and "played together" means a match that started (`players.ts`). Then the two left over: **a phone rings once per room** (`rang:<user>:<code>` in Redis, an hour; the
  ask itself is never refused and reads the same), and **a hidden tab is not "online"**: the page tells its
  socket when it is hidden or back (`live.away`, the `away` message, `online.away`/`isAway` in
  `presence.ts`, kept three hours so a tab closed while hidden stays away), and an invitation to somebody
  hidden rings their phone instead of landing on a tab nobody sees. Still reported before it is known to
  have gone: `reach:'push'`.
- **The evening nudge needs no account.** Notifications are offered signed out too (`renderNotify` no
  longer waits for `auth.user`); a token or subscription is posted with no user, with the device's own
  nudge answer (`remindOn()`, `reminder` in the post, `store 'remind'`), and the 7 pm sweep reaches those
  rows by zone with a note that carries no name (`deviceTargets`, `dailyNote('')`). Signing in posts the same token again and the row takes the account; signing out posts it
  again with none (`notifyRelease`), so the nudge keeps coming while the account's invitations and league
  stop. Backend: migration `017_anon_push.sql` (nullable `user_id`, `reminder` per row), `/push/*` routes
  open to strangers under the address limit, `/push/reminder` by token or endpoint when signed out.
- **The evening nudge fits the evening** (`reminder.ts`, `push.ts`). Nobody who has played today is told
  (`targets`: no `playStreak.last` and no training round scored on the zone's date, from `users.state`).
  What it says fits where they are: a streak still alive (played yesterday, or the day before with a freeze
  to cover it: `aliveStreak`) hears "Your N-day streak ends at midnight"; anyone else what is waiting
  ("Today's four rounds are ready"), never that a streak they no longer have is at stake (`dailyNote(name,
  {kind, streak, tmpl})`, five wordings of each, `NUDGES`, taken in turn per player: the last one used is
  kept in Redis, `tmpl:<id>`, `nextTemplate`). It backs off (`nudgeKind`, counted from the last day played:
  the latest of the streak's day, the last training day and `last_played_at`; for a device with no account,
  the day it last opened the game): every evening for the first three days away, then every third day, one
  last "We'll stop reminding you" note at 15–21 days (once an absence, `nudgebye:<id>:<day>`), then nothing
  until the player plays again. `last_played_at` moves only when a push brought something new — a board, a
  count, a training round, a streak day (`mergeLevels`/`mergeStats` rows moved, `playedIn`) — not on the
  sync every open of the app makes; a delivered push no longer counts as the device being seen.
- **One streak, with freezes** (`bumpDay`, `stepStreak`, `streakNow`, `playStreak`): a day counts when a
  board is cleared (`keepWin`) or a training round is scored (`trainSave`, the round's own day), one number
  for the home screen, the training sheet and the evening nudge. `playStreak` is `{count, last, freeze}`:
  0–2 streak freezes held, earned by the first time all four rounds are scored in a day and by every seventh
  day of a streak, never bought, spent by themselves when the player comes back after exactly one missed day
  (the covered day counts, so the run stays one stretch of the calendar and two devices' runs still join);
  a second missed day ends the streak and keeps the freeze. A **flame and the count** sit in the home bar
  (`#aaStreak`, `renderStreak`), rose while today is still to play, the freezes on its corner; a tap says the
  rule. The result card and the training result say a milestone (3, 7, 14, 30, 50, 100 days) and a freeze
  spent or earned (`streakNews`). Merged on both sides (`mergeStreak`): the freezes are the later day's, the
  more of the two on the same day; commutative and idempotent. On a crowded phone bar (signed in, a streak and
  the league, under 420 px) the gaps close and the league chip shows its trophy only.
- **The build line is hidden where players are.** "Build N" under the credit shows only on localhost or
  in the debug app (`el.build.hidden = !devAllowed()`), the same places the seven taps work; a player's
  Settings ends at the credit line.
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
  'f:<id>', name, d, k, focus: true }`. `tourFor` starts them at the
  **frontier**, right after the last board the player has cleared (`frontierOf`;
  not in front of the first board without a record, which for a player who had
  passed the scene slots added behind them was a hole a hundred levels back), and
  **deals them in among the tour**, one after every two tour boards, until they run
  out: a new player plays the brain, then the home country and its discovery board,
  then the next focus board, and so on (26 abstract shapes in a row used to keep a new
  player off the map and the countries' discoveries for an hour). The ones already
  cleared stay together behind the frontier, so a player who has passed them all
  meets the tour exactly as before. The list is built again on every load and sync, so
  where the rhythm stands is read off the first-clear times (the tour boards cleared
  since the last focus board), and the next board is the same before and after a
  reload; a focus board put off with Skip for now (`focusLater`) comes after the rest. Their progress stays
  on the device (`isLocalOnly`): the account's progress is a list of country ids
  and a board that is not a country has no place in it. They are counted out of
  "N countries discovered" on the map, and the win card gives them **no facts
  line and no YouTube line** — a country has something to tell you when you clear
  it and a lightbulb has not. **Level numbers are the player's own progress**
  (`levelNo`): cleared boards ranked by the time of their first clear (a replay
  keeps it), each id counted once, then the board in hand is cleared-count + 1.
  The list only decides what comes next; a player who cleared
  63 countries before the discovery boards existed is on level 65, not back on
  level 4 because Bhutan's animal sits fourth in their list. A board already
  cleared reads **`Replay`** in the header, with its name under it, never the number
  it was cleared at; a new board reads `Level N` with N the same number as the home
  screen and the training chip (`levelNo(-1)`). A sync that brings clears from
  another device (training included) re-maps the board in hand in the rebuilt list
  and redraws the header at once (`adoptTour`). A board is a milestone when the count
  passes a multiple of ten (`crossedTen`), and the share text uses the number;
  `#level-n` (position in the list) is still read for old links. The win card is deliberately short: kicker, name,
  the subtitle under it (what the find is, or capital, population and region for
  a country, and nothing at all on a focus board), stars, the four stats, the fact box on discovery boards, then Next,
  Play again and Share. No World Tour button: the back arrow in the HUD already
  leads there. The best-time line and
  the paragraph explaining what the player's form did to the next tier were both
  dropped as noise; the record is still kept and the tier still shows on the
  Next button, which names the tier the next board is really dealt at (`tierFor`,
  the rule `startLevel` deals by). Play & Discover, the map's marker and the result
  card's Next all go to the next *open* board **forward from the frontier**
  (`nextOpen`: the first uncleared, unlocked board at or after the slot after the
  last clear, and only when nothing is left ahead the first open one anywhere),
  never to a replay of a cleared one; open boards behind the frontier (scene slots
  added after the player passed them) wait until then. After a win the address
  moves to that next board, so an Android relaunch does not reopen the board just
  cleared. The boards file is loaded with the level
  data, not in the background. The HUD says only `Level n` (or `Replay`); the start toast
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
  in never tops it up, and neither does deleting the account and signing in
  again — a deletion leaves a one-way hash of the Google id in
  `account_tombstones`, and the account made later starts with 0 gold (the
  delete confirmation and the privacy policy both say so). The balance rides
  along in every `user` object and shows on the dashboard.
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
  leaving plays `left`, the last three seconds of the clock `tick` (and pop), and
  the board being dealt plays `go`. The ticks come from whichever clock gets to a
  number first, the one counted here or the server's `countdown_tick` over the
  socket (`fillShow`, `state.ticked`: one number never ticks twice), and at nought
  the card says "Get ready…" while the server's sweep starts the room; `go` is a
  race starting, not a player coming back onto one already run (`playMatch`). The
  same two sounds count in every Daily Training round. All of it goes through the
  same `beep`, so the sound switch silences the lot. The countdown is counted down on the device between
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
  sending it twice is safe. It also takes a clear only once the match has run,
  on its own clock, as long as the fastest honest clear of its boards takes
  (`PUZZLE_MIN_BOARD_MS` a board); sooner it answers `too_early` with when, and
  `sendResult` waits that long and sends it again — the result is kept on the
  device before it is sent, so a reload in the middle still sends it.
  **Gold for an advertisement** (`adOffer`, `adTicket`, `adClaimGold`) asks the
  server for a ticket before anything is shown and claims with it; no ticket (the
  day spent, or the server unreachable) means no advertisement for gold, and the
  toast says why. Without advertising (the web's free lifeline) the gold arrives
  after the few seconds the server holds every ticket for, and the toast says so.
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
- **The opening** (`#aaSplash`; the inline scripts in `puzzle/index.html` and "The opening" in
  `js/puzzle.js`): one surface from the first frame to home, where there used to be a welcome gate, a flash
  of the home screen and a 2.64 s splash with a second, differently placed brain.
  - **The first frame is the opening.** An inline script at the top of `<head>`, before any stylesheet,
    decides it (`openingPlan`: first open, later open, or none) and sets `html.is-opening` (`is-first`) and
    the theme from `localStorage`, every read guarded; `#aaSplash` is shown by that class, never `hidden` in
    the markup, and the home screen is never painted before it.
  - **The brain is the app's splash, continued**: drawn inline, 96 px, dead centre of the layer, in the ink the
    app's splash uses (`--mark`), so the phone's splash hands over to the page without a visible change
    (android/README.md, "The splash"). While the line types it turns the rose of the brain (not with reduced
    motion).
  - **The line types itself**, letter by letter (`typeSchedule` in the second inline script: about 34 ms a
    letter and a breath after punctuation, squeezed into a budget). Every letter is its own span, laid out from
    the start and shown by a CSS delay, so it runs on the compositor while the game's 418 KB script loads; it
    waits for the web font (0.25 s at most). The keys are `SFX.key` (pitch nudged letter by letter), `SFX.space`
    for the return before "— Puzzle" and `SFX.ding` at the end, all quieter than a tap, all put on the audio
    clock at once against the letters' moments, at most one every 45 ms and none on a space. In the app, whose
    WebView lets sound play without a tap, the typing waits up to 0.6 s for the game script so the first
    letter has its key; on the website the typing is silent until a gesture (`soundLive()` never makes a
    context there before one, and never lets a key play late).
  - **First open**: a quote from `QUOTES` (rotating by `aa:v1:launches`) and "— Puzzle" type in 1.8 s at
    most, then the Terms and Privacy sentence and Accept fade in under them on the same surface (on a small
    phone the stage slides up to make room). Accept (`aa:v1:welcomed`) fades straight into home. A tap or a
    key finishes the typing and shows the terms at once. Through a link: the terms, nothing typed, and
    Accept goes straight to what the link opened.
  - **Later opens**: the next quote from `QUOTES` (21 of them, rotating by `aa:v1:launches`) on every open;
    into home once the line has been read and home is drawn, never later than 2.64 s, waits included. A tap or a key goes to home at once. `resumeLive` still cuts it short for a match.
  - **No opening** for a link (`#level-N`, `#b-…`, `#league`, `#m=…`, `#handoff=…`, `?handoff=`),
    a reload in the same session (`sessionStorage aa:splash`), a warm resume (the page is not reloaded), or
    reduced motion (whose first open shows the whole block at once, without typing or keys).
  - **Themes**: night and mint open in their own colours from the first frame, except where the phone's own
    splash was paper (app build 1, and build 2 on Android 12 and older): there the opening stays on that paper
    (`is-paper-first`) and fades into the player's colours.
  - `aa:opened` is dispatched on `window` once, when home is what is on the screen (after the fade, or, with no
    opening, once home is drawn); `#aaSplash` is `hidden` from then on. No notification permission is asked on
    the way in.
  - **The home tour** follows in the app, on a phone that has played nothing (see "The home tour").
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
- **PWA**: `puzzle/app.webmanifest` (and `games/arrow-atlas.webmanifest`, kept so copies installed under the old name update in place); the worker
  `puzzle/sw.js` (scope `/puzzle/`; the requests the game's pages make go through it wherever they point) caches this game's files. It was `/piece-the-world-sw.js` at the root until 30 September 2026: `swStart` in `js/puzzle.js` registers the new one, moves a browser's push subscription to it (same key, posted to the server, the old endpoint dropped) and unregisters the old one; its `ptw-cache-*` caches are deleted when the new worker activates, and the old address answers 410. Opening the game (`openGame`) gives the network 2 s:
  an answer in time is used as before, and after that the cached page is served while the network's answer
  still goes into the cache, so a connection that is up but barely moving no longer holds the app's splash.
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

