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

  $db = inbox_db();

  // A reply sent through here goes to someone who never received the
  // original message themselves (it only ever landed in Ariyan's inbox),
  // so there's nothing on their end for mail clients to thread against.
  // Prepending the quoted original — same as a native "Reply" — is what
  // makes it read as a continuation instead of a cold, unrelated email.
  $quoted_text = '';
  $quoted_html = '';
  if ($in_reply_to !== '') {
    $stmt = $db->prepare('SELECT contact_name, contact_email, body, created_at FROM mail_messages WHERE message_id = :mid ORDER BY id DESC LIMIT 1');
    $stmt->execute(['mid' => $in_reply_to]);
    $original = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($original) {
      $who = $original['contact_name'] !== '' ? $original['contact_name'] : $original['contact_email'];
      $when = inbox_format_quote_date((string) $original['created_at']);
      $quoted_text = "\n\nOn {$when}, {$who} wrote:\n" . inbox_quote_prefix_lines((string) $original['body']);
      $quoted_html = inbox_render_quoted_html($who, $when, (string) $original['body']);
    }
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
      inbox_render_html_body($body) . $quoted_html
    );
    $mail->AltBody = $body . $quoted_text;

    if ($in_reply_to !== '') {
      $mail->addCustomHeader('In-Reply-To', $in_reply_to);
      $mail->addCustomHeader('References', $in_reply_to);
    }

    $mail->send();
    $message_id = trim((string) $mail->getLastMessageID());
    inbox_append_sent_copy($config, $mail->getSentMIMEMessage());

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

/* Copies a just-sent message into the account's own IMAP Sent folder, so
   it shows up in any other client logged into hi@ariyankhan.com (webmail,
   phone, etc.) the same as a normally-sent email would — SMTP alone never
   does this. Best-effort: the reply has already gone out by the time this
   runs, so a failure here is logged, not surfaced as a send failure. */
function inbox_append_sent_copy(array $config, string $raw_message): void {
  if (empty($config['imap_host']) || empty($config['imap_user']) || empty($config['imap_pass'])) {
    return;
  }

  $mailbox = '{' . $config['imap_host'] . ':' . $config['imap_port'] . '/imap/ssl}INBOX.Sent';
  $conn = @imap_open($mailbox, $config['imap_user'], $config['imap_pass']);
  if (!$conn) {
    error_log('inbox-mail: could not open Sent folder to save a copy - ' . imap_last_error());
    return;
  }

  if (!imap_append($conn, $mailbox, $raw_message, '\\Seen')) {
    error_log('inbox-mail: failed to save sent copy - ' . imap_last_error());
  }

  imap_close($conn);
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

/* Formats a stored UTC created_at for the "On [date], [name] wrote:" quote
   line, matching the style native mail clients use when replying. */
function inbox_format_quote_date(string $iso): string {
  try {
    $dt = new DateTime($iso);
  } catch (Throwable $e) {
    return $iso;
  }
  $dt->setTimezone(new DateTimeZone('Asia/Dhaka'));
  return $dt->format('D, M j, Y \a\t g:i A');
}

function inbox_quote_prefix_lines(string $text): string {
  $lines = explode("\n", trim($text));
  return implode("\n", array_map(fn($line) => '> ' . $line, $lines));
}

function inbox_render_quoted_html(string $who, string $when, string $body): string {
  return
    '<div style="margin-top:24px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.15);">'
    . '<p style="margin:0 0 12px;color:#888888;font-size:13px;">On ' . mail_template_esc($when) . ', ' . mail_template_esc($who) . ' wrote:</p>'
    . '<blockquote style="margin:0;padding-left:16px;border-left:2px solid rgba(255,255,255,0.2);color:#aaaaaa;">'
    . inbox_render_html_body($body)
    . '</blockquote>'
    . '</div>';
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

/* Permanently deletes the given messages — from the local database AND,
   for any received message still on the server, from the actual mailbox
   (via IMAP delete + expunge). This is irreversible; the caller is
   responsible for confirming with the user first. */
function inbox_delete_messages_permanently(array $ids): array {
  $ids = array_values(array_unique(array_map('intval', $ids)));
  if (!$ids) {
    return ['deleted' => 0, 'error' => null];
  }

  $db = inbox_db();
  $placeholders = implode(',', array_fill(0, count($ids), '?'));

  $stmt = $db->prepare("SELECT direction, imap_uid FROM mail_messages WHERE id IN ($placeholders)");
  $stmt->execute($ids);
  $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

  $uids = [];
  foreach ($rows as $row) {
    if ($row['direction'] === 'in' && $row['imap_uid'] !== null) {
      $uids[] = (int) $row['imap_uid'];
    }
  }

  $imap_error = null;
  if ($uids) {
    $config = inbox_mail_config();
    if (empty($config['imap_host']) || empty($config['imap_user']) || empty($config['imap_pass'])) {
      $imap_error = 'IMAP is not configured on the server yet.';
    } else {
      $mailbox = '{' . $config['imap_host'] . ':' . $config['imap_port'] . '/imap/ssl}INBOX';
      $conn = @imap_open($mailbox, $config['imap_user'], $config['imap_pass']);
      if (!$conn) {
        $imap_error = trim((string) imap_last_error()) ?: 'Could not connect to the mailbox.';
      } else {
        foreach ($uids as $uid) {
          $msgno = imap_msgno($conn, $uid);
          if ($msgno) {
            imap_delete($conn, $msgno);
          }
        }
        imap_expunge($conn);
        imap_close($conn);
      }
    }
  }

  $db->prepare("DELETE FROM mail_messages WHERE id IN ($placeholders)")->execute($ids);

  return ['deleted' => count($ids), 'error' => $imap_error];
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

    // The contact-form notifier always sends From no-reply@ariyankhan.com
    // with Reply-To set to the actual visitor (see send-mail.php). Prefer
    // Reply-To so each visitor gets their own thread instead of every
    // inquiry collapsing into one "no-reply" bucket.
    $from = $header->from[0];
    $reply_to = $header->reply_to[0] ?? null;
    $sender = (!empty($reply_to->mailbox) && !empty($reply_to->host)) ? $reply_to : $from;

    $from_email = strtolower(($sender->mailbox ?? '') . '@' . ($sender->host ?? ''));
    $from_name = isset($sender->personal) ? inbox_decode_mime_str($sender->personal) : '';
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
