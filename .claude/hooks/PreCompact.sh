#!/usr/bin/env bash
# PreCompact.sh — snapshot session state before context compaction.
# Policy: NEVER include .env contents or anything under core/src/providers/
# (those files may carry inline secret-ref comments).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

mkdir -p "$STATE_DIR"
SNAPSHOT="$STATE_DIR/last-session.md"

cd "$PROJECT_ROOT" 2>/dev/null || true

{
  echo "# Last Session — bevox-hetzner-mcp"
  echo ""
  echo "Snapshot: $(date -Iseconds 2>/dev/null || date)"
  echo ""
  echo "## Current branch"
  git branch --show-current 2>/dev/null || true
  echo ""
  echo "## Working tree status (paths only — no diff content)"
  # Filter out provider paths to avoid surfacing inline secret-ref comments
  git status --short 2>/dev/null | grep -vE 'core/src/providers/' | grep -vE '\.env(\.|$)' || true
  echo ""
  echo "## Last 5 commits"
  git log --oneline -5 2>/dev/null || true
  echo ""
  echo "## Latest specs (top 3 by mtime)"
  if [[ -d "docs/specs" ]]; then
    ls -t docs/specs/*.md 2>/dev/null | head -3 | sed 's|^|- |' || true
  fi
  echo ""
  echo "## Latest plans (top 3 by mtime)"
  if [[ -d "docs/superpowers/plans" ]]; then
    ls -t docs/superpowers/plans/*.md 2>/dev/null | head -3 | sed 's|^|- |' || true
  fi
  echo ""
  echo "## Files changed vs upstream (provider/.env paths redacted)"
  if git rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; then
    git diff --name-only '@{u}'...HEAD 2>/dev/null \
      | grep -vE 'core/src/providers/' \
      | grep -vE '\.env(\.|$)' \
      | head -30 || true
  fi
  echo ""
  echo "---"
  echo "Policy: this snapshot OMITS .env* contents and anything under core/src/providers/."
  echo "Secret refs and provider apply paths are never serialised to disk by hooks."
} > "$SNAPSHOT"

log_info "Snapshot saved to $SNAPSHOT"
