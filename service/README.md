# ariyankhan.com/service — Niche Landing Pages Guide

Subfolder for **audience-specific service landing pages** — narrower variants of the
4 main service pages (`talking-head-video-editing.html`, `documentary-video-editing.html`,
`short-form-video-editing.html`, `map-animation-video-editing.html`) that target a
specific audience's search intent instead of a specific editing style.

---

## Why This Exists

The 4 main service pages already rank for style-based searches ("talking head video
editing"). They don't target *audience*-based searches ("video editor for founders",
"video editor for online coaches") — different search intent, different visitor,
same underlying service. Rather than stuffing every audience into one page (diluting
it) or writing a doorway page per keyword (Google penalty risk, keyword
cannibalization against the main pages), each page in this folder is a genuinely
differentiated landing page for **one specific audience segment**: its own pain
points, its own FAQ, its own case-study framing — but reusing the same booking flow
and portfolio as the main service page it's a variant of.

**Rule: one page per audience segment, not one page per keyword.** If a new page
would say almost the same thing as an existing one, add a section/FAQ to the
existing page instead, or write a blog article (`../blog/`) targeting that keyword.

---

## Folder Structure

```
service/
├── README.md                              ← this file
├── corporate-video-editing.html           ← Corporate / Internal Teams (variant of talking-head)
├── remote-video-editor.html               ← Clients hiring remotely (variant of talking-head)
└── index.php                              ← internal directory of this folder (noindex)
```

No dedicated `css/` or `js/` here — every page reuses the site-wide bundles:
- `../css/style.css`, `../css/service.css`, `../css/service-profile.css`
- `../js/site-nav.js`, `../js/site-footer.js`, `../js/service-profile.js`, `../js/portfolio-data.js`, `../js/main.js`

Pages in this folder are built from the **same markup structure as the 4 main
service pages** (hero → trusted-by → what-i-do → who-this-is-for → problems-i-solve
→ how-it-works → portfolio → faq → explore-services). Copy an existing page in this
folder (or one of the 4 main service pages) as your starting template — don't
build a new layout from scratch.

---

## Subfolder-Relative Paths (important)

Every page here is one level deep (`service/<page>.html`), so:
- All asset links use `../` prefix: `../css/style.css`, `../images/...`, `../favicon/...`
- `<site-nav data-page="subpage" data-home-path="../index.html">`
- `<site-footer data-base-path="../">`
- `<service-profile base-path="../" ...>` — the `base-path` attribute was added to
  `service-profile.js` specifically to support this folder (it prefixes the avatar
  image and the "Order Now" link). Without it the component assumes it's at site
  root and breaks.
- The `who-this-is-for-button` and any other manual CTA links point to
  `../index.html?service=<service-key>#contact`, reusing the **same** contact-form
  service key as the main page (e.g. `talking-head`), not a new one — the contact
  form only recognizes the 4 existing service keys.
- `buildPortfolioGrid("<service-key>")` also reuses the main page's service key —
  there's no separate portfolio pool per audience page.

---

## How to Add a New Audience Page

1. Copy the closest-matching page in this folder (or the main service page it's a
   variant of) as a starting point.
2. Update: `<title>`, meta description, canonical URL, OG/Twitter tags, all 4
   JSON-LD blocks (Service, BreadcrumbList, FAQPage, VideoObject) — keep the
   `Person` `@id` as `https://ariyankhan.com/about.html#person`.
3. Rewrite hero copy, trusted-by tags, what-i-do card copy, who-this-is-for tags,
   problems-i-solve cards, and FAQ for the new audience. Keep the section
   structure and CSS classes identical — only the words change.
4. Keep `service="<key>"` on `<service-profile>` and `buildPortfolioGrid("<key>")`
   pointed at whichever of the 4 main service keys this audience page is a variant
   of (talking-head / documentary / short-form / map-animation).
5. Keep the "Explore More Services" block limited to the 4 main service pages
   (`../talking-head-video-editing.html`, `../documentary-video-editing.html`,
   `../short-form-video-editing.html`, `../map-animation-video-editing.html`) —
   do not add links to other pages in `service/`.
6. Add a `<url>` entry to `../sitemap.xml`.
7. Bump the `?v=` cache-busting number on any shared CSS/JS file you actually
   edited (not on files you only reused unchanged) — see the root `README.md` for
   the convention — and update it on every page that loads that file.

---

## Current Pages

| Page | Audience | Variant of |
|---|---|---|
| `corporate-video-editing.html` | HR/L&D teams, marketing departments, company leadership, internal comms | `talking-head-video-editing.html` |
| `remote-video-editor.html` | Clients hiring an editor remotely, across time zones | `talking-head-video-editing.html` |

## Removed: the `video-editor-for-*.html` pages

The 18 `video-editor-for-*.html` audience pages were deleted after AdSense rejected the
site for **low value content**: templated variants of the same four services read as
doorway pages, and several (history, military history, geography, economics) shared
20–30% of their wording. They came out of `../sitemap.xml`, `../llms.txt` and
`../llms-full.txt`, every internal link to them now points at the main page instead,
and none of their copy was merged into the main pages.

Each old URL **301-redirects** (rules in the root `.htaccess`) to the main service page
it named in its own `<service-profile service="…">`:

| Old pages | Redirect to |
|---|---|
| authors-and-speakers, coaches, finance-and-investing-channels, founders, healthcare-professionals, podcasters, real-estate-agents | `talking-head-video-editing.html` |
| business-documentary-channels, faceless-youtube-channels, nonprofit-organizations, true-crime-youtube-channels, wildlife-and-nature-documentaries | `documentary-video-editing.html` |
| fitness-creators, social-media-promo-clips | `short-form-video-editing.html` |
| economics-and-trade-explainer-channels, geography-and-country-explainer-channels, history-and-geopolitics-channels, military-history-channels | `map-animation-video-editing.html` |

Keep those redirect rules even though the files are gone — they are what answers for
old bookmarks, backlinks and search results. Don't bring back a page at one of those
URLs, and think twice before adding a new audience page here: the rule below is what
the removed pages were meant to follow, and the review still judged them thin.

Every page's "Explore More Services" links **only to the 4 main service pages**
(with `../` prefix) — never to another niche page in this folder, and the 4 main
pages never link into `service/` either. Niche pages don't cross-link each other.

## Planned (not yet built)

- None currently queued — add the next audience segment here when identified.
