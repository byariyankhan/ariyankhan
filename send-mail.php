<?php
/* ══════════════════════════════════════════════════
   Contact Form Mail Handler — ariyankhan.com
   PHPMailer — driver 'mail' (sendmail) or 'smtp'
   ══════════════════════════════════════════════════ */

use PHPMailer\PHPMailer\PHPMailer;

const DEFAULT_SITE_URL = 'https://ariyankhan.com';

header('Content-Type: application/json; charset=utf-8');
set_time_limit(30);

function respond(int $status, array $payload) {
  http_response_code($status);
  echo json_encode($payload);
  exit;
}

function load_mailer_dependency(): void {
  $autoload_path = __DIR__ . '/vendor/autoload.php';

  if (!is_file($autoload_path)) {
    error_log('send-mail.php missing Composer autoload: ' . $autoload_path);
    respond(500, ['ok' => false, 'error' => 'Mail service dependency is missing']);
  }

  require $autoload_path;

  if (!class_exists(PHPMailer::class)) {
    error_log('send-mail.php PHPMailer class not found via Composer autoload');
    respond(500, ['ok' => false, 'error' => 'Mail service dependency is missing']);
  }
}

function env_config(string $key): ?string {
  foreach ([$key, 'ARIYAN_' . $key] as $candidate) {
    $value = getenv($candidate);
    if ($value === false) {
      continue;
    }

    $value = trim((string) $value);
    if ($value !== '') {
      return $value;
    }
  }

  return null;
}

function load_mail_config(): array {
  $local = [];
  $local_path = __DIR__ . '/mail-config.local.php';

  if (is_file($local_path)) {
    $loaded = require $local_path;
    if (is_array($loaded)) {
      $local = $loaded;
    }
  }

  $site_url = $local['site_url'] ?? env_config('SITE_URL') ?? DEFAULT_SITE_URL;

  return [
    'site_url'       => $site_url,
    'allowed_origin' => $local['allowed_origin'] ?? env_config('MAIL_ALLOWED_ORIGIN') ?? $site_url,
    'driver'         => $local['driver'] ?? env_config('MAIL_DRIVER') ?? 'smtp',
    'to_email'       => $local['to_email'] ?? env_config('TO_EMAIL'),
    'smtp_host'      => $local['smtp_host'] ?? env_config('SMTP_HOST'),
    'smtp_user'      => $local['smtp_user'] ?? env_config('SMTP_USER'),
    'smtp_pass'      => $local['smtp_pass'] ?? env_config('SMTP_PASS'),
    'smtp_port'      => (int) ($local['smtp_port'] ?? env_config('SMTP_PORT') ?? 587),
    'allow_self_signed' => filter_var(
      $local['allow_self_signed'] ?? env_config('SMTP_ALLOW_SELF_SIGNED') ?? false,
      FILTER_VALIDATE_BOOL
    ),
  ];
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

function clean_line(string $value): string {
  $value = trim(strip_tags($value));
  $value = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $value) ?? '';

  return preg_replace('/\s{2,}/u', ' ', $value) ?? '';
}

function clean_message(string $value): string {
  $value = trim(strip_tags($value));
  $value = str_replace(["\r\n", "\r"], "\n", $value);

  return preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]+/u', '', $value) ?? '';
}

function normalize_whatsapp_digits(string $value): string {
  $digits = preg_replace('/\D+/', '', trim($value)) ?? '';
  if (str_starts_with($digits, '00')) {
    $digits = substr($digits, 2);
  }

  return $digits;
}

