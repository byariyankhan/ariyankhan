<?php
/* ══════════════════════════════════════════════════
   Project Tracker Admin — dashboard
   ══════════════════════════════════════════════════ */

session_start();
if (empty($_SESSION['tracker_admin'])) {
  header('Location: login.php');
  exit;
}

require __DIR__ . '/../lib/tracker-db.php';
require __DIR__ . '/../lib/tracker-mail.php';

$db = tracker_db();
$notice = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = (string) ($_POST['action'] ?? '');

  if ($action === 'create') {
    $label = trim((string) ($_POST['project_label'] ?? ''));
    $client_name = trim((string) ($_POST['client_name'] ?? ''));
    $client_email = trim((string) ($_POST['client_email'] ?? ''));
    if ($client_email !== '' && !filter_var($client_email, FILTER_VALIDATE_EMAIL)) {
      $client_email = '';
    }

    $now = gmdate('c');
    $code = tracker_generate_code();
    $stage_dates = json_encode(['0' => gmdate('Y-m-d')], JSON_FORCE_OBJECT);

    $stmt = $db->prepare(
      'INSERT INTO projects (code, project_label, stage, stage_dates, client_name, client_email, created_at, updated_at)
       VALUES (:code, :label, 0, :stage_dates, :client_name, :client_email, :now, :now)'
    );
    $stmt->execute([
      'code' => $code,
      'label' => $label,
      'stage_dates' => $stage_dates,
      'client_name' => $client_name,
      'client_email' => $client_email,
      'now' => $now,
    ]);

    $notice = "Created project with code {$code}";
    if ($client_email !== '') {
      $sent = tracker_send_order_email($client_email, $client_name, $label, $code);
      $notice .= $sent ? " — confirmation emailed to {$client_email}" : ' — email failed to send';
    }
  }

  if ($action === 'update_stage') {
    $id = (int) ($_POST['id'] ?? 0);
    $stage = (int) ($_POST['stage'] ?? 0);
    $stage = max(0, min(TRACKER_MAX_STAGE, $stage));
    $notify_client = isset($_POST['notify_client']);

    $stmt = $db->prepare('SELECT stage, stage_dates, project_label, code, client_name, client_email FROM projects WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $existing = $stmt->fetch(PDO::FETCH_ASSOC);

    if ($existing) {
      $previous_stage = (int) $existing['stage'];
      $stage_dates = json_decode((string) $existing['stage_dates'], true);
      if (!is_array($stage_dates)) {
        $stage_dates = [];
      }
      if (!isset($stage_dates[(string) $stage])) {
        $stage_dates[(string) $stage] = gmdate('Y-m-d');
      }

      $stmt = $db->prepare('UPDATE projects SET stage = :stage, stage_dates = :stage_dates, updated_at = :now WHERE id = :id');
      $stmt->execute([
        'stage' => $stage,
        'stage_dates' => json_encode($stage_dates, JSON_FORCE_OBJECT),
        'now' => gmdate('c'),
        'id' => $id,
      ]);
      $notice = 'Stage updated';

      $client_email = (string) ($existing['client_email'] ?? '');
      if ($notify_client && $client_email !== '' && $stage !== $previous_stage) {
        $stage_label = TRACKER_STAGES[$stage]['label'] ?? '';
        $sent = tracker_send_stage_update_email(
          $client_email,
          (string) ($existing['client_name'] ?? ''),
          (string) ($existing['project_label'] ?? ''),
          (string) $existing['code'],
          $stage_label
        );
        $notice .= $sent ? ' — client notified by email' : ' — notification email failed';
      }
    }
  }

  if ($action === 'update_note') {
    $id = (int) ($_POST['id'] ?? 0);
    $note = trim((string) ($_POST['note'] ?? ''));

    $stmt = $db->prepare('UPDATE projects SET note = :note, updated_at = :now WHERE id = :id');
    $stmt->execute(['note' => $note, 'now' => gmdate('c'), 'id' => $id]);
    $notice = 'Note updated';
  }

  if ($action === 'update_delivery') {
    $id = (int) ($_POST['id'] ?? 0);
    $delivery_date = trim((string) ($_POST['delivery_date'] ?? ''));
    if ($delivery_date !== '' && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $delivery_date)) {
      $delivery_date = '';
    }

    $stmt = $db->prepare('UPDATE projects SET delivery_date = :delivery_date, updated_at = :now WHERE id = :id');
    $stmt->execute(['delivery_date' => $delivery_date, 'now' => gmdate('c'), 'id' => $id]);
    $notice = 'Delivery date updated';
  }

  if ($action === 'delete') {
    $id = (int) ($_POST['id'] ?? 0);
    $stmt = $db->prepare('DELETE FROM projects WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $notice = 'Project deleted';
  }

  header('Location: index.php?notice=' . urlencode($notice));
  exit;
}

