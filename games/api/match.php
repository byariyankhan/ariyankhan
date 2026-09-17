<?php
// Gold matches. The host stakes gold and gets a room code; friends open the link and put the same stake in.
// A room can also fill itself from whoever else is online at that stake, and then it starts on its own: at
// seven players, or forty seconds after the second one sat down. Everyone plays the very same board and the
// first to clear it takes the whole pot. The server holds the stakes, picks the board, times the finishes and pays out, so no
// client can pick an easy country, improve a time on a second try or award itself gold.
declare(strict_types=1);
require __DIR__ . '/lib.php';

$action = $_GET['a'] ?? 'get';
$post = $_SERVER['REQUEST_METHOD'] === 'POST';

try { $db = aa_db(); } catch (Throwable $e) { aa_json(['error' => 'storage'], 503); }
$me = aa_current_user($db);
aa_expire_matches($db);
aa_autostart_matches($db);

function aa_match_row(PDO $db, string $code): ?array {
    return aa_match_row_raw($db, strtoupper(trim($code)));
}

// What a player may see. The board only goes to the players, and only once the host has started, so nobody can
// study it while the room is filling up.
function aa_match_view(PDO $db, array $m, ?array $me): array {
    $players = aa_match_players($db, $m, $me);
    $mine = false;
    foreach (aa_room($db, $m['code']) as $p) if ($me && (int)$p['user_id'] === $me['id']) $mine = true;
    $isHost = $me && (int)$m['host_id'] === $me['id'];
    $out = [
        'code' => $m['code'],
        'stake' => (int)$m['stake'],
        'state' => $m['state'],
        'players' => $players,
        'count' => count($players),
        'seats' => AA_MATCH_SEATS,
        'pot' => (int)$m['stake'] * max(1, count($players)),
        'host' => aa_player_name($db, (int)$m['host_id']),
        'you' => $mine ? ($isHost ? 'host' : 'guest') : '',
        'can_start' => $isHost && $m['state'] === 'open' && count($players) > 1,
        'open_to_all' => (bool)$m['open_to_all'],
        // seconds until it begins on its own; null in an invite-only room, or before the second player arrives
        'fills_in' => $m['fills_at'] === null || $m['state'] !== 'open' ? null : max(0, (int)$m['fills_at'] - time()),
    ];
    if ($mine && $m['state'] !== 'open') {
        $out += ['board' => $m['board'], 'tier' => (int)$m['tier'], 'seed' => (int)$m['seed']];
        foreach ($players as $p) if (!empty($p['you'])) { $out['your_ms'] = $p['ms']; break; }
    }
    // the pot is paid the instant somebody clears it, so the winner is named long before the match closes
    if ($m['winner_id'] !== null) {
        $out['winner'] = aa_player_name($db, (int)$m['winner_id']);
        $out['you_won'] = $mine && (int)$m['winner_id'] === $me['id'];
    }
    if ($m['state'] === 'done') $out['draw'] = $m['winner_id'] === null;
    return $out;
}

// Sit down in a room and answer. Used both by a friend opening an invitation link and by a player who asked to
// be put wherever there is a seat at this stake.
function aa_join_room(PDO $db, array $me, string $code, int $tier): void {
    $m = aa_match_row($db, $code);
    if (!$m) aa_json(['error' => 'no_match'], 404);
    if ($m['state'] !== 'open') aa_json(['error' => 'taken'], 409);
    $room = aa_room($db, $m['code']);
    foreach ($room as $p) if ((int)$p['user_id'] === $me['id']) aa_reply($db, $m['code'], $me);   // already in
    if (count($room) >= AA_MATCH_SEATS) aa_json(['error' => 'room_full'], 409);
    $db->beginTransaction();
    if (!aa_take_gold($db, $me['id'], (int)$m['stake'])) { $db->rollBack(); aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400); }
    aa_seat($db, $m['code'], $me['id'], $tier);
    $db->commit();
    aa_room_joined($db, $m['code']);   // seven of them start at once; the second starts the clock
    aa_reply($db, $m['code'], $me);
}

function aa_reply(PDO $db, string $code, ?array $me): void {
    aa_json(['match' => aa_match_view($db, aa_match_row($db, $code), $me), 'gold' => $me ? aa_gold($db, $me['id']) : null]);
}

