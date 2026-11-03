# HetznerCloud declarative→wire translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended for the ~10
> tasks below) or superpowers:executing-plans to implement this plan
> task-by-task. Each task is a self-contained TDD unit (failing test →
> run → minimal impl → run → commit). Do not skip the red step. Do not
> batch commits.

**Goal:** Replace the bookkeeping-only `toApiBody()` in
`core/src/providers/hetzner-cloud.ts` with per-kind translation that
produces Hetzner-wire-shaped bodies for `network`, `server` and
`volume` creates, and a name→id lookup pre-write step in `apply()`
that fails-safe (`precondition`) before any POST when a referenced
network/server is missing. After this PR + a real `HCLOUD_TOKEN`,
`apply_manifest` actually creates resources on Hetzner; pre-fix it
returns the honest "HTTP 400 json_error" exposed by PR-A.

**Architecture:** One file changes in production
(`core/src/providers/hetzner-cloud.ts`) — `toApiBody(kind, desired,
refs?)` gains three per-kind branches and `apply()` resolves
`networkIds` / `serverId` via the existing `findByName` helper
**before** calling `toApiBody`. One new test-only fixture
(`core/test/fakes/hetzner-http-capture.ts`) captures `{url, method,
body}` per call so wire shape can be asserted without going live; it
is **separate** from the existing stateful fake `hetzner-http.ts`,
which is left untouched (backwards-compat for the 954-strong suite).
v1/v2 invariants (idempotency, fail-safe, secrets-at-apply,
StateEvent actor) are preserved; schemas in
`core/src/domain/entities.ts` and the manifest schema are NOT
modified — translation happens at the apply boundary.

**Tech Stack:** Inherits the v1 ratified stack (Node.js 20+,
TypeScript 5.x ESM/NodeNext strict, Zod, Vitest + HTTP fakes). **Zero
new dependencies.** Continues the v1 "no Hetzner SDK" posture — the
new capture fake is a 80–120-line `fetchImpl` adapter, just like
`hetzner-http.ts`.

**Specs:**
- This plan: `docs/specs/2026-05-27-hetzner-cloud-wire-translation.md` (Aceita 2026-05-27)
- Spec irmã (PR-A, merged): `docs/specs/2026-05-27-reconcile-envelope-failure-surface.md`
- Spec-mãe (v1, FROZEN): `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`

---

## How this plan is executed

The plan is one PR on the existing branch
`fix/hetzner-cloud-wire-translation` (already cut from `main`
post-PR-A; this plan does **not** create a branch). Five phases (F0
foundation → F1 network → F2 server + lookups → F3 volume → F4
end-to-end + comment cleanup) plus an F5 verification gate (no
commit). Phases are linear: `F0` is a blocking gate; `F1..F3` are
ordered by risk (network is the simplest translation; server adds
the lookup-before-POST orchestration; volume adds size-string
parsing). Each phase produces working, testable software on its
own.

Baseline suite estimate (post-PR-A): **954 passing / 955 total** (1
`@live` skipped). This plan adds ~7 unit tests; final estimate
≈ 961/962.

### Working agreement (all tasks)

- **TDD, always**: write failing test first → run, see it fail
  (red, for the right reason — assertion, not import) → minimal
  production change → run, see it pass (green) → commit. Reference
  @superpowers:test-driven-development.
- **DRY / YAGNI / minimal change**: scope is strictly the
  `HetznerCloudProvider`. No touching v2 providers, no manifest
  schema enrichment, no `update`/`destroy` paths. Reference
  @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Commit message
  trailer mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Verify before completion**: @superpowers:verification-before-completion
  before any "done" claim.
- **Tests never touch real Hetzner**: every HTTP call resolves
  through the new capture fake (or the existing
  `createHetznerHttpFake()` for regression). `@live` lives only
  under `core/test/live/*.live.test.ts` and is excluded from the
  `unit` vitest project.
- **No silent drift correction, no destructive rollback**: lookup
  failure throws `ReconcileError("precondition", ...)` **before**
  any POST; nothing is created on failure (fail-safe).
- **Secrets at apply only**: `toApiBody` is a pure
  declarative→wire translator; it never sees or logs a resolved
  token. Authorization continues to be injected by `HttpClient`
  from `defaultHeaders`.
- Vitest invocation: `npm --prefix core test -- src/<path>` (path
  relative to the `core/` package root).
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — no public surface changes

This plan is **internal-only**. No MCP tool, REST endpoint, wire
envelope, manifest schema or `StateEvent` shape is added or
modified. The console contract (`console/CONTRACT.md`,
`contract.ts`, `contract-v2.ts`) is untouched.

What is frozen in this PR (private surface — consumed only inside
`hetzner-cloud.ts`):

```ts
interface ApiBodyRefs {
  readonly networkIds?: ReadonlyArray<number>;
  readonly serverId?: number;
}

function toApiBody(
  kind: Kind,
  desired: Record<string, unknown>,
  refs?: ApiBodyRefs,
): Record<string, unknown>;
```

Per-kind branches (frozen by this plan; future v2 schema-enrichment
specs add branches, never rewrite):

- `kind === "network"` — produces `{name, ip_range, subnets:
  Array<{ip_range, type:"cloud", network_zone:"eu-central"}>}`.
  Empty/undefined `desired.subnets` → `subnets: []`.
- `kind === "server"` — produces `{name, server_type, image,
  location, networks:[<id>], ssh_keys, labels}`. `type` is **renamed**
  to `server_type`; `network` (string name) is **removed** and
  replaced with `networks: refs.networkIds`.
