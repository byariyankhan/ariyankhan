<?php
/* ══════════════════════════════════════════════════
   Project Tracker Admin — Delivered orders only.
   Read-only filter over the same projects table; every
   form still posts to index.php (see redirect_to).
   ══════════════════════════════════════════════════ */

session_start();
if (empty($_SESSION['tracker_admin'])) {
  header('Location: login.php');
  exit;
}

require __DIR__ . '/../lib/tracker-db.php';
require __DIR__ . '/../lib/admin-helpers.php';
require __DIR__ . '/../lib/tracker-admin-view.php';

$db = tracker_db();
$notice = isset($_GET['notice']) ? (string) $_GET['notice'] : '';

$stmt = $db->prepare('SELECT * FROM projects WHERE stage = :stage ORDER BY updated_at DESC');
$stmt->execute(['stage' => TRACKER_MAX_STAGE]);
$projects = $stmt->fetchAll(PDO::FETCH_ASSOC);
?>
<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Delivered Orders | Ariyan Khan</title>
<link rel="icon" type="image/x-icon" href="../favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/style.css?v=10">
<link rel="stylesheet" href="../css/tracker.css?v=27">
</head>
<body class="tracker-body">
<div id="stars"></div>
<main class="tracker-admin-wrap">
  <div class="tracker-admin-head">
    <div>
      <div class="tag-pill">Admin</div>
      <h1 class="tracker-auth-title">Delivered Orders</h1>
    </div>
    <div class="tracker-admin-head-links">
      <a href="index.php" class="tracker-btn tracker-btn--ghost">Project Tracker</a>
      <a href="mail.php" class="tracker-btn tracker-btn--ghost">Inbox</a>
      <a href="reviews.php" class="tracker-btn tracker-btn--ghost">Reviews</a>
      <a href="logout.php" class="tracker-btn tracker-btn--ghost">Log Out</a>
    </div>
  </div>

  <?php if ($notice !== ''): ?>
    <p class="tracker-notice"><?= e($notice) ?></p>
  <?php endif; ?>

  <div class="tracker-admin-section">
    <h2>Delivered</h2>
    <?php if (!$projects): ?>
      <p class="tracker-muted">No delivered projects yet.</p>
    <?php else: ?>
      <div class="tracker-project-list">
        <?php foreach ($projects as $project): ?>
          <?php tracker_render_project_card($project, 'orders.php'); ?>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</main>
</body>
</html>
