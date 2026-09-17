<?php
// Checks the Arrow Atlas account server: which ID tokens are accepted, how accounts and sessions are created,
// and that deleting an account really removes everything. Run: php tests/auth.test.php
declare(strict_types=1);
$tmp = sys_get_temp_dir() . '/aa-auth-test-' . getmypid();
@mkdir($tmp, 0770, true);
putenv('AA_DATA_DIR=' . $tmp);
require __DIR__ . '/../games/api/lib.php';

$tests = 0; $bad = 0;
function ok(bool $cond, string $name): void {
    global $tests, $bad; $tests++;
    if ($cond) { echo "  ✓ $name\n"; return; }
    $bad++; echo "  ✗ $name\n";
}
$CLIENT = '83384024830-f7bt8g5amgo21e6pmonr4ssjrq02vhg4.apps.googleusercontent.com';
$fake = function (array $claims): callable {
    return fn(string $t) => json_encode($claims);
};
$PIC = 'https://lh3.googleusercontent.com/a/ACg8ocK_example=s96-c';
$good = ['aud' => $CLIENT, 'iss' => 'https://accounts.google.com', 'exp' => time() + 3600, 'sub' => '1122334455', 'name' => 'Ariyan Khan', 'picture' => $PIC, 'email_verified' => true];

echo "Google ID tokens\n";
ok(aa_google_verify('tok', $CLIENT, $fake($good)) === ['sub' => '1122334455', 'name' => 'Ariyan Khan', 'pic' => $PIC], 'a valid token gives the id, the name and the picture');
ok(aa_google_verify('tok', $CLIENT, $fake(['iss' => 'accounts.google.com'] + $good)) !== null, 'the issuer without a scheme is accepted too');
ok(aa_google_verify('tok', $CLIENT, $fake(['aud' => 'someone-else.apps.googleusercontent.com'] + $good)) === null, 'a token for another site is refused');
ok(aa_google_verify('tok', $CLIENT, $fake(['iss' => 'https://evil.example'] + $good)) === null, 'a token from another issuer is refused');
ok(aa_google_verify('tok', $CLIENT, $fake(['exp' => time() - 10] + $good)) === null, 'an expired token is refused');
ok(aa_google_verify('tok', $CLIENT, $fake(array_diff_key($good, ['sub' => 1]))) === null, 'a token without a user id is refused');
ok(aa_google_verify('tok', $CLIENT, $fake(['email_verified' => false] + $good)) === null, 'an unverified Google account is refused');
ok(aa_google_verify('tok', $CLIENT, fn($t) => 'not json') === null, 'a junk answer is refused');
ok(aa_google_verify('tok', $CLIENT, fn($t) => null) === null, 'no answer at all is refused');
ok(aa_google_verify('', $CLIENT, $fake($good)) === null, 'an empty token is refused');
ok(aa_google_verify(str_repeat('x', 5000), $CLIENT, $fake($good)) === null, 'an absurdly long token is refused without asking Google');
ok(aa_google_verify('tok', '', $fake($good)) === null, 'nothing is accepted when no client id is configured');

echo "\nThe profile picture is only ever Google's own\n";
ok(aa_pic($PIC) === $PIC, 'a googleusercontent.com picture is kept');
ok(aa_pic('https://lh6.googleusercontent.com/x') === 'https://lh6.googleusercontent.com/x', 'any of their picture hosts is kept');
ok(aa_pic('https://evil.example/tracker.gif') === '', 'an image from anywhere else is dropped');
ok(aa_pic('https://googleusercontent.com.evil.example/x') === '', 'and so is a host that only looks like theirs');
ok(aa_pic('http://lh3.googleusercontent.com/x') === '', 'plain http is dropped');
ok(aa_pic('javascript:alert(1)') === '' && aa_pic('data:image/png;base64,AAAA') === '', 'a script or data url is never a picture');
ok(aa_pic('https://lh3.googleusercontent.com/' . str_repeat('x', 600)) === '', 'an absurdly long url is dropped');
ok(aa_pic('') === '', 'no picture at all is no picture');
ok(aa_google_verify('tok', $CLIENT, $fake(['picture' => 'https://evil.example/x.png'] + $good))['pic'] === '', 'a token cannot smuggle an image in from elsewhere');
ok(aa_google_verify('tok', $CLIENT, $fake(array_diff_key($good, ['picture' => 1])))['pic'] === '', 'a Google account with no picture is fine');
ok(aa_google_verify('tok', $CLIENT, $fake(['name' => "  Ariyan\tKhan  "] + $good))['name'] === 'Ariyan Khan', 'stray spaces and tabs are cleaned out of the name');
ok(!str_contains(aa_google_verify('tok', $CLIENT, $fake(['name' => 'Ari~yan'] + $good))['name'], '~'), 'the tilde that separates fields in a challenge link cannot get into a name');
ok(mb_strlen(aa_google_verify('tok', $CLIENT, $fake(['name' => str_repeat('অ', 80)] + $good))['name']) === 24, 'a very long name is cut to 24 characters');

