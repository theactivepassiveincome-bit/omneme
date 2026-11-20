#!/usr/bin/env bash
# End-to-end demo on SYNTHETIC data only. Creates everything in a temp directory.
set -euo pipefail
cd "$(dirname "$0")/.."
D=$(mktemp -d); trap 'rm -rf "$D"' EXIT
export OMNEME_VAULT="$D/vault.omneme" OMNEME_PASSWORD="demo-password-123" OMNEME_KDF_N=16384 OMNEME_TEST_MODE=1
node --no-warnings examples/make-synthetic-exports.ts "$D"
CLI="node bin/omneme.mjs"
$CLI init | sed -n '1,6p'
$CLI import "$D/chatgpt-export.zip" "$D/claude-export.zip"
$CLI stats
$CLI search 长城
$CLI show cg-branch
$CLI backup "$D/backup.omnbak"
$CLI restore "$D/backup.omnbak" --target "$D/restored.omneme"
$CLI stats --vault "$D/restored.omneme"
$CLI verify --vault "$D/restored.omneme"
TX=$($CLI anchor "$D/backup.omnbak" --ledger "$D/ledger" | awk '/txid/{print $2}')
$CLI verify-anchor "$TX" "$D/backup.omnbak" --ledger "$D/ledger"
echo "Demo complete."
