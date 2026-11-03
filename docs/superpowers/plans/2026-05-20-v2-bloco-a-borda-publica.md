# v2 Bloco A — Borda Pública Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Each task is a self-contained TDD unit (failing test → run → minimal impl → run → commit). Do not skip the red step. Do not batch commits.

**Goal:** Deliver the five Bloco A entities (`Firewall`, `LoadBalancer`, `Certificate`, `PrimaryIP`, `Ingress`) defined in §3 of the v2 architecture contract, plus the composite `IngressProvider` and six new MCP tools, so any v1 `Service` can be exposed publicly under HTTPS with declared network policy — without running a proxy as a container.

**Architecture:** Five thin Hetzner REST providers (one per entity) under `core/src/providers/v2/`, all dispatching through a shared v2 HTTP adapter (`hetzner-cloud-v2-http.ts`) that extends the v1 `HttpClient`, and all implementing the existing `Provider<T>` v1 interface; one composite `IngressProvider` orchestrating Cert→LB→FW→DNS via the existing reconciler DAG; six new tools (`set_firewall`, `set_primary_ip`, `set_certificate`, `set_load_balancer`, `set_ingress`, `expose_service`) wired into the v1 Agent Interface (MCP + REST) with the same dry_run/approval/StateEvent semantics; additive Postgres migration carrying both the v2 observed-state tables and the §2 spec-mãe extensions (`capability_token_id`, `policy_eval_result`, `cost_estimate`, `policy_violations`) that Blocos C/D will consume later.

**Tech Stack:** Inherits the v1 ratified stack (Node.js 20+, TypeScript 5.x ESM/NodeNext strict, `@modelcontextprotocol/sdk`, PostgreSQL 16 via `pg`, Docker Engine API via SSH, WireGuard, restic, Zod, Pino, Vitest + HTTP fakes). **Zero new dependencies.** Hetzner publishes no official Node.js SDK; instead, Bloco A extends the v1 `HttpClient` (`core/src/providers/http-client.ts`) with a thin typed adapter (`hetzner-cloud-v2-http.ts`) exposing per-resource helpers for Firewall/LB/Certificate/PrimaryIP. Same retry/backoff/`Retry-After`/error-taxonomy v1 already owns. Consistent with the project's "no npm dep" posture (commit `aa7fa0d`).

**Specs:**
- Parent contract (spec-mãe): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md`
- This bloco (spec-filha): `docs/specs/2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md`
- v1 base: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`

---

## How this plan is executed

This is a **single master plan covering Fases F1–F6**, but executed phase by phase. Each phase is self-contained and produces working, testable software on its own. Do not start `Fase N+1` until `Fase N`'s "Done =" definition holds and CI is green. `Task 0` is a blocking gate before F1.

All paths are relative to the repository root. New v2 code lives under `core/src/providers/v2/` and `core/src/agent/v2/`; existing v1 files are modified only additively (new tools, new endpoints, new migration). No v1 file is renamed or restructured by this plan.

### Working agreement (all tasks)

- **TDD, always**: write failing test → run, see it fail (red) → minimal implementation → run, see it pass (green) → commit. Reference @superpowers:test-driven-development.
- **DRY / YAGNI / minimal change**: build only what the phase needs. No speculative abstraction beyond what is already in the spec-filha. Reference @superpowers:minimal-change-engineer.
- **Frequent commits**: one task = one commit. Commit message trailer mandatory:
  ```
  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  ```
- **Verify before completion**: @superpowers:verification-before-completion before any "done" claim.
- **Tests never touch real Hetzner**: all HTTP calls go through a fake HTTP server (Hetzner Cloud API surface) layered on top of the v1 `hetzner-http.ts` fake. A `@live` suite exists but is opt-in/manual and never runs in CI.
- **No silent correction of drift in any new provider** (fail-safe §1.6 spec-mãe).
- Steps use `- [ ]` checkboxes. Check them as you go.

---

## FROZEN CONTRACT — additions to v1

The v1 console contract (`console/CONTRACT.md`, `console/src/api/contract.ts`) is **not** owned by this plan. Bloco A **adds** the following endpoints; each must be added to a v2 contract appendix file (`console/CONTRACT-v2.md` is created in Task 0) and matched by Zod schemas in a new `console/src/api/contract-v2.ts` so contract-conformance tests can assert structural validity. Adding to v1 schemas is forbidden — additive coexistence only.

### New tool → REST endpoint table

| Agent Tool          | REST Endpoint                              | Method | Approval                                                    |
|---------------------|--------------------------------------------|--------|-------------------------------------------------------------|
| `resolve_selector`  | `/api/v2/selectors/resolve`                | POST   | no (read)                                                   |
| `set_firewall`      | `/api/v2/firewalls`                        | POST   | conditional (destructive if removes rule covering active Server) |
| `set_primary_ip`    | `/api/v2/primary-ips`                      | POST   | **yes** (cost: PrimaryIP billed even when unassigned)       |
| `set_certificate`   | `/api/v2/certificates`                     | POST   | `managed`: no · `uploaded`: yes (touches secret)            |
| `set_load_balancer` | `/api/v2/load-balancers`                   | POST   | **yes** (cost + possible recreation on `location` change)   |
| `set_ingress`       | `/api/v2/ingresses`                        | POST   | conditional (implicitly touches DNS)                        |
| `expose_service`    | `/api/v2/expose`                           | POST   | **one bundled approval** covering Cert+LB+Ingress           |

Read-only listings (consumed by future Console v2 panels; out of scope to render here but in scope to wire):

| Endpoint                          | Method | Returns                            |
|-----------------------------------|--------|------------------------------------|
| `/api/v2/firewalls`               | GET    | `FirewallSchema[]`                 |
| `/api/v2/load-balancers`          | GET    | `LoadBalancerSchema[]`             |
| `/api/v2/certificates`            | GET    | `CertificateSchema[]`              |
| `/api/v2/primary-ips`             | GET    | `PrimaryIPSchema[]`                |
| `/api/v2/ingresses`               | GET    | `IngressSchema[]`                  |

