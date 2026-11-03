---
name: fakes-author
description: |
  Author a new HTTP fake under `core/test/fakes/` for a Hetzner-family or
  adjacent external service (Hetzner Cloud, hcloud DNS, Docker Engine, restic,
  ACME, SSH control). Fakes are the seam that lets the reconciler's plan / apply
  / observe paths run in-process with ZERO network, DB or filesystem — they are
  the reason CI is allowed to run on a laptop and the reason real-infra calls
  never enter CI. This skill encodes the non-negotiable shape: per-instance
  closure state, wire-compatible JSON, deterministic fault injection, per-test
  isolation via `reset()`, and a drop-in `fetchImpl` interface compatible with
  `HttpClient`.
when_to_invoke: |
  - Adding a new external HTTP dependency (e.g. a new Hetzner sub-API, a new
    Docker endpoint, a new ACME / restic surface) that production code reaches
    via `HttpClient` or `fetch`.
  - Extending an existing fake with a new endpoint family large enough to
    warrant its own sub-store (mirrors the `hetzner-http-v2/` split pattern).
  - Reviewing a PR that introduces real network calls in tests — this skill is
    the canonical "what to write instead".
inputs:
  - Service name (e.g. `restic-http`, `hetzner-storage-box`, `docker-engine-v2`)
  - Minimum endpoint surface needed by the caller (list / get / create /
    update / delete + any action endpoints)
  - Resource shape(s) — exact Hetzner / Docker JSON the production code parses
  - Fault classes required for resilience tests (rate-limit, auth, validation,
    transient 5xx, polling latency)
inputs_optional:
  - Existing sibling fake to mirror (default: `core/test/fakes/hetzner-http.ts`
    + `core/test/fakes/hetzner-http-v2/firewalls.ts`)
outputs:
  - `core/test/fakes/<name>.ts` — per-instance factory, closure state,
    wire-compatible `fetch` handler, fault toggles, `reset()`.
  - `core/test/fakes/<name>.test.ts` — direct unit coverage of the fake itself
    (creation, isolation, faults). Sibling-style colocation per CONTRIBUTING.
  - Optional sub-store under `core/test/fakes/<name>-v2/<resource>.ts` if the
    surface is large enough to warrant routing delegation.
references:
  - references/fake-pattern.md
---

# Skill: fakes-author

## Why this exists

Per CONTRIBUTING §"Tests never touch real infra": Hetzner Cloud, Docker
Engine, SSH, restic, ACME — all of these go through interface seams, and CI
runs ONLY against fakes in `core/test/fakes/`. A regression that puts a real
network call into CI breaks the test contract and is grounds for revert.

A fake is NOT a spec-faithful emulator. It models the MINIMAL surface the
reconciler needs, wire-compatible enough that production parsing,
pagination-walking and error-class mapping work unchanged. Everything else
is YAGNI.

## When to use this skill — vs. when NOT to

Use ESTA skill when:
- Production code reaches an external HTTP API and the test would otherwise
  need the network.
- An existing fake is missing endpoints required by a new provider or by a
  resilience test (e.g. drift injection, 429 retry, 401 fatal).

Do NOT use for:
- Pure in-process seams (a plain Vitest `vi.fn()` mock is fine).
- DB-backed harnesses — `core/test/fakes/pg-harness.ts` already covers
  Postgres isolation; do not duplicate.
- One-off stubs inside a single test file — promote to a shared fake only
  when ≥2 callers need the same surface.

## Procedure

### 1. Preparatory reading

- `CONTRIBUTING.md` §"Tests never touch real infra", §"Layout", §"Code
  style" (NodeNext, `.js` import extension, `noUncheckedIndexedAccess`,
  `verbatimModuleSyntax`, ~600-line soft limit).
- `core/test/fakes/hetzner-http.ts` (lines 1–250) — canonical comment block
  + factory shape. The header documents the four invariants every fake
  must honor: per-instance, wire-compatible, deterministic faults,
  exported minimal API.
- `core/test/fakes/hetzner-http-v2/firewalls.ts` — sub-store delegation
  pattern (used when a single fake outgrows the soft size limit).
- `core/test/fakes/pg-harness.ts` — the isolation philosophy referenced
  in the hetzner-http.ts header ("per-instance, resettable").
