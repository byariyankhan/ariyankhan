# ariyankhan.com/service — Retired Folder (Redirects Only)

This folder used to hold audience-specific landing pages: narrower variants of the
4 main service pages. **It holds no pages any more.** Every URL that lived here was
deleted and now **301-redirects** to one of the four main service pages, which are the
only service pages that are live and indexable:

- `talking-head-video-editing.html`
- `documentary-video-editing.html`
- `short-form-video-editing.html`
- `map-animation-video-editing.html`

This README is the only file left in the folder, kept so the redirect map is written
down next to the URLs it covers.

---

## Why They Were Removed

AdSense turned the site down for **low value content**. Twenty templated variants of
the same four services read as doorway pages, and several of them (history, military
history, geography, economics) shared 20–30% of their wording. They were removed
rather than rewritten:

- deleted from the repository, along with the folder's internal directory
  (`index.php`) and its stylesheet (`css/service-index.css`)
- taken out of `../sitemap.xml`, `../llms.txt` and `../llms-full.txt`
- every internal link to them now points straight at the main page, so nothing on
  the site hits a redirect
- **none of their copy was moved or merged into the 4 main service pages**, and the
  4 main pages were not edited

---

## Redirect Map

The rules are at the top of the root `.htaccess`. Each page goes to the main service
page it named in its own `<service-profile service="…">`, so a bookmark, backlink or
search result lands on the same service it was already selling.

| Old URL | 301 → |
|---|---|
| `/service/` and `/service/index.php` (internal directory) | `/talking-head-video-editing.html` |
| `/service/corporate-video-editing.html` | `/talking-head-video-editing.html` |
| `/service/remote-video-editor.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-authors-and-speakers.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-coaches.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-finance-and-investing-channels.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-founders.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-healthcare-professionals.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-podcasters.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-real-estate-agents.html` | `/talking-head-video-editing.html` |
| `/service/video-editor-for-business-documentary-channels.html` | `/documentary-video-editing.html` |
| `/service/video-editor-for-faceless-youtube-channels.html` | `/documentary-video-editing.html` |
| `/service/video-editor-for-nonprofit-organizations.html` | `/documentary-video-editing.html` |
| `/service/video-editor-for-true-crime-youtube-channels.html` | `/documentary-video-editing.html` |
| `/service/video-editor-for-wildlife-and-nature-documentaries.html` | `/documentary-video-editing.html` |
| `/service/video-editor-for-fitness-creators.html` | `/short-form-video-editing.html` |
| `/service/video-editor-for-social-media-promo-clips.html` | `/short-form-video-editing.html` |
| `/service/video-editor-for-economics-and-trade-explainer-channels.html` | `/map-animation-video-editing.html` |
| `/service/video-editor-for-geography-and-country-explainer-channels.html` | `/map-animation-video-editing.html` |
| `/service/video-editor-for-history-and-geopolitics-channels.html` | `/map-animation-video-editing.html` |
| `/service/video-editor-for-military-history-channels.html` | `/map-animation-video-editing.html` |

How the rules behave:

- **One hop from any variant.** They run before the www and HTTPS rules and write the
  target for the canonical host over https, so `http://www.ariyankhan.com/service/…`
  lands on `https://ariyankhan.com/<main page>` in a single 301, not three.
  (A `youtube.` prefix is stripped too: the pages only ever lived on the main site.)
- **Query strings carry over** (`?utm_source=…` arrives on the main page intact).
- **Unknown `/service/` paths stay a 404.** Sending a URL that never existed to a page
  is a soft 404 as far as Google is concerned, so only the URLs above redirect.

`tests/service-redirects.test.mjs` checks all of this against the repository: every
row above has its rule, the sitemap and llms files list none of them, and no page,
script or text file links to a redirected URL.

---

## Rules Going Forward

- **Keep the redirect rules**, even though the files are gone: they are what answers
  for old bookmarks, backlinks and search results.
- **Don't put a page back at any of these URLs**, and don't add new pages to this
  folder. A new audience or keyword belongs in a blog article (`../blog/`), not in a
  new service landing page.
- **Link to the main page, never to a URL in the table.** A link that goes through a
  redirect costs every visitor a hop and tells Google the site doesn't know its own
  addresses.