Every `POST /api/v2/*` returns the same `WriteEnvelope` shape as v1 (`{ status, plan?, approval_id?, error? }`). `plan` carries the two new fields from §2.3 of the spec-mãe, neutral in this bloco:
```ts
plan.cost_estimate     = { monthly_delta_eur: 0, breakdown: [] };  // populated by Bloco D
plan.policy_violations = [];                                       // populated by Bloco C
```

---

## Non-negotiable principles (additive to v1 §"Non-negotiable principles")

All v1 principles apply unchanged. v2 adds:

9. **Selector, never direct ref** (§1.1 spec-mãe). v2 entities reference v1 entities only via the existing `*_selector` pattern.
10. **`StateEvent` records capability token id** (§1.4 spec-mãe; column added in Task 0, populated `null` everywhere in this bloco — Bloco C activates it).
11. **PolicyEngine deferred** (§9 spec-filha). Spec-mãe §3 invariants for new entities live as `// TODO(bloco-c)` comments in each provider, with minimal inline validation behind them.
12. **`cost_estimate` neutral** in this bloco (`{ monthly_delta_eur: 0, breakdown: [] }`). Bloco D populates.
13. **Drift in v2 entity never removes v1 entity** (§1.6 spec-mãe). Each provider documents and tests this.

---

## Testing strategy

Inherits v1 strategy (`docs/specs/.../v1 §"Estratégia de testes"`). Additions for this bloco:

| Layer                  | How                                                                                                       | Covers                                                                                          |
|------------------------|-----------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| New providers (v2)     | Extend `core/test/fakes/hetzner-http.ts` with `/firewalls/*`, `/load_balancers/*`, `/certificates/*`, `/primary_ips/*` routes | entity→REST translation (via v2 HTTP adapter), pagination, rate-limit, error mapping            |
| `IngressProvider`      | In-memory composite over provider fakes (Cert, LB, FW, DNS)                                               | apply DAG ordering, partial-failure handling, status aggregation                                |
| New tools              | REST/MCP integration: tool → reconciler with provider fakes → contract-v2 conformance                     | `dry_run`, approval gating per row of the table above, capability scope (mocked — minimal stub returning fixed scopes; Bloco C replaces with real CapabilityToken store), structured errors |
| Capstone (F6)          | `core/test/e2e/v2-bloco-a-expose.test.ts` — `bevox-web` exposed via `expose_service` end-to-end with fakes | Cert+LB+FW+DNS+Ingress converge; identical to scripted `set_*` calls; bundled approval works    |
| Idempotency (property) | Re-run on Bloco A entities — apply N×, 2nd+ cycle = no-op                                                 | Same v1 guarantee, now over the new entities                                                    |
| `@live` opt-in         | 1 scenario: ACME managed cert in a Hetzner sandbox project                                                | Confidence in real Hetzner-managed certificate flow                                             |

CI runs unit + integration with fakes on every commit. `@live` runs on demand pre-release only. Never test the Hetzner API itself — only translation and convergence logic.

---

## File structure (one responsibility per file)

```
core/
  src/
    domain/
      entities-v2.ts                    Zod entities — Firewall, LoadBalancer, Certificate, PrimaryIP, Ingress (mirrors contract-v2)
      entities-v2.test.ts
      desired-state.ts                  MODIFIED: extend manifest schema with v2 collections (firewalls, load_balancers, certificates, primary_ips, ingresses)
    providers/
      v2/
        hetzner-firewall.ts             HetznerFirewallProvider implements Provider<Firewall>
        hetzner-firewall.test.ts
        hetzner-load-balancer.ts        HetznerLoadBalancerProvider implements Provider<LoadBalancer>
        hetzner-load-balancer.test.ts
        hetzner-certificate.ts          HetznerCertificateProvider implements Provider<Certificate> (managed + uploaded)
        hetzner-certificate.test.ts
        hetzner-primary-ip.ts           HetznerPrimaryIPProvider implements Provider<PrimaryIP>
        hetzner-primary-ip.test.ts
        ingress.ts                      IngressProvider — composite over the four above + v1 DNS
        ingress.test.ts
        hetzner-cloud-v2-http.ts        thin adapter over v1 HttpClient: baseUrl + Authorization + typed per-resource helpers (firewalls/load_balancers/certificates/primary_ips). Zero SDK.
    reconciler/
      plan.ts                           MODIFIED: extend DAG with v2 collections (no new file)
      apply.ts                          MODIFIED: dispatch to v2 providers (no new file)
    agent/
      tools.ts                          MODIFIED: register 6 new tools (resolve_selector + 5 set_*)
      rest.ts                           MODIFIED: mount /api/v2/* routes
      mcp.ts                            MODIFIED: register 6 new tool descriptors
      v2/
        expose-service.ts               expose_service tool (composes set_certificate + set_load_balancer + set_ingress writes against working store with one bundled approval)
        expose-service.test.ts
        contract-v2-conformance.test.ts integration: /api/v2/* responses parse against contract-v2 Zod schemas
    store/
      migrations/
        002_v2_bloco_a.sql              additive: tables firewalls/load_balancers/certificates/primary_ips/ingresses; ALTER state_events ADD capability_token_id, policy_eval_result
      observed-store.ts                 MODIFIED: extend CRUD with v2 entities (no new file unless module exceeds reasonable size; in that case split into observed-store-v2.ts)
      observed-store.test.ts
  test/
    fakes/
      hetzner-http.ts                   MODIFIED: extend with /firewalls, /load_balancers, /certificates, /primary_ips routes (organised into per-resource sub-files imported by the single fake server)
      hetzner-http-v2/
        firewalls.ts                    fake firewall routes
        load-balancers.ts               fake LB routes
        certificates.ts                 fake cert routes (managed polling + uploaded)
        primary-ips.ts                  fake primary IP routes
    e2e/
      v2-bloco-a-expose.test.ts         capstone (F6)

console/
  CONTRACT-v2.md                        new — documents v2 endpoints (frozen contract appendix for v2)
  src/api/
    contract-v2.ts                      new — Zod schemas matching v2 envelopes (oracle for core conformance tests)
```

