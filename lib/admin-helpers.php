<?php
/* ══════════════════════════════════════════════════
   Shared helper for every dashboard/*.php page.
   ══════════════════════════════════════════════════ */

function e(string $value): string {
  return htmlspecialchars($value, ENT_QUOTES, 'UTF-8');
}
