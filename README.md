# ariyankhan.com — Project Guide

Static HTML/CSS/JS + PHP site. No build framework. Namecheap shared hosting.

---

## Deploy

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

**Never commit:** `.env`, `mail-config.local.php` (credentials — both in `.gitignore`)

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

## Do Not

- Do not commit `mail-config.local.php`
- Do not add self-links in explore pills
- Do not create duplicate content across SEO pages (Google penalty)
- Do not add `site-config.js`

