<?php
/* ══════════════════════════════════════════════════
   Admin Inbox — compose emails and track replies,
   all sent/received via hi@ariyankhan.com
   ══════════════════════════════════════════════════ */

session_start();
if (empty($_SESSION['tracker_admin'])) {
  header('Location: login.php');
  exit;
}

require __DIR__ . '/../lib/inbox-db.php';
require __DIR__ . '/../lib/inbox-mail.php';

$db = inbox_db();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $action = (string) ($_POST['action'] ?? '');

  if ($action === 'send') {
    $to_email = trim((string) ($_POST['to_email'] ?? ''));
    $to_name = trim((string) ($_POST['to_name'] ?? ''));
    $subject = trim((string) ($_POST['subject'] ?? ''));
    $body = trim((string) ($_POST['body'] ?? ''));
    $in_reply_to = trim((string) ($_POST['in_reply_to'] ?? ''));

    if ($to_email === '' || !filter_var($to_email, FILTER_VALIDATE_EMAIL) || $subject === '' || $body === '') {
      $notice = 'Please fill in a valid email, subject, and message.';
    } else {
      $result = inbox_send($to_email, $to_name, $subject, $body, $in_reply_to);
      $notice = $result['ok'] ? 'Message sent' : ('Send failed — ' . ($result['error'] ?? 'unknown error'));
    }

    header('Location: mail.php?thread=' . urlencode($to_email) . '&notice=' . urlencode($notice));
    exit;
  }

  if ($action === 'delete_subject') {
    $ids = array_filter(array_map('intval', explode(',', (string) ($_POST['ids'] ?? ''))));
    $thread = trim((string) ($_POST['thread'] ?? ''));

    $result = inbox_delete_messages_permanently($ids);
    $notice = $result['error'] !== null
      ? ('Deleted locally, but removing it from the mail server failed — ' . $result['error'])
      : 'Email permanently deleted';

    header('Location: mail.php?thread=' . urlencode($thread) . '&notice=' . urlencode($notice));
    exit;
  }

  if ($action === 'check_replies') {
    $result = inbox_fetch_new();
    $notice = $result['error'] !== null
      ? ('Check failed — ' . $result['error'])
      : ($result['fetched'] . ' new message' . ($result['fetched'] === 1 ? '' : 's') . ' found');

    $redirect_thread = trim((string) ($_POST['current_thread'] ?? ''));
    $qs = $redirect_thread !== '' ? '?thread=' . urlencode($redirect_thread) . '&' : '?';
    header('Location: mail.php' . $qs . 'notice=' . urlencode($notice));
    exit;
  }
}

$notice = isset($_GET['notice']) ? (string) $_GET['notice'] : '';

// Auto-check for new mail on every plain page load. Skipped when a notice
// is already present — that means we just got here from an action (send,
// delete, or an explicit "Check for Replies") that already checked or
// doesn't need to.
if ($notice === '') {
  $auto = inbox_fetch_new();
  if ($auto['error'] === null && $auto['fetched'] > 0) {
    $notice = $auto['fetched'] . ' new message' . ($auto['fetched'] === 1 ? '' : 's') . ' found';
  }
}

$active_key = isset($_GET['thread']) ? strtolower(trim((string) $_GET['thread'])) : '';
if ($active_key !== '') {
  inbox_mark_thread_read($db, $active_key);
}

$threads = inbox_threads($db);
$active_thread = $threads[$active_key] ?? null;

