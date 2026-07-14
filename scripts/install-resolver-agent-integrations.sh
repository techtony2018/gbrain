#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
mode="${1:---all}"
state_dir="${GBRAIN_RESOLVER_HOME:-$HOME/.gbrain}"

mkdir -p "$state_dir"
install -m 0755 "$repo_root/scripts/resolver-feedback-agent.py" "$state_dir/resolver-feedback-agent.py"

install_codex() {
  local marketplace="$repo_root/integrations/codex-resolver-feedback-marketplace"
  if ! codex plugin marketplace list --json 2>/dev/null | grep -q 'tony-local'; then
    codex plugin marketplace add "$marketplace" --json >/dev/null
  fi
  codex plugin add gbrain-resolver-feedback@tony-local --json >/dev/null
  echo "Codex resolver hooks installed"
}

install_openclaw() {
  local plugin="$repo_root/integrations/openclaw-resolver-feedback"
  openclaw plugins install "$plugin" --force >/dev/null
  openclaw plugins enable gbrain-resolver-feedback >/dev/null
  echo "OpenClaw resolver hooks installed"
}

case "$mode" in
  --codex) install_codex ;;
  --openclaw) install_openclaw ;;
  --all) install_codex; install_openclaw ;;
  *) echo "usage: $0 [--all|--codex|--openclaw]" >&2; exit 2 ;;
esac