- `kind === "volume"` — produces `{name, size:<number>, format,
  server?:<id>, location?}`. `fs` is **renamed** to `format`; `size`
  is **parsed** from `"<N>G"` or `"<N>"` to number; if
  `desired.server` is present, `refs.serverId` is required and
  `location` is omitted; else `location` is required and `server` is
  omitted.

---

## Non-negotiable principles

All v1/v2 principles apply unchanged (spec §5). Restated for this
plan:

1. **Idempotency by design**: `observe-before-create` and
   `findByName` lookups are unchanged. Re-apply of a converged
   manifest emits zero mutating POSTs. The existing property tests
   under `core/src/reconciler/idempotency*.property.test.ts` MUST
   remain green and untouched.
2. **Fail-safe, never fail-deleting**: lookup failure (missing
   referenced network or server) throws
   `ReconcileError("precondition", ..., {entity})` **before** the
   POST. No resource is created on failure. No `delete` /
   `destroy` / `detach` call is added to any code path.
3. **Secrets at apply only**: `toApiBody` is a pure translator
   that never resolves or logs a secret. The Hetzner token
   continues to flow through `HttpClient.defaultHeaders`.
4. **StateEvent actor**: `apply()` continues NOT to write
   `StateEvent` directly — that is owned by `reconciler/apply.ts`
   via `ApplyContext`. No new write site is introduced.
5. **No silent drift correction**: this plan does not introduce a
   drift-correction branch; existing drift reporting in upstream
   layers is unaffected.

---

## Testing strategy

| Layer | How | What it covers |
|---|---|---|
| Fake fixture (`core/test/fakes/hetzner-http-capture.test.ts`) | Smoke-tests the new capture fake itself: POST records body, GET returns seed, unhandled methods throw | §4.4 of spec; gives downstream tasks a trustworthy assertion seam |
| Unit — network wire shape (`core/src/providers/hetzner-cloud.test.ts` new `describe` block) | Provider+capture fake; assert captured POST body for network shape | §4.1 spec |
| Unit — server wire shape + lookup (`hetzner-cloud.test.ts`) | Seed `GET /networks?name=…` with a stub; assert captured POST body has `server_type` rename and resolved `networks:[<id>]` | §4.2 spec |
| Unit — server lookup failure (`hetzner-cloud.test.ts`) | Seed empty networks; assert `apply()` throws `precondition` and that captured requests contain ZERO `POST /servers` | §4.2 fail-safe |
| Unit — volume wire shape (`hetzner-cloud.test.ts`) | Attached (with `server`) and standalone (with `location`); assert `fs`→`format` rename and size parsing | §4.3 spec |
| Unit — volume size parse rejection (`hetzner-cloud.test.ts`) | `"500M"` → `precondition`; `"10G"`/`"100"` accepted | §4.3 strict-reject decision |
| Integration sentinel (`hetzner-cloud.test.ts` new test) | Drives network create then server create in one rig; asserts BOTH wire bodies are correct | §4.6 orchestration |
| Regression — existing `hetzner-cloud.test.ts` suite | Continues to use `createHetznerHttpFake()` (stateful fake) untouched | §6 acceptance criterion 6 |
| Property — existing `idempotency*.property.test.ts` | Re-run unchanged; second apply still no-op | Invariant 1 |
| `@live` (opt-in, manual) | `core/test/live/hetzner-cloud-wire.live.test.ts` skeleton requires `HETZNER_LIVE_TOKEN` + `HETZNER_LIVE_ZONE`; excluded from CI by the `unit` vitest project glob | §9 acceptance criterion 9; deferred to owner |

CI runs unit + property with fakes on every commit; never touches
real Hetzner. `@live` runs on demand pre-release only.

---

## File structure (one responsibility per file)

```
core/
  src/
    providers/
      hetzner-cloud.ts                 MODIFIED — toApiBody per-kind (+ refs), apply() lookup orchestration
      hetzner-cloud.test.ts            MODIFIED — new describe("wire shape") block (~150-200 lines added)
  test/
    fakes/
      hetzner-http-capture.ts          NEW — createCaptureHetznerHttpFake() (~80-120 lines)
      hetzner-http-capture.test.ts     NEW — fixture smoke (~30-50 lines)
    live/
      hetzner-cloud-wire.live.test.ts  NEW (optional, opt-in) — env-gated live smoke (~50-80 lines)
```

No other file is created or modified by this plan. The existing
fake `core/test/fakes/hetzner-http.ts` is intentionally **not**
retrofitted (spec §8 open question — non-blocking).

---

# Task 0 (F0) — Capture fake fixture (BLOCKING GATE)

**Goal/deliverable:** A new test-only fake fixture
`createCaptureHetznerHttpFake()` that exposes a `fetchImpl` matching
`HttpClient`'s seam, captures every request as `{url, method, body}`,
and returns minimally Hetzner-shaped responses (so `findByName`
keeps working). Fixture is verified by its own colocated smoke test.

**Exit criteria:** `npm --prefix core test -- test/fakes/hetzner-http-capture`
green, `npm --prefix core run typecheck` clean. Baseline 954/955
suite remains green.

### Task 0.1 — `createCaptureHetznerHttpFake()` + smoke test

- Files:
  - NEW `core/test/fakes/hetzner-http-capture.ts`
  - NEW `core/test/fakes/hetzner-http-capture.test.ts`
