<?php
/* ══════════════════════════════════════════════════
   Client Reviews — public API
   GET  → list published reviews (for the homepage/service pages)
   POST → submit a review; auto-publishes if the tracking code and
   email match a Delivered project (see lib/tracker-db.php)
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

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
  $reviews = array_map(
    function (array $r): array {
      return [
        'name' => $r['client_name'],
        'rating' => (int) $r['rating'],
        'body' => $r['review_body'],
        'date' => substr((string) $r['created_at'], 0, 10),
      ];
    },
    reviews_list()
  );
  respond(200, ['ok' => true, 'reviews' => $reviews]);
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(405, ['ok' => false, 'error' => 'Method not allowed']);
}

validate_origin(DEFAULT_SITE_URL);

$raw = file_get_contents('php://input');
$data = json_decode($raw ?: '', true);
if (!is_array($data)) {
  respond(400, ['ok' => false, 'error' => 'Invalid request body']);
}

$name = trim((string) ($data['name'] ?? ''));
$email = trim((string) ($data['email'] ?? ''));
$code = trim((string) ($data['code'] ?? ''));
$rating = (int) ($data['rating'] ?? 0);
$body = trim((string) ($data['review'] ?? ''));

if (!$name || !$email || !$code || !$body) {
  respond(400, ['ok' => false, 'error' => 'Please fill in every field.']);
}
if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
  respond(400, ['ok' => false, 'error' => 'Please enter a valid email address.']);
}
if ($rating < 1 || $rating > 5) {
  respond(400, ['ok' => false, 'error' => 'Please choose a rating between 1 and 5.']);
}

$result = review_submit($code, $email, $name, $rating, $body);
if (!$result['ok']) {
  respond(422, $result);
}

respond(200, ['ok' => true]);
