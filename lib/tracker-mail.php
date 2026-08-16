<?php
/* ══════════════════════════════════════════════════
   Project Tracker — client order-confirmation email
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

function tracker_send_order_email(string $to_email, string $to_name, string $project_label, string $code): bool {
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

  $config = tracker_mail_config();
  if ($config['driver'] === 'smtp' && (empty($config['smtp_host']) || empty($config['smtp_user']) || empty($config['smtp_pass']))) {
    error_log('tracker-mail: SMTP config incomplete');
    return false;
  }

  $track_url = rtrim($config['site_url'], '/') . '/track.html';
  $label = $project_label !== '' ? $project_label : 'your project';
  $mail = null;

  try {
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
    error_log('tracker-mail: send failed - ' . $detail);
    return false;
  }
}
