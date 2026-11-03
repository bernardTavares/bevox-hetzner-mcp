#!/usr/bin/env bash
# PostToolUse-leak-scan.sh — scan TS file for secret-leak patterns.
# CONTRIBUTING ground rule #4: secrets resolved at apply only; plan/dry_run/logs
# MUST NEVER contain a resolved secret value. Sentinels (S3CR3T-*) belong only in
# test fixtures under core/test/ — never under core/src/.
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

[[ -f "$FILE_ABS" ]] || exit 0

# Only scan .ts under core/src or core/test
case "$FILE_NORM" in
  */core/src/*.ts|core/src/*.ts|*/core/test/*.ts|core/test/*.ts) ;;
  *) exit 0 ;;
esac

is_test_area=0
if [[ "$FILE_NORM" =~ /core/test/ ]] || [[ "$FILE_NORM" =~ ^core/test/ ]]; then
  is_test_area=1
fi

found_blocker=0

# 1) S3CR3T-* sentinel under core/src/ is a blocker (allowed only under core/test/)
if [[ $is_test_area -eq 0 ]]; then
  if grep -nE 'S3CR3T-[0-9.]+-[a-z-]+-[A-Za-z0-9]+' "$FILE_ABS" >/dev/null 2>&1; then
    log_warn "S3CR3T-* sentinel found under core/src/ — sentinels are TEST fixtures only:"
    grep -nE 'S3CR3T-[0-9.]+-[a-z-]+-[A-Za-z0-9]+' "$FILE_ABS" | sed 's/^/    /' >&2 || true
    log_warn "Move to a test under core/test/ or remove. See .gitleaks.toml allowlist."
    found_blocker=1
  fi
fi

# 2) Raw hcloud_* token literals (any area)
if grep -nE 'hcloud_[A-Za-z0-9]{8,}' "$FILE_ABS" 2>/dev/null | grep -v '// ok:' >/dev/null; then
  log_warn "Possible raw Hetzner Cloud token literal in $FILE_NORM:"
  grep -nE 'hcloud_[A-Za-z0-9]{8,}' "$FILE_ABS" | grep -v '// ok:' | sed 's/^/    /' >&2 || true
  found_blocker=1
fi

# 3) Logger calls that bind raw bearer/token fields directly
PATTERNS=(
  '(req\.log|log|logger)\.(info|debug|warn|error)\([^)]*\b(access_token|hcloud_token|bearer|secret_value|private_key)\b'
  'console\.(log|info|warn|error)\([^)]*\b(access_token|hcloud_token|bearer|secret_value|private_key)\b'
)
for pat in "${PATTERNS[@]}"; do
  if grep -nEi "$pat" "$FILE_ABS" 2>/dev/null | grep -v 'redact(' | grep -v '// ok:' >/dev/null; then
    log_warn "Possible token leak via log call in $FILE_NORM:"
    grep -nEi "$pat" "$FILE_ABS" | grep -v 'redact(' | grep -v '// ok:' | sed 's/^/    /' >&2 || true
    found_blocker=1
  fi
done

if [[ $found_blocker -eq 1 ]]; then
  log_warn "CONTRIBUTING ground rule #4: plan/dry_run/logs MUST NEVER contain a resolved secret value."
  log_warn "Use 'secret:<ref>' references. Wrap log fields with a redact() helper or annotate '// ok: <reason>' if false-positive."
fi

exit 0