- `core/vitest.config.ts` — see the `unit` vs `live` project split. The
  `unit` project excludes `**/*.live.test.ts`; your fake must NOT be
  imported from any `*.live.test.ts` (those are the only files allowed
  to hit real infra).
- `references/fake-pattern.md` in this skill (annotated template + real
  excerpt).

### 2. Design decisions (answer before writing code)

| Question | Options |
|---|---|
| Surface scope | Strict minimum the caller parses — list `meta.pagination`, action envelopes, error `{ error: { code, message } }`. Anything not parsed: omit. |
| State shape | `Map<id, Resource>` in closure + monotonic `seq` counters. NO global / module-level mutable state. |
| Routing | Single switch in `fetch`, OR delegate to per-resource sub-stores (`<name>-v2/<resource>.ts`) if the surface grows past ~400 lines. |
| Fault injection | At minimum: rate-limit (N × 429 + `Retry-After`), auth (sticky 401), one-shot next-request fault (status + code + message). Add polling-latency / per-resource flips only when a test demands them. |
| Pagination | Mirror the upstream exactly (Hetzner: `meta.pagination.{page,per_page,previous_page,next_page,last_page,total_entries}`). HttpClient's `getAllPages` terminates on `next_page: null`. |
| Wire response | `Response` from WHATWG `fetch` — always set `Content-Type: application/json`. 204 → `new Response(null, { status: 204 })`. |
| Test-only escape hatches | OK as `readonly` sub-object on the public interface (e.g. `firewalls.injectExtraRule(...)`) — used for drift tests. MUST be documented as test-only and production MUST NOT depend on them. |

### 3. Canonical structure

Mirror `references/fake-pattern.md`. Non-negotiable points:

```typescript
/**
 * core/test/fakes/<name>.ts
 *
 * In-memory, per-instance fake of <SERVICE>. Sole job is to be a
 * deterministic `fetchImpl` seam for HttpClient so the reconciler can
 * exercise translation / convergence with ZERO network, DB or filesystem.
 *
 * NOT a spec-faithful emulator. Models only what production parses.
 */

// 1) Public shape — the ONLY surface tests touch.
export interface MyFake {
  /** Drop-in `fetchImpl` for HttpClient — never touches the network. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Clear all resources, id counters and pending faults. */
  reset(): void;
  setRateLimitFault(opts: { times: number; retryAfter: number }): void;
  setAuthFault(on: boolean): void;
  setNextRequestFault(opts: { status: number; code: string; message: string }): void;
}

// 2) Resource model — narrow Zod-friendly shape; only fields the caller parses.
interface MyResource {
  id: number;
  name: string;
  labels: Record<string, string>;
  created: string;
}

// 3) Factory — per-instance state lives in the closure.
export function createMyFake(): MyFake {
  let resources = new Map<number, MyResource>();
  let seq = 0;
  let rateLimit: { remaining: number; retryAfter: number } | null = null;
  let authFault = false;
  let nextFault: { status: number; code: string; message: string } | null = null;

  function reset(): void {
    resources = new Map();
    seq = 0;
    rateLimit = null;
    authFault = false;
    nextFault = null;
  }

  function json(body: unknown, status: number): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function err(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
  }

  // Faults run BEFORE routing.
  function maybeFault(): Response | null {
    if (authFault) return err(401, "unauthorized", "auth fault");
    if (nextFault) {
      const f = nextFault;
      nextFault = null;
      return err(f.status, f.code, f.message);
    }
    if (rateLimit && rateLimit.remaining > 0) {
      rateLimit.remaining -= 1;
      return new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "slow down" } }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(rateLimit.retryAfter) },
      });
    }
    return null;
  }

  async function fetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const method = (init?.method ?? "GET").toUpperCase();

    const fault = maybeFault();
    if (fault) return fault;

    // Route on trailing path segments — host/prefix is irrelevant by design.
    // ... switch on (method, url.pathname) ...
    return err(404, "not_found", `unhandled ${method} ${url.pathname}`);
  }

  return {
    fetch: fetchImpl,
    reset,
    setRateLimitFault: (opts) => { rateLimit = { remaining: opts.times, retryAfter: opts.retryAfter }; },
    setAuthFault: (on) => { authFault = on; },
    setNextRequestFault: (opts) => { nextFault = opts; },
  };
}
```

