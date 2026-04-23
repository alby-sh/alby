#!/bin/bash
# Alby v0.8.1 backend deployment.
#
# Run in the Production tab at /home/alby.sh/web/alby.sh/public_html on
# branch error-tracking, after you've pasted the v0.8.1 patches (see
# README.md in the same folder).
#
# What it does: git pull, migrate (seeds builtin team_roles for every
# existing team), cache reset, php-fpm reload.
set -euo pipefail
cd /home/alby.sh/web/alby.sh/public_html

git rev-parse --abbrev-ref HEAD
git fetch origin
git pull --ff-only origin error-tracking

composer install --no-dev --optimize-autoloader --prefer-dist --no-interaction

php artisan migrate --force
php artisan cache:clear
php artisan config:clear
php artisan route:clear
php artisan view:clear
php artisan config:cache
php artisan route:cache

if systemctl list-unit-files | grep -q '^php.*-fpm'; then
  systemctl reload $(systemctl list-unit-files | grep -o '^php[^ ]*-fpm' | head -1) || true
fi

echo
echo "Done. If Reverb is running under supervisor: supervisorctl restart reverb"
echo "Sanity: curl -H 'Authorization: Bearer TOKEN' https://alby.sh/api/teams/TEAM_ID/roles"