function normalize_whatsapp_number(string $rule, string $value): ?string {
  if ($value === '') {
    return null;
  }

  $digits = normalize_whatsapp_digits($value);

  switch ($rule) {
    case 'bd':
      if (str_starts_with($digits, '880')) {
        $digits = substr($digits, 3);
      }
      if (preg_match('/^01\d{9}$/', $digits) === 1) {
        return '+880' . substr($digits, 1);
      }
      if (preg_match('/^1\d{9}$/', $digits) === 1) {
        return '+880' . $digits;
      }
      return null;

    case 'usca':
      if (str_starts_with($digits, '1') && strlen($digits) === 11) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^[2-9]\d{2}[2-9]\d{6}$/', $digits) === 1 ? '+1' . $digits : null;

    case 'uk':
      if (str_starts_with($digits, '44')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^7\d{9}$/', $digits) === 1 ? '+44' . $digits : null;

    case 'in':
      if (str_starts_with($digits, '91')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^[6-9]\d{9}$/', $digits) === 1 ? '+91' . $digits : null;

    case 'pk':
      if (str_starts_with($digits, '92')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^3\d{9}$/', $digits) === 1 ? '+92' . $digits : null;

    case 'ae':
      if (str_starts_with($digits, '971')) {
        $digits = substr($digits, 3);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^5\d{8}$/', $digits) === 1 ? '+971' . $digits : null;

    case 'sa':
      if (str_starts_with($digits, '966')) {
        $digits = substr($digits, 3);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^5\d{8}$/', $digits) === 1 ? '+966' . $digits : null;

    case 'au':
      if (str_starts_with($digits, '61')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^4\d{8}$/', $digits) === 1 ? '+61' . $digits : null;

    case 'nz':
      if (str_starts_with($digits, '64')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^2\d{7,9}$/', $digits) === 1 ? '+64' . $digits : null;

    case 'de':
      if (str_starts_with($digits, '49')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^1[5-7]\d{8,10}$/', $digits) === 1 ? '+49' . $digits : null;

    case 'nl':
      if (str_starts_with($digits, '31')) {
        $digits = substr($digits, 2);
      }
      if (str_starts_with($digits, '0')) {
        $digits = substr($digits, 1);
      }
      return preg_match('/^6\d{8}$/', $digits) === 1 ? '+31' . $digits : null;

    case 'sg':
      if (str_starts_with($digits, '65')) {
        $digits = substr($digits, 2);
      }
      return preg_match('/^[89]\d{7}$/', $digits) === 1 ? '+65' . $digits : null;

    case 'other':
      return preg_match('/^[1-9]\d{7,14}$/', $digits) === 1 ? '+' . $digits : null;
  }

  return null;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(405, ['ok' => false, 'error' => 'Method not allowed']);
}

load_mailer_dependency();

$config = load_mail_config();
validate_origin($config['allowed_origin']);

$required = ['to_email'];
if ($config['driver'] === 'smtp') {
  $required = array_merge($required, ['smtp_host', 'smtp_user', 'smtp_pass']);
}
foreach ($required as $key) {
  if (empty($config[$key])) {
    error_log('send-mail.php missing required config: ' . $key);
    respond(500, ['ok' => false, 'error' => 'Mail service is not configured']);
  }
}

$raw = file_get_contents('php://input');
$data = json_decode($raw ?: '', true);

if (!is_array($data)) {
  respond(400, ['ok' => false, 'error' => 'Invalid request payload']);
}

$name = clean_line((string) ($data['name'] ?? ''));
$email = filter_var(trim((string) ($data['email'] ?? '')), FILTER_SANITIZE_EMAIL);
$whatsapp = clean_line((string) ($data['whatsapp'] ?? ''));
$whatsapp_country = clean_line((string) ($data['whatsappCountry'] ?? ''));
$whatsapp_rule = clean_line((string) ($data['whatsappRule'] ?? ''));
$message = clean_message((string) ($data['message'] ?? ''));
$service = clean_line((string) ($data['service'] ?? '—')) ?: '—';
$budget = clean_line((string) ($data['budget'] ?? '—')) ?: '—';

if (!$name || !$email || !$whatsapp || !$whatsapp_country || !$whatsapp_rule || !$message) {
  respond(400, ['ok' => false, 'error' => 'Missing required fields']);
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
  respond(400, ['ok' => false, 'error' => 'Invalid email address']);
}

$normalized_whatsapp = normalize_whatsapp_number($whatsapp_rule, $whatsapp);
if (!$normalized_whatsapp) {
  respond(400, ['ok' => false, 'error' => 'Invalid WhatsApp number']);
}

$mail = null;

try {
  $mail = new PHPMailer(true);

  if ($config['driver'] === 'smtp') {
    $mail->isSMTP();
    $mail->Host      = $config['smtp_host'];
    $mail->SMTPAuth  = true;
    $mail->Username  = $config['smtp_user'];
    $mail->Password  = $config['smtp_pass'];
    $mail->SMTPSecure = $config['smtp_port'] === 465
      ? PHPMailer::ENCRYPTION_SMTPS
      : PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port      = $config['smtp_port'];
    $mail->Timeout   = 10;

    if ($config['allow_self_signed']) {
      $mail->SMTPOptions = [
        'ssl' => [
          'verify_peer'       => false,
          'verify_peer_name'  => false,
          'allow_self_signed' => true,
        ],
      ];
    }
  } else {
    $mail->isMail();
  }

  $mail->CharSet = 'UTF-8';

  $from_email = $config['driver'] === 'smtp' ? $config['smtp_user'] : $config['to_email'];
  $from_name = $config['driver'] === 'smtp' ? "{$name} (via ariyankhan.com)" : 'Ariyan Khan';

  $mail->setFrom($from_email, $from_name);
  $mail->addAddress($config['to_email'], 'Ariyan Khan');
  $mail->addReplyTo($email, $name);

  $mail->isHTML(false);
  $mail->Subject = "{$name} — {$service}";
  $mail->Body =
    "New project inquiry via ariyankhan.com\n" .
    str_repeat('─', 48) . "\n\n" .
    "Name:      {$name}\n" .
    "Email:     {$email}\n" .
    "Country:   {$whatsapp_country}\n" .
    "WhatsApp:  {$normalized_whatsapp}\n" .
    "Service:   {$service}\n" .
    "Budget:    {$budget}\n\n" .
    "Message:\n{$message}\n\n" .
    str_repeat('─', 48) . "\n" .
    "Reply directly to this email to contact {$name}.\n" .
    "Sent from: {$config['site_url']}\n";

  $mail->send();
  echo json_encode(['ok' => true]);
} catch (Throwable $e) {
  $mail_error = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : '';
  $detail = $mail_error !== '' ? $mail_error : $e->getMessage();

  error_log('send-mail.php mailer error: ' . $detail);
  respond(500, ['ok' => false, 'error' => 'Unable to send message right now']);
}
