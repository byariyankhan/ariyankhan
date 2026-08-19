<?php
/* ══════════════════════════════════════════════════
   Project Tracker Admin — published reviews.
   Reviews auto-publish with no approval step (see
   review_submit() in lib/tracker-db.php) — this page is
   the only moderation safety net: delete anything
   abusive or inappropriate after the fact.
   ══════════════════════════════════════════════════ */

session_start();
if (empty($_SESSION['tracker_admin'])) {
  header('Location: login.php');
  exit;
}

require __DIR__ . '/../lib/tracker-db.php';
require __DIR__ . '/../lib/admin-helpers.php';

$notice = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = (string) ($_POST['action'] ?? '');

  if ($action === 'delete_review') {
    $id = (int) ($_POST['id'] ?? 0);
    review_delete($id);
    $notice = 'Review deleted';
  }

  header('Location: reviews.php?notice=' . urlencode($notice));
  exit;
}

$notice = isset($_GET['notice']) ? (string) $_GET['notice'] : '';
$reviews = reviews_list_admin();
?>
<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Reviews | Ariyan Khan</title>
<link rel="icon" type="image/x-icon" href="../favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/style.css?v=13">
<link rel="stylesheet" href="../css/tracker.css?v=28">
</head>
<body class="tracker-body">
<div id="stars"></div>
<main class="tracker-admin-wrap">
  <div class="tracker-admin-head">
    <div>
      <div class="tag-pill">Admin</div>
      <h1 class="tracker-auth-title">Reviews</h1>
    </div>
    <div class="tracker-admin-head-links">
      <a href="index.php" class="tracker-btn tracker-btn--ghost">Project Tracker</a>
      <a href="mail.php" class="tracker-btn tracker-btn--ghost">Inbox</a>
      <a href="orders.php" class="tracker-btn tracker-btn--ghost">Delivered</a>
      <a href="logout.php" class="tracker-btn tracker-btn--ghost">Log Out</a>
    </div>
  </div>

  <?php if ($notice !== ''): ?>
    <p class="tracker-notice"><?= e($notice) ?></p>
  <?php endif; ?>

  <div class="tracker-admin-section">
    <h2>Published reviews</h2>
    <p class="tracker-muted" style="margin-bottom:20px;">
      Reviews publish immediately when a client submits one — there's no approval step.
      Delete anything abusive, inappropriate, or otherwise not fit to keep live.
    </p>
    <?php if (!$reviews): ?>
      <p class="tracker-muted">No reviews yet.</p>
    <?php else: ?>
      <div class="tracker-project-list">
        <?php foreach ($reviews as $review): ?>
          <div class="tracker-project-card">
            <div class="tracker-project-head">
              <div>
                <span class="tracker-code"><?= e((string) $review['code']) ?></span>
                <?php $svcKey = (string) ($review['service_key'] ?? ''); ?>
                <?php if ($svcKey !== '' && isset(TRACKER_SERVICE_KEYS[$svcKey])): ?>
                  <span class="tracker-service-badge"><?= e(TRACKER_SERVICE_KEYS[$svcKey]) ?></span>
                <?php else: ?>
                  <span class="tracker-service-badge tracker-service-badge--none">No service on file</span>
                <?php endif; ?>
                <h3 class="tracker-project-title"><?= e((string) $review['client_name']) ?></h3>
                <p class="tracker-project-client">
                  <?= str_repeat('★', max(0, min(5, (int) $review['rating']))) ?>
                  <?php if (($review['project_label'] ?? '') !== ''): ?>
                    · for "<?= e((string) $review['project_label']) ?>"
                  <?php endif; ?>
                </p>
              </div>
              <form method="post" onsubmit="return confirm('Delete this review? This can\'t be undone.');">
                <input type="hidden" name="action" value="delete_review">
                <input type="hidden" name="id" value="<?= (int) $review['id'] ?>">
                <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Delete</button>
              </form>
            </div>
            <p class="tracker-review-body"><?= e((string) $review['review_body']) ?></p>
            <p class="tracker-project-foot">Submitted <?= e(substr((string) $review['created_at'], 0, 10)) ?></p>
          </div>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</main>
</body>
</html>