- [ ] Familiarise: read `core/test/fakes/hetzner-http.ts` lines
      1–120 (existing fake's public shape, `fetch` signature,
      response shape with `meta.pagination.next_page`) and
      `core/src/providers/http-client.ts` lines 160–245 (how
      `HttpClient.request` and `getAllPages` call `fetchImpl`). The
      capture fake mimics the same `(input, init?) => Promise<Response>`
      signature so it slots into `new HttpClient({ fetchImpl, ... })`
      with no other change.
- [ ] Failing test (`hetzner-http-capture.test.ts`):
  ```ts
  import { describe, it, expect } from "vitest";
  import { createCaptureHetznerHttpFake } from "./hetzner-http-capture.js";

  describe("hetzner-http-capture fake", () => {
    it("captures POST /v1/networks body and returns a stable 201 envelope", async () => {
      const fake = createCaptureHetznerHttpFake();
      const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "mesh", ip_range: "10.0.0.0/16", subnets: [] }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body).toEqual({ network: { id: 1, name: "mesh" } });
      expect(fake.requests).toHaveLength(1);
      expect(fake.requests[0]).toEqual({
        url: "https://api.hetzner.cloud/v1/networks",
        method: "POST",
        body: { name: "mesh", ip_range: "10.0.0.0/16", subnets: [] },
      });
    });
    it("returns a seeded GET list with Hetzner pagination meta so findByName works", async () => {
      const fake = createCaptureHetznerHttpFake({
        collections: { networks: [{ id: 42, name: "bevox-priv" }] },
      });
      const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks?page=1", { method: "GET" });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({
        networks: [{ id: 42, name: "bevox-priv" }],
        meta: { pagination: { next_page: null } },
      });
    });
    it("throws on unhandled methods/paths so leaks fail loud", async () => {
      const fake = createCaptureHetznerHttpFake();
      await expect(
        fake.fetchImpl("https://api.hetzner.cloud/v1/floating_ips", { method: "PUT" })
      ).rejects.toThrow(/unhandled/i);
    });
    it("reset() clears captured requests and id counter", async () => {
      const fake = createCaptureHetznerHttpFake();
      await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
        method: "POST",
        body: JSON.stringify({ name: "a" }),
      });
      fake.reset();
      expect(fake.requests).toHaveLength(0);
      const res = await fake.fetchImpl("https://api.hetzner.cloud/v1/networks", {
        method: "POST",
        body: JSON.stringify({ name: "b" }),
      });
      const body = await res.json();
      expect(body.network.id).toBe(1); // counter restarted
    });
  });
  ```
- [ ] Run `npm --prefix core test -- test/fakes/hetzner-http-capture`
      → expect FAIL (module not found).
- [ ] Minimal impl `hetzner-http-capture.ts`:
  - Export `CaptureRequest = { url: string; method: string; body:
    unknown }` and `CaptureHetznerHttpFake = { fetchImpl, requests:
    ReadonlyArray<CaptureRequest>, reset() }` matching spec §4.4.
  - Factory signature: `createCaptureHetznerHttpFake(opts?: {
    collections?: Record<string, ReadonlyArray<{id:number;
    name:string}>> })`.
  - `fetchImpl(url, init)`:
    - Parse `URL(url)`; route by `pathname` suffix:
      `/v1/<collection>` (with or without query string).
    - GET → return `200 { [collection]: opts.collections?.[collection]
      ?? [], meta: { pagination: { next_page: null } } }`.
    - POST → parse `init.body` as JSON, push `{url, method:"POST",
      body}` onto `requests`, allocate `id = ++counter`, return
      `201 { [singular(collection)]: { id, name: body.name },
      next_action: null }`. The singular form is the simple
      strip-trailing-`s` (`networks`→`network`, `servers`→`server`,
      `volumes`→`volume`); volume's irregular plural is N/A here.
    - Any other method → `throw new Error("unhandled in capture
      fake: " + method + " " + url)`.
  - `reset()` clears `requests` and resets `counter` to 0.
- [ ] Run `npm --prefix core test -- test/fakes/hetzner-http-capture`
      → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `test(core): capture HetznerHttpFake fixture for wire-shape asserts (0.1)`

**Done (Task 0) =** `createCaptureHetznerHttpFake()` is available
under `core/test/fakes/`, its own smoke test passes, and downstream
tasks (F1–F3) can mount it under `HttpClient` to assert wire bodies.
F1 may begin.

---

# Fase 1 (F1) — Network wire body

**Phase goal:** `toApiBody("network", desired)` produces the
Hetzner-wire shape: `subnets: Array<{ip_range, type:"cloud",
network_zone:"eu-central"}>` instead of `Array<string>`. Empty /
undefined `subnets` → `subnets: []`.

**Deliverable:** Per-kind `network` branch in `toApiBody`; existing
provider regression suite still green.

**Exit criteria:** `npm --prefix core test -- src/providers/hetzner-cloud`
green; new network-wire test asserts the exact subnet object shape;
existing `hetzner-cloud.test.ts` tests using the stateful fake still
pass unchanged.

### Task 1.1 — RED: assert wire body for network create

- Files: MODIFY `core/src/providers/hetzner-cloud.test.ts`
- [ ] Familiarise: read `core/src/providers/hetzner-cloud.test.ts`
      lines 1–80 (existing `makeRig()` pattern, `PlanAction`
      shape). Read
      `core/src/providers/hetzner-cloud.ts:241-248` (the POST call
      site that consumes `toApiBody`).
- [ ] Add a new `describe("wire shape (capture fake)", () => {...})`
      block at the end of `hetzner-cloud.test.ts`. Inside, build a
      `makeWireRig()` helper that uses
      `createCaptureHetznerHttpFake()` (NOT the stateful fake) and
      returns `{ capture, makeProvider }`.
