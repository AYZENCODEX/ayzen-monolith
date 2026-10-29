#!/usr/bin/env sh
set -eu

: "${SMOKE_BASE_URL:?SMOKE_BASE_URL must point at the staged gateway}"

node scripts/cloud-smoke.mjs
SMOKE_PATHS="/internal/routes,/internal/capabilities" node scripts/cloud-smoke.mjs

echo "Staging smoke checks passed for ${SMOKE_BASE_URL}"