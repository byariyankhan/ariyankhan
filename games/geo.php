<?php
// Arrow Atlas: which country is the player in? Cloudflare adds the two-letter country code it derives from the
// connection to every request (CF-IPCountry). Nothing is stored or logged here; the code only decides which
// country the player's World Tour starts from. Without Cloudflare (local server) the answer is empty.
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
$c = isset($_SERVER['HTTP_CF_IPCOUNTRY']) ? strtoupper(trim($_SERVER['HTTP_CF_IPCOUNTRY'])) : '';
if (!preg_match('/^[A-Z]{2}$/', $c) || $c === 'XX' || $c === 'T1') $c = '';
echo json_encode(['c' => $c]);
