/* ══════════════════════════════════════════════════════════════
   PORTFOLIO DATA — Ariyan Khan
   ──────────────────────────────────────────────────────────────
   Add your videos here. Once added, they will appear:
   - On the service pages
   - In the Recent Projects marquee on the home page (random order)

   == YouTube ==
   URL: https://www.youtube.com/watch?v=VIDEO_ID
   Use the ID at the end of the URL.
   Title is auto-fetched from YouTube. Add title as fallback only.

   == Google Drive ==
   Share link: https://drive.google.com/file/d/FILE_ID/view
   Use the FILE_ID portion.

   == Facebook ==
   platform: 'facebook', url: 'FULL_VIDEO_URL'

   == Short Form (vertical 9:16) ==
   Add  vertical: true  to make the card portrait-sized.
══════════════════════════════════════════════════════════════ */

const PORTFOLIO = [

  /* ── TALKING HEAD ──────────────────────────────────────── */
  { service: 'talking-head', platform: 'youtube', id: '_67MWD7XW9Q' },
  { service: 'talking-head', platform: 'youtube', id: '5PKYfRofUdg'  },
  { service: 'talking-head', platform: 'youtube', id: '3yAiVjcImQ4'  },
  { service: 'talking-head', platform: 'youtube', id: 'MLXZ_aa2ZKw'  },
  { service: 'talking-head', platform: 'youtube', id: 't0Mesp118l4'  },
  { service: 'talking-head', platform: 'youtube', id: 'fo8Sw7CMl-M'  },
  { service: 'talking-head', platform: 'youtube', id: 'Qgi5hb7yxjU'  },
  { service: 'talking-head', platform: 'youtube', id: 'htZRCE2GgIs'  },
  { service: 'talking-head', platform: 'youtube', id: 'nAFw5i39m9I'  },
  { service: 'talking-head', platform: 'youtube', id: 'Q_-Ar9tPjdY'  },
  /* ──────────────────────────────────────────────────────── */

  /* ── DOCUMENTARY ────────────────────────────────────────── */
  { service: 'documentary', platform: 'youtube', id: 'Rn69xI61Chs' },
  { service: 'documentary', platform: 'youtube', id: 'GfOAw9dUpYI' },
  { service: 'documentary', platform: 'youtube', id: '9RJpIqD8MGg' },
  { service: 'documentary', platform: 'youtube', id: 'LCgCeoxToek' },
  /* ──────────────────────────────────────────────────────── */

  /* ── SHORT FORM (vertical 9:16) ─────────────────────────── */
  { service: 'short-form', platform: 'youtube', id: 'iYaGblqcbK8', vertical: true },
  { service: 'short-form', platform: 'youtube', id: 'EM9a6mnGupI', vertical: true },
  { service: 'short-form', platform: 'youtube', id: 'p5YfHE0saFg', vertical: true },
  /* ──────────────────────────────────────────────────────── */

  /* ── MAP ANIMATION ──────────────────────────────────────── */
  { service: 'map-animation', platform: 'youtube', id: 'N_CgVMFSgNQ'  },
  { service: 'map-animation', platform: 'youtube', id: 'QhRNs1aeA0U'  },
  { service: 'map-animation', platform: 'youtube', id: '-c61y07VkFU'  },
  { service: 'map-animation', platform: 'youtube', id: 'Cx1N5azxygM'  },
  { service: 'map-animation', platform: 'youtube', id: 'LwdSfdEkXPA'  },
  /* ──────────────────────────────────────────────────────── */

  /* ── TRUE CRIME ──────────────────────────────────────────── */
  { service: 'true-crime', platform: 'youtube', id: 'UzH-ifjcwMo'  },
  { service: 'true-crime', platform: 'youtube', id: 'qAxCty2RWe0'  },
  { service: 'true-crime', platform: 'youtube', id: 'aZ4WbbzAF1A'  },
  { service: 'true-crime', platform: 'youtube', id: 'FXwm-fTDr7M'  },
  { service: 'true-crime', platform: 'youtube', id: '9XHP2cZQxPI'  },
  { service: 'true-crime', platform: 'youtube', id: 'DEa5hfcZyWo'  },
  /* ──────────────────────────────────────────────────────── */

  /* ── FINANCE & INVESTING ─────────────────────────────────── */
  { service: 'finance', platform: 'youtube', id: 'OFWJVkgz5AY'  },
  { service: 'finance', platform: 'youtube', id: 'Q0uXGQu55GM'  },
  { service: 'finance', platform: 'youtube', id: '-C_5hzJCHaY'  },
  { service: 'finance', platform: 'youtube', id: 'ouvbeb2wSGA'  },
  { service: 'finance', platform: 'youtube', id: 'QThz1B8SHmc'  },
  { service: 'finance', platform: 'youtube', id: 'QaJqKWXUs1U'  },
  /* ──────────────────────────────────────────────────────── */

];

/* ══ Service meta — update when adding a new portfolio category ══ */
const SERVICE_META = {
  'talking-head': {
    label: 'Talking Head',
    icon:  '🎙️',
    page:  'talking-head-video-editing.html',
  },
  'documentary': {
    label: 'Documentary',
    icon:  '🎬',
    page:  'documentary-video-editing.html',
  },
  'short-form': {
    label: 'Short Form',
    icon:  '📱',
    page:  'short-form-video-editing.html',
  },
  'map-animation': {
    label: 'Map Animation',
    icon:  '🗺️',
    page:  'map-animation-video-editing.html',
  },
  'true-crime': {
    label: 'True Crime',
    icon:  '🔎',
    page:  'service/video-editor-for-true-crime-youtube-channels.html',
  },
  'finance': {
    label: 'Finance & Investing',
    icon:  '📈',
    page:  'service/video-editor-for-finance-and-investing-channels.html',
  },
};