echo "\nAccounts\n";
$db = aa_db();
$id = aa_upsert_user($db, 'google', 'sub-1', 'Ariyan', $madeFirst);
ok($madeFirst === true, 'the server reports that the account was created just now');
ok($id > 0, 'the first sign-in creates the account');
ok(aa_upsert_user($db, 'google', 'sub-1', 'Ariyan') === $id, 'signing in again reuses the same account');
ok(aa_upsert_user($db, 'google', 'sub-2', 'Someone') !== $id, 'a different Google account is a different player');
ok((int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 2, 'two accounts exist');
$cols = array_column($db->query('PRAGMA table_info(users)')->fetchAll(), 'name');
ok(!in_array('email', $cols, true) && !in_array('password', $cols, true), 'no email and no password column exists at all');
$pic = fn(int $u) => (string)$db->query('SELECT pic FROM users WHERE id = ' . $u)->fetchColumn();
$withPic = aa_upsert_user($db, 'google', 'sub-pic', 'Rahim', $x, $PIC);
ok($pic($withPic) === $PIC, 'the picture from the token is stored with the account');
ok($pic($id) === '', 'an account that signed in without one has none');
aa_upsert_user($db, 'google', 'sub-pic', 'Rahim', $x, 'https://lh3.googleusercontent.com/new');
ok($pic($withPic) === 'https://lh3.googleusercontent.com/new', 'and it follows the Google account on the next sign-in');

echo "\nWelcome gold\n";
$gold = fn(int $u) => (int)$db->query("SELECT gold FROM users WHERE id = $u")->fetchColumn();
ok($gold($id) === 10000, 'a new account starts with 10,000 gold');
ok(AA_SIGNUP_GOLD === 10000, 'the welcome purse is 10,000');
$db->prepare('UPDATE users SET gold = ? WHERE id = ?')->execute([250, $id]);
$again = aa_upsert_user($db, 'google', 'sub-1', 'Ariyan', $madeAgain);
ok($again === $id && $madeAgain === false, 'signing in again does not make a second account');
ok($gold($id) === 250, 'and does not top the gold back up');
$fresh = aa_upsert_user($db, 'google', 'sub-3', 'Newcomer', $madeNew);
ok($madeNew === true && $gold($fresh) === 10000, 'the next new player gets their own 10,000');
$db->prepare('DELETE FROM users WHERE id = ?')->execute([$fresh]);
$db->prepare('UPDATE users SET gold = ? WHERE id = ?')->execute([10000, $id]);

echo "\nSessions\n";
$_COOKIE = [];
$token = bin2hex(random_bytes(32));
$db->prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?, ?, ?, ?)')->execute([hash('sha256', $token), $id, time(), time() + 3600]);
ok((string)$db->query('SELECT hash FROM sessions')->fetchColumn() !== $token, 'the session token is stored hashed, never in the clear');
$_COOKIE[AA_COOKIE] = $token;
$me = aa_current_user($db);
ok($me !== null && $me['id'] === $id && $me['name'] === 'Ariyan', 'the cookie identifies the player');
ok(($me['gold'] ?? null) === 10000, 'and carries the gold balance');
$_COOKIE[AA_COOKIE] = bin2hex(random_bytes(32));
ok(aa_current_user($db) === null, 'a made-up cookie identifies nobody');
$_COOKIE[AA_COOKIE] = 'short';
ok(aa_current_user($db) === null, 'a too-short cookie is ignored');
$stale = bin2hex(random_bytes(32));
$db->prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?, ?, ?, ?)')->execute([hash('sha256', $stale), $id, time() - 7200, time() - 60]);
$_COOKIE[AA_COOKIE] = $stale;
ok(aa_current_user($db) === null, 'an expired session is refused');
ok((int)$db->query("SELECT COUNT(*) FROM sessions WHERE hash = '" . hash('sha256', $stale) . "'")->fetchColumn() === 0, 'and is cleaned out of the table');

echo "\nDeleting an account\n";
$db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
$db->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
ok((int)$db->query("SELECT COUNT(*) FROM users WHERE id = $id")->fetchColumn() === 0, 'the account row is gone');
ok((int)$db->query("SELECT COUNT(*) FROM sessions WHERE user_id = $id")->fetchColumn() === 0, 'every session of that account is gone');

array_map('unlink', glob($tmp . '/*') ?: []); @rmdir($tmp);
echo $bad ? "\n$bad of $tests failed\n" : "\nall $tests tests passed\n";
exit($bad ? 1 : 0);