if ($action === 'create') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    $stake = (int)($body['stake'] ?? 0);
    if (!in_array($stake, AA_STAKES, true)) aa_json(['error' => 'bad_stake'], 400);
    // with open_to_all on, walk into the room already waiting at this stake rather than opening a second one
    if (!empty($body['open_to_all'])) {
        $waiting = aa_open_room($db, $stake, $me['id']);
        if ($waiting !== null) aa_join_room($db, $me, $waiting, (int)($body['tier'] ?? 2));
    }
    $board = aa_pick_board();
    if ($board === null) aa_json(['error' => 'no_boards'], 503);
    $db->beginTransaction();
    if (!aa_take_gold($db, $me['id'], $stake)) { $db->rollBack(); aa_json(['error' => 'not_enough_gold', 'gold' => aa_gold($db, $me['id'])], 400); }
    $code = aa_match_code($db);
    $db->prepare('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, created, open_to_all) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$code, $me['id'], $stake, $board, 2, random_int(100000, 999999), 'open', time(), empty($body['open_to_all']) ? 0 : 1]);
    aa_seat($db, $code, $me['id'], (int)($body['tier'] ?? 2));
    $db->commit();
    aa_reply($db, $code, $me);
}

if ($action === 'get') {
    $m = aa_match_row($db, (string)($_GET['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    // still sitting alone in a room that fills itself? walk into an older one if one has turned up since
    if ($me) { $moved = aa_requeue($db, $m, $me['id']); if ($moved !== null) aa_reply($db, $moved, $me); }
    aa_reply($db, $m['code'], $me);
}

if ($action === 'join') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    aa_join_room($db, $me, (string)($body['code'] ?? ''), (int)($body['tier'] ?? 2));
}

if ($action === 'start') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $m = aa_match_row($db, (string)(aa_body()['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    if ((int)$m['host_id'] !== $me['id']) aa_json(['error' => 'not_host'], 403);
    if ($m['state'] !== 'open') aa_json(['error' => 'taken'], 409);
    if (count(aa_room($db, $m['code'])) < 2) aa_json(['error' => 'need_two'], 400);
    aa_start_room($db, $m['code']);   // the board is set now, from the players who actually turned up
    aa_reply($db, $m['code'], $me);
}

if ($action === 'cancel') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $m = aa_match_row($db, (string)(aa_body()['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    if ((int)$m['host_id'] !== $me['id']) aa_json(['error' => 'not_host'], 403);
    if ($m['state'] !== 'open') aa_json(['error' => 'taken'], 409);
    $db->beginTransaction();
    $upd = $db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ? AND state = 'open'");
    $upd->execute([time(), $m['code']]);
    if ($upd->rowCount() !== 1) { $db->rollBack(); aa_json(['error' => 'taken'], 409); }
    foreach (aa_room($db, $m['code']) as $p) aa_give_gold($db, (int)$p['user_id'], (int)$m['stake']);   // everyone gets their stake back
    $db->commit();
    aa_reply($db, $m['code'], $me);
}

if ($action === 'progress') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    $m = aa_match_row($db, (string)($body['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    $in = false;
    foreach (aa_room($db, $m['code']) as $p) if ((int)$p['user_id'] === $me['id']) $in = true;
    if (!$in) aa_json(['error' => 'not_yours'], 403);
    if ($m['state'] === 'playing' && isset($body['pct'])) {
        $pct = max(0, min(100, (int)$body['pct']));
        $db->prepare('UPDATE match_players SET pct = ? WHERE code = ? AND user_id = ? AND pct < ?')->execute([$pct, $m['code'], $me['id'], $pct]);
    }
    aa_reply($db, $m['code'], $me);
}

if ($action === 'result') {
    if (!$post) aa_json(['error' => 'post_only'], 405);
    if (!$me) aa_json(['error' => 'signed_out'], 401);
    $body = aa_body();
    $m = aa_match_row($db, (string)($body['code'] ?? ''));
    if (!$m) aa_json(['error' => 'no_match'], 404);
    $in = false;
    foreach (aa_room($db, $m['code']) as $p) if ((int)$p['user_id'] === $me['id']) $in = true;
    if (!$in) aa_json(['error' => 'not_yours'], 403);
    if ($m['state'] !== 'playing') aa_reply($db, $m['code'], $me);
    $ms = (int)($body['ms'] ?? -1);
    $ms = ($body['cleared'] ?? false) === true && $ms > 0 ? min($ms, 24 * 3600 * 1000) : -1;
    // the first result counts and the server stamps the moment it arrived: finishing first is what wins
    $db->prepare('UPDATE match_players SET ms = ?, done = ?, pct = ? WHERE code = ? AND user_id = ? AND ms IS NULL')
       ->execute([$ms, (int)round(microtime(true) * 1000), $ms > 0 ? 100 : 0, $m['code'], $me['id']]);
    aa_settle_match($db, aa_match_row($db, $m['code']));
    aa_reply($db, $m['code'], $me);
}

// Where the people are: how many are sitting in a room that fills itself, per stake.
if ($action === 'lobby') aa_json(['waiting' => aa_lobby_counts($db), 'gold' => $me ? aa_gold($db, $me['id']) : null]);

aa_json(['error' => 'unknown_action'], 404);
