#!/usr/bin/env bash
# PostToolUse-tools.sh — when core/src/agent/** is edited, verify the console
# contract oracle is in the staged diff too (cross-package contract integrity).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

FILE_NORM=$(echo "$FILE" | tr '\\' '/')

case "$FILE_NORM" in
  */core/src/agent/*) ;;
  *) exit 0 ;;
esac

# Skip pure test edits
if [[ "$FILE_NORM" =~ \.test\.ts$ ]]; then
  exit 0
fi

log_info "Agent/MCP tool surface touched: $FILE_NORM"

cd "$PROJECT_ROOT" 2>/dev/null || exit 0

# Check staged + unstaged diff for the console contract oracle
STAGED=$(git diff --cached --name-only 2>/dev/null || true)
UNSTAGED=$(git diff --name-only 2>/dev/null || true)
ALL_DIFF="$STAGED"$'\n'"$UNSTAGED"

contract_touched=0
if echo "$ALL_DIFF" | grep -qE '(^|/)console/(src/)?contract(-v2)?\.ts$'; then
  contract_touched=1
fi

# v1 vs v2 surface: agent/v2/** must touch contract-v2.ts; agent/** (root) must touch contract.ts
if [[ "$FILE_NORM" =~ /core/src/agent/v2/ ]]; then
  if [[ $contract_touched -eq 0 ]] || ! echo "$ALL_DIFF" | grep -qE '(^|/)console/(src/)?contract-v2\.ts$'; then
    log_warn "Agent v2 tool edited ($FILE_NORM) but console/contract-v2.ts is not in the diff."
    log_warn "Cross-package contracts go through the console contract-v2 oracle (CONTRIBUTING code style)."
    log_warn "If the public tool surface changed, update console/contract-v2.ts in the same commit."
  fi
else
  if [[ $contract_touched -eq 0 ]] || ! echo "$ALL_DIFF" | grep -qE '(^|/)console/(src/)?contract\.ts$'; then
    log_warn "Agent v1 tool edited ($FILE_NORM) but console/contract.ts is not in the diff."
    log_warn "Cross-package contracts go through the console contract.ts oracle (CONTRIBUTING code style)."
    log_warn "If the public tool surface changed, update console/contract.ts in the same commit."
  fi
fi

# Best-effort skill stubs (non-blocking)
node "$HOOKS_DIR/lib/invoke-skill.js" mcp-tool-author "$FILE_NORM" >/dev/null 2>&1 || true
node "$HOOKS_DIR/lib/invoke-skill.js" approval-gate-protocol "$FILE_NORM" >/dev/null 2>&1 || true

exit 0
