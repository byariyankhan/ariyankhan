<?php
// Checks the gold match server: stakes leave and return the right purses, the room only starts when the host
// says so, the player who finishes first takes the whole pot the instant they clear it even if someone else
// played a shorter clock, the rest play on for second place and no gold, and the gold always adds up.
declare(strict_types=1);
$tmp = sys_get_temp_dir() . '/aa-match-test-' . getmypid();
@mkdir($tmp, 0770, true);
putenv('AA_DATA_DIR=' . $tmp);
require __DIR__ . '/../games/api/lib.php';

$tests = 0; $bad = 0;
function ok(bool $cond, string $name): void {
    global $tests, $bad; $tests++;
    if ($cond) { echo "  ✓ $name\n"; return; }
    $bad++; echo "  ✗ $name\n";
}
$db = aa_db();
$host = aa_upsert_user($db, 'google', 'host', 'Ariyan');
$guest = aa_upsert_user($db, 'google', 'guest', 'Rahim');
$gold = fn(int $u) => aa_gold($db, $u);
$row = fn(string $code) => aa_match_row_raw($db, $code);

// the pieces the endpoint puts together, exercised here without HTTP
$make = function (int $uid, int $stake, int $tier = 2) use ($db) {
    if (!in_array($stake, AA_STAKES, true) || !aa_take_gold($db, $uid, $stake)) return null;
    $code = aa_match_code($db);
    $db->prepare('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$code, $uid, $stake, aa_pick_board() ?? '380', 2, 424242, 'open', time()]);
    aa_seat($db, $code, $uid, $tier);
    return $code;
};
$join = function (string $code, int $uid, int $tier = 2) use ($db) {
    $m = aa_match_row_raw($db, $code);
    if (!$m || $m['state'] !== 'open' || count(aa_room($db, $code)) >= AA_MATCH_SEATS) return false;
    foreach (aa_room($db, $code) as $p) if ((int)$p['user_id'] === $uid) return false;
    if (!aa_take_gold($db, $uid, (int)$m['stake'])) return false;
    aa_seat($db, $code, $uid, $tier);
    return true;
};
$start = function (string $code, int $uid) use ($db) {
    $m = aa_match_row_raw($db, $code);
    if (!$m || $m['state'] !== 'open' || (int)$m['host_id'] !== $uid || count(aa_room($db, $code)) < 2) return false;
    $db->prepare("UPDATE matches SET state = 'playing', started = ?, tier = ? WHERE code = ?")->execute([time(), aa_room_tier($db, $code), $code]);
    return true;
};
// ms = their own clock, at = the moment their result reached the server
$result = function (string $code, int $uid, int $ms, int $at = null) use ($db) {
    $db->prepare('UPDATE match_players SET ms = ?, done = ?, pct = ? WHERE code = ? AND user_id = ? AND ms IS NULL')
       ->execute([$ms, $at ?? (int)round(microtime(true) * 1000), $ms > 0 ? 100 : 0, $code, $uid]);
    return aa_settle_match($db, aa_match_row_raw($db, $code));
};

echo "Stakes and the room\n";
ok(AA_STAKES === [500, 1000, 7000], 'the three stakes are 500, 1,000 and 7,000');
ok(AA_MATCH_SEATS === 7, 'a room holds seven');
ok($gold($host) === 10000 && $gold($guest) === 10000, 'both players start with 10,000');
$code = $make($host, 1000);
ok(is_string($code) && strlen($code) === 6 && !preg_match('/[IO01]/', $code), "the room has a six-letter code ($code)");
ok($gold($host) === 9000, 'the stake leaves the host purse at once');
ok(count(aa_room($db, $code)) === 1, 'the host is the only one in the room');
ok($row($code)['board'] !== '', 'the server picked the board');
ok($make($guest, 999) === null, 'a stake that is not on the list is refused');
$broke = aa_upsert_user($db, 'google', 'broke', 'Karim');
$db->prepare('UPDATE users SET gold = 100 WHERE id = ?')->execute([$broke]);
ok($make($broke, 500) === null && $gold($broke) === 100, 'a player without the stake cannot open a room');

echo "\nThe stake does not buy an easier board\n";
{
    $easy = aa_upsert_user($db, 'google', 'easy', 'Nabila');
    $hard = aa_upsert_user($db, 'google', 'hard', 'Tanvir');
    $cheap = $make($easy, 500, 0);          // the smallest stake, two beginners
    $join($cheap, $hard, 2);
    $db->prepare("UPDATE matches SET state = 'playing', tier = ? WHERE code = ?")->execute([aa_room_tier($db, $cheap), $cheap]);
    ok((int)$row($cheap)['tier'] === 1, 'a 500 room of a beginner and a middling player gets an easy board');
    $rich = $make($easy, 7000, 4);          // the biggest stake, two strong players
    $join($rich, $hard, 4);
    $db->prepare("UPDATE matches SET state = 'playing', tier = ? WHERE code = ?")->execute([aa_room_tier($db, $rich), $rich]);
    ok((int)$row($rich)['tier'] === 4, 'a 7,000 room of two strong players gets a master board');
    $mixed = $make($hard, 500, 4);
    $join($mixed, $easy, 0);
    $db->prepare("UPDATE matches SET state = 'playing', tier = ? WHERE code = ?")->execute([aa_room_tier($db, $mixed), $mixed]);
    ok((int)$row($mixed)['tier'] === 2, 'a mixed room meets in the middle');
    ok(!defined('AA_STAKE_TIER'), 'the stake no longer decides the board at all');
}

echo "\nThe host starts it\n";
ok($start($code, $host) === false, 'one player alone cannot start');
ok($join($code, $guest) === true && $gold($guest) === 9000, 'the friend joins and stakes');
ok($row($code)['state'] === 'open', 'the room stays open until the host says go');
ok(count(aa_room($db, $code)) === 2, 'two are in the room');
ok($join($code, $guest) === false, 'nobody joins twice');
ok($start($code, $guest) === false, 'only the host can start');
ok($start($code, $host) === true && $row($code)['state'] === 'playing', 'the host starts the match');
ok($join($code, $broke) === false, 'and the door is shut once it has started');

echo "\nThe first to clear it is paid at once, the rest play on for their place\n";
// the host clears first on a longer clock; the guest is still playing and does not have to be waited for
$result($code, $host, 77800, 1000);
$m = $row($code);
ok((int)$m['winner_id'] === $host && $gold($host) === 11000, 'the pot is in the winner purse the moment they clear it');
ok($m['state'] === 'playing', 'and the match carries on so the rest can play for their place');
$result($code, $host, 1000, 1001);
$line = aa_match_players($db, $row($code), null);
ok($line[0]['ms'] === 77800, 'a second try cannot overwrite a time');
$result($code, $guest, 69300, 5000);
ok((int)$row($code)['winner_id'] === $host, 'a shorter clock reported later takes nothing');
ok($row($code)['state'] === 'done', 'the match closes once everyone has reported');
$line = aa_match_players($db, $row($code), null);
ok($line[0]['won'] === true && $line[1]['place'] === 2 && $line[1]['won'] === false, 'the later finisher is second, and second place wins no gold');
ok($gold($guest) === 9000 && $gold($host) + $gold($guest) === 20000, 'the loser is out their stake and no gold was made');

echo "\nLosing the board\n";
$c2 = $make($host, 500); $join($c2, $guest); $start($c2, $host);
$result($c2, $host, -1, 2000);
ok($row($c2)['state'] === 'playing', 'running out of hearts does not end the match for the others');
$result($c2, $guest, 45000, 9000);
ok((int)$row($c2)['winner_id'] === $guest && $gold($guest) === 9500, 'the one still going clears it and takes the pot');
ok($row($c2)['state'] === 'done', 'with both reported the match is over');
$c3 = $make($host, 500); $join($c3, $guest); $start($c3, $host);
$before = [$gold($host), $gold($guest)];
$result($c3, $host, -1); $result($c3, $guest, -1);
ok($row($c3)['winner_id'] === null && $row($c3)['state'] === 'done', 'a board neither of them cleared is a draw');
ok($gold($host) === $before[0] + 500 && $gold($guest) === $before[1] + 500, 'and both stakes come back');

echo "\nA room of seven\n";
$c4 = $make($host, 500);
$others = [];
for ($i = 0; $i < 7; $i++) {
    $u = aa_upsert_user($db, 'google', 'seat' . $i, 'Player' . $i);
    $others[] = $u;
    $joined = $join($c4, $u);
    if ($i < 6) ok($joined === true, 'seat ' . ($i + 2) . ' joins');
    else ok($joined === false && $gold($u) === 10000, 'the eighth is turned away and keeps their gold');
}
ok(count(aa_room($db, $c4)) === 7, 'seven are in the room');
$start($c4, $host);
$pot = 500 * 7;
$g0 = $gold($others[0]);
$result($c4, $others[0], 60000, 8000);
ok((int)$row($c4)['winner_id'] === $others[0] && $gold($others[0]) === $g0 + $pot, "the first to clear takes all {$pot} gold without waiting for the other six");
ok($row($c4)['state'] === 'playing', 'and the other six are still on the board');
$g1 = $gold($host);
$result($c4, $host, 30000, 9999);
$line = aa_match_players($db, $row($c4), null);
ok($gold($host) === $g1 && $line[1]['place'] === 2, 'second place is a place, not a purse');
foreach (array_slice($others, 1, 5) as $u) $result($c4, $u, -1);
ok($row($c4)['state'] === 'done' && (int)$row($c4)['winner_id'] === $others[0], 'the match closes when the last of the seven reports');

echo "\nWho is leading\n";
$c5 = $make($host, 500); $join($c5, $guest); $start($c5, $host);
$db->prepare('UPDATE match_players SET pct = 30 WHERE code = ? AND user_id = ?')->execute([$c5, $host]);
$db->prepare('UPDATE match_players SET pct = 70 WHERE code = ? AND user_id = ?')->execute([$c5, $guest]);
$line = aa_match_players($db, $row($c5), ['id' => $host]);
ok($line[0]['name'] === 'Rahim' && $line[0]['place'] === 1, 'the player further along the board is first');
ok($line[1]['name'] === 'Ariyan' && $line[1]['you'] === true, 'and you are marked in the line-up');
$db->prepare('UPDATE match_players SET pct = 95 WHERE code = ? AND user_id = ?')->execute([$c5, $host]);
ok(aa_match_players($db, $row($c5), null)[0]['name'] === 'Ariyan', 'pulling ahead moves you to first');
$db->prepare('UPDATE match_players SET ms = 40000, done = 700 WHERE code = ? AND user_id = ?')->execute([$c5, $guest]);
$line = aa_match_players($db, $row($c5), null);
ok($line[0]['name'] === 'Rahim' && $line[0]['pct'] === 100, 'a finished board goes in front of everyone still playing');
$result($c5, $host, -1);

echo "\nCalling the room off\n";
$c6 = $make($host, 500); $join($c6, $guest);
$g6 = [$gold($host), $gold($guest)];
$db->beginTransaction();
$db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ?")->execute([time(), $c6]);
foreach (aa_room($db, $c6) as $p) aa_give_gold($db, (int)$p['user_id'], 500);
$db->commit();
ok($row($c6)['state'] === 'void' && $gold($host) === $g6[0] + 500 && $gold($guest) === $g6[1] + 500, 'cancelling hands every stake back');
ok($join($c6, $broke) === false, 'and the link is dead');

echo "\nNobody turns up\n";
$c7 = $make($host, 7000);
$g7 = $gold($host);
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c7]);
aa_expire_matches($db);
ok($row($c7)['state'] === 'void' && $gold($host) === $g7 + 7000, 'a room nobody joined is refunded after a day');
$c8 = $make($host, 500); $join($c8, $guest); $start($c8, $host);
$g8 = $gold($guest);
$result($c8, $guest, 30000, 1234);
ok($gold($guest) === $g8 + 1000 && $row($c8)['state'] === 'playing', 'the one who cleared it is paid while the other is still on the board');
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c8]);
aa_expire_matches($db);
ok($row($c8)['state'] === 'done' && (int)$row($c8)['winner_id'] === $guest, 'a player who never finishes is counted out a day later');
ok($gold($guest) === $g8 + 1000, 'and the pot is never paid twice');
$c9 = $make($host, 500); $join($c9, $guest); $start($c9, $host);
$g9 = [$gold($host), $gold($guest)];
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c9]);
aa_expire_matches($db);
ok($row($c9)['state'] === 'done' && $row($c9)['winner_id'] === null, 'a board nobody ever finished is closed out');
ok($gold($host) === $g9[0] + 500 && $gold($guest) === $g9[1] + 500, 'and every stake goes home');

array_map('unlink', glob($tmp . '/*') ?: []); @rmdir($tmp);
echo $bad ? "\n$bad of $tests failed\n" : "\nall $tests tests passed\n";
exit($bad ? 1 : 0);