Why these specific points are non-negotiable:

- **Per-instance, closure state**: `reset()` re-creates the maps and zeros
  the counters; two tests in the same file get full isolation without
  worrying about Vitest's serial-vs-concurrent file ordering (the root
  `fileParallelism: false` only protects the DB harness).
- **`fetch` returns real `Response`**: HttpClient cannot tell it apart
  from a real `fetch`. Production parsing exercises real JSON, real
  status codes, real `Retry-After` headers.
- **Route on trailing path segments**: lets a single fake serve both Cloud
  API (`api.hetzner.cloud/v1/...`) and DNS API (`dns.hetzner.com/api/v1/...`)
  without coupling to host configuration.
- **`maybeFault()` BEFORE routing**: faults are deterministic and consume
  exactly N requests, regardless of which endpoint was hit. This is what
  makes resilience tests assertable.

### 4. Sibling test (mandatory)

`core/test/fakes/<name>.test.ts` covers, at minimum:

- Two `createMyFake()` instances are independent (mutate one, assert the
  other is empty).
- `reset()` brings counters back to 0.
- `setRateLimitFault({ times: 2, retryAfter: 1 })` — exactly 2 × 429
  followed by a normal response.
- `setAuthFault(true)` — every request is 401 until toggled off.
- `setNextRequestFault({ status: 422, code: "invalid_input", message: "..." })`
  consumes exactly one request.
- Wire compatibility: pagination terminates on `next_page: null`.

The sibling test is the proof the fake itself works — provider tests
that import it then run cheaply.

### 5. Wiring into a provider test

The fake is a drop-in `fetchImpl`:

```typescript
import { createMyFake } from "../../../test/fakes/my-fake.js";  // NodeNext .js
import { HttpClient } from "../../src/providers/.../http-client.js";

const fake = createMyFake();
const http = new HttpClient({ baseUrl: "https://api.example/v1", token: "stub", fetchImpl: fake.fetch });
afterEach(() => fake.reset());
```

NEVER:

- Bind to a real TCP port. Fakes are in-process `fetch` handlers, NOT
  http.Server instances. A port-based fake would re-introduce flakiness
  (port collisions, async listener startup) the closure model eliminates.
- Reach `globalThis.fetch` from a fake. The fake IS the fetchImpl; it
  must be pure.
- Add a `@live` suffix to a fake-backed test. `@live` is reserved for
  `*.live.test.ts` files that opt into real infra and are excluded from
  `npm test` via the vitest `unit` project's glob.

### 6. Verification

```bash
npm --prefix core run typecheck                  # NodeNext strict; must be clean
npm --prefix core test -- test/fakes/<name>      # sibling test green
npm --prefix core test                           # full suite still green
```

## Checklist before declaring done

- [ ] File header documents: scope, what is NOT modeled, link to provider it
      serves.
- [ ] `createMyFake()` returns a fresh instance; no module-level mutable state.
- [ ] `reset()` clears resources, counters AND all pending faults.
- [ ] `fetch` is `(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>`.
- [ ] At least three fault toggles: rate-limit, auth, one-shot next-request.
- [ ] Wire shape matches what production parses (verified by an existing
      provider test, not by reading docs).
- [ ] Pagination matches upstream (`next_page: null` terminates).
- [ ] Imports of project files use `.js` extension (NodeNext).
- [ ] No `any` in the public interface; resource shapes are explicit.
- [ ] File under ~600 lines, else split into `<name>-v2/<resource>.ts` sub-stores.
- [ ] Sibling `<name>.test.ts` covers isolation, reset, and every fault toggle.
- [ ] No real network call introduced (`fetchImpl` is the only seam).
- [ ] No import from `*.live.test.ts`; not referenced from `test/live/`.

## Limits

- Do not add HTTP server / port-binding code. The closure-based fetch
  handler is the entire contract.
- Do not add cross-fake shared state (e.g. a "global clock"). Determinism
  comes from per-instance state + explicit fault toggles; nothing else.
- Do not model authentication beyond the sticky-401 fault — production's
  token threading is exercised by `HttpClient` unit tests, not here.
- Do not exceed ~600 lines per file (CONTRIBUTING §"Code style"). Split
  via the `<name>-v2/<resource>.ts` sub-store pattern.
