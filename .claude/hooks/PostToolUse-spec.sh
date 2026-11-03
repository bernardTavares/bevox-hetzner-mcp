#!/usr/bin/env bash
# PostToolUse-spec.sh — react to edits under docs/specs/**.
# - Loud warning for frozen specs (PreToolUse-guard should already block; defense in depth).
# - Suggest /new-plan when a new spec lands without a matching plan.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
FILE="$(json_field "$INPUT" "tool_input.file_path")"
[[ -z "$FILE" ]] && exit 0

FILE_NORM=$(echo "$FILE" | tr '\\' '/')
BASENAME=$(basename "$FILE_NORM")

case "$BASENAME" in
  2026-05-17-bevox-hetzner-mcp-design.md|2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
    log_warn "============================================================"
    log_warn "WARNING: $BASENAME is a FROZEN spec."
    log_warn "v1 (2026-05-17) and v2 contract (2026-05-20) are immutable."
    log_warn "CONTRIBUTING ground rule #1: invariants change via NEW spec revision."
    log_warn "If your edit slipped through the PreToolUse guard, revert NOW."
    log_warn "============================================================"
    exit 0
    ;;
esac

# Look for a matching plan in docs/superpowers/plans/
SLUG="${BASENAME%.md}"
PLAN_DIR="$PROJECT_ROOT/docs/superpowers/plans"
matching_plan=""
if [[ -d "$PLAN_DIR" ]]; then
  # Try suffix match (spec slug minus its leading date prefix)
  CORE_SLUG=$(echo "$SLUG" | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//')
  matching_plan=$(ls "$PLAN_DIR"/*"$CORE_SLUG"*.md 2>/dev/null | head -1 || true)
fi

if [[ -z "$matching_plan" ]]; then
  log_info "Spec touched: $FILE_NORM"
  log_info "No matching plan found under docs/superpowers/plans/ for slug '${CORE_SLUG:-?}'."
  log_info "Workflow: brainstorm -> spec -> plan -> implementation."
  log_info "Run '/new-plan' (superpowers:writing-plans) before touching code."
else
  log_info "Spec touched: $FILE_NORM (matching plan: ${matching_plan#$PROJECT_ROOT/})"
fi

exit 0
