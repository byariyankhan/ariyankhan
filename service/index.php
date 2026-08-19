<?php
/* ══════════════════════════════════════════════════
   Services directory — every *.html file in this folder
   is auto-discovered and listed below, pulling its title,
   description, image and category straight from the page
   itself. Add a new niche service page to this folder and
   it appears here automatically — no manual edit needed.
   ══════════════════════════════════════════════════ */

function si_e(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function si_extract(string $pattern, string $html): string {
  return preg_match($pattern, $html, $m) ? trim($m[1]) : '';
}

// Underlying service-profile key → a nicer display label. Any key not
// listed here still works, just falls back to a title-cased version of
// the key itself instead of a hand-picked label.
$category_labels = [
  'talking-head'  => 'Talking Head',
  'documentary'   => 'Documentary',
  'short-form'    => 'Short-Form',
  'map-animation' => 'Map Animation',
  'true-crime'    => 'True Crime',
  'finance'       => 'Finance & Investing',
];

$pages = [];
foreach (glob(__DIR__ . '/*.html') as $file) {
  $html = file_get_contents($file);
  if ($html === false) {
    continue;
  }

  $title = si_extract('/<title>(.*?)<\/title>/is', $html);
  $title = html_entity_decode(strip_tags($title), ENT_QUOTES, 'UTF-8');
  $title = trim(preg_replace('/\s*\|\s*Ariyan Khan\s*$/i', '', $title));
  if ($title === '') {
    continue;
  }

  $description = si_extract('/<meta\s+name="description"\s+content="(.*?)"\s*\/?>/is', $html);
  $description = html_entity_decode($description, ENT_QUOTES, 'UTF-8');

  $image = si_extract('/<meta\s+property="og:image"\s+content="(.*?)"\s*\/?>/is', $html);

  // Prefer the display-only portfolio-category (e.g. "true-crime") over the
  // underlying booking service (e.g. "documentary") when a page has both.
  $category = '';
  if (preg_match('/<service-profile[^>]*>/is', $html, $blockMatch)) {
    $block = $blockMatch[0];
    $key = '';
    if (preg_match('/\sportfolio-category="([a-z0-9-]+)"/i', $block, $m)) {
      $key = $m[1];
    } elseif (preg_match('/\sservice="([a-z0-9-]+)"/i', $block, $m)) {
      $key = $m[1];
    }
    if ($key !== '') {
      $category = $category_labels[$key] ?? ucwords(str_replace('-', ' ', $key));
    }
  }

  $pages[] = [
    'href'        => basename($file),
    'title'       => $title,
    'description' => $description,
    'image'       => $image,
    'category'    => $category,
  ];
}

usort($pages, fn($a, $b) => strcasecmp($a['title'], $b['title']));

$page_count = count($pages);
$page_title = 'Video Editing Services | Ariyan Khan';
$page_description = $page_count > 0
  ? "Every specialized video editing service Ariyan Khan offers — {$page_count} niche-specific pages covering YouTube channels, businesses, and creators across every category."
  : 'Every specialized video editing service Ariyan Khan offers, browsable in one place.';
?>
<!doctype html>
<html lang="en-US">
  <head>
    <!-- Google tag (gtag.js) -->
    <script async src="https://www.googletagmanager.com/gtag/js?id=G-8ZPSNG5X37"></script>
    <script>
      window.dataLayer = window.dataLayer || [];
      function gtag() {
        dataLayer.push(arguments);
      }
      gtag("js", new Date());
      gtag("config", "G-8ZPSNG5X37");
    </script>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />

    <!-- SEO -->
    <title><?= si_e($page_title) ?></title>
    <meta name="description" content="<?= si_e($page_description) ?>" />
    <meta name="author" content="Ariyan Khan" />
    <meta name="robots" content="noindex, nofollow" />
    <meta name="theme-color" content="#0a0a0a" />

    <!-- FAVICON -->
    <link rel="icon" type="image/x-icon" href="../favicon/favicon.ico" />
    <link rel="icon" type="image/png" sizes="96x96" href="../favicon/favicon-96x96.png" />
    <link rel="apple-touch-icon" href="../favicon/apple-touch-icon.png" />
    <link rel="manifest" href="../favicon/site.webmanifest" />

    <!-- FONTS -->
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@400;500;600;700;800;900&family=Inter:wght@400;500;600;700;800&display=swap"
      rel="stylesheet"
    />
    <link rel="stylesheet" href="../css/style.css?v=14" />
    <link rel="stylesheet" href="css/service-index.css?v=2" />
  </head>
  <body>
    <div id="stars"></div>

    <site-nav data-page="subpage" data-home-path="../index.html"></site-nav>

    <main class="si-page">
      <section class="si-hero si-width">
        <span class="si-label">Internal &mdash; Not Linked Publicly</span>
        <h1>Every service page, one place.</h1>
        <p>
          <?= $page_count > 0 ? si_e((string) $page_count) : 'Several' ?> live service pages —
          use this to find the right one and grab its link for a client.
        </p>
      </section>

      <section class="si-list si-width" aria-label="Video editing services">
        <?php if ($pages): ?>
          <div class="si-grid">
            <?php foreach ($pages as $p): ?>
              <a class="si-card" href="<?= si_e($p['href']) ?>">
                <div class="si-card-frame">
                  <?php if ($p['category'] !== ''): ?>
                    <span class="si-card-tag"><?= si_e($p['category']) ?></span>
                  <?php endif; ?>
                  <?php if ($p['image'] !== ''): ?>
                    <img src="<?= si_e($p['image']) ?>" alt="<?= si_e($p['title']) ?>" loading="lazy" decoding="async" />
                  <?php endif; ?>
                </div>
                <div class="si-card-body">
                  <h2><?= si_e($p['title']) ?></h2>
                  <?php if ($p['description'] !== ''): ?>
                    <p><?= si_e($p['description']) ?></p>
                  <?php endif; ?>
                  <span class="si-card-link">View service <span aria-hidden="true">&#8599;</span></span>
                </div>
              </a>
            <?php endforeach; ?>
          </div>
        <?php else: ?>
          <p class="si-empty">No service pages found.</p>
        <?php endif; ?>
      </section>
    </main>

    <site-footer data-base-path="../"></site-footer>

    <script src="../js/site-nav.js?v=9"></script>
    <script src="../js/site-footer.js?v=8"></script>
    <script src="../js/main.js?v=22"></script>
  </body>
</html>
