<?php
/* ══════════════════════════════════════════════════
   Project Tracker — client notification emails
   Reuses the same mail-config.local.php / PHPMailer
   setup as send-mail.php, kept separate so the
   contact-form handler stays untouched.
   ══════════════════════════════════════════════════ */

use PHPMailer\PHPMailer\PHPMailer;

require_once __DIR__ . '/mail-template.php';
require_once __DIR__ . '/tracker-db.php'; // tracker_format_money()

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
    'to_email'   => $local['to_email'] ?? null,
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
  if (!empty($config['to_email'])) {
    // Sent from no-reply@ — route any client reply to the real inbox
    // instead of a dead address, same trick send-mail.php uses.
    $mail->addReplyTo($config['to_email'], 'Ariyan Khan');
  }
  $mail->addAddress($to_email, $to_name !== '' ? $to_name : $to_email);
  $mail->isHTML(true);

  return $mail;
}

function tracker_send_order_email(string $to_email, string $to_name, string $project_label, string $code, float $price_amount = 0, float $advance_amount = 0): bool {
  $config = tracker_mail_config();
  if (!tracker_mail_ready($config)) {
    return false;
  }

  $track_url = rtrim($config['site_url'], '/') . '/track.html?code=' . urlencode($code);
  $label = $project_label !== '' ? $project_label : 'your project';
  $mail = null;

  // Only mentioned when an advance is actually on file — matches the
  // tracker page/admin dropdown, which stay silent until there's a real
  // number to show.
  $payment_line_html = '';
  $payment_line_text = '';
  if ($advance_amount > 0) {
    $advance_fmt = tracker_format_money($advance_amount);
    if ($price_amount > 0 && $advance_amount < $price_amount) {
      $due_fmt = tracker_format_money($price_amount - $advance_amount);
      $payment_line_html = "<p style=\"margin:0 0 16px;\">I've received your advance payment of <strong style=\"color:#FFED54;\">{$advance_fmt}</strong> — {$due_fmt} remaining before final delivery.</p>";
      $payment_line_text = "I've received your advance payment of {$advance_fmt} — {$due_fmt} remaining before final delivery.\n\n";
    } else {
      $payment_line_html = "<p style=\"margin:0 0 16px;\">I've received your payment of <strong style=\"color:#FFED54;\">{$advance_fmt}</strong> — thank you!</p>";
      $payment_line_text = "I've received your payment of {$advance_fmt} — thank you!\n\n";
    }
  }

  try {
    $mail = tracker_mail_new($config, $to_email, $to_name);
    $mail->MessageID = tracker_mail_thread_id($code);
    $mail->Subject = $label;

    $greeting_text = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $greeting_html = $to_name !== '' ? 'Hi ' . mail_template_esc($to_name) . ',' : 'Hi,';
    $label_esc = mail_template_esc($label);
    $code_esc = mail_template_esc($code);
    $track_url_esc = mail_template_esc($track_url);

    $content = <<<HTML
      <p style="margin:0 0 16px;">{$greeting_html}</p>
      <p style="margin:0 0 16px;">Thank you for your order! Your project <strong style="color:#FFED54;">&ldquo;{$label_esc}&rdquo;</strong> is now underway.</p>
      {$payment_line_html}
      <div style="background-color:#111111;border:1px solid rgba(255,237,84,0.15);border-radius:8px;padding:18px 20px;margin:24px 0;text-align:center;">
        <div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#888888;margin-bottom:6px;">Your Tracking Code</div>
        <div style="font-size:22px;font-weight:700;letter-spacing:2px;color:#FFED54;font-family:'Courier New',monospace;">{$code_esc}</div>
      </div>
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 20px;">
        <tr><td style="background-color:#FFED54;border-radius:8px;">
          <a href="{$track_url_esc}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#000000;text-decoration:none;">Track My Project &rarr;</a>
        </td></tr>
      </table>
      <p style="margin:0;color:#888888;font-size:13px;">The button above takes you straight to your status &mdash; no need to re-enter the code. Save it in case you check from a different device.</p>
      HTML;

    $mail->Body = mail_template_wrap("Your project \"{$label}\" is now underway — track it anytime.", $content, "You're receiving this because you have an active project with Ariyan Khan.");
    $mail->AltBody =
      "{$greeting_text}\n\n" .
      "Thank you for your order! Your project \"{$label}\" is now underway.\n\n" .
      $payment_line_text .
      "You can track its progress anytime here:\n{$track_url}\n\n" .
      "Your tracking code: {$code}\n\n" .
      "That link takes you straight to your status. Save the code in case you check from a different device.\n\n" .
      "Thanks again,\nAriyan Khan\n";

    $mail->send();
    return true;
  } catch (Throwable $e) {
    $detail = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : $e->getMessage();
    error_log('tracker-mail: order confirmation send failed - ' . $detail);
    return false;
  }
}

