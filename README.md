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
| `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, `SMTP_PORT`, `TO_EMAIL`, `SITE_URL` | `mail-config.local.php` (contact form) |
| `WEB_PORT` (default 8081), `SITE_BRANCH` (default `main`) | compose itself |

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
| `arrow-atlas.html`, `js/arrow-atlas.js`, `css/arrow-atlas.css` | Tap-away arrow puzzle game on country maps — see "Arrow Atlas" section below |
| `games/data/arrow-atlas.json`, `games/build-arrow-atlas.mjs`, `games/arrow-atlas.webmanifest` | Its level data (outlines + tier scales for 168 countries; masks are rasterised in the browser), build script and PWA manifest |
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

## Arrow Atlas (tap-away arrow puzzle on country maps)

`arrow-atlas.html` is the second game: the casual, addictive one. It is a
standalone game, not a site page: it does not load `css/style.css`, the nav or the
footer, and has its own look (`css/arrow-atlas.css`: Nunito, cream “paper” theme
plus “night” and “mint” via `data-theme` on `<html>`, picked in Settings or with
the palette button). Home = streak chip, settings, a card carousel (Today's
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
run to the edge is clear, a blocked tap costs one of 4 hearts, no clock (time is still recorded for the result card), 4 hearts and 3 hints per
level, adaptive difficulty (Normal/Hard/Expert/Master by tier; the tour's
`BASE_TIER` is shifted one tier up or down by a skill score in `aa:v1:skill`
that `nextSkill`/`rateRun` update after every board from hearts lost, wrong taps,
hints, retries and seconds per arrow — two clean quick clears step up, repeated
losses ease off; `tierFor`/`TIER_OF`/`LEVEL_DIFF`; Try again keeps the same
board, New layout takes the adapted tier; the result card says why), combo
counter (taps within 1.5 s), win streak, milestones every 10 levels, a Today's Country
bonus board (date-seeded, same for everyone, `#daily`), and clearing the board reveals the country for a
3-option quiz plus capital/population/region. 168-country World Tour (every country in world-atlas 110m minus dependencies and disputed areas) with sequential
unlock (skip allowed after two fails), stars, best times and progress in
`localStorage` (`aa:v1:*`), share text, `#level-N` deep links.

- **Engine**: `js/arrow-atlas.js` (no libraries), styles in `css/arrow-atlas.css`
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
  drawn on the home screen by `renderWorld()`: every country faint, the tour
  countries outlined and tappable (opens that level), cleared ones filled green
  and numbered with their level, the next level pulsing purple. The map fits the
  screen width (bleeding into the side gutters) and the height left over in the
  lobby is split evenly above and below it.
  Features world-atlas leaves without an id (Kosovo) get `n:<slug>` ids in both
  data files. Versioned with `MAP_VERSION`. There is no Restart button in the game any more (back out or
  fail and retry).
- **Lobby layout**: title, the world map (fills the space), Continue, then two
  compact buttons (Today's Country, World Tour n/168 · All levels). The old cards
  carousel and the level-path dots are gone.
- **SEO**: title/description/keywords around "Arrow Atlas", "arrow puzzle" and
  "arrow game"; Open Graph/Twitter card `images/arrow-atlas-og.jpg` (1200×630,
  rendered from `scratchpad/og/arrow-atlas-og.html`); schema.org WebPage +
  VideoGame/WebApplication (alternateNames, keywords, image, PlayAction) +
  BreadcrumbList + FAQPage; the About / how-to / FAQ copy is a visible
  `#aaAbout` section under the app (the settings "How to play" and "About"
  rows scroll to it); the homepage has a "Games" section linking both games
  with keyword anchor text; sitemap priority 1.0 with an image entry.
- **Scale and feel** (matched to the reference apps): boards are at most 32 cells
  across (46 tall / 38 wide for elongated shapes; `TARGETS` 110/240/400/540/680
  cells), so phones show ~12 px cells; strokes are 0.2 of a cell with 0.5-cell
  arrowheads; snakes run up to 7-15 cells (`MAXLEN_OF`). Every tap has feedback:
  pressing thickens the arrow; a blocked arrow lunges forward, hits and comes
  back (`bounce()`, WAAPI) with a thud; a shot arrow lights up with a three-colour
  gradient of three success-green shades that streams along it (`#aaGrad`: a 5-cell
  diagonal period, repeated, slid by SMIL `animateTransform`; static under reduced
  motion); the head rides the body's exact curve so the two never part. Hard boards: ~55-65 arrows, ~3.4 free at any moment, freed arrow
  within two cells of the tap 24%, five or more cells away 44%.
- **Cheers** (as in the reference apps): shots closer than `COMBO_WINDOW_MS`
  (1.8 s) chain into a combo and a wrong tap breaks it; from x3 every shot fires
  `sideBurst(level)` (streamers from both screen edges on the shared particle
  canvas, level 0-3 from `comboLevel`: Good / Great / Amazing / Unstoppable)
  with `SFX.cheer(level)`, a jingle that rises three semitones per level. One
  arrow travelling `LONG_SHOT` (10) cells or more earns a level-0 cheer on its
  own. `fxEmit()` runs one animation loop for every emitter, including the win
  fountain `confetti()`; nothing is drawn under reduced motion.
- **Armed arrows and lane preview** (as in the reference apps): a blocked tap
  costs a heart once and leaves the arrow *armed* (it just turns red);
  after every shot `releaseArmed()` fires any armed arrow whose lane is now clear
  (`shoot(p, true)`: no combo/milestone chatter), one at a time so cascades chain.
  Tapping an armed arrow again costs nothing. Pressing and holding an arrow for
  260 ms (`peek()`) draws its lane, green if it can go and red if not, and marks
  the arrow; the next tap anywhere clears it (`clearPeek()`). Taps are handled on
  pointerdown/pointerup with a 12 px move tolerance; keyboard: Enter/Space tap,
  L peeks. Lanes live in the `.aa-lanes` group above the pieces.
- **Legal**: the game has its own `arrow-atlas-privacy.html` and
  `arrow-atlas-terms.html` (what is stored on the device, Google Analytics, fonts,
  permissions, children, no account), linked from the welcome gate and Settings;
  Settings → Reset progress wipes every `aa:v1:*` key.
- **First open / launch**: `#aaGate` (welcome, Terms + Privacy links, Accept,
  stored in `aa:v1:welcomed`), then `#aaSplash` (logo + one line from `QUOTES`,
  rotating per launch in `aa:v1:launches`, tap or 2.4 s to dismiss, skipped for
  `#level-N`/`#daily` deep links and once per browser session).
- **Data**: `games/data/arrow-atlas.json` (112 KB for 168 countries) built by
  `games/build-arrow-atlas.mjs` from world-atlas 110m + Natural Earth 50m
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
- **PWA**: `games/arrow-atlas.webmanifest`; the shared worker
  `piece-the-world-sw.js` also caches this game's files.
- **Tests**: `node tests/arrow-atlas.test.mjs` runs the production `generate()` on
  every level (and 100 random seeds on the hardest tier), checks solvability, full
  coverage, determinism and data shape.

## Do Not

- Do not commit `mail-config.local.php`
- Do not add self-links in explore pills
- Do not create duplicate content across SEO pages (Google penalty)
- Do not add `site-config.js`
- Do not load JS/CSS from a CDN — the CSP only allows `'self'`; vendor it under `js/vendor/`

