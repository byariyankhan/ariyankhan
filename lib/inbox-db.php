<?php
/* ══════════════════════════════════════════════════
   Admin Inbox — shared SQLite helper
   Used by admin/mail.php and lib/inbox-mail.php.
   Threads are derived by grouping messages on
   contact_email — there's no separate threads table.
   ══════════════════════════════════════════════════ */

function inbox_db(): PDO {
  static $db = null;
  if ($db !== null) {
    return $db;
  }

  $data_dir = __DIR__ . '/../data';
  if (!is_dir($data_dir)) {
    mkdir($data_dir, 0755, true);
  }

  $db = new PDO('sqlite:' . $data_dir . '/inbox.sqlite');
  $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $db->exec('
    CREATE TABLE IF NOT EXISTS mail_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      direction TEXT NOT NULL,
      contact_email TEXT NOT NULL,
      contact_name TEXT NOT NULL DEFAULT "",
      subject TEXT NOT NULL DEFAULT "",
      body TEXT NOT NULL DEFAULT "",
      message_id TEXT NOT NULL DEFAULT "",
      in_reply_to TEXT NOT NULL DEFAULT "",
      imap_uid INTEGER,
      created_at TEXT NOT NULL
    )
  ');
  $db->exec('CREATE INDEX IF NOT EXISTS idx_mail_contact ON mail_messages (contact_email)');

  $columns = $db->query('PRAGMA table_info(mail_messages)')->fetchAll(PDO::FETCH_COLUMN, 1);
  if (!in_array('hidden', $columns, true)) {
    $db->exec('ALTER TABLE mail_messages ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (!in_array('is_read', $columns, true)) {
    // Existing rows predate read-tracking — treat them as already read
    // so old threads don't suddenly all show as unread after this update.
    $db->exec('ALTER TABLE mail_messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 1');
  }

  return $db;
}

/* Groups all non-hidden messages by contact_email into threads, each
   sorted oldest-first internally, and the thread list itself sorted by
   most recent activity first. Deleted messages stay in the table (with
   hidden=1) so their imap_uid still counts as "already seen" and the
   underlying email isn't re-imported on the next check. */
function inbox_threads(PDO $db): array {
  $rows = $db->query('SELECT * FROM mail_messages WHERE hidden = 0 ORDER BY created_at ASC')->fetchAll(PDO::FETCH_ASSOC);

  $threads = [];
  foreach ($rows as $row) {
    $key = strtolower($row['contact_email']);
    if (!isset($threads[$key])) {
      $threads[$key] = [
        'contact_email' => $row['contact_email'],
        'contact_name' => $row['contact_name'],
        'messages' => [],
      ];
    }
    if ($row['contact_name'] !== '') {
      $threads[$key]['contact_name'] = $row['contact_name'];
    }
    $threads[$key]['messages'][] = $row;
  }

  foreach ($threads as $key => $thread) {
    $threads[$key]['unread'] = (bool) array_filter(
      $thread['messages'],
      fn(array $m) => $m['direction'] === 'in' && (int) $m['is_read'] === 0
    );
  }

  uasort($threads, function (array $a, array $b): int {
    $a_msgs = $a['messages'];
    $b_msgs = $b['messages'];
    $a_last = $a_msgs[count($a_msgs) - 1]['created_at'];
    $b_last = $b_msgs[count($b_msgs) - 1]['created_at'];
    return strcmp($b_last, $a_last);
  });

  return $threads;
}

/* Strips repeated "Re:" / "Fwd:" prefixes so replies group under the
   same email as the message they're replying to. */
function inbox_normalize_subject(string $subject): string {
  $s = trim($subject);
  while (preg_match('/^(re|fwd?)\s*:\s*/i', $s)) {
    $s = (string) preg_replace('/^(re|fwd?)\s*:\s*/i', '', $s);
  }
  return strtolower(trim($s));
}

function inbox_mark_thread_read(PDO $db, string $contact_email): void {
  $stmt = $db->prepare('UPDATE mail_messages SET is_read = 1 WHERE LOWER(contact_email) = LOWER(:email) AND direction = "in" AND is_read = 0');
  $stmt->execute(['email' => $contact_email]);
}

/* Formats a stored UTC created_at timestamp for display in Asia/Dhaka —
   relative for anything recent, an absolute date once it's over a week old. */
function inbox_format_time(string $iso): string {
  try {
    $dt = new DateTime($iso);
  } catch (Throwable $e) {
    return $iso;
  }

  $tz = new DateTimeZone('Asia/Dhaka');
  $dt->setTimezone($tz);
  $now = new DateTime('now', $tz);
  $diff = $now->getTimestamp() - $dt->getTimestamp();

  if ($diff < 60) {
    return 'Just now';
  }
  if ($diff < 3600) {
    return floor($diff / 60) . 'm ago';
  }
  if ($dt->format('Y-m-d') === $now->format('Y-m-d')) {
    return $dt->format('g:i A');
  }
  if ($diff > 0 && $diff < 604800) {
    return $dt->format('D g:i A');
  }
  if ($dt->format('Y') === $now->format('Y')) {
    return $dt->format('M j');
  }
  return $dt->format('M j, Y');
}