> If `observed-store.ts` grows past ~600 lines after the v2 additions, split into `observed-store.ts` (v1) and `observed-store-v2.ts` in the same task — keep responsibilities focused. Otherwise extend in place.

---

# Task 0 — v2 foundations migration + HTTP adapter (BLOCKING GATE)

**Goal/deliverable:** Postgres schema carries v2 observed-state tables and §2 spec-mãe extensions; v2 HTTP adapter over the v1 `HttpClient` compiles with injectable baseUrl; `contract-v2.ts` exists with empty schema placeholders so subsequent fases can fill it; vitest passes with the additions. **Exit criteria:** `npm --prefix core test` green, `npm --prefix core run typecheck` clean, new migration applies cleanly forward.

### Task 0.1 — Hetzner v2 HTTP adapter (extends v1 HttpClient)

> **Note:** the brainstorm originally picked "@hetznercloud/hcloud SDK". That package does not exist on npm (Hetzner publishes only Go/Python SDKs). Replaced with a zero-dep adapter over v1 `HttpClient` — same pattern v1 uses in `core/src/providers/hetzner-cloud.ts`. See spec-filha §2.

- Files: create `core/src/providers/v2/hetzner-cloud-v2-http.ts`, `core/src/providers/v2/hetzner-cloud-v2-http.test.ts`. **No `package.json` changes.**
- [ ] Familiarise: read `core/src/providers/http-client.ts` (HttpClient class — constructor takes `defaultHeaders`, `request(url, init)` takes complete URLs) and `core/src/providers/hetzner-cloud.ts` lines 60-150 (how v1 composes `baseUrl + "/" + collection` to call `http.request(...)`). The adapter mirrors that style.
- [ ] Failing test:
  ```ts
  // core/src/providers/v2/hetzner-cloud-v2-http.test.ts
  import { describe, it, expect } from "vitest";
  import { createHetznerV2HttpClient } from "./hetzner-cloud-v2-http.js";

  describe("hetzner v2 http adapter", () => {
    it("returns an object exposing the four v2 resource clients", () => {
      const c = createHetznerV2HttpClient({ token: "t", baseUrl: "http://localhost:0/v1" });
      expect(typeof c.firewalls.list).toBe("function");
      expect(typeof c.firewalls.get).toBe("function");
      expect(typeof c.firewalls.create).toBe("function");
      expect(typeof c.firewalls.update).toBe("function");
      expect(typeof c.firewalls.delete).toBe("function");
      expect(c.loadBalancers).toBeDefined();
      expect(c.certificates).toBeDefined();
      expect(c.primaryIps).toBeDefined();
    });
    it("each resource client routes through the shared HttpClient with Authorization header injected", async () => {
      const calls: { url: string; init?: RequestInit }[] = [];
      const fakeFetch: typeof fetch = async (input, init) => {
        calls.push({ url: String(input), init });
        return new Response(JSON.stringify({ firewalls: [], meta: { pagination: { next_page: null } } }), { status: 200 });
      };
      const c = createHetznerV2HttpClient({ token: "secret", baseUrl: "http://fake/v1", fetchImpl: fakeFetch });
      await c.firewalls.list();
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("http://fake/v1/firewalls");
      expect((calls[0].init?.headers as Record<string,string>)?.["Authorization"]).toBe("Bearer secret");
    });
    it("throws fast on empty token", () => {
      expect(() => createHetznerV2HttpClient({ token: "", baseUrl: "http://x/v1" })).toThrow(/token/);
    });
    it("throws fast on missing baseUrl (no implicit prod default — tests never hit live API)", () => {
      expect(() => createHetznerV2HttpClient({ token: "t", baseUrl: "" })).toThrow(/baseUrl/);
    });
  });
  ```
- [ ] Run `npm --prefix core test hetzner-cloud-v2-http` → expect FAIL (module missing).
- [ ] Minimal impl `hetzner-cloud-v2-http.ts`:
  - export `createHetznerV2HttpClient({ token, baseUrl, fetchImpl? })` returning `{ firewalls, loadBalancers, certificates, primaryIps }`.
  - validate `token` non-empty and `baseUrl` non-empty (no implicit Hetzner-prod default).
  - construct a single `HttpClient` with `defaultHeaders: { Authorization: \`Bearer ${token}\` }` and the optional `fetchImpl`. Strip trailing slash from baseUrl (same as v1).
  - each resource client exposes `list / get(id) / create(body) / update(id, body) / delete(id)` — implementations are 1-line `http.request(\`${baseUrl}/<collection>[/<id>]\`, { method: ..., body: JSON.stringify(...) })` calls. Keep them thin; per-resource action endpoints (e.g. `apply_to_resources`) come in F1.3 onward, not here. **Do not** add Zod parsing here — that lives in each provider.
- [ ] Run → expect PASS. `npm --prefix core run typecheck` → clean.
- [ ] Commit: `feat(core): Hetzner v2 HTTP adapter over v1 HttpClient (0.1)`

### Task 0.2 — Migration `002_v2_bloco_a.sql` (additive)

