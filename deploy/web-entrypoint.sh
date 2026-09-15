#!/usr/bin/env bash
# Startup for the `web` service in deploy/docker-compose.yml (php:8.4-apache).
# Turns the plain Apache image into what the site expects and materialises the
# gitignored SMTP config file from environment variables, so no credential is
# ever committed or copied around by hand.
set -euo pipefail
ROOT=/var/www/html

# Apache modules the site's .htaccess relies on, plus real client IPs behind Caddy.
a2enmod rewrite headers expires deflate remoteip >/dev/null
cat > /etc/apache2/conf-enabled/zz-site.conf <<'CONF'
ServerName ariyankhan.com
RemoteIPHeader X-Forwarded-For
RemoteIPInternalProxy 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16
CONF
sed -ri 's#AllowOverride None#AllowOverride All#g' /etc/apache2/apache2.conf

# mail-config.local.php <- SITE_URL, TO_EMAIL, SMTP_*, ALLOW_SELF_SIGNED (contact form)
php -r '
$keys = ["site_url","to_email","driver","smtp_host","smtp_user","smtp_pass","smtp_port","allow_self_signed"];
$cfg = [];
foreach ($keys as $k) {
  $v = getenv(strtoupper($k));
  if ($v !== false && trim($v) !== "") $cfg[$k] = trim($v);
}
file_put_contents("/var/www/html/mail-config.local.php", "<?php\nreturn " . var_export($cfg, true) . ";\n");
'
chown www-data:www-data "$ROOT"/mail-config.local.php
chmod 600 "$ROOT"/mail-config.local.php

exec apache2-foreground
