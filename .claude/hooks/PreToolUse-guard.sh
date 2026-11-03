#!/usr/bin/env bash
# PreToolUse-guard.sh — block destructive ops and edits to frozen specs / security files.
# Reads JSON stdin from Claude Code. Exit 0 (allow) or 2 (block) with message to stderr.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

INPUT="$(read_hook_stdin)"
TOOL="$(json_field "$INPUT" "tool_name")"
[[ -z "$TOOL" ]] && TOOL="$(json_field "$INPUT" "tool")"

# --- Bash: block destructive commands ---
if [[ "$TOOL" == "Bash" ]]; then
  CMD="$(json_field "$INPUT" "tool_input.command")"
  [[ -z "$CMD" ]] && CMD="$(json_field "$INPUT" "input.command")"
  CMD_LC=$(echo "$CMD" | tr '[:upper:]' '[:lower:]')

  # rm against frozen specs / security / leak config
  if [[ "$CMD_LC" =~ rm[[:space:]].*docs/specs/2026-05-17 ]]; then
    block "rm against frozen v1 spec (2026-05-17-bevox-hetzner-mcp-design.md). Open a new spec revision per CONTRIBUTING ground rule #1."
  fi
  if [[ "$CMD_LC" =~ rm[[:space:]].*docs/specs/2026-05-20.*v2-architecture-contract ]]; then
    block "rm against frozen v2 contract (2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md). Open a new spec revision."
  fi
  if [[ "$CMD_LC" =~ rm[[:space:]].*\.gitleaks\.toml ]]; then
    block "rm against .gitleaks.toml. Changing leak-detection config requires an explicit PR review."
  fi
  if [[ "$CMD_LC" =~ rm[[:space:]].*(license|security\.md) ]]; then
    block "rm against LICENSE or SECURITY.md. Legal/security files require explicit PR."
  fi
  if [[ "$CMD_LC" =~ rm[[:space:]].*\.env ]]; then
    block "rm against .env files. Use .env.example as reference; never delete operator-supplied env files."
  fi

  # destructive git
  if [[ "$CMD_LC" =~ git[[:space:]]+push[[:space:]]+(--force|-f) ]]; then
    block "git push --force/-f disabled. Use rebase + normal push, or ask for explicit approval."
  fi
  if [[ "$CMD_LC" =~ git[[:space:]]+reset[[:space:]]+--hard ]]; then
    block "git reset --hard disabled. Use 'git stash' or targeted 'git restore'."
  fi
  if [[ "$CMD_LC" =~ git[[:space:]]+clean[[:space:]]+-fdx ]]; then
    block "git clean -fdx disabled. List paths to remove manually."
  fi

  # npm install <new pkg> — warn only (spec discussion first)
  if [[ "$CMD_LC" =~ ^[[:space:]]*npm[[:space:]]+(install|i|add)[[:space:]]+[a-z@] ]]; then
    if [[ ! "$CMD_LC" =~ npm[[:space:]]+(install|i)[[:space:]]*$ ]] && [[ ! "$CMD_LC" =~ npm[[:space:]]+install[[:space:]]+--prefix ]]; then
      warn_only "Adding an npm dependency. CONTRIBUTING: substantive changes start as a spec. List alternatives and justify before pinning a new runtime dep."
    fi
  fi

  exit 0
fi

# --- Edit/Write: block protected paths ---
if [[ "$TOOL" == "Edit" || "$TOOL" == "Write" || "$TOOL" == "MultiEdit" ]]; then
  FILE="$(json_field "$INPUT" "tool_input.file_path")"
  [[ -z "$FILE" ]] && FILE="$(json_field "$INPUT" "tool_input.path")"
  [[ -z "$FILE" ]] && FILE="$(json_field "$INPUT" "input.file_path")"

  # Normalize Windows separators
  FILE_NORM=$(echo "$FILE" | tr '\\' '/')

  case "$FILE_NORM" in
    */docs/specs/2026-05-17-bevox-hetzner-mcp-design.md|docs/specs/2026-05-17-bevox-hetzner-mcp-design.md)
      block "v1 spec (2026-05-17-bevox-hetzner-mcp-design.md) is FROZEN. Open a new spec revision per CONTRIBUTING ground rule #1."
      ;;
    */docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md|docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
      block "v2 architecture contract (2026-05-20-...) is FROZEN. Open a new spec revision."
      ;;
    */LICENSE|LICENSE)
      block "LICENSE requires an explicit human PR — never auto-edit."
      ;;
    */SECURITY.md|SECURITY.md)
      block "SECURITY.md requires an explicit human PR — never auto-edit."
      ;;
    */.gitleaks.toml|.gitleaks.toml)
      block "Changing .gitleaks.toml requires explicit review (it controls leak detection)."
      ;;
    */.env|*/.env.local|*/core/.env|*/console/.env|.env|.env.local|core/.env|console/.env)
      block ".env files are gitignored and operator-supplied. Edit .env.example if a new variable is needed."
      ;;
  esac
fi

exit 0