- Files: create `core/src/store/migrations/002_v2_bloco_a.sql`; modify `core/src/store/observed-store.test.ts` (or add `observed-store-v2.test.ts`).
- [ ] Failing test (uses the pg test harness from v1):
  ```ts
  it("migration 002 creates v2 tables and adds StateEvent columns", async () => {
    const db = await freshDb();
    const rows = await db.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('firewalls','load_balancers','certificates','primary_ips','ingresses')
      ORDER BY table_name
    `);
    expect(rows.rows.map(r => r.table_name)).toEqual(
      ["certificates","firewalls","ingresses","load_balancers","primary_ips"]
    );
    const cols = await db.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'state_events'
        AND column_name IN ('capability_token_id','policy_eval_result')
      ORDER BY column_name
    `);
    expect(cols.rows.map(r => r.column_name)).toEqual(
      ["capability_token_id","policy_eval_result"]
    );
  });
  ```
- [ ] Run → expect FAIL (migration missing).
- [ ] Minimal impl `002_v2_bloco_a.sql`:
  ```sql
  CREATE TABLE firewalls (
    id          uuid PRIMARY KEY,
    name        text UNIQUE NOT NULL,
    observed    jsonb NOT NULL,
    status      text NOT NULL,
    updated_at  timestamptz NOT NULL
  );
  CREATE TABLE load_balancers ( /* same columns */ );
  CREATE TABLE certificates   ( /* same columns */ );
  CREATE TABLE primary_ips    ( /* same columns */ );
  CREATE TABLE ingresses      ( /* same columns */ );

  ALTER TABLE state_events
    ADD COLUMN capability_token_id text,
    ADD COLUMN policy_eval_result  jsonb;
  ```
- [ ] Run → expect PASS. Forward-only; no rollback.
- [ ] Commit: `feat(core): v2 Bloco A additive migration + StateEvent extensions (0.2)`

### Task 0.3 — `contract-v2.ts` scaffold + envelope extensions

- Files: create `console/src/api/contract-v2.ts`, `console/CONTRACT-v2.md`; modify `core/src/agent/envelope.ts` (or its sibling) to carry the two neutral fields.
- [ ] Failing test:
  ```ts
  // core/src/agent/v2/contract-v2-conformance.test.ts
  import { WriteEnvelopeV2Schema } from "../../../../console/src/api/contract-v2.js";

  it("v2 WriteEnvelope always carries neutral cost_estimate and policy_violations", () => {
    const env = {
      status: "planned",
      plan: { ops: [], cost_estimate: { monthly_delta_eur: 0, breakdown: [] }, policy_violations: [] },
    };
    expect(() => WriteEnvelopeV2Schema.parse(env)).not.toThrow();
    expect(() => WriteEnvelopeV2Schema.parse({ status: "planned", plan: { ops: [] } })).toThrow();
  });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: `contract-v2.ts` exports `WriteEnvelopeV2Schema` (extends v1 envelope with required `cost_estimate` + `policy_violations` on `plan`); v2 builder in core fills them with neutral defaults; `CONTRACT-v2.md` documents the endpoints from the table above as the human-readable companion.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): v2 envelope schema with neutral cost_estimate/policy_violations (0.3)`

### Task 0.4 — `resolve_selector` tool (read-only, used by every phase)

- Files: create `core/src/agent/v2/resolve-selector.ts`, `.test.ts`; modify `core/src/agent/tools.ts`, `core/src/agent/rest.ts`, `core/src/agent/mcp.ts`.
- [ ] Failing test:
  ```ts
  it("resolves { label: app } against current observed Servers", async () => {
    await seedServers([{ name: "s1", labels: { app: "x" }}, { name: "s2", labels: {} }]);
    const res = await call("/api/v2/selectors/resolve", { selector: { label: "app" } });
    expect(res.matched).toEqual(["s1"]);
  });
  it("matches v1 server_selector semantics exactly", async () => { /* same suite as v1 server_selector */ });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: extract the existing v1 `server_selector` resolution into `resolve-selector.ts` (single source of truth — function reused both as the new tool and as the internal helper the reconciler already calls; spec-filha §1). v1 already resolves `server_selector` inside `core/src/reconciler/` for `Service.server_selector` — locate that logic first (grep `server_selector` under `core/src/`), then extract; do not re-implement.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): resolve_selector tool + shared internal helper (0.4)`

**Done (Task 0) =** v2 HTTP adapter compiles with injectable baseUrl; migration applies and adds 5 tables + 2 columns; v2 envelope schema enforces neutral fields; `resolve_selector` available as both tool and internal helper. F1 may begin.

---

# Fase 1 (F1) — Firewall + `set_firewall`

**Phase goal:** Declarative Hetzner Firewall management with allow-list semantics, drift reporting (no silent correction), and an MCP tool that classifies removals of rules covering active Servers as destructive. **Deliverable:** working `HetznerFirewallProvider` + `set_firewall` tool. **Exit criteria:** all F1 tests green; idempotency property holds for `Firewall`; fail-safe verified (drift never removes anything).

### Task 1.1 — `FirewallSchema` in `entities-v2.ts`

