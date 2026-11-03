#!/usr/bin/env bash
# PostToolUse-providers.sh — reminders when a file under core/src/providers/** is edited.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

FILE_NORM=$(echo "$FILE" | tr '\\' '/')

# Resolve absolute path
if [[ "$FILE_NORM" != /* ]] && [[ "$FILE_NORM" != ?:* ]]; then
  FILE_ABS="$PROJECT_ROOT/$FILE_NORM"
else
  FILE_ABS="$FILE_NORM"
fi

# Only care about provider sources (not tests, not fakes)
case "$FILE_NORM" in
  */core/src/providers/*) ;;
  *) exit 0 ;;
esac

# Skip test files themselves (they trigger their own checks)
if [[ "$FILE_NORM" =~ \.test\.ts$ ]]; then
  exit 0
fi

log_info "Provider source touched: $FILE_NORM"
log_info "Reminders (CONTRIBUTING / spec invariants):"
log_info "  - Idempotency property test: re-running apply on identical desired state must converge (see <provider>.test.ts)."
log_info "  - Fail-safe, never fail-deleting: no failure path may remove a resource the operator did not explicitly ask to remove."
log_info "  - Secrets resolved at apply only: plan/dry_run/logs MUST NEVER contain resolved secret values, only 'secret:<ref>'."
log_info "  - Every StateEvent records the actor."

# If the file is new (no companion <name>.test.ts), suggest provider-author agent
BASE_NO_EXT="${FILE_ABS%.ts}"
TEST_FILE="${BASE_NO_EXT}.test.ts"
if [[ ! -f "$TEST_FILE" ]]; then
  log_warn "No companion test file found at: ${TEST_FILE#$PROJECT_ROOT/}"
  log_warn "Consider invoking the 'specialized-mcp-builder' / 'engineering-backend-architect' agent for provider scaffolding,"
  log_warn "and run the 'idempotency-property-test' and 'fakes-author' skills before committing."
fi

# Best-effort skill stubs (non-blocking)
node "$HOOKS_DIR/lib/invoke-skill.js" idempotency-property-test "$FILE_NORM" >/dev/null 2>&1 || true

exit 0
