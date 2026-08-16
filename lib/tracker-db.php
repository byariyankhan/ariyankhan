<?php
/* ══════════════════════════════════════════════════
   Project Tracker — shared SQLite helper
   Used by track-lookup.php and admin/index.php
   ══════════════════════════════════════════════════ */

const TRACKER_STAGES = [
  0 => 'Footage Received',
  1 => 'Editing In Progress',
  2 => 'In Review',
  3 => 'Delivered',
];

const TRACKER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L

function tracker_db(): PDO {
  static $db = null;
  if ($db !== null) {
    return $db;
  }

  $data_dir = __DIR__ . '/../data';
  if (!is_dir($data_dir)) {
    mkdir($data_dir, 0755, true);
  }

  $db = new PDO('sqlite:' . $data_dir . '/tracker.sqlite');
  $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
  $db->exec('
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      project_label TEXT NOT NULL DEFAULT "",
      stage INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  ');

  return $db;
}

function tracker_generate_code(): string {
  $db = tracker_db();
  $alphabet = TRACKER_CODE_ALPHABET;
  $max = strlen($alphabet) - 1;

  do {
    $chars = [];
    for ($i = 0; $i < 8; $i++) {
      $chars[] = $alphabet[random_int(0, $max)];
    }
    $raw = implode('', $chars);
    $code = substr($raw, 0, 4) . '-' . substr($raw, 4, 4);

    $stmt = $db->prepare('SELECT 1 FROM projects WHERE code = :code');
    $stmt->execute(['code' => $code]);
  } while ($stmt->fetch());

  return $code;
}

function tracker_normalize_code(string $raw): string {
  $upper = strtoupper(trim($raw));
  $stripped = preg_replace('/[^A-Z0-9]/', '', $upper) ?? '';
  if (strlen($stripped) !== 8) {
    return $upper;
  }
  return substr($stripped, 0, 4) . '-' . substr($stripped, 4, 4);
}
