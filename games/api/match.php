<?php
// Gold matches: a player stakes gold, invites a friend with a link, and whoever clears the very same board
// faster takes the pot. The server holds both stakes, picks the board and decides the winner, so neither side
// can pick an easy country, change the board or award itself gold.
declare(strict_types=1);
require __DIR__ . '/lib.php';

$action = $_GET['a'] ?? 'get';
$post = $_SERVER['REQUEST_METHOD'] === 'POST';

try { $db = aa_db(); } catch (Throwable $e) { aa_json(['error' => 'storage'], 503); }
$me = aa_current_user($db);
aa_expire_matches($db);

function aa_match_row(PDO $db, string $code): ?array {
    $st = $db->prepare('SELECT * FROM matches WHERE code = ?');
    $st->execute([strtoupper($code)]);
    $row = $st->fetch();
    return $row ?: null;
}

// What a player is allowed to see. The board and the seed only go to the two players, and only once the match
// is on, so an invitation cannot be scouted before it is accepted.
function aa_match_view(PDO $db, array $m, ?array $me): array {
    $mine = $me && ((int)$m['host_id'] === $me['id'] || (int)$m['guest_id'] === $me['id']);
    $isHost = $me && (int)$m['host_id'] === $me['id'];
    $out = [
        'code' => $m['code'],
        'stake' => (int)$m['stake'],
        'state' => $m['state'],
        'host' => aa_player_name($db, (int)$m['host_id']),
        'guest' => aa_player_name($db, $m['guest_id'] === null ? null : (int)$m['guest_id']),
        'you' => $mine ? ($isHost ? 'host' : 'guest') : '',
    ];
    if ($mine && $m['state'] !== 'open') {
        $out += ['board' => $m['board'], 'tier' => (int)$m['tier'], 'seed' => (int)$m['seed']];
    }
    if ($mine) {
        $mineMs = $isHost ? $m['host_ms'] : $m['guest_ms'];
        $themMs = $isHost ? $m['guest_ms'] : $m['host_ms'];
        $out += ['your_ms' => $mineMs === null ? null : (int)$mineMs, 'their_ms' => $themMs === null ? null : (int)$themMs];
    }
    $out['players'] = aa_match_players($db, $m, $me);
    if ($m['state'] === 'done') {
        $out['winner'] = $m['winner_id'] === null ? '' : aa_player_name($db, (int)$m['winner_id']);
        $out['you_won'] = $mine && $m['winner_id'] !== null && (int)$m['winner_id'] === $me['id'];
        $out['draw'] = $m['winner_id'] === null;
    }
    return $out;
}

if ($action === 'create') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $stake = (int)(aa_body()['stake'] ?? 0);
    if (!in_array($stake, AA_STAKES, true)) aa_json(['error' => 'bad_stake'], 400);
    if (aa_gold($db, $me['id']) < $stake) aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400);
    $board = aa_pick_board();
    if ($board === null) aa_json(['error' => 'no_boards'], 503);
    $db->beginTransaction();
    if (!aa_take_gold($db, $me['id'], $stake)) { $db->rollBack(); aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400); }
    $code = aa_match_code($db);
    $db->prepare('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$code, $me['id'], $stake, $board, AA_STAKE_TIER[$stake], random_int(100000, 999999), 'open', time()]);
    $db->commit();
    aa_json(['match' => aa_match_view($db, aa_match_row($db, $code), $me), 'gold' => aa_gold($db, $me['id'])]);
}

