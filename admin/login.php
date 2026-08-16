<?php
/* ══════════════════════════════════════════════════
   Project Tracker Admin — login
   ══════════════════════════════════════════════════ */

session_start();

function admin_password(): ?string {
  $config_path = __DIR__ . '/../admin-config.local.php';
  if (!is_file($config_path)) {
    return null;
  }
  $config = require $config_path;
  return is_array($config) ? ($config['password'] ?? null) : null;
}

$error = '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
  $submitted = (string) ($_POST['password'] ?? '');
  $expected = admin_password();

  if ($expected === null) {
    $error = 'Admin password is not configured on the server yet.';
  } elseif (hash_equals($expected, $submitted)) {
    session_regenerate_id(true);
    $_SESSION['tracker_admin'] = true;
    header('Location: index.php');
    exit;
  } else {
    $error = 'Incorrect password.';
  }
}
?>
<!doctype html>
<html lang="en-US">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex, nofollow">
<title>Admin Login | Ariyan Khan</title>
<link rel="icon" type="image/x-icon" href="../favicon/favicon.ico">
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;900&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="../css/style.css?v=9">
<link rel="stylesheet" href="../css/tracker.css?v=3">
</head>
<body class="tracker-body">
<div id="stars"></div>
<main class="tracker-auth-wrap">
  <form class="tracker-auth-card" method="post" novalidate>
    <div class="tag-pill">Admin</div>
    <h1 class="tracker-auth-title">Project Tracker</h1>
    <?php if ($error !== ''): ?>
      <p class="tracker-auth-error"><?= htmlspecialchars($error, ENT_QUOTES, 'UTF-8') ?></p>
    <?php endif; ?>
    <label class="tracker-field">
      <span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    <button type="submit" class="tracker-btn">Log In</button>
  </form>
</main>
</body>
</html>