$notice = isset($_GET['notice']) ? (string) $_GET['notice'] : '';
$projects = $db->query('SELECT * FROM projects ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);

function e(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
?>
<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Project Tracker Admin | Ariyan Khan</title>
<link rel="icon" type="image/x-icon" href="../favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/style.css?v=10">
<link rel="stylesheet" href="../css/tracker.css?v=18">
</head>
<body class="tracker-body">
<div id="stars"></div>
<main class="tracker-admin-wrap">
  <div class="tracker-admin-head">
    <div>
      <div class="tag-pill">Admin</div>
      <h1 class="tracker-auth-title">Project Tracker</h1>
    </div>
    <div class="tracker-admin-head-links">
      <a href="mail.php" class="tracker-btn tracker-btn--ghost">Inbox</a>
      <a href="logout.php" class="tracker-btn tracker-btn--ghost">Log Out</a>
    </div>
  </div>

  <?php if ($notice !== ''): ?>
    <p class="tracker-notice"><?= e($notice) ?></p>
  <?php endif; ?>

  <div class="tracker-admin-section">
    <h2>New Project</h2>
    <form method="post" class="tracker-inline-form">
      <input type="hidden" name="action" value="create">
      <label class="tracker-field">
        <span>Project label (shown to the client)</span>
        <input type="text" name="project_label" placeholder="e.g. Documentary Edit" maxlength="80" required>
      </label>
      <label class="tracker-field">
        <span>Client name (optional)</span>
        <input type="text" name="client_name" placeholder="e.g. Jane Doe" maxlength="80">
      </label>
      <label class="tracker-field">
        <span>Client email (optional — sends order confirmation)</span>
        <input type="email" name="client_email" placeholder="client@example.com" maxlength="160">
      </label>
      <button type="submit" class="tracker-btn">Create &amp; Generate Code</button>
    </form>
  </div>

  <div class="tracker-admin-section">
    <h2>Projects</h2>
    <?php if (!$projects): ?>
      <p class="tracker-muted">No projects yet.</p>
    <?php else: ?>
      <div class="tracker-project-list">
        <?php foreach ($projects as $project): ?>
          <div class="tracker-project-card">
            <div class="tracker-project-head">
              <div>
                <span class="tracker-code"><?= e($project['code']) ?></span>
                <h3 class="tracker-project-title"><?= e($project['project_label'] !== '' ? $project['project_label'] : '(untitled)') ?></h3>
                <?php if (($project['client_name'] ?? '') !== '' || ($project['client_email'] ?? '') !== ''): ?>
                  <p class="tracker-project-client">
                    <?= e((string) ($project['client_name'] ?? '')) ?>
                    <?php if (($project['client_email'] ?? '') !== ''): ?>
                      <?= (($project['client_name'] ?? '') !== '') ? ' · ' : '' ?><?= e((string) $project['client_email']) ?>
                    <?php endif; ?>
                  </p>
                <?php endif; ?>
              </div>
              <form method="post" onsubmit="return confirm('Delete this project?');">
                <input type="hidden" name="action" value="delete">
                <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
                <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Delete</button>
              </form>
            </div>

            <div class="tracker-project-fields">
              <div class="tracker-project-field">
                <label>Stage</label>
                <form method="post" class="tracker-stage-form">
                  <input type="hidden" name="action" value="update_stage">
                  <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
                  <select name="stage" onchange="this.form.submit()">
                    <?php foreach (TRACKER_STAGES as $index => $info): ?>
                      <option value="<?= $index ?>" <?= ((int) $project['stage'] === $index) ? 'selected' : '' ?>>
                        <?= e($info['label']) ?>
                      </option>
                    <?php endforeach; ?>
                  </select>
                  <?php if (($project['client_email'] ?? '') !== ''): ?>
                    <label class="tracker-notify-check">
                      <input type="checkbox" name="notify_client" value="1" checked>
                      Notify client by email
                    </label>
                  <?php endif; ?>
                </form>
              </div>

              <div class="tracker-project-field">
                <label>Delivery date</label>
                <form method="post" class="tracker-date-form">
                  <input type="hidden" name="action" value="update_delivery">
                  <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
                  <input type="date" name="delivery_date" value="<?= e((string) ($project['delivery_date'] ?? '')) ?>">
                  <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Save</button>
                </form>
              </div>

              <div class="tracker-project-field tracker-project-field--wide">
                <label>Payment note</label>
                <form method="post" class="tracker-note-form">
                  <input type="hidden" name="action" value="update_note">
                  <input type="hidden" name="id" value="<?= (int) $project['id'] ?>">
                  <textarea name="note" rows="2" maxlength="300" placeholder="e.g. 50% advance ($150) received"><?= e((string) ($project['note'] ?? '')) ?></textarea>
                  <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small">Save Note</button>
                </form>
              </div>
            </div>

            <p class="tracker-project-foot">Created <?= e(substr((string) $project['created_at'], 0, 10)) ?></p>
          </div>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</main>
</body>
</html>
