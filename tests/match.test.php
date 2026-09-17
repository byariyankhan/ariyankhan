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
$make = function (int $uid, int $stake, int $tier = 2, bool $openToAll = false) use ($db) {
    if (!in_array($stake, AA_STAKES, true)) return null;
    if ($openToAll) {
        $seat = aa_open_room($db, $stake, $uid);                       // walk into the room already waiting
        if ($seat !== null) {
            if (!aa_take_gold($db, $uid, $stake)) return null;
            aa_seat($db, $seat, $uid, $tier);
            aa_room_joined($db, $seat);
            return $seat;
        }
    }
    if (!aa_take_gold($db, $uid, $stake)) return null;
    $code = aa_match_code($db);
    $db->prepare('INSERT INTO matches (code, host_id, stake, board, tier, seed, state, created, open_to_all) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$code, $uid, $stake, aa_pick_board() ?? '380', 2, 424242, 'open', time(), $openToAll ? 1 : 0]);
    aa_seat($db, $code, $uid, $tier);
    return $code;
};
$join = function (string $code, int $uid, int $tier = 2) use ($db) {
    $m = aa_match_row_raw($db, $code);
    if (!$m || $m['state'] !== 'open' || count(aa_room($db, $code)) >= AA_MATCH_SEATS) return false;
    foreach (aa_room($db, $code) as $p) if ((int)$p['user_id'] === $uid) return false;
    if (!aa_take_gold($db, $uid, (int)$m['stake'])) return false;
    aa_seat($db, $code, $uid, $tier);
    aa_room_joined($db, $code);
    return true;
};
$start = function (string $code, int $uid) use ($db) {
    $m = aa_match_row_raw($db, $code);
    if (!$m || $m['state'] !== 'open' || (int)$m['host_id'] !== $uid || (int)$m['open_to_all'] || count(aa_room($db, $code)) < 2) return false;
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
$db->prepare('UPDATE users SET pic = ? WHERE id = ?')->execute(['https://lh3.googleusercontent.com/a/face', $guest]);
$faces = aa_match_players($db, $row($c5), null);
ok($faces[0]['pic'] === 'https://lh3.googleusercontent.com/a/face', 'the line-up carries each face, so two players are told apart');
ok($faces[1]['pic'] === '', 'and a player without one is simply blank');
ok($line[1]['name'] === 'Ariyan' && $line[1]['you'] === true, 'and you are marked in the line-up');
$db->prepare('UPDATE match_players SET pct = 95 WHERE code = ? AND user_id = ?')->execute([$c5, $host]);
ok(aa_match_players($db, $row($c5), null)[0]['name'] === 'Ariyan', 'pulling ahead moves you to first');
$db->prepare('UPDATE match_players SET ms = 40000, done = 700 WHERE code = ? AND user_id = ?')->execute([$c5, $guest]);
$line = aa_match_players($db, $row($c5), null);
ok($line[0]['name'] === 'Rahim' && $line[0]['pct'] === 100, 'a finished board goes in front of everyone still playing');
$result($c5, $host, -1);

echo "\nLeaving a room\n";
{
    $l = fn(string $sub) => aa_upsert_user($db, 'google', $sub, ucfirst($sub));
    $lead = $l('leave-1'); $second = $l('leave-2'); $third = $l('leave-3');
    $rm = $make($lead, 500);
    $join($rm, $second); $join($rm, $third);
    ok((int)$row($rm)['host_id'] === $lead && count(aa_room($db, $rm)) === 3, 'three of them, the first in charge');
    $g = [$gold($lead), $gold($second), $gold($third)];
    aa_leave_room($db, $row($rm), $lead);
    ok($row($rm)['state'] === 'open', 'the leader walking out does not call the match off');
    ok((int)$row($rm)['host_id'] === $second, 'the next one in becomes the leader');
    ok(count(aa_room($db, $rm)) === 2, 'and two are still in the room');
    ok($gold($lead) === $g[0] + 500, 'the one who left has their stake back');
    ok($gold($second) === $g[1] && $gold($third) === $g[2], 'and nobody else was touched');
    ok($start($rm, $lead) === false, 'the one who left cannot start it any more');
    ok($start($rm, $second) === true && $row($rm)['state'] === 'playing', 'the new leader can');

    // down to one, and then to none
    $rm2 = $make($lead, 500); $join($rm2, $second);
    aa_leave_room($db, $row($rm2), $second);
    ok(count(aa_room($db, $rm2)) === 1 && $row($rm2)['state'] === 'open', 'a guest leaving a room of two leaves the host waiting');
    ok((int)$row($rm2)['host_id'] === $lead, 'who is still the host');
    $g2 = $gold($lead);
    aa_leave_room($db, $row($rm2), $lead);
    ok($row($rm2)['state'] === 'void' && $gold($lead) === $g2 + 500, 'the last one out closes the room and takes their stake');
    ok(aa_leave_room($db, $row($rm2), $lead) === null && $gold($lead) === $g2 + 500, 'and leaving a closed room a second time pays nothing');

    // a clock left running over a room of one goes back to waiting rather than starting a match of one
    $p1 = $l('leave-p1'); $p2 = $l('leave-p2');
    $pr = $make($p1, 1000, 2, true);
    $make($p2, 1000, 2, true);
    ok(count(aa_room($db, $pr)) === 2 && $row($pr)['fills_at'] !== null, 'a room that fills itself has its clock running at two');
    aa_leave_room($db, $row($pr), $p2);
    aa_autostart_matches($db);
    ok($row($pr)['state'] === 'open' && $row($pr)['fills_at'] === null, 'one of them leaving stops the clock instead of starting a match of one');
    ok((int)$row($pr)['created'] >= time() - 2, 'and the wait starts over for the one left behind');
}

echo "\nA room that fills itself is started by its clock, not by a hand\n";
{
    $h1 = aa_upsert_user($db, 'google', 'clock-1', 'Nadia');
    $h2 = aa_upsert_user($db, 'google', 'clock-2', 'Sabbir');
    $cr = $make($h1, 500, 2, true);
    $make($h2, 500, 2, true);
    ok(count(aa_room($db, $cr)) === 2 && $row($cr)['fills_at'] !== null, 'two are in, the clock is running');
    ok($start($cr, $h1) === false && $row($cr)['state'] === 'open', 'the leader cannot start it early and shut the others out');
    $db->prepare('UPDATE matches SET fills_at = ? WHERE code = ?')->execute([time() - 1, $cr]);
    aa_autostart_matches($db);
    ok($row($cr)['state'] === 'playing', 'only the clock running out starts it');
    $inv = $make($h1, 500);
    $join($inv, $h2);
    ok($start($inv, $h1) === true, 'while an invite-only room is still the host\'s to start whenever they like');
    // these two sections leave rooms open that take anyone: close them, or the section further down that counts
    // who is waiting would be counting these
    $db->exec("UPDATE matches SET state = 'void' WHERE state = 'open' AND open_to_all = 1");
}

echo "\nCalling the room off\n";
$c6 = $make($host, 500); $join($c6, $guest);
$g6 = [$gold($host), $gold($guest)];
aa_leave_room($db, $row($c6), $guest);
aa_leave_room($db, $row($c6), $host);
ok($row($c6)['state'] === 'void' && $gold($host) === $g6[0] + 500 && $gold($guest) === $g6[1] + 500, 'everybody leaving hands every stake back and closes the room');
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

echo "\nA room that fills itself from online\n";
{
    $pub = fn(string $sub, int $tier = 2) => aa_upsert_user($db, 'google', $sub, ucfirst($sub));
    $a = $pub('online-a'); $b = $pub('online-b'); $c = $pub('online-c');
    $r1 = $make($a, 1000, 2, true);
    ok(is_string($r1) && (int)$row($r1)['open_to_all'] === 1, 'the first player opens a room that takes anyone');
    ok($row($r1)['fills_at'] === null, 'and nothing is on the clock while they sit there alone');
    ok(aa_lobby_counts($db)[1000] === 1, 'the picker can see one player waiting at 1,000');
    ok(aa_lobby_counts($db)[500] === 0, 'and nobody at 500');
    $r2 = $make($b, 1000, 2, true);
    ok($r2 === $r1, 'the next player walks into that room instead of opening a second one');
    ok(count(aa_room($db, $r1)) === 2 && $gold($b) === 9000, 'two are in it, both staked');
    $fills = (int)$row($r1)['fills_at'];
    ok($fills > time() && $fills <= time() + AA_FILL_SECONDS, 'the second player starts the forty-second clock');
    ok($row($r1)['state'] === 'open', 'the match has not started yet');
    // a third joins: the clock is already running and is not pushed back
    $r3 = $make($c, 1000, 2, true);
    ok($r3 === $r1 && (int)$row($r1)['fills_at'] === $fills, 'a third player joins without resetting the clock');
    $db->prepare('UPDATE matches SET fills_at = ? WHERE code = ?')->execute([time() - 1, $r1]);
    aa_autostart_matches($db);
    ok($row($r1)['state'] === 'playing', 'the clock runs out and the match begins on its own');
    ok((int)$row($r1)['started'] > 0 && (int)$row($r1)['tier'] === 2, 'with the board set from the players who turned up');
    ok(aa_lobby_counts($db)[1000] === 0, 'and the room is no longer on offer');
    ok($make($a, 1000, 2, true) !== $r1, 'a started room does not take anyone else');

    // seven of them do not wait for the clock at all
    $seats = [];
    $r4 = $make($pub('seatx0'), 500, 2, true);
    for ($i = 1; $i < 7; $i++) { $u = $pub('seatx' . $i); $seats[] = $u; $got = $make($u, 500, 2, true); if ($i < 6) ok($got === $r4, 'online player ' . ($i + 1) . ' lands in the same room'); }
    ok(count(aa_room($db, $r4)) === 7, 'seven of them are in it');
    ok($row($r4)['state'] === 'playing', 'and a full room starts at once, without waiting out the clock');

    // nobody turns up: the stake comes back in two minutes, not a day
    $lone = $pub('online-lonely');
    $r5 = $make($lone, 7000, 2, true);
    ok($gold($lone) === 3000, 'the stake is held while they wait');
    aa_autostart_matches($db);
    ok($row($r5)['state'] === 'open', 'a room that has just opened is left alone');
    $db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - AA_LONELY_SECONDS - 1, $r5]);
    aa_autostart_matches($db);
    ok($row($r5)['state'] === 'void' && $gold($lone) === 10000, 'nobody came, so the gold is handed straight back');

    // two of them tapped the same coin in the same second and each opened a room: they must still meet
    $t1 = $pub('tie-a'); $t2 = $pub('tie-b');
    $q1 = $make($t1, 500, 2, true);
    $db->prepare('UPDATE matches SET created = ? WHERE code = ?')->execute([time() - 5, $q1]);   // the older of the two
    // a dead heat: both looked, neither saw the other, so both opened a room of their own
    $q2 = $make($t2, 500);
    $db->prepare('UPDATE matches SET open_to_all = 1 WHERE code = ?')->execute([$q2]);
    ok($q2 !== $q1, 'each of them opened their own room');
    ok(aa_requeue($db, $row($q1), $t1) === null, 'the older room stays put: there is nothing older to move to');
    $moved = aa_requeue($db, $row($q2), $t2);
    ok($moved === $q1, 'the newer one walks into the older room on its next poll');
    ok($row($q2)['state'] === 'void' && count(aa_room($db, $q2)) === 0, 'and the room it left is closed and empty');
    ok($gold($t2) === 9500, 'the stake moved with the player: taken once, never handed back');
    ok(count(aa_room($db, $q1)) === 2 && $row($q1)['fills_at'] !== null, 'two are in the older room now, with the clock running');
    ok(aa_requeue($db, $row($q1), $t1) === null, 'and nobody who has company is moved anywhere');
    aa_start_room($db, $q1);   // out of the pool, so the checks below are about their own rooms

    // and with the switch off nothing moves without the host
    $d1 = $pub('private-a'); $d2 = $pub('private-b');
    $r6 = $make($d1, 500);
    ok((int)$row($r6)['open_to_all'] === 0, 'with the switch off the room is invite-only');
    ok($make($d2, 500, 2, true) !== $r6, 'and an online player is never put into it');
    ok($join($r6, $d2) === true && $row($r6)['fills_at'] === null && $row($r6)['state'] === 'open', 'a friend joining starts no clock: the host still says go');
    ok(aa_lobby_counts($db)[500] === 1, 'and its players are not counted as a place to walk into: only the one open room at 500 is');
}

array_map('unlink', glob($tmp . '/*') ?: []); @rmdir($tmp);
echo $bad ? "\n$bad of $tests failed\n" : "\nall $tests tests passed\n";
exit($bad ? 1 : 0);
