---
description: Invokes the provider-author agent to scaffold a new provider adapter under core/src/providers/. Takes provider name + domain as input.
---

# /new-provider

Scaffolds a new provider adapter (Hetzner Cloud, Hetzner DNS, Docker,
WireGuard, restic, or v2 Bloco A primitives) following the canonical
provider contract from the v1 spec (`2026-05-17`) and v2 contract
(`2026-05-20`).

## Arguments

Two inputs, both required:

1. **Provider name** — kebab-case, no `Provider` suffix. Example: `hetzner-firewall`,
   `restic-snapshot`.
2. **Domain** — one of: `hetzner-cloud`, `hetzner-dns`, `docker`, `wireguard`,
   `restic`, or a v2 Bloco A primitive (`firewall`, `load-balancer`,
   `certificate`, `primary-ip`, `ingress`).

Example:

```
/new-provider
name: hetzner-loadbalancer-l7
domain: load-balancer
```

## What it does

1. Verifies a spec exists that motivates this provider (CONTRIBUTING
   §"Ground rules" #1). If not, aborts and points to `/new-spec`.
2. Verifies an active plan in `docs/superpowers/plans/` references this
   provider. If not, aborts and points to `/new-plan`.
3. Invokes the **`provider-author`** agent with: name, domain, target path
   (`core/src/providers/` or `core/src/providers/v2/`), reference spec, and
   the invariants the provider must uphold:
   - Idempotent `apply` (re-running converges).
   - Fail-safe: no failure path deletes resources not explicitly requested.
   - Secrets resolved only inside `apply` via the apply-context token; never
     in `plan` / `dry_run` / logs.
   - Every mutation emits a `StateEvent` with an `actor` field.
4. Agent produces: provider source file, sibling `*.test.ts` against fakes
   under `core/test/fakes/`, optional `@live` smoke under `core/test/live/`.
5. Reports the file paths. Does NOT wire the provider into the reconciler —
   that is a separate task in the plan.

## Does not

- Touch real Hetzner / Docker APIs in tests (CONTRIBUTING §"Tests never touch
  real infra").
- Skip the spec / plan precondition. Providers without a spec are rejected
  in PR review.
- Introduce a new SDK dependency without confirmation. The repo uses an
  in-house Hetzner Cloud REST client by design.
