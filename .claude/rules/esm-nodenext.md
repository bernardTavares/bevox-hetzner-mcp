---
name: esm-nodenext
glob: "core/src/**/*.ts"
description: |
  TypeScript NodeNext + strict ESM. Imports of project files use `.js`
  extension on `.ts` sources (NodeNext resolution rule). `verbatimModuleSyntax`
  is on — `import type` is required for type-only imports. `noUncheckedIndexedAccess`
  is on — narrow indexed access before use. Zod is the only wire schema
  validator. One responsibility per file, ~600-line soft limit (CONTRIBUTING
  §"Code style"). Aligned with `core/tsconfig.json`.
priority: 2
---

# Rule: ESM + NodeNext + strict TypeScript hygiene

Applies to all `core/src/**/*.ts`. The compiler settings in
`core/tsconfig.json` enforce most of this mechanically; the items below
are the conventions a human reviewer must check that no tool catches.

## Compiler baseline (do not weaken)

`core/tsconfig.json` is the source of truth:

```jsonc
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node", "vitest/globals"]
  },
  "include": ["src", "test"]
}
```

Do not relax any of these flags in a sub-config. Per CONTRIBUTING §"Code
style": "TypeScript strict (`NodeNext`, `noUncheckedIndexedAccess`,
`verbatimModuleSyntax`). ESM throughout".

## Rule 1 — `.js` extension on imports of project files

NodeNext resolution requires explicit extensions on relative imports of
project sources. The on-disk file is `.ts`, but the import string is
`.js`:

```typescript
// ✓ Correct
import { HttpClient } from "../http/http-client.js";
import type { Firewall } from "../../domain/v2/firewall.js";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";

// ✗ Wrong — NodeNext will not resolve
import { HttpClient } from "../http/http-client";
import { HttpClient } from "../http/http-client.ts";
```

This applies uniformly to `core/src/**` and `core/test/**`. Bare specifiers
(npm packages, e.g. `import { z } from "zod"`) do NOT take an extension.

## Rule 2 — `verbatimModuleSyntax`: `import type` for type-only imports

Every import used purely for types must use `import type` (or `import {
type Foo }`). The compiler will error otherwise, but in PR review:

```typescript
// ✓ Correct
import type { FastifyInstance } from "fastify";
import { z, type ZodType } from "zod";

// ✗ Wrong — value import for a type
import { FastifyInstance } from "fastify";
```

Mixed imports use the inline `type` modifier per specifier; do not split
into two import lines just to satisfy this rule.

## Rule 3 — `noUncheckedIndexedAccess`: narrow before use

Indexed access on arrays / records returns `T | undefined`. You MUST
narrow before use; do not assert away with `!` except when a runtime
invariant has just been checked.

```typescript
// ✗ Wrong
const first = items[0];
first.id;                          // TS2532: possibly undefined

// ✓ Correct — narrow
const first = items[0];
if (!first) throw new Error("empty");
first.id;                          // ok

// ✓ Correct — runtime invariant just checked
if (items.length === 0) return [];
const first = items[0]!;           // narrow via `!` only when invariant proved one line above
```

For `Record<string, T>` lookups, the safe pattern is:

```typescript
const v = byName[key];
if (v === undefined) throw new Error(`missing ${key}`);
```

## Rule 4 — Zod is the only wire schema validator

Every byte that crosses a process boundary (HTTP wire, DB column we don't
own, env var, file we did not just write) is validated through a Zod
schema. Per CONTRIBUTING §"Code style":

> Zod for all wire schemas. Cross-package contracts go through the
> console `contract.ts` / `contract-v2.ts` oracle.

Practical consequences:

- HTTP responses from fakes / real APIs: `.parse(await res.json())`
  against a Zod schema. Never `as SomeType` on `await res.json()`.
- Env vars: a single Zod object schema at process boot. No `process.env.X
  ?? ""` in business logic.
- DB rows for tables this project does not own (e.g. legacy schemas): Zod
  on the way in. Tables this project owns are typed via the
  observed/working store layer.
- Inter-package contracts (core ↔ console): defined in the console
  `contract.ts` / `contract-v2.ts` oracle and consumed by both sides.

No `any` on the wire. No `unknown` left un-narrowed past one line.

## Rule 5 — One responsibility per file (~600-line soft limit)

Per CONTRIBUTING §"Code style":

> One responsibility per file. If a file grows past ~600 lines or starts
> bundling unrelated concerns, split it.

Practical patterns the repo already follows:

