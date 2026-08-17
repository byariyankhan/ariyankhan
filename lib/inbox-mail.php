<?php
/* ══════════════════════════════════════════════════
   Admin Inbox — send + fetch mail via hi@ariyankhan.com
   Sending reuses PHPMailer (same vendor/ as tracker-mail.php)
   and the shared branded template. Fetching uses the imap
   PHP extension to poll the same mailbox on demand — no
   cron required. Every message in the mailbox is imported
   (grouped into threads by sender email), so this mirrors
   the whole hi@ariyankhan.com inbox, not just self-started
   conversations.
   ══════════════════════════════════════════════════ */

use PHPMailer\PHPMailer\PHPMailer;

require_once __DIR__ . '/inbox-db.php';
require_once __DIR__ . '/mail-template.php';

function inbox_mail_config(): array {
  $local = [];
  $local_path = __DIR__ . '/../mail-config.local.php';

  if (is_file($local_path)) {
    $loaded = require $local_path;
    if (is_array($loaded)) {
      $local = $loaded;
    }
  }

  return [
    'smtp_host' => $local['smtp_host'] ?? null,
    'smtp_port' => (int) ($local['smtp_port'] ?? 587),
    'imap_host' => $local['imap_host'] ?? null,
    'imap_port' => (int) ($local['imap_port'] ?? 993),
    'imap_user' => $local['imap_user'] ?? null,
    'imap_pass' => $local['imap_pass'] ?? null,
    'allow_self_signed' => filter_var($local['allow_self_signed'] ?? false, FILTER_VALIDATE_BOOL),
  ];
}

function inbox_mail_ready(array $config): bool {
  $autoload_path = __DIR__ . '/../vendor/autoload.php';
  if (!is_file($autoload_path)) {
    error_log('inbox-mail: missing Composer autoload');
    return false;
  }
  require_once $autoload_path;
  if (!class_exists(PHPMailer::class)) {
    error_log('inbox-mail: PHPMailer class not found');
    return false;
  }
  return !empty($config['smtp_host']) && !empty($config['imap_user']) && !empty($config['imap_pass']);
}

function inbox_send(string $to_email, string $to_name, string $subject, string $body, string $in_reply_to = ''): array {
  $config = inbox_mail_config();
  if (!inbox_mail_ready($config)) {
    return ['ok' => false, 'error' => 'Mail is not configured on the server yet.'];
  }

  $mail = new PHPMailer(true);

  try {
    $mail->isSMTP();
    $mail->Host = $config['smtp_host'];
    $mail->SMTPAuth = true;
    $mail->Username = $config['imap_user'];
    $mail->Password = $config['imap_pass'];
    $mail->SMTPSecure = $config['smtp_port'] === 465
      ? PHPMailer::ENCRYPTION_SMTPS
      : PHPMailer::ENCRYPTION_STARTTLS;
    $mail->Port = $config['smtp_port'];
    $mail->Timeout = 10;

    if ($config['allow_self_signed']) {
      $mail->SMTPOptions = [
        'ssl' => [
          'verify_peer'       => false,
          'verify_peer_name'  => false,
          'allow_self_signed' => true,
        ],
      ];
    }

    $mail->CharSet = 'UTF-8';
    $mail->setFrom($config['imap_user'], 'Ariyan Khan');
    $mail->addAddress($to_email, $to_name !== '' ? $to_name : $to_email);
    $mail->isHTML(true);
    $mail->Subject = $subject;
    $mail->Body = mail_template_wrap(
      mb_strimwidth(trim(preg_replace('/\s+/', ' ', $body) ?? $body), 0, 110, '…'),
      inbox_render_html_body($body)
    );
    $mail->AltBody = $body;

    if ($in_reply_to !== '') {
      $mail->addCustomHeader('In-Reply-To', $in_reply_to);
      $mail->addCustomHeader('References', $in_reply_to);
    }

    $mail->send();
    $message_id = trim((string) $mail->getLastMessageID());

    $db = inbox_db();
    $stmt = $db->prepare(
      'INSERT INTO mail_messages (direction, contact_email, contact_name, subject, body, message_id, in_reply_to, created_at)
       VALUES ("out", :email, :name, :subject, :body, :message_id, :in_reply_to, :now)'
    );
    $stmt->execute([
      'email' => $to_email,
      'name' => $to_name,
      'subject' => $subject,
      'body' => $body,
      'message_id' => $message_id,
      'in_reply_to' => $in_reply_to,
      'now' => gmdate('c'),
    ]);

    return ['ok' => true, 'message_id' => $message_id];
  } catch (Throwable $e) {
    $detail = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : $e->getMessage();
    error_log('inbox-mail: send failed - ' . $detail);
    return ['ok' => false, 'error' => $detail];
  }
}

function inbox_render_html_body(string $body_text): string {
  $paragraphs = preg_split('/\n{2,}/', trim($body_text)) ?: [];
  $html = '';
  foreach ($paragraphs as $paragraph) {
    if ($paragraph === '') {
      continue;
    }
    $html .= '<p style="margin:0 0 16px;">' . nl2br(mail_template_esc($paragraph)) . '</p>';
  }
  return $html;
}

