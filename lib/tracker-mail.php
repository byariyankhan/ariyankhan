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

function tracker_mail_esc(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

/* ══════════════════════════════════════════════════
   Branded HTML email shell — table-based layout with
   inline styles for cross-client compatibility
   (Outlook/Gmail/Apple Mail all render this reliably).
   ══════════════════════════════════════════════════ */
function tracker_mail_wrap(string $preheader, string $content_html): string {
  $logo = 'https://ariyankhan.com/favicon/favicon-96x96.png';
  $avatar = 'https://ariyankhan.com/images/ariyan-khan-profile.webp';
  $year = date('Y');
  $preheader_esc = tracker_mail_esc($preheader);

  $social = [
    ['YouTube', 'https://www.youtube.com/@ariyankhan'],
    ['Instagram', 'https://www.instagram.com/byariyankhan/'],
    ['LinkedIn', 'https://www.linkedin.com/in/ariyankhan'],
    ['TikTok', 'https://www.tiktok.com/@byariyankhan'],
    ['Facebook', 'https://www.facebook.com/ariyankhan'],
  ];
  $social_html = implode(
    '<span style="color:#3a3a3a;"> &nbsp;&middot;&nbsp; </span>',
    array_map(
      fn($s) => '<a href="' . $s[1] . '" style="color:#FFED54;text-decoration:none;font-size:12px;font-weight:600;letter-spacing:.3px;">' . $s[0] . '</a>',
      $social
    )
  );

  return <<<HTML
<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark light">
<title>Ariyan Khan</title>
</head>
<body style="margin:0;padding:0;background-color:#000000;font-family:Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">{$preheader_esc}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#000000;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background-color:#0D0D0D;border:1px solid rgba(255,237,84,0.15);border-radius:12px;overflow:hidden;">
          <!-- Header -->
          <tr>
            <td align="center" style="padding:28px 32px;border-bottom:1px solid rgba(255,237,84,0.15);">
              <img src="{$logo}" width="36" height="36" alt="Ariyan Khan" style="display:block;margin:0 auto 10px;border-radius:8px;">
              <div style="font-size:19px;font-weight:700;letter-spacing:.5px;color:#FFFFFF;">ARIYAN KHAN</div>
              <div style="font-size:11px;color:#888888;letter-spacing:1.5px;text-transform:uppercase;margin-top:5px;">Video Editor &amp; Documentary Creator</div>
            </td>
          </tr>
          <!-- Content -->
          <tr>
            <td style="padding:36px 32px 8px;color:#FFFFFF;font-size:15px;line-height:1.65;">
              {$content_html}
            </td>
          </tr>
          <!-- Signature -->
          <tr>
            <td style="padding:12px 32px 32px;">
              <table role="presentation" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding-right:12px;vertical-align:middle;">
                    <img src="{$avatar}" width="44" height="44" alt="Ariyan Khan" style="display:block;border-radius:50%;border:1px solid rgba(255,237,84,0.3);">
                  </td>
                  <td style="vertical-align:middle;">
                    <div style="font-size:14px;font-weight:700;color:#FFFFFF;">Ariyan Khan</div>
                    <div style="font-size:12px;color:#888888;">hi@ariyankhan.com</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td align="center" style="padding:22px 32px;border-top:1px solid rgba(255,237,84,0.15);background-color:#000000;">
              <div style="margin-bottom:12px;">{$social_html}</div>
              <div style="font-size:11px;color:#555555;">&copy; {$year} Ariyan Khan &middot; Dhaka, Bangladesh</div>
              <div style="font-size:11px;color:#555555;margin-top:4px;">You're receiving this because you have an active project with Ariyan Khan.</div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
HTML;
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
  $mail->isHTML(true);

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
    $mail->Subject = $label;

    $greeting_text = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $greeting_html = $to_name !== '' ? 'Hi ' . tracker_mail_esc($to_name) . ',' : 'Hi,';
    $label_esc = tracker_mail_esc($label);
    $code_esc = tracker_mail_esc($code);
    $track_url_esc = tracker_mail_esc($track_url);

    $content = <<<HTML
      <p style="margin:0 0 16px;">{$greeting_html}</p>
      <p style="margin:0 0 16px;">Thank you for your order! Your project <strong style="color:#FFED54;">&ldquo;{$label_esc}&rdquo;</strong> is now underway.</p>
      <div style="background-color:#111111;border:1px solid rgba(255,237,84,0.15);border-radius:8px;padding:18px 20px;margin:24px 0;text-align:center;">
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#888888;margin-bottom:6px;">Your Tracking Code</div>
        <div style="font-size:22px;font-weight:700;letter-spacing:2px;color:#FFED54;font-family:'Courier New',monospace;">{$code_esc}</div>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
        <tr><td style="background-color:#FFED54;border-radius:8px;">
          <a href="{$track_url_esc}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#000000;text-decoration:none;">Track My Project &rarr;</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#888888;font-size:13px;">Enter your tracking code on that page anytime to see the current status.</p>
      HTML;

    $mail->Body = tracker_mail_wrap("Your project \"{$label}\" is now underway — track it anytime.", $content);
    $mail->AltBody =
      "{$greeting_text}\n\n" .
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
    $mail->Subject = "Re: {$label}";
    $mail->addCustomHeader('In-Reply-To', $thread_id);
    $mail->addCustomHeader('References', $thread_id);

    $greeting_text = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $greeting_html = $to_name !== '' ? 'Hi ' . tracker_mail_esc($to_name) . ',' : 'Hi,';
    $label_esc = tracker_mail_esc($label);
    $stage_label_esc = tracker_mail_esc($stage_label);
    $code_esc = tracker_mail_esc($code);
    $track_url_esc = tracker_mail_esc($track_url);

    $content = <<<HTML
      <p style="margin:0 0 16px;">{$greeting_html}</p>
      <p style="margin:0 0 16px;">Your project <strong style="color:#FFED54;">&ldquo;{$label_esc}&rdquo;</strong> just moved to a new stage:</p>
      <div style="background-color:#111111;border:1px solid rgba(255,237,84,0.15);border-radius:8px;padding:18px 20px;margin:24px 0;text-align:center;">
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#888888;margin-bottom:6px;">New Stage</div>
        <div style="font-size:20px;font-weight:700;color:#FFED54;">{$stage_label_esc}</div>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
        <tr><td style="background-color:#FFED54;border-radius:8px;">
          <a href="{$track_url_esc}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#000000;text-decoration:none;">See Full Progress &rarr;</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#888888;font-size:13px;">Your tracking code: <span style="color:#FFFFFF;font-family:'Courier New',monospace;">{$code_esc}</span></p>
      HTML;

    $mail->Body = tracker_mail_wrap("Your project \"{$label}\" just moved to: {$stage_label}", $content);
    $mail->AltBody =
      "{$greeting_text}\n\n" .
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
