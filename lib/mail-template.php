<?php
/* ══════════════════════════════════════════════════
   Shared branded HTML email shell — used by both
   lib/tracker-mail.php (order/stage notifications)
   and lib/inbox-mail.php (admin-composed messages).
   Table-based layout with inline styles for cross-
   client compatibility (Outlook/Gmail/Apple Mail all
   render this reliably).
   ══════════════════════════════════════════════════ */

function mail_template_esc(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}

function mail_template_wrap(string $preheader, string $content_html, string $footer_note = ''): string {
  $avatar = 'https://ariyankhan.com/images/ariyan-khan-profile.webp';
  $year = date('Y');
  $preheader_esc = mail_template_esc($preheader);
  $footer_note_esc = mail_template_esc($footer_note);

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

  $footer_note_html = $footer_note_esc !== ''
    ? '<div style="font-size:11px;color:#555555;margin-top:4px;">' . $footer_note_esc . '</div>'
    : '';

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
                    <div style="font-size:12px;"><a href="https://ariyankhan.com" style="color:#888888;text-decoration:none;">ariyankhan.com</a></div>
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
              {$footer_note_html}
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
