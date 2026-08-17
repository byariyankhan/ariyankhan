<?php
/* ══════════════════════════════════════════════════
   Project Tracker — client notification emails
   Reuses the same mail-config.local.php / PHPMailer
   setup as send-mail.php, kept separate so the
   contact-form handler stays untouched.
   ══════════════════════════════════════════════════ */

use PHPMailer\PHPMailer\PHPMailer;

function tracker_mail_config(): array {
  $local = [];
  $local_path = __DIR__ . '/../mail-config.local.php';

  if (is_file($local_path)) {
    $loaded = require $local_path;
    if (is_array($loaded)) {
      $local = $loaded;
    }
  }

  return [
    'site_url'   => $local['site_url'] ?? 'https://ariyankhan.com',
    'driver'     => $local['driver'] ?? 'smtp',
    'smtp_host'  => $local['smtp_host'] ?? null,
    'smtp_user'  => $local['smtp_user'] ?? null,
    'smtp_pass'  => $local['smtp_pass'] ?? null,
    'smtp_port'  => (int) ($local['smtp_port'] ?? 587),
    'allow_self_signed' => filter_var($local['allow_self_signed'] ?? false, FILTER_VALIDATE_BOOL),
  ];
}

function tracker_mail_ready(array $config): bool {
  $autoload_path = __DIR__ . '/../vendor/autoload.php';
  if (!is_file($autoload_path)) {
    error_log('tracker-mail: missing Composer autoload');
    return false;
  }
  require_once $autoload_path;
  if (!class_exists(PHPMailer::class)) {
    error_log('tracker-mail: PHPMailer class not found');
    return false;
  }
  if ($config['driver'] === 'smtp' && (empty($config['smtp_host']) || empty($config['smtp_user']) || empty($config['smtp_pass']))) {
    error_log('tracker-mail: SMTP config incomplete');
    return false;
  }
  return true;
}

function tracker_mail_thread_id(string $code): string {
  $slug = strtolower(preg_replace('/[^A-Za-z0-9]/', '', $code) ?? '');
  return "<tracker-{$slug}@ariyankhan.com>";
}

function tracker_mail_new(array $config, string $to_email, string $to_name): PHPMailer {
  $mail = new PHPMailer(true);

  if ($config['driver'] === 'smtp') {
    $mail->isSMTP();
    $mail->Host = $config['smtp_host'];
    $mail->SMTPAuth = true;
    $mail->Username = $config['smtp_user'];
    $mail->Password = $config['smtp_pass'];
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
  } else {
    $mail->isMail();
  }

  $mail->CharSet = 'UTF-8';
  $from_email = $config['driver'] === 'smtp' ? $config['smtp_user'] : $to_email;
  $mail->setFrom($from_email, 'Ariyan Khan');
  $mail->addAddress($to_email, $to_name !== '' ? $to_name : $to_email);
  $mail->isHTML(false);

  return $mail;
}

function tracker_send_order_email(string $to_email, string $to_name, string $project_label, string $code): bool {
  $config = tracker_mail_config();
  if (!tracker_mail_ready($config)) {
    return false;
  }

  $track_url = rtrim($config['site_url'], '/') . '/track.html';
  $label = $project_label !== '' ? $project_label : 'your project';
  $mail = null;

  try {
    $mail = tracker_mail_new($config, $to_email, $to_name);
    $mail->MessageID = tracker_mail_thread_id($code);
    $mail->Subject = "Your order is confirmed — {$label}";

    $greeting = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $mail->Body =
      "{$greeting}\n\n" .
      "Thank you for your order! Your project \"{$label}\" is now underway.\n\n" .
      "You can track its progress anytime here:\n{$track_url}\n\n" .
      "Your tracking code: {$code}\n\n" .
      "Just enter that code on the page above to see the current status.\n\n" .
      "Thanks again,\nAriyan Khan\n";

    $mail->send();
    return true;
  } catch (Throwable $e) {
    $detail = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : $e->getMessage();
    error_log('tracker-mail: order confirmation send failed - ' . $detail);
    return false;
  }
}

function tracker_send_stage_update_email(string $to_email, string $to_name, string $project_label, string $code, string $stage_label): bool {
  $config = tracker_mail_config();
  if (!tracker_mail_ready($config)) {
    return false;
  }

  $track_url = rtrim($config['site_url'], '/') . '/track.html';
  $label = $project_label !== '' ? $project_label : 'your project';
  $thread_id = tracker_mail_thread_id($code);
  $mail = null;

  try {
    $mail = tracker_mail_new($config, $to_email, $to_name);
    $mail->Subject = "Re: Your order is confirmed — {$label}";
    $mail->addCustomHeader('In-Reply-To', $thread_id);
    $mail->addCustomHeader('References', $thread_id);

    $greeting = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $mail->Body =
      "{$greeting}\n\n" .
      "Your project \"{$label}\" just moved to a new stage: {$stage_label}.\n\n" .
      "You can see full progress anytime here:\n{$track_url}\n\n" .
      "Your tracking code: {$code}\n\n" .
      "Thanks,\nAriyan Khan\n";

    $mail->send();
    return true;
  } catch (Throwable $e) {
    $detail = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : $e->getMessage();
    error_log('tracker-mail: stage update send failed - ' . $detail);
    return false;
  }
}
