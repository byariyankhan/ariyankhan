<?php
/* ══════════════════════════════════════════════════
   Project Tracker — shared SQLite helper
   Used by track-lookup.php and admin/index.php
   ══════════════════════════════════════════════════ */

const TRACKER_STAGES = [
  0 => [
    'label' => 'Footage Received',
    'desc' => 'Your raw footage has been received and reviewed — getting familiar with the material before editing begins.',
  ],
  1 => [
    'label' => 'Payment (Advance)',
    'desc' => 'Advance payment confirmed. Editing begins once this step is complete.',
  ],
  2 => [
    'label' => 'Editing In Progress',
    'desc' => 'Cutting, pacing, and shaping your video — building the structure, adding B-roll, captions, and sound design.',
  ],
  3 => [
    'label' => 'In Review',
    'desc' => 'Your first cut is ready and out for your feedback — waiting on notes or approval before the final pass.',
  ],
  4 => [
    'label' => 'Payment (Full)',
    'desc' => 'Final payment confirmed. Your video is being prepared for delivery.',
  ],
  5 => [
    'label' => 'Delivered',
    'desc' => 'Your finished video has been delivered, exported, and ready to publish.',
  ],
];

const TRACKER_MAX_STAGE = 5;

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

  $columns = $db->query('PRAGMA table_info(projects)')->fetchAll(PDO::FETCH_COLUMN, 1);
  if (!in_array('note', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN note TEXT NOT NULL DEFAULT ""');
  }

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
