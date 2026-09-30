# ariyankhan.com/blog — Blog Guide

Self-contained blog subfolder. Static HTML/CSS/JS, no build step, no CMS. Every article is a hand-written `.html` file that shares two small CSS/JS bundles.

---

## Why It's a Subfolder, Not a Subdomain

`ariyankhan.com/blog/` — not `blog.ariyankhan.com`. Google treats subdomains as
semi-separate sites; a subfolder feeds all its authority and backlinks straight
into the main domain. This blog was migrated from a subdomain for that reason.
Keep everything under `/blog/` going forward.

---

## Folder Structure

```
blog/
├── README.md                          ← this file
├── index.html                         ← blog listing / homepage
├── <slug>.html                        ← one file per article, flat in this folder
├── css/
│   ├── blog.css                       ← listing page only
│   └── article.css                    ← article page only
├── js/
│   ├── blog.js                        ← listing page behavior
│   └── article.js                     ← article page behavior
└── images/
    └── <slug>.webp                    ← one cover image per article
```

Nothing in `blog/` depends on anything outside it except:
- `../css/style.css` — shared site-wide tokens (`--yellow`, `--border`, `--muted`) and the `<site-nav>` / `<site-footer>` component styles
- `../js/site-nav.js`, `../js/site-footer.js`, `../js/main.js` — shared nav/footer web components + menu toggle
- `../images/*.webp` — a few articles reuse an existing site image instead of a dedicated blog cover (check each article's `<img>` src)

This split is intentional: site-wide chrome (nav, footer, color tokens) stays
shared so a redesign only happens once; everything blog-specific (typography,
article layout, listing grid) lives only in `blog/css` and `blog/js` so it
never leaks into the rest of the site and never needs touching when the main
site changes.

---

## How the Listing Page Works (`index.html` + `blog.css` + `blog.js`)

**Hero**
- `data-typewriter` span — cycles through a word list (`editing`, `storytelling`, `pacing`, `color`, `sound design`) defined at the top of `blog.js`.
- `data-count="N"` on the three stat numbers — animates 0→N on scroll into view. **`Core Topics` is always `5`** (Documentary / Talking Head / Editing / Maps / World — the five filter categories, not the article count). `world` is the Geography & History category: written companions to Ariyan's own documentaries on the channel. Those articles embed their video (`.article-video`), link the channel instead of a service page (no `data-service-link`), and are generated from the video's script. Finished ones wait in `drafts/blog/` (a 404 on the web) until their publishing week; moving one into `blog/` (and its cover from `drafts/blog/images/` into `blog/images/`), with the date set to that day, is what publishes it; then add its card, schema entries, sitemap URL and llms.txt line like any other article. Publish one or two a week, not all at once. `Latest Articles` and `Published Articles` should both equal the current total number of published articles.
- `.blog-topic-nav` links (`data-topic-filter="..."`) jump to `#latest` and pre-select that category filter.

**Article grid**
- Each `<article class="blog-article-card" data-category="...">` is one card. `data-category` must be one of: `documentary`, `talking`, `editing`, `maps`.
- The `[data-card-reading-time]` `<span>` inside the card starts empty. On load, `blog.js` `fetch()`s that card's own article page, parses out `[data-article-body]`, counts words, and fills in `"N MIN READ"`. **You never type a reading time on the listing page.** If the fetch fails (e.g. article deleted), the span just removes itself — no stale/wrong number is ever shown.
- Filter buttons (`data-filter="..."`) show/hide cards by `data-category` and toggle `.is-filtered`.
- `data-max-articles="7"` on the grid — cards beyond that count get `.is-over-limit` and the "View all articles" button un-hides. With ≤7 articles this button stays hidden; no action needed until article #8.

**Schema**
- One `<script type="application/ld+json">` `@graph` containing `WebSite`, `Blog` (with a `blogPost` array), `WebPage`, and `ItemList` (with `itemListElement`). Both `blogPost` and `itemListElement` need a new entry per article (see checklist below).

⚠️ **The listing-page fetch (`data-card-reading-time`) only works over `http(s)`.** Opening `index.html` directly from disk (`file://`) will fail silently (each badge just disappears) because browsers block `fetch()` across `file://` origins. Test on the live site or a local server, not by double-clicking the file.

---

## How an Article Page Works (`<slug>.html` + `article.css` + `article.js`)

Design language: **"serious minimalism / editing-bay"** — black background, yellow used only as an accent, monospace (`SFMono-Regular`) for all metadata/timecodes, Barlow Condensed for headings. No glow/shimmer animation like the marketing pages — this is deliberately calmer.

**Structure, top to bottom:**
1. `<main class="article-page" data-category="...">` — the `data-category` here drives two automatic things (see below).
2. Breadcrumb → header (tag, `<h1>`, dek, meta row, byline)
3. `.article-frame` — cover image in a CSS "timeline ruler" frame with REC dot + fake timecode badge. If an article has no cover image yet, just omit the `<img>` and the frame still looks intentional (ruler pattern + badges only).
4. `.article-body[data-article-body]` — the actual content. See "Body content building blocks" below.
5. `.article-share` — LinkedIn / X / Copy Link, auto-wired by `article.js`.
6. `.article-footer` → `.article-related` (auto-filled) → `.article-cta` → `.article-nav-links`

**What's automatic (`article.js`):**
| Feature | How |
|---|---|
| Reading time (`[data-reading-time]`) | Counts words in `[data-article-body]`, `÷220`, rounds up |
| Reading progress bar | Scroll-driven width on `.article-progress` |
| Share links | Builds LinkedIn/X share URLs from the canonical link + `og:title` |
| Copy link button | Copies canonical URL, shows "Copied" for 1.6s |
| Service CTA link (`[data-service-link]`) | Reads `data-category` off `<main>`, looks up `SERVICE_MAP` in `article.js`, sets `href` **and** fills any `[data-service-label]` span inside it. Put this attribute on **both** the primary "Work With Me" button and the small footer nav link — one `SERVICE_MAP` lookup drives both. |
| Related articles (`.article-related` / `[data-related-articles]`) | `fetch()`es `index.html`, reads every `.blog-article-card`, excludes the current page, sorts same-category first, renders the top 2 as links. If the fetch fails or nothing else exists yet, the whole `.article-related` block removes itself — never shows an empty "Keep Reading" label. |

`SERVICE_MAP` (top of `article.js`) — the only place that maps a blog category to a service page:
```js
documentary → documentary-video-editing.html
talking     → talking-head-video-editing.html
editing     → talking-head-video-editing.html   (closest fit for general/YouTube-editing topics)
maps        → map-animation-video-editing.html
```
Add a row here if a 5th service page or blog category ever exists — nothing else needs to change.

**Body content building blocks (all in `article.css`):**
| Class | Use |
|---|---|
| `.article-lead` (on the first `<p>`) | Bigger opening paragraph |
| `<h2>` optionally wrapped: `<span class="article-h-num">01</span> Heading` | Numbered section. Only number the sections that are part of a real ordered argument (e.g. 8 comparison factors) — intro/definition/conclusion `<h2>`s stay unnumbered, that's fine, the CSS doesn't require the span |
| `<h3>` | Sub-heading inside a section (e.g. individual steps in a how-to list) |
| `<blockquote class="article-pull">` | Pull quote / quoted example line |
| `<p class="article-verdict">Best for X: <strong>Y</strong></p>` | Short "verdict" callout badge, used in comparison articles |
| `<div class="article-table-wrap"><table>...</table></div>` | Comparison table — always wrap in `.article-table-wrap` (gives horizontal scroll on mobile so the table never breaks the page width) |
| `<div class="article-break" aria-hidden="true">&mdash; &mdash; &mdash;</div>` | Scene-break divider between major parts of a long article |
| plain `<ul>` / `<ol>` / `<p>` / `<strong>` / `<em>` / `<a>` | Already styled, just use them |

---

## How to Publish a New Article

1. **Copy the closest existing article file** as a starting point (same head structure, same footer structure) rather than writing one from scratch.
2. **Pick a slug** — lowercase, hyphenated, matches the title (e.g. `why-your-videos-need-captions.html`). This filename is used everywhere: the URL, the cover image name, the OG/canonical URLs, and the schema `@id`.
3. **Fill in the `<head>`:**
   - `<title>`, `meta description`, `canonical`, `hreflang`
   - OG + Twitter tags (title/description/image — use the real cover image, not a placeholder)
   - Both `<script type="application/ld+json">` blocks: `BlogPosting` (with correct `headline`, `description`, `datePublished`/`dateModified`, `image`) and `BreadcrumbList`
4. **Set `data-category`** on `<main class="article-page" data-category="...">` — one of `documentary`, `talking`, `editing`, `maps`. This one attribute drives the auto service-link *and* the related-articles category matching.
5. **Write the body** inside `<article class="article-body" data-article-body>` using the building blocks above. Aim for real depth — the shortest published article so far is ~530 words, the longest ~2,150. There's no fixed target; write what the topic needs.
6. **Cover image:** save it to `blog/images/<slug>.webp` (rename from whatever the source file is called — no spaces). Reference it as `images/<slug>.webp` inside the article page and `../blog/images/<slug>.webp` in the OG/Twitter/schema `<meta>` tags (those need the full path from site root). If you don't have an image yet, just omit the `<img>` inside `.article-frame` — ship it later, add the `<img>` tag then.
7. **Placeholder reading time:** set `<span data-reading-time>N MIN READ</span>` to a reasonable guess — it gets overwritten instantly on load, this only avoids a flash of wrong text on slow connections.
8. **Service CTA copy:** write a specific 1–2 sentence pitch matching the article's own category (see existing articles for tone) — don't reuse generic "hire me" text. The **link destination** is automatic (`data-service-link` + `data-category`), only the *words* need writing.

### Then update `index.html` (4 things):

- [ ] Add a new `<article class="blog-article-card" data-category="...">` card at the **top** of `.blog-article-grid` (newest first). Include the cover image if you have one; the reading-time span stays empty (`<span data-card-reading-time></span>`) — never hardcode a number there.
- [ ] Add a `BlogPosting` entry to the `blogPost` array (top of the array = newest)
- [ ] Add a `ListItem` entry to the `ItemList.itemListElement` array, renumbering `position` for every item so it stays sequential
- [ ] Bump `data-count` on **both** `Latest Articles` and `Published Articles` (top of the hero) to the new total. **Do not touch `Core Topics` — it stays `5` unless a category is added.**

### Then update the site root:

- [ ] Add a `<url>` block to `/sitemap.xml` for the new article

That's it — no other file needs touching. The reading-time badges, related-articles list, and service CTA link all resolve themselves on page load.

---

## Design Tokens Reused From the Main Site

Both `blog.css` and `article.css` pull `--yellow`, `--border`, `--muted` from `../css/style.css` — they don't redefine their own palette. If the site's core yellow/accent color ever changes, it changes once in `css/style.css` and both blog stylesheets pick it up automatically.

Every blog-specific class is prefixed `.blog-` (listing page) or `.article-` (article page) specifically so nothing here can ever collide with a class name elsewhere on the site.

---

## Known Gotchas

- **`fetch()`-based features need a real server.** Reading-time badges on the listing page and the related-articles block on article pages will silently do nothing (not error, just stay empty/hidden) when opened via `file://`. Always verify on the deployed site.
- **`Core Topics` is a fixed `5`**, not derived from anything — don't let it drift when bumping the other two stats.
- **Renumber `ItemList` positions** every time you add or reorder an article — stale/duplicate `position` values are invalid schema.
- **Don't hand-write a reading time anywhere a human will see it** — both the listing card and the article header pull from live word counts. If a number looks wrong, the actual article content is the source of truth; fix the words, not the number.

---

## Deploying

Same as the rest of the site — see the root `README.md` → "Deploy" section
(`git push live master`, auto-deploys via the server-side git hook).
