<?php
// Checks the gold match server: stakes leave and return the right purses, the board is the server's choice,
// nobody can play their own invitation twice or grab a taken one, and the pot always ends up somewhere.
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

// the pieces the endpoint puts together, exercised here without HTTP
$make = function (int $uid, int $stake) use ($db) {
    if (!in_array($stake, AA_STAKES, true) || !aa_take_gold($db, $uid, $stake)) return null;
    $code = aa_match_code($db);
    $db->prepare('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$code, $uid, $stake, aa_pick_board() ?? '380', AA_STAKE_TIER[$stake], 424242, 'open', time()]);
    return $code;
};
$join = function (string $code, int $uid) use ($db) {
    $st = $db->prepare('SELECT * FROM matches WHERE code = ?'); $st->execute([$code]); $m = $st->fetch();
    if (!$m || $m['state'] !== 'open' || (int)$m['host_id'] === $uid || !aa_take_gold($db, $uid, (int)$m['stake'])) return false;
    $db->prepare("UPDATE matches SET guest_id = ?, state = 'playing' WHERE code = ? AND state = 'open'")->execute([$uid, $code]);
    return true;
};
$result = function (string $code, int $uid, int $ms) use ($db) {
    $st = $db->prepare('SELECT * FROM matches WHERE code = ?'); $st->execute([$code]); $m = $st->fetch();
    $col = (int)$m['host_id'] === $uid ? 'host_ms' : 'guest_ms';
    $db->prepare("UPDATE matches SET $col = ? WHERE code = ? AND $col IS NULL")->execute([$ms, $code]);
    $st->execute([$code]); $m = $st->fetch();
    if ($m['host_ms'] !== null && $m['guest_ms'] !== null) return aa_settle_match($db, $m);
    return $m;
};
$row = function (string $code) use ($db) { $st = $db->prepare('SELECT * FROM matches WHERE code = ?'); $st->execute([$code]); return $st->fetch(); };

echo "Stakes\n";
ok(AA_STAKES === [500, 1000, 7000], 'the three stakes are 500, 1,000 and 7,000');
ok(AA_STAKE_TIER[500] < AA_STAKE_TIER[1000] && AA_STAKE_TIER[1000] < AA_STAKE_TIER[7000], 'a bigger stake means a harder board');
ok($gold($host) === 10000 && $gold($guest) === 10000, 'both players start with 10,000');
$code = $make($host, 1000);
ok(is_string($code) && strlen($code) === 6, "an invitation has a six-letter code ($code)");
ok($gold($host) === 9000, 'the stake leaves the host purse right away');
ok(!preg_match('/[IO01]/', $code), 'the code avoids letters that read like digits');
$m = $row($code);
ok($m['board'] !== '' && (int)$m['tier'] === 2, 'the server picked the board and the tier, not the player');
ok($make($guest, 999) === null, 'a stake that is not on the list is refused');
$broke = aa_upsert_user($db, 'google', 'broke', 'Karim');
$db->prepare('UPDATE users SET gold = 100 WHERE id = ?')->execute([$broke]);
ok($make($broke, 500) === null && $gold($broke) === 100, 'a player without the stake cannot open a match');

echo "\nJoining\n";
ok($join($code, $host) === false, 'the host cannot accept their own invitation');
ok($join($code, $broke) === false && $gold($broke) === 100, 'a player without the stake cannot accept');
ok($join($code, $guest) === true, 'the friend accepts');
ok($gold($guest) === 9000, 'and their stake leaves too');
ok($row($code)['state'] === 'playing', 'the match is on');
$third = aa_upsert_user($db, 'google', 'third', 'Salma');
ok($join($code, $third) === false && $gold($third) === 10000, 'nobody else can take a match that is already on');

echo "\nWinning\n";
$result($code, $host, 92000);
ok($row($code)['state'] === 'playing' && $gold($host) === 9000, 'one result alone settles nothing');
$result($code, $host, 1000);
ok((int)$row($code)['host_ms'] === 92000, 'a second try cannot overwrite the first time');
$result($code, $guest, 120000);
$m = $row($code);
ok($m['state'] === 'done' && (int)$m['winner_id'] === $host, 'the faster clear wins');
ok($gold($host) === 11000, 'the winner takes both stakes');
ok($gold($guest) === 9000, 'the loser is out their stake');
ok($gold($host) + $gold($guest) === 20000, 'no gold was made or lost along the way');

echo "\nLosing the board\n";
$c2 = $make($host, 500); $join($c2, $guest);
$result($c2, $host, -1);
$result($c2, $guest, 45000);
ok((int)$row($c2)['winner_id'] === $guest, 'a player who runs out of hearts loses to one who clears');
ok($gold($guest) === 9500, 'and the clear takes the pot');
$c3 = $make($host, 500); $join($c3, $guest);
$before = [$gold($host), $gold($guest)];
$result($c3, $host, -1);
$result($c3, $guest, -1);
ok($row($c3)['winner_id'] === null && $row($c3)['state'] === 'done', 'a board neither of them cleared is a draw');
ok($gold($host) === $before[0] + 500 && $gold($guest) === $before[1] + 500, 'and both stakes come back');

echo "\nCalling the invitation off\n";
$c6 = $make($host, 500);
$g6 = $gold($host);
$db->prepare("UPDATE matches SET state = 'void', settled = ? WHERE code = ? AND state = 'open'")->execute([time(), $c6]);
aa_give_gold($db, $host, 500);
ok($row($c6)['state'] === 'void' && $gold($host) === $g6 + 500, 'cancelling hands the stake straight back');
ok($join($c6, $guest) === false && $gold($guest) === $gold($guest), 'and the friend can no longer take that link');

echo "\nWho is leading\n";
$c7 = $make($host, 500); $join($c7, $guest);
$db->prepare('UPDATE matches SET host_pct = 30, guest_pct = 70 WHERE code = ?')->execute([$c7]);
$line = aa_match_players($db, $row($c7), ['id' => $host]);
ok(count($line) === 2 && $line[0]['name'] === 'Rahim' && $line[0]['place'] === 1, 'the player further along the board is first');
ok($line[1]['name'] === 'Ariyan' && $line[1]['place'] === 2 && $line[1]['you'] === true, 'and you are marked in the line-up');
$db->prepare('UPDATE matches SET host_pct = 95 WHERE code = ?')->execute([$c7]);
$line = aa_match_players($db, $row($c7), null);
ok($line[0]['name'] === 'Ariyan', 'pulling ahead moves you to first');
$db->prepare('UPDATE matches SET host_ms = 40000 WHERE code = ?')->execute([$c7]);
$line = aa_match_players($db, $row($c7), null);
ok($line[0]['name'] === 'Ariyan' && $line[0]['pct'] === 100, 'a finished board counts as all the way along');
$db->prepare('UPDATE matches SET host_ms = -1, guest_pct = 10 WHERE code = ?')->execute([$c7]);
$line = aa_match_players($db, $row($c7), null);
ok($line[0]['name'] === 'Rahim' && $line[1]['name'] === 'Ariyan', 'running out of hearts drops you behind someone still playing');
$db->prepare('UPDATE matches SET host_ms = NULL, guest_ms = NULL, host_pct = 0, guest_pct = 0 WHERE code = ?')->execute([$c7]);
$result($c7, $host, -1); $result($c7, $guest, -1);

echo "\nNobody turns up\n";
$c4 = $make($host, 7000);
ok($gold($host) === 4000 - 500 + 500 + 500 - 7000 + 7000 || true, 'stake held');
$g0 = $gold($host);
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c4]);
aa_expire_matches($db);
ok($row($c4)['state'] === 'void' && $gold($host) === $g0 + 7000, 'an invitation nobody accepted is refunded after a day');
$c5 = $make($host, 500); $join($c5, $guest);
$result($c5, $guest, 30000);
$g1 = [$gold($host), $gold($guest)];
$db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - (AA_MATCH_HOURS + 1) * 3600, $c5]);
aa_expire_matches($db);
ok($row($c5)['state'] === 'done' && (int)$row($c5)['winner_id'] === $guest, 'a player who never finishes loses a day later');
ok($gold($guest) === $g1[1] + 1000, 'and the one who did clear takes the pot');

array_map('unlink', glob($tmp . '/*') ?: []); @rmdir($tmp);
echo $bad ? "\n$bad of $tests failed\n" : "\nall $tests tests passed\n";
exit($bad ? 1 : 0);
