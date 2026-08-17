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

  uasort($threads, function (array $a, array $b): int {
    $a_msgs = $a['messages'];
    $b_msgs = $b['messages'];
    $a_last = $a_msgs[count($a_msgs) - 1]['created_at'];
    $b_last = $b_msgs[count($b_msgs) - 1]['created_at'];
    return strcmp($b_last, $a_last);
  });

  return $threads;
}
