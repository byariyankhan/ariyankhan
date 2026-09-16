<?php
// Shared helpers for the Arrow Atlas account API.
// The database lives outside the web root (a deploy wipes /var/www/html, a Docker volume keeps this), holds no
// email and no password: a sign-in stores only the provider's opaque user id and the display name the provider
// gives. Sessions are random tokens kept hashed, sent as a host-only, HttpOnly, SameSite=Lax cookie.
declare(strict_types=1);

const AA_COOKIE = 'aa_session';
const AA_SIGNUP_GOLD = 10000;   // what a new player starts with, once, when the account is created
const AA_STAKES = [500, 1000, 7000];        // the three stakes a player can pick; the stake never touches the board
const AA_MATCH_HOURS = 24;      // an invitation nobody accepts is refunded after this
const AA_MATCH_SEATS = 7;       // how many can be in one room
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
    $db->exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL, sub TEXT NOT NULL, name TEXT NOT NULL DEFAULT \'\', gold INTEGER NOT NULL DEFAULT ' . AA_SIGNUP_GOLD . ', created INTEGER NOT NULL, seen INTEGER NOT NULL, UNIQUE(provider, sub))');
    // gold arrived after the first accounts did: the column default hands the same welcome purse to those rows
    $cols = array_column($db->query('PRAGMA table_info(users)')->fetchAll(), 'name');
    if (!in_array('gold', $cols, true)) $db->exec('ALTER TABLE users ADD COLUMN gold INTEGER NOT NULL DEFAULT ' . AA_SIGNUP_GOLD);
    $db->exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)');
    $db->exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)');
    // A gold match: everyone in the room stakes the same, everyone plays the very same board, and the first to
    // clear it takes the pot. The room stays open until the host starts it.
    $db->exec('CREATE TABLE IF NOT EXISTS matches (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, board TEXT NOT NULL, tier INTEGER NOT NULL, seed INTEGER NOT NULL, state TEXT NOT NULL, winner_id INTEGER, created INTEGER NOT NULL, started INTEGER, settled INTEGER)');
    // one row per player: pct is how far along they are, ms their own clock (-1 = out of hearts), done the moment
    // their result reached the server, which is what decides who finished first.
    $db->exec('CREATE TABLE IF NOT EXISTS match_players (code TEXT NOT NULL, user_id INTEGER NOT NULL, joined INTEGER NOT NULL, tier INTEGER NOT NULL DEFAULT 2, pct INTEGER NOT NULL DEFAULT 0, ms INTEGER, done INTEGER, PRIMARY KEY (code, user_id))');
    $pcols = array_column($db->query('PRAGMA table_info(match_players)')->fetchAll(), 'name');
    if ($pcols && !in_array('tier', $pcols, true)) $db->exec('ALTER TABLE match_players ADD COLUMN tier INTEGER NOT NULL DEFAULT 2');
    $db->exec('CREATE INDEX IF NOT EXISTS matches_host ON matches(host_id)');
    $db->exec('CREATE INDEX IF NOT EXISTS match_players_user ON match_players(user_id)');
    aa_migrate_matches($db);
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
    $st = $db->prepare('SELECT u.id, u.name, u.provider, u.gold, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ?');
    $st->execute([aa_hash($token)]);
    $row = $st->fetch();
    if (!$row) return null;
    if ((int)$row['expires'] < time()) { $db->prepare('DELETE FROM sessions WHERE hash = ?')->execute([aa_hash($token)]); return null; }
    return ['id' => (int)$row['id'], 'name' => (string)$row['name'], 'provider' => (string)$row['provider'], 'gold' => (int)$row['gold']];
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

// Fetch Google's verdict on an ID token. Split out so the checks below can be tested without the network.
function aa_google_fetch(string $idToken): ?string {
    $url = 'https://oauth2.googleapis.com/tokeninfo?id_token=' . urlencode($idToken);
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 6, CURLOPT_CONNECTTIMEOUT => 4]);
        $body = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $code === 200 && is_string($body) ? $body : null;
    }
    if (ini_get('allow_url_fopen')) {
        $body = @file_get_contents($url, false, stream_context_create(['http' => ['timeout' => 6]]));
        return is_string($body) ? $body : null;
    }
    return null;
}

