#!/bin/bash
set -euo pipefail

GBRAIN_BIN="${GBRAIN_BIN:-$HOME/.bun/bin/gbrain}"
STATE_DIR="${GBRAIN_RESOLVER_NIGHTLY_DIR:-$HOME/.gbrain/resolver-feedback-nightly}"
LOCK_DIR="$STATE_DIR/lock"
LOG_FILE="$STATE_DIR/nightly.log"
LATEST="$STATE_DIR/latest.json"

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG_FILE"; }

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "skip: resolver learning already running"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

temp="$STATE_DIR/latest.tmp.$$"
trap 'rm -f "$temp"; rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

if "$GBRAIN_BIN" dream --phase resolver_learning --json > "$temp" 2>> "$LOG_FILE"; then
  mv "$temp" "$LATEST"
  status=$(jq -r '.phases[0].status // .status // "unknown"' "$LATEST")
  summary=$(jq -r '.phases[0].summary // "no summary"' "$LATEST")
  log "ok: status=$status $summary"
else
  code=$?
  log "error: resolver learning exited $code"
  exit "$code"
fi
