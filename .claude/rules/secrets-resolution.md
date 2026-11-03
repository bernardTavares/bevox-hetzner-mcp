---
name: secrets-resolution
glob: "core/src/**/*.ts"
priority: 1
---

# Rule: secrets-resolution

Authoritative reference: `CONTRIBUTING.md` §"Ground rules" #4
("Secrets resolved at apply only"), plus `CLAUDE.md` invariants and
`SECURITY.md` "Secret hygiene".

## Invariant

Secrets enter the system **only** as `secret:<ref>` references inside desired
state (YAML manifests, MCP/REST write tool payloads). The **resolved** value
of any secret exists **only** inside `apply()` of a Provider, gated by the
unforgeable `ApplyContext` token defined in `core/src/store/secrets.ts`.

A resolved secret MUST NEVER appear in:

- `Plan` (`core/src/reconciler/plan.ts`) — plans carry `secret:<ref>` only.
- `dry_run` output — same surface as `Plan`.
- Any `logger.*`, `console.*`, `req.log.*` invocation, at any log level.
- `StateEvent.payload` — drift reports, apply reports, observed-state diffs.
- Observed-state storage in Postgres — observed state never holds plaintext
  secrets; references only.
- Any HTTP response body, MCP tool result, or REST envelope returned to an
  agent.
- Error messages thrown out of `apply()` — wrap upstream errors so the
  resolved value never appears in `.message` or `.cause`.

## Test sentinels

The strings matching `S3CR3T-X.Y-must-never-leak-XYZ` (and the stub PEM
patterns `fakecert-*` / `fakekey-*`) are **leak-detection sentinels**. Their
purpose is to be searched for in test outputs: their presence anywhere
**outside** the test files allowlisted in `.gitleaks.toml` is, by construction,
a bug. They MUST NOT be introduced in `core/src/**` non-test code or in any
runtime output.

## Correct usage

```ts
// In a Provider's apply() — and ONLY here:
import type { ApplyContext } from "../store/secrets.js";

async function apply(desired: Desired, ctx: ApplyContext): Promise<Applied> {
  // The ApplyContext token is the only key that unlocks resolveSecret().
  const token = await ctx.resolveSecret(desired.apiToken); // desired.apiToken === "secret:hcloud/main"
  const client = new HetznerClient(token);
  try {
    return await client.upsert(desired.spec);
  } catch (err) {
    // Wrap — never re-throw an error whose .message could contain `token`.
    throw new ProviderError("hcloud.upsert failed", {
      cause: redactSecretsFromError(err),
      ref: desired.apiToken, // the REFERENCE is fine to log; the value is not.
    });
  }
}
```

## Incorrect usage (forbidden)

```ts
// In plan.ts — NEVER resolve here.
plan.envVars[k] = await resolveSecret(ref); // ❌ leaks into Plan → dry_run.

// In any logger — NEVER log the resolved value.
logger.info({ token }, "calling hcloud"); // ❌ token is the resolved secret.

// In StateEvent.payload — NEVER record the resolved value.
await recordEvent({ type: "apply", payload: { token } }); // ❌

// In error messages — NEVER let upstream error bodies escape verbatim.
catch (err) { throw new Error(`hcloud failed: ${err.message}`); } // ❌ if err.message contains token.
```

## Enforcement

- `core/src/reconciler/secret-apply.test.ts` is the golden test: it executes
  the full Observe → Plan → Apply → Record loop with sentinel-bearing secrets
  and asserts no sentinel string appears in any captured plan, log, or event.
- The `leak-sentinel-auditor` agent runs this check on demand against any
  changed code.
- `gitleaks` runs against the working tree with `.gitleaks.toml` allowlisting
  only the documented test files; any new file matching the sentinel patterns
  must be added to the allowlist with justification.