if ($action === 'cancel') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $m = aa_match_row($db, (string)(aa_body()['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    if ((int)$m['host_id'] !== $me['id']) aa_json(['error' => 'not_yours'], 403);
    if ($m['state'] !== 'open') aa_json(['error' => 'taken'], 409);
    $db->beginTransaction();
    $upd = $db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ? AND state = 'open'");
    $upd->execute([time(), $m['code']]);
    if ($upd->rowCount() !== 1) { $db->rollBack(); aa_json(['error' => 'taken'], 409); }
    aa_give_gold($db, $me['id'], (int)$m['stake']);   // the invitation is off, so the stake comes back
    $db->commit();
    aa_json(['match' => aa_match_view($db, aa_match_row($db, $m['code']), $me), 'gold' => aa_gold($db, $me['id'])]);
}

if ($action === 'progress') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    $m = aa_match_row($db, (string)($body['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    $isHost = (int)$m['host_id'] === $me['id'];
    $isGuest = $m['guest_id'] !== null && (int)$m['guest_id'] === $me['id'];
    if (!$isHost && !$isGuest) aa_json(['error' => 'not_yours'], 403);
    if ($m['state'] === 'playing' && isset($body['pct'])) {
        $pct = max(0, min(100, (int)$body['pct']));
        $col = $isHost ? 'host_pct' : 'guest_pct';
        $db->prepare("UPDATE matches SET $col = ? WHERE code = ? AND $col < ?")->execute([$pct, $m['code'], $pct]);
        $m = aa_match_row($db, $m['code']);
    }
    aa_json(['match' => aa_match_view($db, $m, $me), 'gold' => aa_gold($db, $me['id'])]);
}

if ($action === 'get') {
    $code = (string)($_GET['code'] ?? '');
    $m = $code === '' ? null : aa_match_row($db, $code);
    if (!$m) aa_json(['error' => 'no_match'], 404);
    aa_json(['match' => aa_match_view($db, $m, $me), 'gold' => $me ? aa_gold($db, $me['id']) : null]);
}

if ($action === 'join') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $m = aa_match_row($db, (string)(aa_body()['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    if ((int)$m['host_id'] === $me['id']) aa_json(['error' => 'own_match'], 400);
    if ($m['state'] !== 'open') aa_json(['error' => 'taken'], 409);
    $stake = (int)$m['stake'];
    if (aa_gold($db, $me['id']) < $stake) aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400);
    $db->beginTransaction();
    if (!aa_take_gold($db, $me['id'], $stake)) { $db->rollBack(); aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400); }
    $upd = $db->prepare("UPDATE matches SET guest_id = ?, state = 'playing' WHERE code = ? AND state = 'open'");
    $upd->execute([$me['id'], $m['code']]);
    if ($upd->rowCount() !== 1) { $db->rollBack(); aa_json(['error' => 'taken'], 409); }
    $db->commit();
    aa_json(['match' => aa_match_view($db, aa_match_row($db, $m['code']), $me), 'gold' => aa_gold($db, $me['id'])]);
}

if ($action === 'result') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    $m = aa_match_row($db, (string)($body['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    $isHost = (int)$m['host_id'] === $me['id'];
    $isGuest = $m['guest_id'] !== null && (int)$m['guest_id'] === $me['id'];
    if (!$isHost && !$isGuest) aa_json(['error' => 'not_yours'], 403);
    if ($m['state'] !== 'playing') aa_json(['match' => aa_match_view($db, $m, $me), 'gold' => aa_gold($db, $me['id'])]);
    $ms = (int)($body['ms'] ?? -1);
    $ms = ($body['cleared'] ?? false) === true && $ms > 0 ? min($ms, 24 * 3600 * 1000) : -1;
    $col = $isHost ? 'host_ms' : 'guest_ms';
    // first result only: a second attempt must never overwrite a time
    $db->prepare("UPDATE matches SET $col = ? WHERE code = ? AND $col IS NULL")->execute([$ms, $m['code']]);
    $m = aa_match_row($db, $m['code']);
    if ($m['host_ms'] !== null && $m['guest_ms'] !== null) $m = aa_settle_match($db, aa_match_row($db, $m['code']));
    aa_json(['match' => aa_match_view($db, aa_match_row($db, $m['code']), $me), 'gold' => aa_gold($db, $me['id'])]);
}

aa_json(['error' => 'unknown_action'], 404);