function tracker_send_stage_update_email(string $to_email, string $to_name, string $project_label, string $code, string $stage_label, string $delivery_link = ''): bool {
  $config = tracker_mail_config();
  if (!tracker_mail_ready($config)) {
    return false;
  }

  $track_url = rtrim($config['site_url'], '/') . '/track.html?code=' . urlencode($code);
  $review_url = rtrim($config['site_url'], '/') . '/review.html?code=' . urlencode($code);
  $label = $project_label !== '' ? $project_label : 'your project';
  $thread_id = tracker_mail_thread_id($code);
  $mail = null;

  try {
    $mail = tracker_mail_new($config, $to_email, $to_name);
    $mail->Subject = "Re: {$label}";
    $mail->addCustomHeader('In-Reply-To', $thread_id);
    $mail->addCustomHeader('References', $thread_id);

    $greeting_text = $to_name !== '' ? "Hi {$to_name}," : 'Hi,';
    $greeting_html = $to_name !== '' ? 'Hi ' . mail_template_esc($to_name) . ',' : 'Hi,';
    $label_esc = mail_template_esc($label);
    $stage_label_esc = mail_template_esc($stage_label);
    $code_esc = mail_template_esc($code);
    $track_url_esc = mail_template_esc($track_url);
    $review_url_esc = mail_template_esc($review_url);
    $is_delivered = $stage_label === 'Delivered';

    if ($is_delivered) {
      // The download button + expiry note only appear when a delivery
      // link is actually on file (set from the project card) — an admin
      // can still mark a project Delivered without one and this just
      // quietly skips that block.
      $delivery_link_html = '';
      $delivery_link_text = '';
      if ($delivery_link !== '') {
        $delivery_link_esc = mail_template_esc($delivery_link);
        $delivery_link_html = <<<HTML
          <table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 12px;">
            <tr><td style="background-color:#FFED54;border-radius:8px;">
              <a href="{$delivery_link_esc}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;color:#000000;text-decoration:none;">Access Your Files &rarr;</a>
            </td></tr>
          </table>
          <p style="margin:0 0 24px;color:#888888;font-size:13px;">Please download within the next 7&ndash;14 days &mdash; the file is removed after that, so don't wait too long to grab it.</p>
          HTML;
        $delivery_link_text =
          "Access your files here:\n{$delivery_link}\n\n" .
          "Please download within the next 7-14 days — the file is removed after that, so don't wait too long to grab it.\n\n";
      }

      $content = <<<HTML
        <p style="margin:0 0 16px;">{$greeting_html}</p>
        <p style="margin:0 0 16px;">Your project <strong style="color:#FFED54;">&ldquo;{$label_esc}&rdquo;</strong> has been delivered — thanks for working with me on this one.</p>
        {$delivery_link_html}
        <p style="margin:0 0 12px;">If you're happy with how it turned out, I'd really appreciate a quick review — it takes less than a minute: <a href="{$review_url_esc}" style="color:#FFED54;font-weight:700;text-decoration:none;">Leave a Review &rarr;</a></p>
        <p style="margin:0 0 16px;color:#888888;font-size:13px;">You can also see full progress anytime here: <a href="{$track_url_esc}" style="color:#888888;">{$track_url_esc}</a></p>
        <p style="margin:0;color:#888888;font-size:13px;">Your tracking code: <span style="color:#FFFFFF;font-family:'Courier New',monospace;">{$code_esc}</span></p>
        HTML;

      $mail->Body = mail_template_wrap("Your project \"{$label}\" has been delivered.", $content, "You're receiving this because you have an active project with Ariyan Khan.");
      $mail->AltBody =
        "{$greeting_text}\n\n" .
        "Your project \"{$label}\" has been delivered — thanks for working with me on this one.\n\n" .
        $delivery_link_text .
        "If you're happy with how it turned out, I'd really appreciate a quick review — it takes less than a minute:\n{$review_url}\n\n" .
        "You can also see full progress anytime here:\n{$track_url}\n\n" .
        "Your tracking code: {$code}\n\n" .
        "Thanks,\nAriyan Khan\n";
    } else {
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

      $mail->Body = mail_template_wrap("Your project \"{$label}\" just moved to: {$stage_label}", $content, "You're receiving this because you have an active project with Ariyan Khan.");
      $mail->AltBody =
        "{$greeting_text}\n\n" .
        "Your project \"{$label}\" just moved to a new stage: {$stage_label}.\n\n" .
        "You can see full progress anytime here:\n{$track_url}\n\n" .
        "Your tracking code: {$code}\n\n" .
        "Thanks,\nAriyan Khan\n";
    }

    $mail->send();
    return true;
  } catch (Throwable $e) {
    $detail = $mail instanceof PHPMailer ? trim((string) $mail->ErrorInfo) : $e->getMessage();
    error_log('tracker-mail: stage update send failed - ' . $detail);
    return false;
  }
}
