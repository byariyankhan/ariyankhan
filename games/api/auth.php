<?php
// Arrow Atlas accounts. Signing in is only needed to play with other people; the single-player game never asks.
// Actions: me (who am I, which providers work), google (sign in with a Google ID token), name (rename),
// logout, delete (remove the account and everything attached to it).
declare(strict_types=1);
require __DIR__ . '/lib.php';

$action = $_GET['a'] ?? 'me';
$post = $_SERVER['REQUEST_METHOD'] === 'POST';

try {
    $db = aa_db();
} catch (Throwable $e) {
    aa_json(['error' => 'storage'], 503);
}
$providers = aa_providers();
$me = aa_current_user($db);
$shape = fn(?array $u) => $u ? ['id' => (int)$u['id'], 'name' => (string)$u['name'], 'provider' => (string)$u['provider'], 'pic' => (string)($u['pic'] ?? ''), 'gold' => (int)($u['gold'] ?? 0)] : null;

if ($action === 'me') {
    aa_json(['user' => $shape($me), 'providers' => ['google' => $providers['google'] ?? null]]);
}

if ($action === 'google') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    $clientId = $providers['google'] ?? null;
    if (!$clientId) aa_json(['error' => 'google_not_configured'], 503);
    $token = (string)(aa_body()['credential'] ?? '');
    $claims = aa_google_verify($token, $clientId);
    if (!$claims) aa_json(['error' => 'bad_token'], 401);
    $id = aa_upsert_user($db, 'google', $claims['sub'], $claims['name'], $created, $claims['pic']);
    aa_start_session($db, $id);
    $st = $db->prepare('SELECT id, name, provider, pic, gold FROM users WHERE id = ?');
    $st->execute([$id]);
    aa_json(['user' => $shape($st->fetch() ?: null), 'gold_granted' => $created ? AA_SIGNUP_GOLD : 0]);
}

if ($action === 'name') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $name = aa_name((string)(aa_body()['name'] ?? ''));
    if ($name === '') aa_json(['error' => 'empty_name'], 400);
    $db->prepare('UPDATE users SET name = ? WHERE id = ?')->execute([$name, $me['id']]);
    aa_json(['user' => $shape(['id' => $me['id'], 'name' => $name, 'provider' => $me['provider'], 'pic' => $me['pic'], 'gold' => $me['gold']])]);
}

if ($action === 'logout') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    aa_end_session($db);
    aa_json(['user' => null]);
}

if ($action === 'delete') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$me['id']]);
    $db->prepare('DELETE FROM users WHERE id = ?')->execute([$me['id']]);
    aa_end_session($db);
    aa_json(['user' => null, 'deleted' => true]);
}

aa_json(['error' => 'unknown_action'], 404);
