#!/bin/sh
set -e

echo "→ Applying database migrations…"
node scripts/migrate.mjs

echo "→ Starting WP Plugin Forge…"
exec node server.js
