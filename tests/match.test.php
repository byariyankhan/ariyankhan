<?php
// Checks the gold match server: stakes leave and return the right purses, the room only starts when the host
// says so, the player who finishes first takes the pot even if someone else played a shorter clock, and the
// gold always adds up.
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

echo "\nFinishing first is what wins\n";
// the guest reports a shorter clock, but the host's result reaches the server first
$result($code, $host, 77800, 1000);
ok($row($code)['state'] === 'playing' && $gold($host) === 9000, 'one result alone settles nothing');
$result($code, $host, 1000, 1001);
$line = aa_match_players($db, $row($code), null);
ok($line[0]['ms'] === 77800, 'a second try cannot overwrite a time');
$result($code, $guest, 69300, 5000);
$m = $row($code);
ok($m['state'] === 'done' && (int)$m['winner_id'] === $host, 'the one who finished first wins, even on a longer clock');
ok($gold($host) === 11000 && $gold($guest) === 9000, 'the winner takes the whole pot');
ok($gold($host) + $gold($guest) === 20000, 'no gold was made or lost');

echo "\nLosing the board\n";
$c2 = $make($host, 500); $join($c2, $guest); $start($c2, $host);
$result($c2, $host, -1, 2000);
$result($c2, $guest, 45000, 9000);
ok((int)$row($c2)['winner_id'] === $guest, 'a player who runs out of hearts loses to one who clears, whenever they clear');
ok($gold($guest) === 9500, 'and the clear takes the pot');
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
foreach (array_slice($others, 0, 6) as $k => $u) $result($c4, $u, 60000 + $k, 8000 + $k * 10);
$g0 = $gold($host);
$result($c4, $host, 30000, 9999);
ok((int)$row($c4)['winner_id'] === $others[0], 'in a room of seven the first to finish takes it');
ok($gold($others[0]) === 9500 + $pot, "the winner takes all {$pot} gold");
ok($gold($host) === $g0, 'and the last to finish gets nothing back');

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
$result($c8, $guest, 30000, 1234);
$g8 = $gold($guest);
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c8]);
aa_expire_matches($db);
ok($row($c8)['state'] === 'done' && (int)$row($c8)['winner_id'] === $guest, 'a player who never finishes loses a day later');
ok($gold($guest) === $g8 + 1000, 'and the one who did clear takes the pot');

array_map('unlink', glob($tmp . '/*') ?: []); @rmdir($tmp);
echo $bad ? "\n$bad of $tests failed\n" : "\nall $tests tests passed\n";
exit($bad ? 1 : 0);
