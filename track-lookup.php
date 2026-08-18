<?php
/* ══════════════════════════════════════════════════
   Project Tracker — public code lookup
   ══════════════════════════════════════════════════ */

require __DIR__ . '/lib/tracker-db.php';

const DEFAULT_SITE_URL = 'https://ariyankhan.com';

header('Content-Type: application/json; charset=utf-8');

function respond(int $status, array $payload) {
  http_response_code($status);
  echo json_encode($payload);
  exit;
}

function normalize_host(?string $url): string {
  if (!$url) {
    return '';
  }
  $host = parse_url($url, PHP_URL_HOST);
  return is_string($host) ? strtolower($host) : '';
}

function validate_origin(string $expected_origin): void {
  $expected_host = normalize_host($expected_origin);
  if ($expected_host === '') {
    return;
  }

  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  $referer = $_SERVER['HTTP_REFERER'] ?? '';
  $source_host = $origin !== '' ? normalize_host($origin) : normalize_host($referer);

  if ($source_host !== '' && $source_host !== $expected_host) {
    respond(403, ['ok' => false, 'error' => 'Unauthorized origin']);
  }
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(405, ['ok' => false, 'error' => 'Method not allowed']);
}

validate_origin(DEFAULT_SITE_URL);

$raw_body = file_get_contents('php://input');
$data = json_decode((string) $raw_body, true);
if (!is_array($data)) {
  respond(400, ['ok' => false, 'error' => 'Invalid request body']);
}

$code_input = trim((string) ($data['code'] ?? ''));
if ($code_input === '') {
  respond(400, ['ok' => false, 'error' => 'Please enter your tracking code']);
}

$code = tracker_normalize_code($code_input);

$db = tracker_db();
$stmt = $db->prepare('SELECT project_label, stage, created_at, delivery_date, stage_dates, price_amount, advance_amount FROM projects WHERE code = :code');
$stmt->execute(['code' => $code]);
$project = $stmt->fetch(PDO::FETCH_ASSOC);

if (!$project) {
  respond(404, ['ok' => false, 'error' => "We couldn't find a project with that code. Double-check it and try again."]);
}

$stage = (int) $project['stage'];
$stage_dates = json_decode((string) ($project['stage_dates'] ?? '{}'), true);
if (!is_array($stage_dates)) {
  $stage_dates = [];
}

respond(200, [
  'ok' => true,
  'projectLabel' => $project['project_label'] !== '' ? $project['project_label'] : 'Your Project',
  'stage' => $stage,
  'stages' => array_values(TRACKER_STAGES),
  'priceAmount' => (float) ($project['price_amount'] ?? 0),
  'advanceAmount' => (float) ($project['advance_amount'] ?? 0),
  'createdAt' => substr((string) $project['created_at'], 0, 10),
  'deliveryDate' => (string) ($project['delivery_date'] ?? ''),
  'stageDates' => (object) $stage_dates,
]);
