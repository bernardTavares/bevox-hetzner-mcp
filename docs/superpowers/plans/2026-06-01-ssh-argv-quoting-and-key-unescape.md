# SSH argv quoting + SSH_PRIVATE_KEY unescape — Implementation Plan

**Spec:** `docs/specs/2026-06-01-ssh-argv-quoting-and-key-unescape.md` (Aceita).

**Goal:** Fix the two SSH deploy blockers (argv not shell-quoted → remote command
corruption; `SSH_PRIVATE_KEY` `\n` literals → OpenSSH rejects the keyfile) and
document the SSH credential workflow. TDD, fakes-only. Each task: red → minimal
green → one commit with the `Co-Authored-By` trailer and `spec:
2026-06-01-ssh-argv-quoting-and-key-unescape.md (task N)`.

**Working agreement:** `.claude/rules/tdd-required.md` + `esm-nodenext` (`.js`
imports, `import type`, narrow indexed access, no `console.*`, test-only export
uses `_` prefix — Rule 8). `npm --prefix core run typecheck` clean +
`npm --prefix core test` green before each commit.

---

### Task 1 — `_shellEscape` + `buildSshArgs` escapes each remoteArgv element (Bug 2, blocker)

- Files: `core/src/providers/ssh-exec.ts`, `core/src/providers/ssh-exec.test.ts`.
- [ ] Familiarise: `buildSshArgs` (`ssh-exec.ts:208-240`), the wrong comment at
  `:237` ("literal argv vector … No shell"), how `ssh-exec.test.ts` drives
  `runSsh`/`buildSshArgs` (is `buildSshArgs` exported or tested via a fake spawn
  capturing argv?). If `buildSshArgs` is private, export `_shellEscape` (Rule 8)
  and assert on it directly + add a `runSsh` argv-capture assertion.
- [ ] Failing test(s) in `ssh-exec.test.ts`:
  - `_shellEscape("\n__BEVOX_HTTP__%{http_code}")` === `'…'`-wrapped (newline +
    `%{}` preserved literally).
  - `_shellEscape("a b")`, `_shellEscape("$VAR")`, `_shellEscape("it's")`
    (→ `'it'\''s'`), `_shellEscape("")` (→ `''`).
  - Through the existing argv path: a `remoteArgv` with a `%{http_code}`/newline
    token yields, after `--`, the escaped tokens (each element wrapped); the
    non-remote ssh args (flags, host) are unchanged.
  - Round-trip property: joining the escaped tokens with spaces and parsing via
    a POSIX `sh -c 'printf %s\\n "$@"' _ <joined>` (or a small POSIX splitter)
    returns the original `remoteArgv`.
- [ ] Run `npm --prefix core test ssh-exec` → FAIL (raw tokens, not escaped).
- [ ] Minimal impl: add `export function _shellEscape(s)` (single-quote POSIX
  escaping); in `buildSshArgs` change the tail to
  `args.push("--", ...remoteArgv.map(_shellEscape))`; fix the comment to state
  ssh space-joins and the remote runs via `$SHELL -c`, so each token is escaped.
- [ ] Run → PASS; typecheck clean.
- [ ] Commit: `fix(core): shell-escape SSH remote argv to survive remote $SHELL -c (1)`

### Task 2 — `SSH_PRIVATE_KEY` `\n`-unescape + trailing newline (Bug 1)

- Files: `core/src/config.ts`, `core/src/config.test.ts` (extend or new).
- [ ] Familiarise: `requiredSecret` (`config.ts:55-59`, note `.trim()`),
  `SSH_PRIVATE_KEY` decl (`:124`), how `config.test.ts` builds a config from a
  raw env object.
- [ ] Failing test(s): parsing an env where `SSH_PRIVATE_KEY` contains literal
  `\n` (e.g. `-----BEGIN-----\nABC\n-----END-----`) yields a value with REAL
  newlines and a trailing `\n`; a PEM already containing real newlines is
  idempotent (only trailing ensured); `RESTIC_PASSWORD` containing `\n` is NOT
  unescaped (scope regression guard).
- [ ] Run `npm --prefix core test config` → FAIL.
- [ ] Minimal impl: `SSH_PRIVATE_KEY: requiredSecret("SSH_PRIVATE_KEY").transform(
  (s) => { const pem = s.replace(/\\n/g, "\n"); return pem.endsWith("\n") ? pem
  : pem + "\n"; })`.
- [ ] Run → PASS; typecheck clean. (After merge+build the `dist/` workaround is
  superseded by source — noted in spec §5; no source ref to remove.)
- [ ] Commit: `fix(core): unescape \\n in SSH_PRIVATE_KEY + ensure trailing newline (2)`

### Task 3 — Docs: `.env.example` + runbook + CHANGELOG (Bug 3)

- Files: `core/.env.example`, `deploy/` (runbook or README), `CHANGELOG.md`.
- Docs-only (spec-exempt per CLAUDE.md "operacional"); no TDD.
- [ ] `.env.example`: `SSH_PRIVATE_KEY` placeholder documents the single-line
  `\n`-escaped convention (post Bug 1); `SSH_HOST`/`SSH_USER` note real values.
- [ ] `deploy/` runbook: the SSH credential workflow (Hetzner SSH key → manifest
  `servers[].ssh_keys: ["<name>"]` → `.env` `SSH_PRIVATE_KEY` format).
- [ ] `CHANGELOG.md` `[Unreleased]`: SSH argv quoting + key-unescape fix entry
  citing the spec.
- [ ] Commit: `docs: SSH credential workflow + env.example + CHANGELOG (3)`

---

## Risks
- **`buildSshArgs` private/testability:** if it cannot be reached, export
  `_shellEscape` (Rule 8) and assert via a `runSsh` spawn-capture fake. Do not
  widen the public API beyond the `_`-prefixed helper.
- **Over-escaping:** single-quote wrapping is inert for already-safe tokens
  (`'curl'` runs fine); the round-trip test guards against regressions.
- **Idempotent key transform:** a real-newline PEM must not be double-processed;
  the test asserts idempotency.

## Rollback
- Pure additive correctness fixes; revert the commit range to restore prior
  (broken) behaviour. No migration, no contract change, no destructive op.

## Done =
Remote argv is shell-safe (each token escaped; comment corrected);
`SSH_PRIVATE_KEY` is normalised to real PEM with trailing newline (RESTIC
untouched); docs explain the SSH workflow; suite green; typecheck clean.