$reply_subject = '';
$reply_in_reply_to = '';
if ($active_thread) {
  $msgs = $active_thread['messages'];
  $last = $msgs[count($msgs) - 1];
  $reply_subject = (stripos((string) $last['subject'], 're:') === 0) ? $last['subject'] : ('Re: ' . $last['subject']);
  $reply_in_reply_to = (string) $last['message_id'];
}

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
<title>Inbox Admin | Ariyan Khan</title>
<link rel="icon" type="image/x-icon" href="../favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/style.css?v=10">
<link rel="stylesheet" href="../css/tracker.css?v=20">
</head>
<body class="tracker-body">
<div id="stars"></div>
<main class="tracker-admin-wrap tracker-admin-wrap--wide">
  <div class="tracker-admin-head">
    <div>
      <div class="tag-pill">Admin</div>
      <h1 class="tracker-auth-title">Inbox</h1>
    </div>
    <div class="tracker-admin-head-links">
      <a href="index.php" class="tracker-btn tracker-btn--ghost">Project Tracker</a>
      <a href="logout.php" class="tracker-btn tracker-btn--ghost">Log Out</a>
    </div>
  </div>

  <?php if ($notice !== ''): ?>
    <p class="tracker-notice"><?= e($notice) ?></p>
  <?php endif; ?>

  <div class="mail-layout">
    <aside class="mail-sidebar">
      <a href="mail.php" class="tracker-btn <?= $active_thread ? 'tracker-btn--ghost' : '' ?> mail-new-btn">+ New Message</a>

      <form method="post" class="mail-check-form">
        <input type="hidden" name="action" value="check_replies">
        <input type="hidden" name="current_thread" value="<?= e($active_thread ? $active_thread['contact_email'] : '') ?>">
        <button type="submit" class="tracker-btn tracker-btn--ghost tracker-btn--small mail-check-btn">Check for Replies</button>
      </form>

      <?php if (!$threads): ?>
        <p class="tracker-muted mail-empty">No conversations yet.</p>
      <?php else: ?>
        <div class="mail-thread-list">
          <?php foreach ($threads as $key => $thread): ?>
            <?php
              $msgs = $thread['messages'];
              $last = $msgs[count($msgs) - 1];
              $is_active = $key === $active_key;
            ?>
            <a href="mail.php?thread=<?= urlencode($thread['contact_email']) ?>" class="mail-thread-item <?= $is_active ? 'is-active' : '' ?> <?= $thread['unread'] ? 'is-unread' : '' ?>">
              <span class="mail-thread-row">
                <span class="mail-thread-name"><?php if ($thread['unread']): ?><span class="mail-unread-dot" aria-hidden="true"></span><?php endif; ?><?= e($thread['contact_name'] !== '' ? $thread['contact_name'] : $thread['contact_email']) ?></span>
                <span class="mail-thread-time"><?= e(inbox_format_time((string) $last['created_at'])) ?></span>
              </span>
              <span class="mail-thread-preview"><?= e($last['direction'] === 'out' ? 'You: ' : '') . e(mb_strimwidth((string) $last['subject'], 0, 48, '…')) ?></span>
            </a>
          <?php endforeach; ?>
        </div>
      <?php endif; ?>
    </aside>

    <section class="mail-main">
      <?php if ($active_thread): ?>
        <div class="mail-thread-head">
          <h2><?= e($active_thread['contact_name'] !== '' ? $active_thread['contact_name'] : $active_thread['contact_email']) ?></h2>
          <p class="tracker-muted"><?= e($active_thread['contact_email']) ?></p>
        </div>

        <?php
          // Group by normalized subject (stripping Re:/Fwd: prefixes) so a
          // whole email exchange — original plus every reply — deletes as
          // one unit instead of message by message.
          $subject_groups = [];
          foreach ($active_thread['messages'] as $msg) {
            $norm = inbox_normalize_subject((string) $msg['subject']);
            $subject_groups[$norm][] = $msg;
          }
        ?>
        <div class="mail-messages">
          <?php foreach ($subject_groups as $group): ?>
            <div class="mail-subject-group">
              <div class="mail-subject-group-head">
                <span class="mail-subject-group-title"><?= e((string) $group[0]['subject']) ?></span>
                <form method="post" class="mail-delete-form" onsubmit="return confirm('Permanently delete this email? This removes it from the mail server too and cannot be undone.');">
                  <input type="hidden" name="action" value="delete_subject">
                  <input type="hidden" name="ids" value="<?= e(implode(',', array_map(fn($m) => (string) $m['id'], $group))) ?>">
                  <input type="hidden" name="thread" value="<?= e($active_thread['contact_email']) ?>">
                  <button type="submit" class="mail-delete-btn" aria-label="Delete email" title="Delete email">&times;</button>
                </form>
              </div>
              <?php foreach ($group as $msg): ?>
                <div class="mail-message mail-message--<?= e($msg['direction']) ?>">
                  <div class="mail-message-meta">
                    <span><?= $msg['direction'] === 'out' ? 'You' : e($active_thread['contact_name'] !== '' ? $active_thread['contact_name'] : $active_thread['contact_email']) ?></span>
                    <span><?= e(inbox_format_time((string) $msg['created_at'])) ?></span>
                  </div>
                  <div class="mail-message-body"><?= nl2br(e((string) $msg['body'])) ?></div>
                </div>
              <?php endforeach; ?>
            </div>
          <?php endforeach; ?>
        </div>

        <form method="post" class="mail-compose mail-reply">
          <input type="hidden" name="action" value="send">
          <input type="hidden" name="to_email" value="<?= e($active_thread['contact_email']) ?>">
          <input type="hidden" name="to_name" value="<?= e($active_thread['contact_name']) ?>">
          <input type="hidden" name="in_reply_to" value="<?= e($reply_in_reply_to) ?>">
          <label class="tracker-field">
            <span>Subject</span>
            <input type="text" name="subject" value="<?= e($reply_subject) ?>" maxlength="200" required>
          </label>
          <label class="tracker-field">
            <span>Reply</span>
            <textarea name="body" rows="6" required placeholder="Write your reply…"></textarea>
          </label>
          <button type="submit" class="tracker-btn">Send Reply</button>
        </form>
      <?php else: ?>
        <div class="mail-thread-head">
          <h2>New Message</h2>
        </div>
        <form method="post" class="mail-compose">
          <input type="hidden" name="action" value="send">
          <label class="tracker-field">
            <span>To (email)</span>
            <input type="email" name="to_email" placeholder="client@example.com" maxlength="160" required>
          </label>
          <label class="tracker-field">
            <span>Name (optional)</span>
            <input type="text" name="to_name" placeholder="e.g. Jane Doe" maxlength="80">
          </label>
          <label class="tracker-field">
            <span>Subject</span>
            <input type="text" name="subject" maxlength="200" required>
          </label>
          <label class="tracker-field">
            <span>Message</span>
            <textarea name="body" rows="8" required placeholder="Write your message…"></textarea>
          </label>
          <button type="submit" class="tracker-btn">Send Message</button>
        </form>
      <?php endif; ?>
    </section>
  </div>
</main>
</body>
</html>
