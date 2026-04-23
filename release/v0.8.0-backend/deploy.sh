#!/bin/bash
# Alby v0.8.0 backend deployment.
#
# Run this FROM THE PRODUCTION ENVIRONMENT TAB in Alby
# (i.e. a terminal at root@vps.three.hostie.it with CWD
#  /home/alby.sh/web/alby.sh/public_html on branch error-tracking).
#
# What it does:
#   1. Pulls the latest error-tracking branch (in case you already
#      committed the patch files).
#   2. Runs php artisan migrate to apply 2026_04_23_000001_add_manual_issue_fields.
#   3. Warms the route cache + clears the view cache.
#   4. Reloads php-fpm so the new Issue model class is picked up.
#   5. Tells you to bounce Reverb if it's running under supervisor.
#
# What it does NOT do automatically:
#   - Copying the patch files into place. That's a manual step — each
#     patch is small and they each mean something slightly different in
#     the target file. See the README for the paste list.
#
# Usage: bash deploy.sh
set -euo pipefail

cd /home/alby.sh/web/alby.sh/public_html

echo "==> Branch check"
git rev-parse --abbrev-ref HEAD

echo "==> Pulling latest (expects patches already committed on error-tracking)"
git fetch origin
git pull --ff-only origin error-tracking

echo "==> Installing / updating PHP deps (if composer.json moved)"
composer install --no-dev --optimize-autoloader --prefer-dist --no-interaction

echo "==> Running migrations"
php artisan migrate --force

echo "==> Cache reset"
php artisan cache:clear
php artisan config:clear
php artisan route:clear
php artisan view:clear
php artisan config:cache
php artisan route:cache

echo "==> Reloading php-fpm (adjust service name if different)"
if systemctl list-unit-files | grep -q '^php.*-fpm'; then
  systemctl reload $(systemctl list-unit-files | grep -o '^php[^ ]*-fpm' | head -1) || true
fi

echo
echo "==> Done. If Reverb is running under supervisor:"
echo "      supervisorctl restart reverb"
echo
echo "Sanity check: curl -sH 'Accept: application/json' https://alby.sh/api/issues/mine"
echo "   → 401 if not logged in is fine. 404 means the route didn't register."