- Provider modules split per resource family: `providers/v2/firewall.ts`,
  `providers/v2/load-balancer.ts`, etc.
- The Hetzner fake split its sub-stores into `core/test/fakes/hetzner-
  http-v2/<resource>.ts` once the parent passed the soft limit.
- One Zod schema family per file in `core/src/domain/` — entity + error
  taxonomy ride together; cross-entity helpers live elsewhere.

Symptoms a file is bundling unrelated concerns:

- Two `export` blocks separated by a comment header that essentially
  says "now for something completely different".
- Test file imports half the file just to mock the other half.
- Two unrelated PRs both touch the file every week.

When you split: keep the public API stable, re-export from the original
path during the same commit, and remove the re-export in a follow-up
commit once callers have migrated.

## Rule 6 — Tests colocated; live tests isolated

Per CONTRIBUTING §"Code style":

> Tests live next to source as `<name>.test.ts`. End-to-end and opt-in
> live tests live under `test/e2e/` and `test/live/` respectively.

The vitest `unit` project (see `core/vitest.config.ts`) globs `src/**/*.test.ts`
and `test/**/*.test.ts` and EXCLUDES `**/*.live.test.ts`. Add a unit test
to `core/src/foo.test.ts`; add a live smoke to `core/test/live/foo.live.test.ts`.
Do not put a `.live.test.ts` next to source — the project glob will not
exclude it correctly.

## Rule 7 — No `console.*` in `core/src/**`

Logs go through the project's structured logger (Pino in the meta-api
sibling; `core/src/` follows the same convention via its own logger
seam). `console.log` / `console.error` in production code is a review
block — at minimum it bypasses log redaction, at worst it leaks secrets
(see ground rule 4 in CONTRIBUTING: "Secrets resolved at apply only.
`plan` / `dry_run` / logs MUST NEVER contain a resolved secret value").

## Rule 8 — Test-only exports use the `_<name>` prefix

A symbol exported solely so that a colocated `*.test.ts` (or `core/test/`
file) can reach it MUST be named with a leading underscore — e.g.
`export async function _validateSopsAgeConfig(...)`. Production callers
MUST NEVER reach the symbol directly; they go through an indirected
public entrypoint (e.g. `buildBootDeps`) that calls the `_`-prefixed
helper internally.

Rationale. TypeScript has no first-class "internal export" modifier. The
`_<name>` prefix is the project's hand-rolled convention to mark "this is
public to the compiler so the test can import it, but it is NOT part of
the runtime contract". Reviewers should treat a non-test call site of a
`_`-prefixed symbol as a layering violation: refactor the caller to go
through the indirected entrypoint instead.

When to use:

- Boot-time validation helpers whose inputs are stable but whose unit
  test wants direct seam injection (e.g. `_validateSopsAgeConfig`
  consumes `fs` + `spawn` directly; production wires them via
  `buildBootDeps`).
- Pure helpers whose extraction is justified by testability alone, not
  by any external caller's need.

When NOT to use:

- A symbol another `core/src/**` module legitimately consumes — that is
  a normal export, no prefix.
- A symbol another package consumes — that goes in the cross-package
  contract (e.g. console `contract.ts`), not under `_`.

Convention added at the explicit guidance of plan
`docs/superpowers/plans/2026-05-28-secret-resolver-real-v1.md` Task 2.1
(the first production helper to use the prefix in `core/src/`).

## Checklist for reviewers

- [ ] All relative imports end in `.js`.
- [ ] Every type-only import is `import type` (or inline `type`).
- [ ] Every `arr[i]` / `record[k]` is narrowed before use or proven
      non-`undefined` by a check on the previous line.
- [ ] Wire data is parsed through Zod; no `as` casts on `res.json()`,
      `JSON.parse`, `process.env.*`, or untyped DB row.
- [ ] File is under ~600 lines and represents one responsibility.
- [ ] Test colocation is correct (`*.test.ts` next to source for unit,
      `*.live.test.ts` only under `core/test/live/`).
- [ ] No `console.*` in `core/src/`.
- [ ] `_<name>`-prefixed exports are reached only from test files; any
      production call site of a `_`-prefixed symbol is a layering
      violation (Rule 8).

## References

- `core/tsconfig.json` (compiler baseline)
- `core/vitest.config.ts` (`unit` vs `live` project split)
- `CONTRIBUTING.md` §"Code style"
- `CONTRIBUTING.md` §"Ground rules" item 4 (secrets / log hygiene)
- `.claude/skills/fakes-author/SKILL.md` (how to test new external HTTP
  deps without violating Rule 4)
