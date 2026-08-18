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
require __DIR__ . '/../lib/admin-helpers.php';
require __DIR__ . '/../lib/tracker-admin-view.php';

$db = tracker_db();
$notice = '';

// Only ever redirect back to one of our own admin pages — never trust
// this value for an open redirect.
function tracker_admin_redirect_target(): string {
  $target = (string) ($_POST['redirect_to'] ?? 'index.php');
  return in_array($target, ['index.php', 'orders.php'], true) ? $target : 'index.php';
}

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = (string) ($_POST['action'] ?? '');
  $redirect_to = tracker_admin_redirect_target();

  if ($action === 'create') {
    $label = trim((string) ($_POST['project_label'] ?? ''));
    $client_name = trim((string) ($_POST['client_name'] ?? ''));
    $client_email = trim((string) ($_POST['client_email'] ?? ''));
    $service_key = trim((string) ($_POST['service_key'] ?? ''));
    $delivery_date = trim((string) ($_POST['delivery_date'] ?? ''));
    $price_amount = (float) ($_POST['price_amount'] ?? 0);
    $advance_amount = (float) ($_POST['advance_amount'] ?? 0);
    if ($client_email !== '' && !filter_var($client_email, FILTER_VALIDATE_EMAIL)) {
      $client_email = '';
    }
    if (!array_key_exists($service_key, TRACKER_SERVICE_KEYS)) {
      $service_key = '';
    }
    if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $delivery_date)) {
      $delivery_date = '';
    }
    if ($price_amount < 0) {
      $price_amount = 0;
    }
    if ($advance_amount < 0) {
      $advance_amount = 0;
    }

    if ($label === '' || $service_key === '' || $delivery_date === '' || $price_amount <= 0) {
      header('Location: index.php?notice=' . urlencode('Project label, service, delivery date, and price are all required.'));
      exit;
    }

    $now = gmdate('c');
    $code = tracker_generate_code();
    // An advance given right at creation means it's already been paid —
    // start at "Payment (Advance)" instead of "Footage Received" so the
    // stage reflects that immediately, no manual bump required.
    $initial_stage = $advance_amount > 0 ? TRACKER_ADVANCE_STAGE : 0;
    $stage_dates = json_encode([(string) $initial_stage => gmdate('Y-m-d')], JSON_FORCE_OBJECT);

    $stmt = $db->prepare(
      'INSERT INTO projects (code, project_label, stage, stage_dates, client_name, client_email, service_key, delivery_date, price_amount, advance_amount, created_at, updated_at)
       VALUES (:code, :label, :stage, :stage_dates, :client_name, :client_email, :service_key, :delivery_date, :price_amount, :advance_amount, :now, :now)'
    );
    $stmt->execute([
      'code' => $code,
      'label' => $label,
      'stage' => $initial_stage,
      'stage_dates' => $stage_dates,
      'client_name' => $client_name,
      'client_email' => $client_email,
      'service_key' => $service_key,
      'delivery_date' => $delivery_date,
      'price_amount' => $price_amount,
      'advance_amount' => $advance_amount,
      'now' => $now,
    ]);

    $notice = "Created project with code {$code}";
    if ($client_email !== '') {
      $sent = tracker_send_order_email($client_email, $client_name, $label, $code, $price_amount, $advance_amount);
      $notice .= $sent ? " — confirmation emailed to {$client_email}" : ' — email failed to send';
    }
  }

  if ($action === 'update_stage') {
    $id = (int) ($_POST['id'] ?? 0);
    $stage = (int) ($_POST['stage'] ?? 0);
    $stage = max(0, min(TRACKER_MAX_STAGE, $stage));
    $notify_client = isset($_POST['notify_client']);

    $stmt = $db->prepare('SELECT stage, stage_dates, project_label, code, client_name, client_email, delivery_link FROM projects WHERE id = :id');
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
          $stage_label,
          (string) ($existing['delivery_link'] ?? '')
        );
        $notice .= $sent ? ' — client notified by email' : ' — notification email failed';
      }
    }
  }

  if ($action === 'update_payment') {
    $id = (int) ($_POST['id'] ?? 0);
    $price_amount = (float) ($_POST['price_amount'] ?? 0);
    $advance_amount = (float) ($_POST['advance_amount'] ?? 0);
    if ($price_amount < 0) {
      $price_amount = 0;
    }
    if ($advance_amount < 0) {
      $advance_amount = 0;
    }

    $stmt = $db->prepare('UPDATE projects SET price_amount = :price_amount, advance_amount = :advance_amount, updated_at = :now WHERE id = :id');
    $stmt->execute(['price_amount' => $price_amount, 'advance_amount' => $advance_amount, 'now' => gmdate('c'), 'id' => $id]);
    $notice = 'Payment updated';
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

  if ($action === 'update_delivery_link') {
    $id = (int) ($_POST['id'] ?? 0);
    $delivery_link = trim((string) ($_POST['delivery_link'] ?? ''));
    if ($delivery_link !== '' && !filter_var($delivery_link, FILTER_VALIDATE_URL)) {
      header('Location: ' . $redirect_to . '?notice=' . urlencode('Delivery link must be a valid URL.'));
      exit;
    }

    $stmt = $db->prepare('UPDATE projects SET delivery_link = :delivery_link, updated_at = :now WHERE id = :id');
    $stmt->execute(['delivery_link' => $delivery_link, 'now' => gmdate('c'), 'id' => $id]);
    $notice = 'Delivery link updated';
  }

  if ($action === 'delete') {
    $id = (int) ($_POST['id'] ?? 0);
    $stmt = $db->prepare('DELETE FROM projects WHERE id = :id');
    $stmt->execute(['id' => $id]);
    $notice = 'Project deleted';
  }

  header('Location: ' . $redirect_to . '?notice=' . urlencode($notice));
  exit;
}