- [ ] Failing test:
  ```ts
  it("network create POSTs subnets as array of objects with cloud/eu-central defaults", async () => {
    const { capture, makeProvider } = makeWireRig();
    const provider = makeProvider();
    await provider.apply({
      op: "create",
      entity: "network:bevox-priv",
      desired: { name: "bevox-priv", ip_range: "10.50.0.0/16", subnets: ["10.50.1.0/24"] },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({
      name: "bevox-priv",
      ip_range: "10.50.0.0/16",
      subnets: [
        { ip_range: "10.50.1.0/24", type: "cloud", network_zone: "eu-central" },
      ],
    });
  });

  it("network create with empty subnets sends subnets: []", async () => {
    const { capture, makeProvider } = makeWireRig();
    await makeProvider().apply({
      op: "create",
      entity: "network:bare",
      desired: { name: "bare", ip_range: "10.99.0.0/16", subnets: [] },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0].body).toEqual({ name: "bare", ip_range: "10.99.0.0/16", subnets: [] });
  });
  ```
- [ ] Run `npm --prefix core test -- src/providers/hetzner-cloud`
      → expect FAIL (`Expected subnets: [{ip_range, type,
      network_zone}], received subnets: ["10.50.1.0/24"]` — current
      `toApiBody` forwards strings as-is).
- [ ] Commit: `test(core): RED — network wire body must use subnet objects (1.1)`

### Task 1.2 — GREEN: add `network` branch to `toApiBody`

- Files: MODIFY `core/src/providers/hetzner-cloud.ts`
- [ ] Familiarise: re-read
      `core/src/providers/hetzner-cloud.ts:255-279` (the current
      `toApiBody` plus the `WIRE-SHAPE WARNING` comment block).
- [ ] Minimal impl:
  - Extend `toApiBody` to dispatch on `kind`. Keep the strip of
    `hcloud_id`/`network_id`/`status` as a first step for all kinds.
  - Add a private helper (file-local) `networkBody(desired)`:
    - Read `desired.subnets` as `unknown`; coerce to `[]` when
      undefined or empty array.
    - Map each string `s` to `{ ip_range: s, type: "cloud",
      network_zone: "eu-central" }`. Non-string entries → throw
      `ReconcileError("precondition", ..., {entity: <unknown
      here — pass entity as 3rd arg or leave to caller>})`. NB:
      since `toApiBody` doesn't currently receive `entity`, defer
      validation: trust the Zod-parsed `NetworkSchema` from
      `parseDesired` (which already enforces `subnets:
      z.array(z.string())`). If runtime type-narrowing is still
      needed, raise a non-classified `Error` — `parseDesired` is
      the contract.
    - Return `{ name: desired.name, ip_range: desired.ip_range,
      subnets: <mapped array> }`.
  - Server/volume branches: leave as the current strip-only
    behaviour for this task (F2 / F3 fix them).
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
      Existing `hetzner-cloud.test.ts` tests (using the stateful
      fake) MUST also remain green — they only assert `name` /
      `changed:true|false`, so the new wire shape is invisible to
      them.
- [ ] Commit: `feat(core): hetzner-cloud network wire body (subnet objects) (1.2)`

**Done (F1) =** Network creates emit `subnets:
[{ip_range, type:"cloud", network_zone:"eu-central"}]` on the wire;
empty subnets → `[]`; existing provider regression suite untouched
and green.

---

# Fase 2 (F2) — Server wire body + network name→id lookup

**Phase goal:** `toApiBody("server", desired, refs)` renames `type`
→ `server_type`, removes `network` (string), and inserts `networks:
refs.networkIds`. `apply()` resolves `networkIds` via the existing
`findByName("networks", desired.network)` **before** calling
`toApiBody`. Missing network → `ReconcileError("precondition", ...)`
**before** any POST (fail-safe).

**Deliverable:** `server` branch in `toApiBody`; pre-write lookup in
`apply()`; lookup failure surfaces as `precondition` without any
mutating call.

**Exit criteria:** Two new tests (happy path + missing-network) pass;
existing `assertPreconditions` check remains in place; idempotency
property tests untouched and green.

### Task 2.1 — RED: assert wire body for server create + network lookup

- Files: MODIFY `core/src/providers/hetzner-cloud.test.ts`
- [ ] Familiarise: read
      `core/src/providers/hetzner-cloud.ts:161-184`
      (`assertPreconditions` — the existing pre-write network
      existence check) and `:135-142` (`findByName`).
- [ ] Failing test:
  ```ts
  it("server create renames type→server_type and resolves network name→id", async () => {
    const { capture, makeProvider } = makeWireRig({
      collections: { networks: [{ id: 42, name: "bevox-priv" }] },
    });
    await makeProvider().apply({
      op: "create",
      entity: "server:app-1",
      desired: {
        name: "app-1",
        type: "cx22",
        image: "ubuntu-22.04",
        location: "nbg1",
        network: "bevox-priv",
        ssh_keys: ["k1"],
        labels: { role: "app" },
      },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toMatch(/\/v1\/servers$/);
    expect(posts[0].body).toEqual({
      name: "app-1",
      server_type: "cx22",
      image: "ubuntu-22.04",
      location: "nbg1",
      networks: [42],
      ssh_keys: ["k1"],
      labels: { role: "app" },
    });
    // crucially, NO `type` and NO `network` (string) leak through:
    expect((posts[0].body as Record<string, unknown>)["type"]).toBeUndefined();
    expect((posts[0].body as Record<string, unknown>)["network"]).toBeUndefined();
  });
  ```
