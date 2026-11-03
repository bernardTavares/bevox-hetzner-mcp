#!/usr/bin/env bash
# .claude/hooks/lib/common.sh — shared helpers for bevox-hetzner-mcp hooks.
# Source-once guard.
if [[ "${__BEVOX_HETZNER_MCP_COMMON_LOADED:-}" == "1" ]]; then
  return 0 2>/dev/null || true
fi
__BEVOX_HETZNER_MCP_COMMON_LOADED=1

set -euo pipefail

# PROJECT_ROOT: three levels up from lib/ (lib -> hooks -> .claude -> root)
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
HOOKS_DIR="$PROJECT_ROOT/.claude/hooks"
STATE_DIR="$PROJECT_ROOT/.claude/state"

log_info()  { printf '[hook] %s\n' "$*" >&2; }
log_warn()  { printf '[hook WARN] %s\n' "$*" >&2; }
log_error() { printf '[hook ERROR] %s\n' "$*" >&2; }

block() {
  local msg="$1"
  printf '\n[BLOCKED] %s\n\n' "$msg" >&2
  exit 2
}

warn_only() {
  local msg="$1"
  printf '\n[WARN] %s\n\n' "$msg" >&2
  return 0
}

# Read JSON stdin from Claude Code if available (non-blocking).
read_hook_stdin() {
  if [[ ! -t 0 ]]; then
    cat
  else
    echo ""
  fi
}

# Extract a dotted field from a JSON blob via node (jq optional).
json_field() {
  local json="$1"
  local field="$2"
  node -e "try{const d=JSON.parse(process.argv[1]||'{}');const p='$field'.split('.');let v=d;for(const k of p){v=v?.[k]}process.stdout.write(v??'')}catch(e){}" "$json" 2>/dev/null || true
}