// Is this ID token real, meant for this site, and still valid? Returns the claims we keep, or null.
function aa_google_verify(string $idToken, string $clientId, ?callable $fetch = null): ?array {
    if ($idToken === '' || strlen($idToken) > 4096 || $clientId === '') return null;
    $body = ($fetch ?? 'aa_google_fetch')($idToken);
    if (!is_string($body) || $body === '') return null;
    $d = json_decode($body, true);
    if (!is_array($d)) return null;
    $iss = $d['iss'] ?? '';
    if (($d['aud'] ?? '') !== $clientId) return null;
    if ($iss !== 'accounts.google.com' && $iss !== 'https://accounts.google.com') return null;
    if ((int)($d['exp'] ?? 0) <= time()) return null;
    if (array_key_exists('email_verified', $d) && ($d['email_verified'] === false || $d['email_verified'] === 'false')) return null;
    $sub = (string)($d['sub'] ?? '');
    if ($sub === '') return null;
    return ['sub' => $sub, 'name' => aa_name((string)($d['name'] ?? ''))];
}

// One account per provider id. Returns the user id, creating the row the first time someone signs in; a new
// account starts with AA_SIGNUP_GOLD (the column default), and signing in again never tops it up.
function aa_upsert_user(PDO $db, string $provider, string $sub, string $name, ?bool &$created = null): int {
    $now = time();
    $created = false;
    $st = $db->prepare('SELECT id FROM users WHERE provider = ? AND sub = ?');
    $st->execute([$provider, $sub]);
    $id = $st->fetchColumn();
    if ($id !== false) {
        $db->prepare('UPDATE users SET seen = ?, name = CASE WHEN name = \'\' THEN ? ELSE name END WHERE id = ?')->execute([$now, $name, (int)$id]);
        return (int)$id;
    }
    $db->prepare('INSERT INTO users (provider, sub, name, created, seen) VALUES (?, ?, ?, ?, ?)')->execute([$provider, $sub, $name, $now, $now]);
    $created = true;   // the welcome gold comes from the column default, so it lands once and only here
    return (int)$db->lastInsertId();
}

// ── Gold matches ──

function aa_gold(PDO $db, int $userId): int {
    $st = $db->prepare('SELECT gold FROM users WHERE id = ?');
    $st->execute([$userId]);
    $g = $st->fetchColumn();
    return $g === false ? 0 : (int)$g;
}

// Take a stake out of a purse. False when there is not enough, so a match can never be created on credit.
function aa_take_gold(PDO $db, int $userId, int $amount): bool {
    $st = $db->prepare('UPDATE users SET gold = gold - ? WHERE id = ? AND gold >= ?');
    $st->execute([$amount, $userId, $amount]);
    return $st->rowCount() === 1;
}

function aa_give_gold(PDO $db, int $userId, int $amount): void {
    $db->prepare('UPDATE users SET gold = gold + ? WHERE id = ?')->execute([$amount, $userId]);
}