- [ ] Run → expect FAIL (`Expected server_type:"cx22", received
      type:"cx22"` and/or `Expected networks:[42], received
      network:"bevox-priv"`).
- [ ] Commit: `test(core): RED — server wire body must rename type and resolve network id (2.1)`

### Task 2.2 — GREEN: per-kind `server` branch + lookup in `apply()`

- Files: MODIFY `core/src/providers/hetzner-cloud.ts`
- [ ] Familiarise: re-read
      `core/src/providers/hetzner-cloud.ts:207-251` (the `apply()`
      orchestrator) and `:269-279` (current `toApiBody`).
- [ ] Minimal impl:
  - Define a file-local `interface ApiBodyRefs { networkIds?:
    ReadonlyArray<number>; serverId?: number }` near the top of the
    module (above `KINDS`).
  - Change `toApiBody` signature to `toApiBody(kind: Kind, desired:
    Record<string, unknown>, refs?: ApiBodyRefs)`.
  - Add a private helper `serverBody(desired, refs)`:
    - Destructure declarative fields: `{name, type, image, location,
      network, ssh_keys, labels, ...rest}` (drop `network`; do not
      forward `rest` — server wire is closed under v1 spec §4.2).
    - Require `refs?.networkIds` when `network` was present in
      `desired`; if missing, throw a plain `Error` (this is a
      programming error from `apply` — `apply` MUST have resolved
      it; classification happens upstream in `apply`).
    - Return `{name, server_type: type, image, location, ssh_keys,
      labels, ...(refs.networkIds ? { networks: [...refs.networkIds]
      } : {})}`. Pass `ssh_keys` through unchanged (Hetzner accepts
      names OR ids per spec §4.2).
  - In `apply()` (currently lines 207–251):
    - **After** `assertPreconditions(...)` and **before**
      `http.request(...)`, build `refs` for server kind:
      ```ts
      const refs: { networkIds?: number[]; serverId?: number } = {};
      if (kind === "server") {
        const netName = desired["network"];
        if (typeof netName === "string" && netName.length > 0) {
          const net = await findByName("networks", netName);
          if (!net) {
            throw new ReconcileError(
              "precondition",
              `HetznerCloudProvider: ${action.entity} references network "${netName}" which does not exist — create the network first`,
              { entity: action.entity },
            );
          }
          refs.networkIds = [net.id];
        }
      }
      ```
    - Pass `refs` into `toApiBody(kind, desired, refs)`.
    - **Do NOT remove** `assertPreconditions`. The lookup is an
      extension that materialises the resolved id; the existing
      `assertPreconditions` is the original fail-safe and remains
      the first gate. (Spec §8 open question — plan-writer's
      recommendation per Decision 3 below: keep both, defer the
      refactor.)
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): hetzner-cloud server wire body + network name→id lookup (2.2)`

### Task 2.3 — RED+GREEN: missing network → precondition before POST

- Files: MODIFY `core/src/providers/hetzner-cloud.test.ts`
- [ ] Failing test (RED first — this test exists today only via
      `assertPreconditions`; we now want to additionally guarantee
      it via the capture fake that ZERO POST is emitted):
  ```ts
  it("server create with missing network throws precondition BEFORE any server POST", async () => {
    const { capture, makeProvider } = makeWireRig({ collections: { networks: [] } });
    await expect(
      makeProvider().apply({
        op: "create",
        entity: "server:orphan-1",
        desired: {
          name: "orphan-1",
          type: "cx22",
          image: "ubuntu-22.04",
          location: "nbg1",
          network: "no-such-net",
          ssh_keys: [],
          labels: {},
        },
      })
    ).rejects.toMatchObject({
      kind: "precondition",
      context: { entity: "server:orphan-1" },
    });
    // GETs (the listAll for findByName) may have happened, but no POST may have.
    const serverPosts = capture.requests.filter(
      r => r.method === "POST" && /\/v1\/servers$/.test(r.url),
    );
    expect(serverPosts).toHaveLength(0);
  });
  ```
- [ ] Run → expect PASS immediately (the `assertPreconditions`
      check already returns `precondition` for the network case;
      the new lookup added in 2.2 is upstream of the POST). If
      this test fails red instead, that is a regression in 2.2 —
      revisit `apply()` ordering: `parseDesired → existing → assertPreconditions
      → refs lookup → toApiBody → POST`.
- [ ] If the test came up green on the first run, document explicitly
      in the commit body why no production change was needed (the
      assertion existed; this test pins the invariant against future
      drift). This is the documented "test pins existing behaviour"
      case and counts as a legitimate task per the TDD rule's
      "test passes on first run" guidance.
- [ ] Commit: `test(core): pin fail-safe — missing network throws precondition with zero server POST (2.3)`

**Done (F2) =** Server creates emit Hetzner-wire body with
`server_type` rename, resolved `networks:[<id>]`, and pass-through
`ssh_keys`/`labels`; missing network throws `precondition` before
any `POST /servers`; idempotency property tests untouched and green.

---

# Fase 3 (F3) — Volume wire body + size parsing + server name→id lookup

**Phase goal:** `toApiBody("volume", desired, refs)` renames `fs` →
`format`, parses `size` from `"<N>G"` / `"<N>"` to number, and
either includes `server: refs.serverId` (attached) or `location:
desired.location` (standalone). Size formats other than `"<N>G"` /
`"<N>"` (e.g. `"500M"`) are rejected as `precondition` (spec §8 —
strict, fail-loud). `apply()` resolves `serverId` via
`findByName("servers", desired.server)` when `desired.server` is
present, with the same fail-safe semantics as F2.

**Deliverable:** `volume` branch in `toApiBody`; server-lookup in
`apply()`; size-parsing helper with strict reject.

**Exit criteria:** Three new tests pass (attached, standalone,
strict reject of `"500M"`); existing volume tests in
`hetzner-cloud.test.ts` (stateful fake) remain green.

### Task 3.1 — RED: assert wire body for attached and standalone volumes + size parsing

- Files: MODIFY `core/src/providers/hetzner-cloud.test.ts`
- [ ] Failing test:
  ```ts
  it("volume create (attached) renames fs→format, parses size, and resolves server id", async () => {
    const { capture, makeProvider } = makeWireRig({
      collections: { servers: [{ id: 7, name: "app-1" }] },
    });
    await makeProvider().apply({
      op: "create",
      entity: "volume:data-1",
      desired: { name: "data-1", size: "10G", fs: "xfs", server: "app-1" },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0].url).toMatch(/\/v1\/volumes$/);
    expect(posts[0].body).toEqual({
      name: "data-1",
      size: 10,
      format: "xfs",
      server: 7,
    });
  });

  it("volume create (standalone) omits server and includes location", async () => {
    const { capture, makeProvider } = makeWireRig();
    await makeProvider().apply({
      op: "create",
      entity: "volume:cold-1",
      desired: { name: "cold-1", size: "100", fs: "ext4", location: "nbg1" },
    });
    const posts = capture.requests.filter(r => r.method === "POST");
    expect(posts[0].body).toEqual({
      name: "cold-1",
      size: 100,
      format: "ext4",
      location: "nbg1",
    });
    expect((posts[0].body as Record<string, unknown>)["server"]).toBeUndefined();
  });

  it("volume create rejects unparseable size as precondition (e.g. '500M')", async () => {
    const { makeProvider } = makeWireRig();
    await expect(
      makeProvider().apply({
        op: "create",
        entity: "volume:bad-1",
        desired: { name: "bad-1", size: "500M", fs: "ext4", location: "nbg1" },
      })
    ).rejects.toMatchObject({ kind: "precondition", context: { entity: "volume:bad-1" } });
  });
  ```
- [ ] Run → expect FAIL on all three (current `toApiBody` forwards
      `fs`/`size:string` as-is and ignores `refs`).
- [ ] Commit: `test(core): RED — volume wire body must rename fs, parse size, resolve server id (3.1)`

### Task 3.2 — GREEN: per-kind `volume` branch + server lookup + size parsing

- Files: MODIFY `core/src/providers/hetzner-cloud.ts`
- [ ] Familiarise: re-read `core/src/domain/entities.ts` near line
      55 (`VolumeSchema`) — confirm `size` is `z.string()` and `fs`
      is the declarative field. Confirm `server` and `location` are
      both optional in the schema (one or the other present).
- [ ] Minimal impl:
  - Add a file-local helper `parseVolumeSize(raw: unknown,
    entity: string): number`:
    - If `typeof raw !== "string"` → throw
      `ReconcileError("precondition", ..., {entity})`.
    - Match `/^\s*(\d+)\s*G\s*$/i` or `/^\s*(\d+)\s*$/`; on match,
      return the integer.
    - Otherwise → throw
      `ReconcileError("precondition",
      \`HetznerCloudProvider: volume ${entity} size "${raw}" not
      parseable as GB (accepted: "<N>G" or "<N>")\`, {entity})`.
  - Add a private helper `volumeBody(desired, refs, entity)`:
    - Compute `sizeNum = parseVolumeSize(desired.size, entity)`.
    - Build the base body `{ name: desired.name, size: sizeNum,
      format: desired.fs }`.
    - If `desired.server` was present: require `refs?.serverId`
      (else programming error — throw plain `Error`); set `server:
      refs.serverId`; do NOT set `location`.
    - Else: require `typeof desired.location === "string"`;
      otherwise throw `ReconcileError("precondition", ..., {entity})`;
      set `location: desired.location`; do NOT set `server`.
    - Note: `volumeBody` needs `entity` so it can throw classified
      errors. Pass it as a third argument; extend `toApiBody` to
      accept `entity` as a fourth optional argument **OR** thread
      entity into `refs` (recommended: extend `toApiBody` signature
      with an additional `entity?: string` arg — clear and
      explicit; network/server branches ignore it).
  - In `apply()`, extend the refs-resolution block to handle
    volumes:
    ```ts
    if (kind === "volume") {
      const serverName = desired["server"];
      if (typeof serverName === "string" && serverName.length > 0) {
        const srv = await findByName("servers", serverName);
        if (!srv) {
          throw new ReconcileError(
            "precondition",
            `HetznerCloudProvider: ${action.entity} references server "${serverName}" which does not exist — create the server first`,
            { entity: action.entity },
          );
        }
        refs.serverId = srv.id;
      }
    }
    ```
  - Wire `toApiBody(kind, desired, refs, action.entity)` at the
    POST call site.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): hetzner-cloud volume wire body + server lookup + size parse (3.2)`

**Done (F3) =** Volume creates emit Hetzner-wire body with `format`
rename, integer `size`, and either `server:<id>` (attached) or
`location` (standalone); `"500M"` rejected as `precondition`; missing
server throws `precondition` before any `POST /volumes`.

---

# Fase 4 (F4) — End-to-end sentinel + comment cleanup

**Phase goal:** A single integration test drives the full chain
(parsed manifest → `apply()` for network, then `apply()` for server
referencing that network) and asserts BOTH wire bodies. The
`WIRE-SHAPE WARNING` comment in `hetzner-cloud.ts` is replaced with a
short pointer to this spec. Optional `@live` smoke skeleton is
added under `core/test/live/`.

**Deliverable:** One new integration test + comment update +
optional live skeleton.

**Exit criteria:** All new tests green; comment block on
`:255-267` references the new spec by date+slug instead of the
"YAGNI: add it then" placeholder; `npm --prefix core test` full
suite green.

### Task 4.1 — Integration sentinel: network + server in one rig

- Files: MODIFY `core/src/providers/hetzner-cloud.test.ts`
- [ ] Failing test:
  ```ts
  it("create network then create server resolving its id — both bodies wire-correct, in order", async () => {
    const { capture, makeProvider } = makeWireRig();
    const provider = makeProvider();

    // 1. Create the network.
    await provider.apply({
      op: "create",
      entity: "network:bevox-priv",
      desired: { name: "bevox-priv", ip_range: "10.50.0.0/16", subnets: ["10.50.1.0/24"] },
    });
    // The capture fake doesn't persist for findByName; pre-seed it via a second rig
    // OR rely on collections being seeded — choose the seeded path:
    //   the test asserts the NETWORK POST body first, then runs a second rig with
    //   seeded { networks: [{id:1, name:"bevox-priv"}] } for the SERVER apply.
    // (Implementer: pick whichever pattern keeps the test deterministic. The
    // capture fake is intentionally stateless for list responses; that is the
    // hook the test must respect.)

    const networkPost = capture.requests.find(
      r => r.method === "POST" && /\/v1\/networks$/.test(r.url),
    );
    expect(networkPost?.body).toEqual({
      name: "bevox-priv",
      ip_range: "10.50.0.0/16",
      subnets: [{ ip_range: "10.50.1.0/24", type: "cloud", network_zone: "eu-central" }],
    });

    // 2. Second rig: server apply with pre-seeded network for findByName.
    const { capture: cap2, makeProvider: makeProvider2 } = makeWireRig({
      collections: { networks: [{ id: 1, name: "bevox-priv" }] },
    });
    await makeProvider2().apply({
      op: "create",
      entity: "server:app-1",
      desired: {
        name: "app-1",
        type: "cx22",
        image: "ubuntu-22.04",
        location: "nbg1",
        network: "bevox-priv",
        ssh_keys: [],
        labels: {},
      },
    });
    const serverPost = cap2.requests.find(
      r => r.method === "POST" && /\/v1\/servers$/.test(r.url),
    );
    expect(serverPost?.body).toMatchObject({
      name: "app-1",
      server_type: "cx22",
      networks: [1],
    });
  });
  ```
- [ ] Run → expect PASS (this is a sentinel built atop F1/F2;
      should pass on the first run once those phases are green).
      If it fails, the failure is a regression in earlier phases —
      do NOT relax this test; fix the earlier phase.
- [ ] Commit: `test(core): integration sentinel — network + server wire bodies in order (4.1)`

### Task 4.2 — Replace `WIRE-SHAPE WARNING` comment with spec pointer

- Files: MODIFY `core/src/providers/hetzner-cloud.ts`
- [ ] No test required (comment-only edit; comment-only edits are
      exempt from the TDD rule per
      `.claude/rules/tdd-required.md` §"Out of scope for this
      rule").
- [ ] Minimal edit: replace the block at `:255-267` (the
      `WIRE-SHAPE WARNING:` paragraph) with:
  ```ts
  // ---------------------------------------------------------------------------
  // Internals — desired entity → Hetzner Cloud create body. Per-kind
  // translation: network builds subnet objects with eu-central defaults;
  // server renames `type → server_type` and consumes resolved `networks:[id]`
  // from `refs.networkIds`; volume renames `fs → format`, parses size to
  // number, and consumes resolved `server: refs.serverId` when attached.
  //
  // Contract: docs/specs/2026-05-27-hetzner-cloud-wire-translation.md (Aceita).
  // Pre-write name→id lookups happen in apply() and surface missing references
  // as ReconcileError("precondition", ..., {entity}) BEFORE any POST.
  // The v1 spec-mãe (docs/specs/2026-05-17-bevox-hetzner-mcp-design.md) is
  // FROZEN; this file's translation contract evolves through follow-up
  // spec-filhas, not in-place edits.
  // ---------------------------------------------------------------------------
  ```
- [ ] Run `npm --prefix core run typecheck` → clean. `npm --prefix
      core test` → 961/962 (1 `@live` skipped) green.
- [ ] Commit: `docs(core): update hetzner-cloud wire-shape comment to point at 2026-05-27 spec (4.2)`

### Task 4.3 — (Optional) `@live` skeleton, env-gated

- Files: NEW `core/test/live/hetzner-cloud-wire.live.test.ts`
- [ ] No production code; this is opt-in pre-release smoke.
- [ ] Implementation: a single `describe("@live hetzner-cloud wire",
      () => { ... })` that:
  - Reads `HETZNER_LIVE_TOKEN` and `HETZNER_LIVE_ZONE` from
    `process.env`; if either is missing, call `it.skip(...)` for
    every test (do NOT throw — keep skipped, opt-in semantics).
  - Otherwise: provisions a unique-named ephemeral network with one
    `/24` subnet, then a `cx22` server in `nbg1` referencing it;
    asserts both creates succeed and that the second apply
    (idempotent) returns `changed: false`. **Cleanup is left to the
    operator** (the spec acknowledges this; this is opt-in pre-release
    smoke, not CI).
  - File MUST be named `hetzner-cloud-wire.live.test.ts` under
    `core/test/live/` so the `unit` vitest project's glob excludes it
    (per `.claude/rules/tdd-required.md` §"Fakes only").
- [ ] Run `npm --prefix core test` → unchanged (live test is
      excluded from the unit glob — verify by counting tests: still
      961/962 green, 1 skipped).
- [ ] If owner prefers to defer, skip this task — the spec marks it
      optional (§9 criterion 9). Plan-writer recommendation: include
      the skeleton so the next pre-release operator has a working
      starting point.
- [ ] Commit: `test(core): @live skeleton for hetzner-cloud wire (opt-in, env-gated) (4.3)`

**Done (F4) =** Integration sentinel pins the whole chain;
`hetzner-cloud.ts` comment points at the new spec; optional `@live`
skeleton is in place for the operator.

---

# Fase 5 (F5) — Verification gate (no commit)

**Phase goal:** Final verification before the PR is opened. No new
commit.

**Exit criteria:** All of the following hold simultaneously.

### Task 5.1 — Full verification

- [ ] `npm --prefix core run typecheck` → clean.
- [ ] `npm --prefix core test` → 961/962 green (1 `@live`
      skipped). The +6/+7 deltaversus the 954/955 baseline comes
      from: 4 capture-fake smoke tests + 2 network wire shape +
      1 server wire shape (positive) + 1 server fail-safe pin +
      3 volume tests + 1 integration sentinel ≈ 12 net new
      assertions across ~7 test cases. Exact count is informational
      — the gating criterion is "no regression, all green".
- [ ] Spot-grep: no `console.*` introduced in
      `core/src/providers/hetzner-cloud.ts` (per
      `.claude/rules/esm-nodenext.md` Rule 7).
- [ ] Spot-grep: no `delete` / `destroy` / `remove` introduced in
      any error path of `core/src/providers/hetzner-cloud.ts` (per
      `.claude/rules/fail-safe.md`).
- [ ] Spot-grep: no secret value flows through `toApiBody` —
      `toApiBody` body still receives only `desired` (Zod-parsed
      manifest fields) and `refs` (numeric ids resolved from a
      stateless GET); the Hetzner token continues to live only on
      `HttpClient.defaultHeaders` (per
      `.claude/rules/secrets-resolution.md`).
- [ ] Idempotency: `npm --prefix core test --
      reconciler/idempotency` → green (property tests untouched
      and still passing).
- [ ] Diff summary check: only the 4 files listed in §"File
      structure" are changed/created. If any other file diff
      appears, justify in the PR description or revert.

**Done (F5) =** PR is ready to open against `main`. Owner reviews
and decides on the `@live` smoke run pre-merge.

---

## Fora de escopo / depende de credenciais reais

This plan deliberately leaves the following to follow-up specs /
operator action:

- **Schema enrichment** — manifest accepting subnet objects
  directly, `networks: string[]` on server (multi-network), or
  `size: number` on volume. v2 spec, additive on top of this
  contract.
- **Multi-zone networks** — `network_zone` other than
  `eu-central`. v2 spec.
- **`update`/`destroy` paths** — `apply()` continues to no-op on
  `op === "remove" | "destroy"` per the existing v1 comment at
  `:213-215`. Spec §3 non-goal.
- **DNS / backup / firewall / LB / cert / primary-ip / ingress
  providers** — they already produce wire-correct bodies (v1 v2
  Bloco A); not touched here. Spec §3 non-goal.
- **`assertPreconditions` → `resolveRefs` refactor** — spec §8
  open question. Plan-writer recommendation: defer to keep this PR
  scoped to the wire-translation contract; both helpers coexist
  until a follow-up cleanup spec consolidates them.
- **`hetzner-http.ts` retrofit to validate wire bodies** — spec
  §8 open question, non-blocking. Existing stateful fake validates
  `name` only and remains backwards-compat.
- **Live Hetzner verification** — Task 4.3 ships only a skeleton.
  Running it requires `HETZNER_LIVE_TOKEN` + `HETZNER_LIVE_ZONE`
  and is the operator's pre-release responsibility (spec §9
  criterion 9).
- **Renewal / lifecycle of the assertPreconditions invariant** —
  unchanged by this plan; it remains the first pre-write gate. The
  new refs-resolution block is strictly additive.

## Done = (per phase, summary)

- **F0 (Task 0):** `createCaptureHetznerHttpFake()` exists with a
  passing smoke test; the assertion seam is available to F1–F3.
- **F1:** Network `toApiBody` produces `subnets:
  [{ip_range, type:"cloud", network_zone:"eu-central"}]`; empty
  subnets → `[]`; existing provider tests untouched and green.
- **F2:** Server `toApiBody` renames `type → server_type`,
  consumes resolved `networks: [<id>]`; missing network throws
  `precondition` before any `POST /servers`; fail-safe pinned.
- **F3:** Volume `toApiBody` renames `fs → format`, parses
  `"<N>G"`/`"<N>"` to integer, includes `server: <id>` (attached)
  or `location` (standalone); `"500M"` rejected as `precondition`;
  missing server throws `precondition` before any `POST /volumes`.
- **F4:** Integration sentinel pins the chain; comment in
  `hetzner-cloud.ts` points at the new spec; optional `@live`
  skeleton is in place under `core/test/live/`.
- **F5:** Full verification gate green — 961/962 unit (1 `@live`
  skipped), typecheck clean, no regression in invariants or file
  scope.
