#!/usr/bin/env bash
# SessionStart.sh — initial banner for bevox-hetzner-mcp.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

cd "$PROJECT_ROOT" 2>/dev/null || true

echo ""
echo "=== bevox-hetzner-mcp — session started ==="
echo "Date: $(date -Iseconds 2>/dev/null || date)"
echo "Root: $PROJECT_ROOT"

# --- Git ---
branch=$(git branch --show-current 2>/dev/null || echo "?")
last_commit=$(git log -1 --format='%h %s (%cr)' 2>/dev/null || echo "?")
echo ""
echo "Branch: $branch"
echo "Last commit: $last_commit"

# Status vs origin
if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
  ahead_behind=$(git rev-list --left-right --count '@{u}'...HEAD 2>/dev/null || echo "")
  if [[ -n "$ahead_behind" ]]; then
    behind=$(echo "$ahead_behind" | awk '{print $1}')
    ahead=$(echo "$ahead_behind" | awk '{print $2}')
    echo "vs upstream: $ahead ahead, $behind behind"
  fi
else
  echo "vs upstream: (no tracking branch)"
fi

# Working tree
dirty=$(git status --short 2>/dev/null | wc -l | tr -d ' ')
if [[ "$dirty" != "0" ]]; then
  echo "Working tree: $dirty modified path(s)"
else
  echo "Working tree: clean"
fi

# --- Latest specs ---
echo ""
if [[ -d "docs/specs" ]]; then
  echo "Latest specs (top 3 by mtime):"
  ls -t docs/specs/*.md 2>/dev/null | head -3 | sed 's/^/  - /' || echo "  (none)"
else
  echo "docs/specs: (missing)"
fi

# --- Latest plans ---
echo ""
if [[ -d "docs/superpowers/plans" ]]; then
  echo "Latest plans (top 3 by mtime):"
  ls -t docs/superpowers/plans/*.md 2>/dev/null | head -3 | sed 's/^/  - /' || echo "  (none)"
else
  echo "docs/superpowers/plans: (missing)"
fi

# --- Test status cache ---
echo ""
TEST_CACHE="$STATE_DIR/last-test-result.txt"
if [[ -f "$TEST_CACHE" ]]; then
  echo "Last test run:"
  head -3 "$TEST_CACHE" | sed 's/^/  /'
else
  echo "Last test run: (no cached result — run 'npm --prefix core test')"
fi

# --- Recent commits ---
echo ""
echo "Recent commits (last 5):"
git log --oneline -5 2>/dev/null | sed 's/^/  /' || echo "  (none)"

echo ""
echo "Reminders:"
echo "  - Spec-first workflow: brainstorm -> spec -> plan -> implementation."
echo "  - Frozen specs: 2026-05-17 (v1), 2026-05-20 (v2 contract). New spec to change invariants."
echo "  - Idempotency by design; fail-safe never fail-deleting; secrets resolved at apply only."
echo "  - Tests never touch real Hetzner/Docker (fakes under core/test/fakes/)."
echo ""