- Files: create `core/src/domain/entities-v2.ts`, `.test.ts`; modify `console/src/api/contract-v2.ts`.
- [ ] Failing test: parses a minimal Firewall (matching spec-mãe §3 Bloco A); rejects rules without `port` for tcp/udp; rejects `0.0.0.0/0` on port 22 unless `acknowledged_public_ssh: true`.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: Zod schemas for `Firewall`, `FirewallRule` mirroring spec-mãe §3; export from both `entities-v2.ts` (core) and `contract-v2.ts` (console oracle — vendored copy or shared file, same convention as v1 Task 1.1).
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): FirewallSchema (v2 entity) (1.1)`

### Task 1.2 — Fake HTTP routes for `/firewalls/*`

- Files: create `core/test/fakes/hetzner-http-v2/firewalls.ts`; modify `core/test/fakes/hetzner-http.ts` to mount.
- [ ] Failing test: fake supports `POST /firewalls`, `GET /firewalls/:id`, `PUT /firewalls/:id/actions/set_rules`, `POST /firewalls/:id/actions/apply_to_resources`, `DELETE /firewalls/:id`; pagination on `GET /firewalls`; 429 with `Retry-After` injectable via test harness.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: in-memory store keyed by id; responses match Hetzner Cloud API shape (verify against `@hetznercloud/hcloud` type definitions).
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): fake hcloud Firewall routes (1.2)`

### Task 1.3 — `HetznerFirewallProvider` (observe + plan + apply + verify)

- Files: create `core/src/providers/v2/hetzner-firewall.ts`, `.test.ts`.
- [ ] Failing test:
  ```ts
  it("plan creates firewall when absent", async () => {
    const p = providerWithFake();
    const plan = await p.plan({ name: "web-fw", rules: [{direction:"in",protocol:"tcp",port:"443",source_ips:["0.0.0.0/0"]}], applied_to: { label: "web" }}, /*observed*/ null);
    expect(plan.ops).toEqual([{ op: "create", entity: "firewall:web-fw" }]);
  });
  it("plan is no-op when desired == observed (idempotency)", async () => { /* ... */ });
  it("apply is idempotent: second call same desired = no-op", async () => { /* ... */ });
  it("drift: extra rule on Hetzner is reported, NEVER removed", async () => { /* ... */ });
  it("verify() returns true only after observed matches desired", async () => { /* ... */ });
  it("classify error: 429 → transient; 422 invalid rules → fatal precondition", async () => { /* ... */ });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: provider talks to Hetzner via `hetzner-cloud-v2-http.ts`'s `firewalls` resource client; `apply` resolves `applied_to` via `resolve_selector`; drift comparison uses Hetzner-natural set semantics (no order); error mapping to v1 taxonomy.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): HetznerFirewallProvider with allow-list semantics + drift report (1.3)`

### Task 1.4 — `set_firewall` tool wired into REST + MCP

- Files: create `core/src/agent/v2/set-firewall.ts`, `.test.ts`; modify `core/src/agent/tools.ts`, `rest.ts`, `mcp.ts`.
- [ ] Failing test: `POST /api/v2/firewalls { dry_run: true, firewall: {...} }` returns `WriteEnvelopeV2{status:"planned", plan}`; `dry_run: false` with new firewall returns `{status:"applied"}`; **removing a rule that currently covers an active Server returns `{status:"pending_approval"}`** (destructive classification); MCP tool returns same envelope; capability scope without `set_firewall` returns 403.
- [ ] Run → expect FAIL.
- [ ] Minimal impl: tool computes diff against observed, classifies destructive iff `removed_rules.some(r => coversAnyActiveServer(r))`; writes to working desired state (v1 §"Write-path"); reconciler picks up next cycle.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): set_firewall tool (REST+MCP) with destructive-removal gating (1.4)`

### Task 1.5 — Conformance + idempotency property

- Files: modify `core/src/agent/v2/contract-v2-conformance.test.ts`; create `core/src/reconciler/idempotency-firewall.property.test.ts`.
- [ ] Failing test: `POST /api/v2/firewalls` responses parse against `WriteEnvelopeV2Schema`; `GET /api/v2/firewalls` parses against `FirewallSchema[]`; property: random Firewall manifests applied N×, second cycle = no-op.
- [ ] Run → expect FAIL.
- [ ] Wire the listing endpoint + property harness.
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): contract-v2 + idempotency for Firewall (1.5)`

**Done (F1) =** Firewall CRUD via tool; allow-list semantics; drift reported never removed; destructive removal gated; idempotency property green; v2 envelope contract enforced.

---

# Fase 2 (F2) — PrimaryIP + `set_primary_ip`

**Phase goal:** Declarative PrimaryIP management, always Approval-gated (cost). **Deliverable:** `HetznerPrimaryIPProvider` + `set_primary_ip` tool. **Exit criteria:** all F2 tests green; `assignee_selector` ≤1 enforced; idempotency property green.

### Task 2.1 — `PrimaryIPSchema`

- Files: modify `core/src/domain/entities-v2.ts`, `console/src/api/contract-v2.ts` (+ tests). TDD: schema matches spec-mãe §3; `type` enum `ipv4|ipv6`; `assignee_selector` optional. Commit: `feat(core): PrimaryIPSchema (2.1)`

### Task 2.2 — Fake `/primary_ips/*` routes

- Files: create `core/test/fakes/hetzner-http-v2/primary-ips.ts`; mount in `hetzner-http.ts`. TDD: CRUD + assign/unassign actions + pagination. Commit: `test(core): fake hcloud PrimaryIP routes (2.2)`

### Task 2.3 — `HetznerPrimaryIPProvider`

- Files: create `core/src/providers/v2/hetzner-primary-ip.ts` (+ test). TDD: observe/plan/apply/verify; `assignee_selector` resolved at apply; invariant `matches ≤ 1 Server` returns `precondition_failed` (inline validation — `// TODO(bloco-c): move to PolicyEngine`); drift in assignment is reported. Commit: `feat(core): HetznerPrimaryIPProvider (2.3)`

### Task 2.4 — `set_primary_ip` tool (Approval always)

- Files: create `core/src/agent/v2/set-primary-ip.ts` (+ test); modify `tools.ts`, `rest.ts`, `mcp.ts`. TDD: `dry_run` plans; non-dry-run always returns `pending_approval`; approval bypass for `e2e` mode flagged for §6 capstone use only; capability scope enforced. Commit: `feat(core): set_primary_ip tool, Approval always (cost) (2.4)`

### Task 2.5 — Conformance + idempotency property

- Files: extend `contract-v2-conformance.test.ts`, create `idempotency-primary-ip.property.test.ts`. TDD as in 1.5. Commit: `test(core): contract-v2 + idempotency for PrimaryIP (2.5)`

**Done (F2) =** PrimaryIP CRUD via tool; Approval always required; ≤1 assignee enforced; idempotency green.