function inbox_decode_mime_str(string $value): string {
  $decoded = imap_mime_header_decode($value);
  $result = '';
  foreach ($decoded as $part) {
    $text = $part->text;
    $charset = strtolower($part->charset ?? 'default');
    if ($charset !== 'default' && $charset !== 'utf-8' && function_exists('mb_convert_encoding')) {
      $text = @mb_convert_encoding($text, 'UTF-8', $part->charset) ?: $text;
    }
    $result .= $text;
  }
  return $result;
}

function inbox_decode_part_data(string $data, int $encoding): string {
  switch ($encoding) {
    case 3: // BASE64
      return base64_decode($data) ?: $data;
    case 4: // QUOTED-PRINTABLE
      return quoted_printable_decode($data);
    default:
      return $data;
  }
}

/** @param resource|\IMAP\Connection $conn */
function inbox_extract_body($conn, int $msgno, object $structure, string $part_number = ''): string {
  if (!isset($structure->parts)) {
    $data = $part_number !== '' ? imap_fetchbody($conn, $msgno, $part_number) : imap_body($conn, $msgno);
    return trim(inbox_decode_part_data($data, $structure->encoding ?? 0));
  }

  $plain = null;
  $html = null;

  foreach ($structure->parts as $index => $part) {
    $number = $part_number !== '' ? $part_number . '.' . ($index + 1) : (string) ($index + 1);

    if (isset($part->parts)) {
      $nested = inbox_extract_body($conn, $msgno, $part, $number);
      if ($nested !== '' && $plain === null) {
        $plain = $nested;
      }
      continue;
    }

    $subtype = strtoupper($part->subtype ?? '');
    if ($subtype !== 'PLAIN' && $subtype !== 'HTML') {
      continue; // skip attachments and other parts
    }

    $data = imap_fetchbody($conn, $msgno, $number);
    $decoded = inbox_decode_part_data($data, $part->encoding ?? 0);

    if ($subtype === 'PLAIN' && $plain === null) {
      $plain = $decoded;
    } elseif ($subtype === 'HTML' && $html === null) {
      $html = $decoded;
    }
  }

  if ($plain !== null) {
    return trim($plain);
  }
  if ($html !== null) {
    $text = preg_replace('/<(br|p|div)[^>]*>/i', "\n", $html) ?? $html;
    return trim(html_entity_decode(strip_tags($text), ENT_QUOTES, 'UTF-8'));
  }
  return '';
}

function inbox_fetch_new(): array {
  $config = inbox_mail_config();
  if (empty($config['imap_host']) || empty($config['imap_user']) || empty($config['imap_pass'])) {
    return ['fetched' => 0, 'error' => 'IMAP is not configured on the server yet.'];
  }

  $mailbox = '{' . $config['imap_host'] . ':' . $config['imap_port'] . '/imap/ssl}INBOX';
  $conn = @imap_open($mailbox, $config['imap_user'], $config['imap_pass']);
  if (!$conn) {
    return ['fetched' => 0, 'error' => trim((string) imap_last_error()) ?: 'Could not connect to the mailbox.'];
  }

  $db = inbox_db();
  $known_uids = array_flip(array_map('intval', $db->query('SELECT imap_uid FROM mail_messages WHERE imap_uid IS NOT NULL')->fetchAll(PDO::FETCH_COLUMN, 0)));

  $total = imap_num_msg($conn);
  $fetched = 0;

  for ($msgno = 1; $msgno <= $total; $msgno++) {
    $uid = (int) imap_uid($conn, $msgno);
    if (isset($known_uids[$uid])) {
      continue;
    }

    $header = imap_headerinfo($conn, $msgno);
    if (!$header || empty($header->from[0])) {
      continue;
    }

    $from = $header->from[0];
    $from_email = strtolower(($from->mailbox ?? '') . '@' . ($from->host ?? ''));

    $from_name = isset($from->personal) ? inbox_decode_mime_str($from->personal) : '';
    $subject = isset($header->subject) ? inbox_decode_mime_str($header->subject) : '';
    $message_id = isset($header->message_id) ? trim($header->message_id) : '';
    $in_reply_to = isset($header->in_reply_to) ? trim($header->in_reply_to) : '';

    $structure = imap_fetchstructure($conn, $msgno);
    $body = $structure ? inbox_extract_body($conn, $msgno, $structure) : '';

    $stmt = $db->prepare(
      'INSERT INTO mail_messages (direction, contact_email, contact_name, subject, body, message_id, in_reply_to, imap_uid, is_read, created_at)
       VALUES ("in", :email, :name, :subject, :body, :message_id, :in_reply_to, :uid, 0, :now)'
    );
    $stmt->execute([
      'email' => $from_email,
      'name' => $from_name,
      'subject' => $subject,
      'body' => $body,
      'message_id' => $message_id,
      'in_reply_to' => $in_reply_to,
      'uid' => $uid,
      'now' => gmdate('c'),
    ]);
    $fetched++;
  }

  imap_close($conn);
  return ['fetched' => $fetched, 'error' => null];
}
