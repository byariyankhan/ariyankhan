<?php
/* ══════════════════════════════════════════════════
   Shared helper for every admin/*.php page.
   ══════════════════════════════════════════════════ */

function e(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