---

# Fase 3 (F3) — Certificate + `set_certificate`

**Phase goal:** Declarative TLS certificate management covering both `managed` (Hetzner-owned ACME) and `uploaded` paths, with secret resolution at apply-time and `pending` polling that does not block the reconciler cycle. **Deliverable:** `HetznerCertificateProvider` + `set_certificate` tool. **Exit criteria:** managed path produces a cert via fake ACME polling; uploaded path resolves secret only at apply; timeouts surface as `cancelled` actions; idempotency property green.

### Task 3.1 — `CertificateSchema`

- Files: modify `entities-v2.ts`, `contract-v2.ts` (+ tests). TDD: schema matches spec-mãe §3; discriminated union on `type`; `uploaded` requires `certificate_pem` + `private_key_secret_ref`; `managed` requires `domains` only. Commit: `feat(core): CertificateSchema (3.1)`

### Task 3.2 — Fake `/certificates/*` routes (managed polling + uploaded)

- Files: create `core/test/fakes/hetzner-http-v2/certificates.ts`; mount. TDD: `POST /certificates` for both `managed` (returns `status: pending`, transitions to `issued` after N polling calls — N injectable per-test) and `uploaded` (immediate); `GET /certificates/:id`; `DELETE`; pagination. Commit: `test(core): fake hcloud Certificate routes (managed polling + uploaded) (3.2)`

### Task 3.3 — `HetznerCertificateProvider` — `uploaded` path

- Files: create `core/src/providers/v2/hetzner-certificate.ts` (+ test). TDD: `uploaded` cert — resolves `private_key_secret_ref` via v1 `secrets.ts` **only at apply** (plan/dry_run shows reference only); PEM parser-mock validates chain+key match before upload; drift (cert removed on Hetzner) reported never re-emitted. Commit: `feat(core): HetznerCertificateProvider uploaded path (3.3)`

### Task 3.4 — `HetznerCertificateProvider` — `managed` path + non-blocking polling

- Files: modify `hetzner-certificate.ts` (+ test). TDD:
  - apply creates cert → enters `pending` state in observed store; action becomes `blocked` (consistent with v1 approval lifecycle §236);
  - next reconcile cycle re-checks via the v2 HTTP adapter (`certificates.get(id)`); on `issued` transitions to `healthy`;
  - polling has TTL ≤30min (clock injectable, default per spec-filha); timeout → cert `error`, action `cancelled`, StateEvent emitted, agent must explicitly retry.
  - **Provider does NOT publish `_acme-challenge` records.** If fake or real Hetzner returns a `requires_dns_challenge` hint, log `// TODO(bloco-a-fallback): orchestrate via HetznerDNSProvider` and surface `precondition_failed` — fallback orchestration is opt-in for a follow-up task, not in this initial impl (spec-filha §3.3 fallback note).
  - **Renewal drift check** (spec-filha §8): `observe()` reads `expires_at` from the Hetzner cert and, if `< 14d` away with no in-progress renewal visible, emits a `kind: "drift"` StateEvent with reason `cert-expiring-soon`. **Does not re-emit automatically** (fail-safe); agent decides.
- Commit: `feat(core): HetznerCertificateProvider managed path with non-blocking polling (3.4)`

### Task 3.5 — `set_certificate` tool (Approval per type)

- Files: create `core/src/agent/v2/set-certificate.ts` (+ test); modify `tools.ts`, `rest.ts`, `mcp.ts`. TDD: `managed` no Approval; `uploaded` Approval (touches secret); capability scope enforced; envelope conforms. Commit: `feat(core): set_certificate tool with type-based Approval (3.5)`

### Task 3.6 — Conformance + idempotency property

- Files: extend conformance test; create `idempotency-certificate.property.test.ts`. Commit: `test(core): contract-v2 + idempotency for Certificate (3.6)`

**Done (F3) =** uploaded + managed cert flows green; secret resolved only at apply; managed polling non-blocking; timeout surfaces as `cancelled`; idempotency green.

---

# Fase 4 (F4) — LoadBalancer + `set_load_balancer`