function aa_match_code(PDO $db): string {
    $alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no I, O, 0 or 1: these get read out loud
    for ($try = 0; $try < 40; $try++) {
        $code = '';
        for ($i = 0; $i < 6; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
        $st = $db->prepare('SELECT 1 FROM matches WHERE code = ?');
        $st->execute([$code]);
        if ($st->fetchColumn() === false) return $code;
    }
    throw new RuntimeException('could not find a free match code');
}

// A country from the tour, picked by the server so neither player can choose an easy one.
function aa_pick_board(): ?string {
    static $ids = null;
    if ($ids === null) {
        $ids = [];
        $raw = @file_get_contents(dirname(__DIR__) . '/data/arrow-atlas.json');
        $data = $raw ? json_decode($raw, true) : null;
        foreach (($data['levels'] ?? []) as $L) if (isset($L['id'])) $ids[] = (string)$L['id'];
    }
    return $ids ? $ids[random_int(0, count($ids) - 1)] : null;
}

// The first shape of a match held two seats in the matches table. Anything still unfinished from then is handed
// back rather than quietly changed under the players.
function aa_migrate_matches(PDO $db): void {
    $cols = array_column($db->query('PRAGMA table_info(matches)')->fetchAll(), 'name');
    if (!in_array('guest_id', $cols, true)) return;
    foreach ($db->query("SELECT * FROM matches WHERE state IN ('open','playing')")->fetchAll() as $m) {
        aa_give_gold($db, (int)$m['host_id'], (int)$m['stake']);
        if (!empty($m['guest_id'])) aa_give_gold($db, (int)$m['guest_id'], (int)$m['stake']);
        $db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ?")->execute([time(), $m['code']]);
    }
    $db->exec('ALTER TABLE matches RENAME TO matches_v1');
    $db->exec('CREATE TABLE matches (code TEXT PRIMARY KEY, host_id INTEGER NOT NULL, stake INTEGER NOT NULL, board TEXT NOT NULL, tier INTEGER NOT NULL, seed INTEGER NOT NULL, state TEXT NOT NULL, winner_id INTEGER, created INTEGER NOT NULL, started INTEGER, settled INTEGER)');
    $db->exec('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, winner_id, created, settled) SELECT code, host_id, stake, board, tier, seed, state, winner_id, created, settled FROM matches_v1');
    $db->exec('DROP TABLE matches_v1');
}

function aa_room(PDO $db, string $code): array {
    $st = $db->prepare('SELECT mp.*, u.name FROM match_players mp JOIN users u ON u.id = mp.user_id WHERE mp.code = ? ORDER BY mp.joined');
    $st->execute([$code]);
    return $st->fetchAll();
}

function aa_seat(PDO $db, string $code, int $userId, int $tier = 2): void {
    $db->prepare('INSERT OR IGNORE INTO match_players (code, user_id, joined, tier) VALUES (?, ?, ?, ?)')->execute([$code, $userId, time(), max(0, min(4, $tier))]);
}

// The board is as hard as the room deserves: the middle of everyone's own difficulty, never the size of the
// stake. Gold buys a bigger pot, never an easier board.
function aa_room_tier(PDO $db, string $code): int {
    $tiers = array_map(fn($p) => max(0, min(4, (int)$p['tier'])), aa_room($db, $code));
    if (!$tiers) return 2;
    return (int)max(0, min(4, (int)round(array_sum($tiers) / count($tiers))));
}

// Everyone in the room, first place first. Whoever cleared the board earliest leads, because the race is won by
// finishing first, not by the shortest clock; then the players still going, the one furthest along in front; and
// last anyone who ran out of hearts.
function aa_match_players(PDO $db, array $m, ?array $me): array {
    $rows = [];
    foreach (aa_room($db, $m['code']) as $p) {
        $ms = $p['ms'] === null ? null : (int)$p['ms'];
        $done = $p['done'] === null ? null : (int)$p['done'];
        $rows[] = [
            'name' => (string)$p['name'],
            'pct' => $ms !== null && $ms > 0 ? 100 : max(0, min(100, (int)$p['pct'])),
            'ms' => $ms,
            'race_ms' => $done !== null && $ms !== null && $ms > 0 && $m['started'] ? max(0, $done - (int)$m['started'] * 1000) : null,
            'you' => $me !== null && (int)$p['user_id'] === $me['id'],
            'host' => (int)$p['user_id'] === (int)$m['host_id'],
            'won' => $m['winner_id'] !== null && (int)$p['user_id'] === (int)$m['winner_id'],
        ];
        $rows[count($rows) - 1]['_done'] = $done;
    }
    usort($rows, function ($a, $b) {
        $rank = fn($p) => $p['ms'] !== null && $p['ms'] > 0 ? 0 : ($p['ms'] === null ? 1 : 2);
        if ($rank($a) !== $rank($b)) return $rank($a) <=> $rank($b);
        if ($rank($a) === 0) return ($a['_done'] ?? 0) <=> ($b['_done'] ?? 0);
        return $b['pct'] <=> $a['pct'];
    });
    foreach ($rows as $i => $_) { $rows[$i]['place'] = $i + 1; unset($rows[$i]['_done']); }
    return $rows;
}

// Nobody's stake is allowed to sit in limbo. A room nobody joined, or one the host never started, is handed
// back; a match where someone never finished is settled a day later with the missing run counted as a loss.
function aa_expire_matches(PDO $db): void {
    $cut = time() - AA_MATCH_HOURS * 3600;
    $st = $db->prepare("SELECT code, stake FROM matches WHERE state = 'open' AND created < ? LIMIT 20");
    $st->execute([$cut]);
    foreach ($st->fetchAll() as $m) {
        $db->beginTransaction();
        $upd = $db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ? AND state = 'open'");
        $upd->execute([time(), $m['code']]);
        if ($upd->rowCount() === 1) foreach (aa_room($db, $m['code']) as $p) aa_give_gold($db, (int)$p['user_id'], (int)$m['stake']);
        $db->commit();
    }
    $st = $db->prepare("SELECT code FROM matches WHERE state = 'playing' AND created < ? LIMIT 20");
    $st->execute([$cut]);
    foreach ($st->fetchAll() as $m) {
        $db->prepare('UPDATE match_players SET ms = -1, done = ? WHERE code = ? AND ms IS NULL')->execute([time() * 1000, $m['code']]);
        aa_settle_match($db, aa_match_row_raw($db, $m['code']));
    }
}

function aa_match_row_raw(PDO $db, string $code): ?array {
    $st = $db->prepare('SELECT * FROM matches WHERE code = ?');
    $st->execute([$code]);
    return $st->fetch() ?: null;
}

// The first player to clear the board takes the whole pot the moment their result lands: nobody waits on the
// rest. The others play on for second, third, fourth place — the places are still theirs to win, the gold is
// not. The match itself only closes once everyone has reported, and if not one of them cleared it every stake
// goes back.
function aa_settle_match(PDO $db, array $m): array {
    $room = aa_room($db, $m['code']);
    if (!$room) return $m;
    $first = null; $best = null; $everyoneIn = true;
    foreach ($room as $p) {
        if ($p['ms'] === null) { $everyoneIn = false; continue; }
        if ((int)$p['ms'] <= 0) continue;
        if ($best === null || (int)$p['done'] < $best) { $best = (int)$p['done']; $first = (int)$p['user_id']; }
    }
    $stake = (int)$m['stake'];
    if ($m['winner_id'] === null && $first !== null) {
        $db->beginTransaction();
        $upd = $db->prepare("UPDATE matches SET winner_id = ?, settled = ? WHERE code = ? AND state = 'playing' AND winner_id IS NULL");
        $upd->execute([$first, time(), $m['code']]);
        if ($upd->rowCount() === 1) aa_give_gold($db, $first, $stake * count($room));
        $db->commit();
        $m['winner_id'] = aa_match_row_raw($db, $m['code'])['winner_id'] ?? null;   // whoever won the race to the row
    }
    if (!$everyoneIn) return $m;                       // the rest are still on the board, playing for their place
    $db->beginTransaction();
    $upd = $db->prepare("UPDATE matches SET state = 'done', settled = ? WHERE code = ? AND state = 'playing'");
    $upd->execute([time(), $m['code']]);
    if ($upd->rowCount() === 1 && $m['winner_id'] === null) foreach ($room as $p) aa_give_gold($db, (int)$p['user_id'], $stake);
    $db->commit();
    $m['state'] = 'done';
    return $m;
}

function aa_player_name(PDO $db, ?int $id): string {
    if (!$id) return '';
    $st = $db->prepare('SELECT name FROM users WHERE id = ?');
    $st->execute([$id]);
    return (string)($st->fetchColumn() ?: 'A friend');
}