$notice = isset($_GET['notice']) ? (string) $_GET['notice'] : '';
$projects = $db->query('SELECT * FROM projects ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);
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
<link rel="stylesheet" href="../css/tracker.css?v=27">
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
      <a href="orders.php" class="tracker-btn tracker-btn--ghost">Delivered</a>
      <a href="reviews.php" class="tracker-btn tracker-btn--ghost">Reviews</a>
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
      <label class="tracker-field">
        <span>Service (which page a review publishes to)</span>
        <select name="service_key" required>
          <option value="" disabled selected>Choose a service&hellip;</option>
          <?php foreach (TRACKER_SERVICE_KEYS as $key => $svcLabel): ?>
            <option value="<?= e($key) ?>"><?= e($svcLabel) ?></option>
          <?php endforeach; ?>
        </select>
      </label>
      <label class="tracker-field">
        <span>Delivery date</span>
        <input type="text" name="delivery_date" class="tracker-date-input" placeholder="DD/MM/YYYY" inputmode="numeric" autocomplete="off" maxlength="10" pattern="\d{2}/\d{2}/\d{4}" title="DD/MM/YYYY" required>
      </label>
      <label class="tracker-field">
        <span>Project price ($)</span>
        <input type="number" name="price_amount" min="0" step="0.01" placeholder="e.g. 300" required>
      </label>
      <label class="tracker-field">
        <span>Advance paid ($, optional)</span>
        <input type="number" name="advance_amount" min="0" step="0.01" placeholder="e.g. 150">
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
          <?php tracker_render_project_card($project, 'index.php'); ?>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>
  </div>
</main>
<script>
  // Plain text input styled/typed as DD/MM/YYYY (native <input type="date">
  // renders in whatever order the browser's locale picks, which was
  // showing month-first and getting mistyped). Auto-inserts the slashes
  // as digits are typed, then rewrites to YYYY-MM-DD right before the
  // form submits — the PHP side only ever sees ISO format.
  document.querySelectorAll('.tracker-date-input').forEach((input) => {
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').slice(0, 8);
      if (digits.length > 4) {
        input.value = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
      } else if (digits.length > 2) {
        input.value = `${digits.slice(0, 2)}/${digits.slice(2)}`;
      } else {
        input.value = digits;
      }
    });

    input.closest('form')?.addEventListener('submit', () => {
      const match = input.value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      if (match) {
        input.value = `${match[3]}-${match[2]}-${match[1]}`;
      }
    });
  });
</script>
</body>
</html>