**Phase goal:** Declarative LB management with health checks, target resolution via `service_selector`, and an Approval-gated destructive flag on `location` change. **Deliverable:** `HetznerLoadBalancerProvider` + `set_load_balancer` tool. **Exit criteria:** location-change diff is unambiguous; target drift reported and re-converged; **provider does not touch Firewall** (that's IngressProvider in F5); idempotency green.

### Task 4.1 — `LoadBalancerSchema`

- Files: modify `entities-v2.ts`, `contract-v2.ts` (+ tests). TDD: schema matches spec-mãe §3; `algorithm` enum; `health_check` shape. Commit: `feat(core): LoadBalancerSchema (4.1)`

### Task 4.2 — Fake `/load_balancers/*` routes

- Files: create `core/test/fakes/hetzner-http-v2/load-balancers.ts`; mount. TDD: CRUD + targets + health-check actions + pagination. Commit: `test(core): fake hcloud LoadBalancer routes (4.2)`

### Task 4.3 — `HetznerLoadBalancerProvider`

- Files: create `core/src/providers/v2/hetzner-load-balancer.ts` (+ test). TDD: targets resolve via `service_selector` → list of Servers running the Service (composes with `resolve_selector`); algorithm/health-check changes are in-place; **`location` change → plan produces a single op `{ op: "recreate", entity: "load_balancer:NAME", impact: "public IP will change" }`**; drift in targets (server added/removed out-of-band) is reported and the reconciler re-converges; **no Firewall handling**. Commit: `feat(core): HetznerLoadBalancerProvider with location-recreate detection (4.3)`

### Task 4.4 — `set_load_balancer` tool (Approval always)

- Files: create `core/src/agent/v2/set-load-balancer.ts` (+ test); modify `tools.ts`, `rest.ts`, `mcp.ts`. TDD: `dry_run` plans; non-dry-run always Approval (cost); location-change plan highlights recreation in `WriteEnvelope.plan.ops[i].impact`; capability scope enforced. Commit: `feat(core): set_load_balancer tool, Approval always + location warning (4.4)`

### Task 4.5 — Conformance + idempotency property

- Files: extend conformance test; create `idempotency-load-balancer.property.test.ts`. Commit: `test(core): contract-v2 + idempotency for LoadBalancer (4.5)`

**Done (F4) =** LB CRUD via tool; targets via selector; location-change destructive flag; no firewall coupling; idempotency green.

---

# Fase 5 (F5) — `IngressProvider` + `set_ingress`

**Phase goal:** Composite provider that orchestrates `Cert → LB → Firewall → DNS → healthy` for a public hostname, with partial-failure surfacing and a `firewall_ref` that applies to LB **backend Servers** (not the LB itself). **Deliverable:** `IngressProvider` + `set_ingress` tool. **Exit criteria:** DAG ordering correct; partial failure surfaces `degraded`; firewall applied to backend Servers; idempotency green.

### Task 5.1 — `IngressSchema` + `IngressRoute`

- Files: modify `entities-v2.ts`, `contract-v2.ts` (+ tests). TDD: schema matches spec-mãe §3; `tls.certificate_ref` resolves by name; `routes` non-empty; cross-entity invariant (`tls.certificate_ref` cert has `hostname` ∈ `domains`) validated inline with `// TODO(bloco-c)` marker. Commit: `feat(core): IngressSchema (5.1)`

### Task 5.2 — `IngressProvider` composite (uses provider fakes from F1, F3, F4 + v1 DNS)

- Files: create `core/src/providers/v2/ingress.ts` (+ test). TDD:
  - apply DAG order: `Certificate` (skip if `type: uploaded` — parallel with LB) → `LoadBalancer` → `Firewall` (if `firewall_ref`, applied to **Servers backend of LB**, not LB) → `DnsRecord` pointing to LB IP → Ingress `healthy`;
  - status aggregation: Ingress is `healthy` only if all components are `healthy`; else `degraded` with worst-component reason;
  - partial failure: any component failing leaves siblings in their last state, Ingress = `degraded`, reconciler retries next cycle (idempotency);
  - firewall_ref resolution: provider calls `HetznerFirewallProvider.apply()` with `applied_to: { in: backend_servers }`.
- Commit: `feat(core): IngressProvider composite with backend-firewall + status aggregation (5.2)`

### Task 5.3 — `set_ingress` tool (conditional Approval on DNS touch)

- Files: create `core/src/agent/v2/set-ingress.ts` (+ test); modify `tools.ts`, `rest.ts`, `mcp.ts`. TDD: `dry_run` plans full composite; `hostname` change → Approval (implicit DNS mutation); new ingress (DNS record creation) → no Approval (consistent with v1 `set_dns` which is no-Approval); capability scope enforced. Commit: `feat(core): set_ingress tool with conditional DNS-touch Approval (5.3)`

### Task 5.4 — Plan/apply DAG hook in `reconciler/plan.ts` + `apply.ts`

- Files: modify `core/src/reconciler/plan.ts`, `apply.ts` (+ test). TDD: DAG extended with v2 collections in the order `firewall → primary_ip → certificate → load_balancer → ingress`; dispatcher picks the right provider; v1 entities unchanged. Commit: `feat(core): extend reconciler DAG with v2 collections (5.4)`

### Task 5.5 — Conformance + idempotency property

- Files: extend conformance test; create `idempotency-ingress.property.test.ts`. Commit: `test(core): contract-v2 + idempotency for Ingress (5.5)`

**Done (F5) =** Ingress applies Cert+LB+FW(backend)+DNS in correct order; partial failure produces `degraded` not silent loss; firewall coupling to LB backend Servers correct; idempotency green.

---

# Fase 6 (F6) — `expose_service` + capstone E2E

**Phase goal:** Agent-native convenience tool that bundles Cert+LB+Ingress under one Approval, plus a full end-to-end capstone test where `bevox-web` becomes publicly reachable via the fakes — proving the whole bloco composes. **Deliverable:** `expose_service` + capstone scenario. **Exit criteria:** `expose_service` produces the same converged state as scripted `set_*` calls; one bundled approval; capstone scenario converges to all-`healthy` via fakes; `@live` smoke (manual, opt-in) emits a real Hetzner managed cert in a sandbox project.

### Task 6.1 — `expose_service` writes a triple to working desired state

- Files: create `core/src/agent/v2/expose-service.ts`, `.test.ts`; modify `tools.ts`, `rest.ts`, `mcp.ts`.
- [ ] Failing test:
  ```ts
  it("expose_service(bevox-web, app.example.com, tls:'managed') writes Cert+LB+Ingress to working store", async () => {
    const res = await call("/api/v2/expose", {
      service: "bevox-web", hostname: "app.example.com", tls: "managed", dry_run: true
    });
    expect(res.status).toBe("planned");
    expect(res.plan.ops.map(o => o.entity).sort()).toEqual([
      "certificate:bevox-web-app", "ingress:bevox-web-app", "load_balancer:bevox-web-app"
    ]);
  });
  it("non-dry-run returns exactly ONE approval covering all three", async () => {
    const res = await call("/api/v2/expose", { service: "bevox-web", hostname: "app.example.com", tls: "managed" });
    expect(res.status).toBe("pending_approval");
    expect(res.approval_id).toBeDefined();
    // Single approval, not three
    const approvals = await call("/api/approvals");
    expect(approvals.filter(a => a.bundle === res.approval_id)).toHaveLength(1);
  });
  it("equivalence: result of expose_service equals result of three scripted set_* calls", async () => { /* ... */ });
  ```
- [ ] Run → expect FAIL.
- [ ] Minimal impl: tool synthesises canonical entity names (e.g. `bevox-web-app` slug from `service` + first DNS label of `hostname`); writes all three to working desired state in one transaction; creates **one** `Approval` row tagged with a `bundle` discriminator that all three under-actions reference; reconciler honours bundle so approve→apply triggers all three together.
- [ ] Run → expect PASS.
- [ ] Commit: `feat(core): expose_service tool (bundled approval) (6.1)`

### Task 6.2 — Capstone E2E: bevox-web exposed via fakes

- Files: create `core/test/e2e/v2-bloco-a-expose.test.ts`.
- [ ] Failing test: full scenario — seed v1 stack (Server `bevox-app-1` running Service `bevox-web` with label `app: bevox-web`); fake DNS zone for `example.com`; call `expose_service` (approve via test helper); reconcile to fixpoint; assert all of {`firewall:bevox-web-app`, `load_balancer:bevox-web-app`, `certificate:bevox-web-app`, `ingress:bevox-web-app`, `dns:app.example.com`} are `healthy`; assert StateEvents include actor + (null) `capability_token_id`; assert second reconcile cycle is a no-op (idempotency).
- [ ] Run → expect FAIL.
- [ ] Minimal impl wiring + any thin glue discovered; no new providers.
- [ ] Run → expect PASS.
- [ ] Commit: `test(core): e2e v2 Bloco A — bevox-web exposed via fakes (6.2)`

### Task 6.3 — Fault injection on the capstone

- Files: modify `v2-bloco-a-expose.test.ts`. TDD: inject (a) Hetzner 503 storm during cert polling → cert stays `pending`, Ingress `degraded`, no resource auto-deleted, recovery on clean retry; (b) drift — extra Firewall rule injected on the fake → reported in StateEvent, **never removed**; (c) target Service replicas drop to 0 → LB targets reported, Ingress `degraded`, recovers when replicas return. Commit: `test(core): e2e fault injection over v2 Bloco A (6.3)`

### Task 6.4 — `@live` smoke for managed cert (opt-in, manual)

- Files: create `core/test/live/v2-managed-cert.live.test.ts`. Marked `@live`, never in CI. Test: against a Hetzner sandbox project (operator-supplied token + zone), `set_certificate { type: managed, domains: [<sandbox-domain>] }` returns `applied` and the cert reaches `issued` within 30 minutes of polling. Skipped unless `HETZNER_LIVE_TOKEN` env present. Commit: `test(core): @live managed-cert smoke (opt-in) (6.4)`

### Task 6.5 — Wire v2 listings into Console (read-only consumption)

- Files: modify `core/src/agent/rest.ts` to add the five `GET /api/v2/*` listing endpoints; add their conformance tests. **Listing schemas were already added to `contract-v2.ts` incrementally per phase (1.5, 2.5, 3.6, 4.5, 5.5)** — this task only wires the REST routes, not invent schemas. **No console UI work** — UI for v2 entities is explicitly out of scope per spec-filha §9; this task only ensures the data is available for the future Console v2 panels. Commit: `feat(core): v2 listing endpoints (read-only, contract-conformant) (6.5)`

**Done (F6) =** `expose_service` produces converged Cert+LB+Ingress under one bundled approval; capstone scenario green; fault injection green; `@live` managed-cert smoke available; v2 listing endpoints contract-conformant.

---

## Fora de escopo / depende de credenciais reais

- **Real Hetzner Cloud API for v2 endpoints** — only the `@live` smoke (Task 6.4) touches real API, manual pre-release, sandbox project; requires operator-supplied token.
- **PolicyEngine (Bloco C)** — invariants such as "every Server matched by some Firewall.applied_to", "TLS hostname ⊆ cert domains", "PrimaryIP assignee_selector matches ≤1 server" live as inline minimal validation in providers with `// TODO(bloco-c)` markers; full PolicyEngine implementation belongs to Bloco C.
- **`cost_estimate` populated values (Bloco D)** — this bloco emits `{ monthly_delta_eur: 0, breakdown: [] }` everywhere; Bloco D replaces with a pricing provider.
- **`capability_token_id` populated values (Bloco C)** — column is added in Task 0.2, StateEvent inserts always write `null`. Bloco C activates.
- **Hetzner ACME `_acme-challenge` orchestration fallback** — assumed unnecessary based on Hetzner managed-cert behaviour; if F3 confirms otherwise, a follow-up task in F3 wires `HetznerDNSProvider` orchestration (already noted in F3.4).
- **PlacementGroup, FloatingIP, Image, `region`/`datacenter`** — Bloco B.
- **Webhooks, Prometheus metrics, `explain_state`** — Bloco D.
- **Console v2 UI for new entities** — out of scope; this bloco only exposes the data.
- **Renovação automática de cert uploaded** — manual via re-`set_certificate`.

## Done = (per phase, summary)

- **Task 0:** v2 HTTP adapter compiles (zero new npm deps); migration applies (5 v2 tables + 2 StateEvent columns); v2 envelope schema enforces neutral fields; `resolve_selector` tool + internal helper.
- **F1:** Firewall CRUD + allow-list + drift report + destructive-removal gating; idempotency property green.
- **F2:** PrimaryIP CRUD + Approval-always + ≤1 assignee invariant; idempotency property green.
- **F3:** Certificate uploaded + managed (non-blocking polling); secret apply-only; timeout cancelled; idempotency property green.
- **F4:** LoadBalancer CRUD + targets via selector + location-change destructive flag + no firewall coupling; idempotency property green.
- **F5:** IngressProvider composite + correct DAG + firewall to backend Servers + partial-failure `degraded`; idempotency property green.
- **F6:** `expose_service` one-bundled-approval; capstone E2E green; fault injection green; `@live` managed-cert smoke; v2 listings contract-conformant.
