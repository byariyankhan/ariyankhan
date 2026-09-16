<?php
// Shared helpers for the Arrow Atlas account API.
// The database lives outside the web root (a deploy wipes /var/www/html, a Docker volume keeps this), holds no
// email and no password: a sign-in stores only the provider's opaque user id and the display name the provider
// gives. Sessions are random tokens kept hashed, sent as a host-only, HttpOnly, SameSite=Lax cookie.
declare(strict_types=1);

const AA_COOKIE = 'aa_session';
const AA_SESSION_DAYS = 180;

function aa_json($data, int $code = 200): void {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function aa_data_dir(): string {
    $dir = getenv('AA_DATA_DIR');
    return $dir !== false && trim($dir) !== '' ? rtrim(trim($dir), '/') : '/var/lib/arrow-atlas';
}

function aa_db(): PDO {
    $dir = aa_data_dir();
    if (!is_dir($dir)) @mkdir($dir, 0770, true);
    $db = new PDO('sqlite:' . $dir . '/arrow-atlas.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $db->exec('PRAGMA journal_mode=WAL');
    $db->exec('PRAGMA busy_timeout=4000');
    $db->exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', created INTEGER NOT NULL, seen INTEGER NOT NULL, UNIQUE(provider, sub))');
    $db->exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)');
    return $db;
}

function aa_name(string $raw): string {
    $n = preg_replace('/[\p{C}~]+/u', ' ', $raw) ?? '';
    $n = trim(preg_replace('/\s+/u', ' ', $n) ?? '');
    return mb_substr($n, 0, 24);
}

function aa_hash(string $token): string { return hash('sha256', $token); }

// Which providers this server can actually sign people in with (an id is set in the container's environment).
function aa_providers(): array {
    $g = getenv('GOOGLE_CLIENT_ID');
    return ['google' => $g !== false && trim($g) !== '' ? trim($g) : null];
}

function aa_current_user(PDO $db): ?array {
    $token = $_COOKIE[AA_COOKIE] ?? '';
    if (!is_string($token) || strlen($token) < 20) return null;
    $st = $db->prepare('SELECT u.id, u.name, u.provider, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?');
    $st->execute([aa_hash($token)]);
    $row = $st->fetch();
    if (!$row) return null;
    if ((int)$row['expires'] < time()) { $db->prepare('DELETE FROM sessions WHERE hash = ?')->execute([aa_hash($token)]); return null; }
    return ['id' => (int)$row['id'], 'name' => (string)$row['name'], 'provider' => (string)$row['provider']];
}

function aa_start_session(PDO $db, int $userId): void {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $exp = $now + AA_SESSION_DAYS * 86400;
    $db->prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?, ?, ?, ?)')->execute([aa_hash($token), $userId, $now, $exp]);
    $db->prepare('DELETE FROM sessions WHERE expires < ?')->execute([$now]);
    setcookie(AA_COOKIE, $token, [
        'expires' => $exp, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax',
        'secure' => (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' || ($_SERVER['HTTPS'] ?? '') === 'on'),
    ]);
}

function aa_end_session(PDO $db): void {
    $token = $_COOKIE[AA_COOKIE] ?? '';
    if (is_string($token) && $token !== '') $db->prepare('DELETE FROM sessions WHERE hash = ?')->execute([aa_hash($token)]);
    setcookie(AA_COOKIE, '', ['expires' => time() - 3600, 'path' => '/', 'httponly' => true, 'samesite' => 'Lax']);
}

function aa_body(): array {
    $raw = file_get_contents('php://input') ?: '';
    $data = json_decode($raw, true);
    return is_array($data) ? $data : [];
}

// Ask Google whether this ID token is real and was issued for this site.
function aa_google_verify(string $idToken, string $clientId): ?array {
    if ($idToken === '' || strlen($idToken) > 4096) return null;
    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);
    $body = null;
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6, CURLOPT_CONNECTTIMEOUT => 4]);
        $body = curl_exec($ch);
        if (curl_getinfo($ch, CURLINFO_RESPONSE_CODE) !== 200) $body = null;
        curl_close($ch);
    } elseif (ini_get('allow_url_fopen')) {
        $body = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 6]]));
    }
    if (!is_string($body) || $body === '') return null;
    $d = json_decode($body, true);
    if (!is_array($d)) return null;
    $iss = $d['iss'] ?? '';
    if (($d['aud'] ?? '') !== $clientId) return null;
    if ($iss !== 'accounts.google.com' && $iss !== 'https://accounts.google.com') return null;
    if ((int)($d['exp'] ?? 0) <= time()) return null;
    $sub = (string)($d['sub'] ?? '');
    if ($sub === '') return null;
    return ['sub' => $sub, 'name' => aa_name((string)($d['name'] ?? ''))];
}
