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

// Which service page a project belongs to — also the exact keys used in
// js/reviews-data.js's CURATED_REVIEWS and each page's data-curated
// attribute, so a review submitted against this project shows up on the
// right page (see review_submit() and reviews.php).
const TRACKER_SERVICE_KEYS = [
  'talking-head' => 'Talking Head',
  'documentary' => 'Documentary',
  'short-form' => 'Short Form',
  'map-animation' => 'Map Animation',
];

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
  if (!in_array('delivery_date', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN delivery_date TEXT NOT NULL DEFAULT ""');
  }
  if (!in_array('stage_dates', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN stage_dates TEXT NOT NULL DEFAULT "{}"');
  }
  if (!in_array('client_name', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN client_name TEXT NOT NULL DEFAULT ""');
  }
  if (!in_array('client_email', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN client_email TEXT NOT NULL DEFAULT ""');
  }
  if (!in_array('service_key', $columns, true)) {
    $db->exec('ALTER TABLE projects ADD COLUMN service_key TEXT NOT NULL DEFAULT ""');
  }

  $db->exec('
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL UNIQUE,
      code TEXT NOT NULL,
      client_name TEXT NOT NULL,
      rating INTEGER NOT NULL,
      review_body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )
  ');

  $review_columns = $db->query('PRAGMA table_info(reviews)')->fetchAll(PDO::FETCH_COLUMN, 1);
  if (!in_array('service_key', $review_columns, true)) {
    $db->exec('ALTER TABLE reviews ADD COLUMN service_key TEXT NOT NULL DEFAULT ""');
  }

  return $db;
}

/* Self-service review submission — a client proves they're a real,
   completed client by supplying the tracking code + the email on
   file for that project. No manual approval step: a valid code+email
   match against a Delivered project publishes immediately. One
   review per project; resubmitting under the same code updates it
   rather than creating a duplicate. */
function review_submit(string $code, string $email, string $name, int $rating, string $body): array {
  $code = tracker_normalize_code($code);
  $email = strtolower(trim($email));
  $name = trim($name);
  $body = trim($body);

  if ($code === '' || $email === '' || $name === '' || $body === '' || $rating < 1 || $rating > 5) {
    return ['ok' => false, 'error' => 'Please fill in every field with a rating between 1 and 5.'];
  }

  $db = tracker_db();
  $stmt = $db->prepare('SELECT id, stage, client_email, service_key FROM projects WHERE code = :code');
  $stmt->execute(['code' => $code]);
  $project = $stmt->fetch(PDO::FETCH_ASSOC);

  if (!$project || $project['client_email'] === '' || strtolower((string) $project['client_email']) !== $email) {
    return ['ok' => false, 'error' => "We couldn't verify that order. Double-check your tracking code and the email address used on this project."];
  }

  if ((int) $project['stage'] < TRACKER_MAX_STAGE) {
    return ['ok' => false, 'error' => 'Reviews can be left once your project has been marked as delivered.'];
  }

  $now = gmdate('c');
  $stmt = $db->prepare('
    INSERT INTO reviews (project_id, code, client_name, rating, review_body, service_key, created_at, updated_at)
    VALUES (:project_id, :code, :name, :rating, :body, :service_key, :now, :now)
    ON CONFLICT(project_id) DO UPDATE SET
      client_name = excluded.client_name,
      rating = excluded.rating,
      review_body = excluded.review_body,
      service_key = excluded.service_key,
      updated_at = excluded.updated_at
  ');
  $stmt->execute([
    'project_id' => $project['id'],
    'code' => $code,
    'name' => $name,
    'rating' => $rating,
    'body' => $body,
    'service_key' => (string) $project['service_key'],
    'now' => $now,
  ]);

  return ['ok' => true];
}

function reviews_list(): array {
  $db = tracker_db();
  return $db->query('SELECT client_name, rating, review_body, service_key, created_at FROM reviews ORDER BY created_at DESC')->fetchAll(PDO::FETCH_ASSOC);
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
