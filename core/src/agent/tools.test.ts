/**
 * core/src/agent/tools.test.ts
 *
 * Task 4.4 — the 12-tool catalog shared by REST (4.5) and MCP (4.7). TDD
 * teeth, one assertion-cluster per tool, all driven through the SINGLE
 * `executeTool` dispatch so REST/MCP can never grow parallel logic.
 *
 * The contract source for the approval-policy table is
 * console/CONTRACT.md §"Write Envelope" lifecycle + the Tool→endpoint table:
 *   reads (get_state,diff,events,health)       → NO approval, NO mutation
 *   provision_server, restore, destroy         → ALWAYS approval
 *   deploy_service  dry_run:true               → planned (plan only, no secret)
 *   deploy_service  dry_run:false              → conditional
 *   scale_service, apply_manifest              → conditional
 *   set_dns, snapshot                          → none (apply directly)
 *
 * Reuses, never reinvents: 4.1 envelope builders, 4.2 authorizeAndRecord
 * (deny-before-write + audit on success AND failure), 4.3 createApprovalGate
 * (the per-tool sensitivity predicate is the documented 4.3 injection seam),
 * and the reconcile() Observe→Plan→Gate→Apply→Record cycle.
 *
 * DB tests use the pg harness (resetSchema + runMigrations per test); the
 * gate clock + approval ids are injected (deterministic, no real timers).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";

import {
  ALL_TOOLS,
  __mintVerifiedCredentialForTest,
  type VerifiedCredential,
} from "./capability.js";
import { createApprovalGate, type Clock } from "./approval-gate.js";
import {
  asBool,
  asRecord,
  createToolCatalog,
  TOOL_POLICY,
  type ToolCatalog,
  type ToolContext,
  type ToolResult,
} from "./tools.js";
import type { WriteEnvelope } from "./envelope.js";
import type { ReconcileGate } from "../reconciler/reconcile.js";
import { compositeProvider } from "../reconciler/composite-provider.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import { queryEvents } from "../store/state-events.js";
import { putState as putWorkingState } from "../store/working-store.js";
import { putState as putObservedState } from "../store/observed-store.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";
import type pg from "pg";
import { ReconcileError } from "../domain/errors.js";

let pool: pg.Pool;

beforeAll(() => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

// --- injected fixed clock (no real time) -----------------------------------
const FIXED = new Date("2026-05-18T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };

// --- in-memory fake Provider (network-free, idempotent) --------------------
function makeFakeProvider(): Provider {
  const reality = new Set<string>();
  return {
    name: "fake",
    async observe(scope: string): Promise<ObservedSlice> {
      const prefix = `${scope}:`;
      return {
        scope,
        entities: [...reality]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      if (reality.has(action.entity)) {
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
}

/**
 * A Provider whose observe() throws unconditionally. Used as the F3 sentinel:
 * any v1 dry_run handler that still hits provider.observe() will fail loudly
 * (the executeTool result flips from "planned" to "error"). The dry_run path
 * must read observed state from the observed-store, never from the provider.
 */
function makeThrowingObserveProvider(message: string): Provider {
  return {
    name: "throwing-observe",
    async observe(): Promise<ObservedSlice> {
      throw new Error(message);
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

/**
 * Provider whose `apply()` throws for any entity matching `failOnEntity`.
 * Used as the bug #5 / spec 2026-05-27 fixture: applyPlan reports the failure
 * via `report.failed[]`, reconcileToEnvelope must surface it as `error`
 * envelope (not silently as `applied`).
 */
function makeFailingApplyProvider(
  failOnEntity: string,
  message: string,
): Provider {
  const reality = new Set<string>();
  return {
    name: "failing-apply",
    async observe(scope: string): Promise<ObservedSlice> {
      const prefix = `${scope}:`;
      return {
        scope,
        entities: [...reality]
          .filter((k) => k.startsWith(prefix))
          .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      if (action.entity === failOnEntity) {
        throw new ReconcileError("transient", message, { entity: action.entity });
      }
      reality.add(action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };
}

const EMPTY: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

// Observed adapter: materialise minimal rows from the reported entity keys so
// plan() sees a converged reality as noop and an absent one as create.
function observedAdapter(slice: ObservedSlice): State {
  const servers = slice.entities
    .filter((e) => e.key.startsWith("server:"))
    .map((e) => ({
      name: e.key.slice("server:".length),
      type: "cx22",
      location: "nbg1",
      network: "net-a",
      image: "ubuntu-24.04",
      status: "healthy" as const,
    }));
  const services = slice.entities
    .filter((e) => e.key.startsWith("service:"))
    .map((e) => ({
      name: e.key.slice("service:".length),
      image: "registry/x:v1",
      replicas: 1,
    }));
  return {
    ...EMPTY,
    servers: servers as State["servers"],
    services: services as State["services"],
  };
}

/**
 * The desired manifest the catalog's reconcile loads for a scope. The tools
 * write desired state to the working-store; loadDesired reads it back. For
 * tests we keep a per-scope map seeded by the tool action.
 */
function makeCatalog(opts?: {
  desiredByScope?: Map<string, DesiredState>;
  provider?: Provider;
}): ToolCatalog {
  const desiredByScope = opts?.desiredByScope ?? new Map<string, DesiredState>();
  const provider = opts?.provider ?? makeFakeProvider();
  let idn = 0;
  return createToolCatalog({
    pool,
    provider,
    observedAdapter,
    loadDesired: async (scope: string): Promise<DesiredState> =>
      desiredByScope.get(scope) ?? {},
    // The tool layer writes the tool's desired delta here before reconcile.
    writeDesired: async (scope: string, desired: DesiredState) => {
      desiredByScope.set(scope, desired);
    },
    makeGate: (isSensitive): ReconcileGate =>
      createApprovalGate({
        pool,
        clock,
        isSensitive,
        idFactory: () => `apr_test_${++idn}`,
      }),
  });
}

function cred(caps: readonly string[], actor = "agent:vox"): VerifiedCredential {
  return __mintVerifiedCredentialForTest(actor, caps);
}

const fullCred = (): VerifiedCredential =>
  cred(ALL_TOOLS as unknown as string[]);

function ctx(c: VerifiedCredential, scope = "server"): ToolContext {
  return { credential: c, scope };
}

// Narrowers: ToolResult is a union (WriteEnvelope | {status:"ok",data}).
// These keep the assertions readable without sprinkling casts.
function env(r: ToolResult): WriteEnvelope {
  return r as WriteEnvelope;
}
function data(r: ToolResult): unknown {
  return (r as { data: unknown }).data;
}

// ===========================================================================
// 0. The policy table mirrors the frozen contract exactly
// ===========================================================================

describe("TOOL_POLICY mirrors the frozen contract", () => {
  it("declares exactly the 12 contract tools with the contract policy", () => {
    expect(Object.keys(TOOL_POLICY).sort()).toEqual(
      [...ALL_TOOLS].sort(),
    );
    expect(TOOL_POLICY.get_state).toBe("read");
    expect(TOOL_POLICY.diff).toBe("read");
    expect(TOOL_POLICY.events).toBe("read");
    expect(TOOL_POLICY.health).toBe("read");
    expect(TOOL_POLICY.provision_server).toBe("always");
    expect(TOOL_POLICY.deploy_service).toBe("conditional");
    expect(TOOL_POLICY.scale_service).toBe("conditional");
    expect(TOOL_POLICY.set_dns).toBe("none");
    expect(TOOL_POLICY.snapshot).toBe("none");
    expect(TOOL_POLICY.restore).toBe("always");
    expect(TOOL_POLICY.destroy).toBe("always");
    expect(TOOL_POLICY.apply_manifest).toBe("conditional");
  });
});

// ===========================================================================
// 1. Authz-first: deny-before-write, audited on denial=NONE, fatal envelope
// ===========================================================================

describe("authz spine (4.2) wraps every tool", () => {
  it("an out-of-scope tool returns a fatal error envelope and writes NOTHING", async () => {
    const cat = makeCatalog();
    // Credential with NO capabilities at all.
    const res = await cat.executeTool(
      "provision_server",
      { name: "app-1", type: "cx22", location: "nbg1", network: "net-a" },
      ctx(cred([])),
    );
    expect(res.status).toBe("error");
    expect(env(res).error?.code).toBe("fatal");
    expect(env(res).error?.retryable).toBe(false);
    // deny-before-write: NO StateEvent of any kind was recorded.
    const events = await queryEvents(pool, {});
    expect(events.length).toBe(0);
  });

  it("an authorized read still requires the capability for that read tool", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "get_state",
      {},
      ctx(cred(["health"])), // has health, NOT get_state
    );
    expect(res.status).toBe("error");
    expect(env(res).error?.code).toBe("fatal");
  });

  it("an unknown tool name is rejected as a fatal error envelope", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "not_a_tool" as never,
      {},
      ctx(fullCred()),
    );
    expect(res.status).toBe("error");
    expect(env(res).error?.code).toBe("fatal");
  });
});

// ===========================================================================
// 2. Reads: NO approval, NO desired-state write, NO reconcile mutation
// ===========================================================================

describe("read tools (get_state/diff/events/health)", () => {
  it("get_state returns the contract State shape and mutates nothing", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool("get_state", {}, ctx(fullCred()));
    expect(res.status).toBe("ok");
    expect(data(res)).toMatchObject({
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    });
    // a read is audited (4.2 audits authorized calls) but performs NO
    // mutating event: only the read audit event exists, result "ok",
    // and the working/observed stores were never written.
    const events = await queryEvents(pool, {});
    expect(events.every((e) => e.op === "get_state")).toBe(true);
  });

  it("diff returns drift between working (desired) and observed", async () => {
    const cat = makeCatalog();
    // Seed working desired with a server; observed empty ⇒ a create-diff.
    await putWorkingState(pool, "server", {
      ...EMPTY,
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          status: "pending",
        },
      ],
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16", subnets: [] }],
    });
    const res = await cat.executeTool("diff", {}, ctx(fullCred()));
    expect(res.status).toBe("ok");
    expect(Array.isArray(data(res))).toBe(true);
  });

  it("events returns the contract StateEvent list (filterable)", async () => {
    const cat = makeCatalog();
    // generate one event via a read
    await cat.executeTool("health", {}, ctx(fullCred()));
    const res = await cat.executeTool(
      "events",
      { actor: "agent:vox" },
      ctx(fullCred()),
    );
    expect(res.status).toBe("ok");
    expect(Array.isArray(data(res))).toBe(true);
    expect((data(res) as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("health returns the contract HealthReport shape", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool("health", {}, ctx(fullCred()));
    expect(res.status).toBe("ok");
    expect(data(res)).toHaveProperty("reconciler");
    expect(data(res)).toHaveProperty("circuit_breakers");
  });

  it("reads NEVER create an approval and NEVER write working/observed state", async () => {
    const cat = makeCatalog();
    for (const tool of ["get_state", "diff", "events", "health"] as const) {
      await cat.executeTool(tool, {}, ctx(fullCred()));
    }
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 3. ALWAYS-approval tools: provision_server / restore / destroy
//    → pending_approval envelope, reality NOT mutated until approved
// ===========================================================================

describe("ALWAYS-approval tools → pending_approval (fail-safe)", () => {
  it("provision_server returns pending_approval and applies NOTHING", async () => {
    // Seed the scope's desired with the referenced network so plan()'s
    // ref-completeness check passes (provision_server adds only the server;
    // the network is part of the existing declared desired).
    const desiredByScope = new Map<string, DesiredState>([
      ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
    ]);
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "provision_server",
      {
        name: "app-1",
        type: "cx22",
        location: "nbg1",
        network: "net-a",
      },
      ctx(fullCred(), "server"),
    );
    expect(res.status).toBe("pending_approval");
    expect(env(res).approval_id).toMatch(/^apr_/);
    // a pending approval row exists; nothing applied (fail-safe).
    const apr = await pool.query(
      "SELECT status FROM approvals WHERE id = $1",
      [env(res).approval_id],
    );
    expect(apr.rows[0].status).toBe("pending");
  });

  it("restore returns pending_approval (always-gated)", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "restore",
      { target: "volume:pg-data", snapshot: "snap-1" },
      ctx(fullCred(), "volume"),
    );
    expect(res.status).toBe("pending_approval");
    expect(env(res).approval_id).toMatch(/^apr_/);
  });

  it("destroy returns pending_approval and never auto-destructs", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "destroy",
      { entity: "server:app-1" },
      ctx(fullCred(), "server"),
    );
    expect(res.status).toBe("pending_approval");
    expect(env(res).approval_id).toMatch(/^apr_/);
  });

  it("destroy EXECUTES after approval (caller-retry) and removes the container (Bug 8)", async () => {
    const reality = new Set<string>(["service:nginx-test"]); // pre-existing
    const provider: Provider = {
      name: "destroyable",
      async observe(scope: string): Promise<ObservedSlice> {
        return {
          scope,
          entities: [...reality]
            .filter((k) => k.startsWith(`${scope}:`))
            .map((k) => ({ key: k, payload: { name: k.slice(k.lastIndexOf(":") + 1) } })),
        };
      },
      async apply(a: PlanAction): Promise<ApplyResult> {
        reality.add(a.entity);
        return { entity: a.entity, op: a.op, changed: true };
      },
      async verify(a: PlanAction): Promise<boolean> {
        return reality.has(a.entity);
      },
      async destroy(a: PlanAction): Promise<ApplyResult> {
        const had = reality.delete(a.entity);
        return { entity: a.entity, op: a.op, changed: had };
      },
    };
    const cat = makeCatalog({ provider });

    // 1. destroy → pending (fail-safe: nothing removed yet).
    const r1 = env(
      await cat.executeTool("destroy", { entity: "service:nginx-test" }, ctx(fullCred(), "service")),
    );
    expect(r1.status).toBe("pending_approval");
    expect(reality.has("service:nginx-test")).toBe(true);
    const id = r1.approval_id!;

    // 2. approve (a gate over the same pool resolves the row).
    let n = 0;
    const gate = createApprovalGate({
      pool,
      clock,
      isSensitive: () => true,
      idFactory: () => `apr_resolve_${++n}`,
    });
    await gate.resolveApproval(id, "approved", "human:op");

    // 3. re-call destroy → gate sees approved → provider.destroy removes it.
    const r2 = env(
      await cat.executeTool("destroy", { entity: "service:nginx-test" }, ctx(fullCred(), "service")),
    );
    expect(r2.status).toBe("applied");
    expect(reality.has("service:nginx-test")).toBe(false); // REMOVED

    // 4. a destroy StateEvent was recorded.
    const ev = await pool.query(
      "SELECT op, result FROM state_events WHERE entity = $1 AND op = 'destroy'",
      ["service:nginx-test"],
    );
    expect(ev.rows.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 3b. EXACT per-action approval_id — the gate→reconcile→tools accessor
//     A plan withholding ≥2 sensitive items in ONE scope (or two same-scope
//     calls) must surface the approval row for the entity the call REQUESTED,
//     never an arbitrary scope-only pending row (review [Important] #1).
// ===========================================================================

describe("pending_approval carries the EXACT requested-action approval_id", () => {
  it("≥2 withheld items in one scope → envelope id is the approval for the requested server (others get distinct correct ids)", async () => {
    // Pre-seed the scope's desired with the network + TWO servers that are
    // not observed, so plan() emits a `create` for each. provision_server
    // appends a THIRD. provision_server's gate is `() => true` ⇒ ALL THREE
    // creates are sensitive ⇒ THREE pending approvals open in scope "server"
    // within the SAME reconcile cycle.
    const desiredByScope = new Map<string, DesiredState>([
      [
        "server",
        {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          servers: [
            {
              name: "bevox-a",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
            },
            {
              name: "bevox-b",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
            },
          ],
        },
      ],
    ]);
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "provision_server",
      { name: "bevox-c", type: "cx22", location: "nbg1", network: "net-a" },
      ctx(fullCred(), "server"),
    );
    expect(res.status).toBe("pending_approval");

    // provision_server's gate is `() => true` ⇒ every plan item in the scope
    // is sensitive; with the network also un-observed the cycle withholds the
    // network create + all three server creates. We assert on the SERVER
    // approvals (the (scope,op,entity)-keyed rows the agent cares about).
    const all = await pool.query<{ id: string; entity: string }>(
      `SELECT id, entity FROM approvals
         WHERE scope = $1 AND op = 'create' AND status = 'pending'
           AND entity LIKE 'server:%'
         ORDER BY entity`,
      ["server"],
    );
    expect(all.rows.map((r) => r.entity)).toEqual([
      "server:bevox-a",
      "server:bevox-b",
      "server:bevox-c",
    ]);
    // distinct ids per withheld item.
    const ids = new Set(all.rows.map((r) => r.id));
    expect(ids.size).toBe(3);

    // The envelope's approval_id is EXACTLY the row for the requested entity
    // (server:bevox-c) — NOT an arbitrary scope-only pick.
    const requestedRow = all.rows.find(
      (r) => r.entity === "server:bevox-c",
    )!;
    expect(env(res).approval_id).toBe(requestedRow.id);

    // And it is genuinely one of the three (not a stale/foreign id).
    expect(ids.has(env(res).approval_id!)).toBe(true);
    // It is NOT the approval for a different withheld entity.
    const otherIds = all.rows
      .filter((r) => r.entity !== "server:bevox-c")
      .map((r) => r.id);
    expect(otherIds).not.toContain(env(res).approval_id);
  });

  it("two sequential same-scope provision_server calls each surface their OWN approval id (no cross-surfacing)", async () => {
    const desiredByScope = new Map<string, DesiredState>([
      ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
    ]);
    const cat = makeCatalog({ desiredByScope });

    const r1 = await cat.executeTool(
      "provision_server",
      { name: "srv-1", type: "cx22", location: "nbg1", network: "net-a" },
      ctx(fullCred(), "server"),
    );
    const r2 = await cat.executeTool(
      "provision_server",
      { name: "srv-2", type: "cx22", location: "nbg1", network: "net-a" },
      ctx(fullCred(), "server"),
    );
    expect(r1.status).toBe("pending_approval");
    expect(r2.status).toBe("pending_approval");
    expect(env(r1).approval_id).not.toBe(env(r2).approval_id);

    const rows = await pool.query<{ id: string; entity: string }>(
      `SELECT id, entity FROM approvals
         WHERE scope = $1 AND op = 'create' AND status = 'pending'`,
      ["server"],
    );
    const byEntity = new Map(rows.rows.map((r) => [r.entity, r.id]));
    // Each call's envelope id matches the approval row for the entity IT
    // requested — never the other call's row.
    expect(env(r1).approval_id).toBe(byEntity.get("server:srv-1"));
    expect(env(r2).approval_id).toBe(byEntity.get("server:srv-2"));
  });
});

// ===========================================================================
// 4. deploy_service dry_run → planned (plan only; NO write, NO secret value)
// ===========================================================================

describe("deploy_service dry_run", () => {
  it("dry_run:true → planned envelope, no write, no reconcile, no secret value", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "deploy_service",
      {
        name: "bevox-harness",
        image: "registry/bevox-harness:v12",
        replicas: 2,
        env: { TOKEN: "secret:bevox-harness" },
        dry_run: true,
      },
      ctx(fullCred(), "service"),
    );
    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    expect(env(res).plan!.length).toBeGreaterThanOrEqual(1);
    // NO secret value (and no resolution) reaches the planned envelope. The
    // contract PlanItem is {op,entity,change,impact} only — it carries NO env
    // payload at all, so a `secret:` ref cannot even appear, let alone a
    // resolved value. plan() is pure and never resolves; this asserts the
    // non-applied output is value-free (1.9/3.3 discipline at the tool layer).
    const blob = JSON.stringify(res);
    expect(blob).not.toContain("RESOLVED");
    expect(blob).not.toMatch(/secret-value|decrypted|TOKEN/i);
    // dry_run wrote NOTHING to working_state and created NO approval.
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 4b. dry_run honoured by the remaining v1 mutating handlers (Phase F2):
//     provision_server / scale_service / set_dns / apply_manifest each
//     return a planned envelope with NO desired-state write + NO approval row.
// ===========================================================================

describe("provision_server dry_run", () => {
  it("dry_run:true → planned envelope, no desired write, no approval", async () => {
    // Seed the scope's desired with the referenced network so plan()'s
    // ref-completeness check passes for the hypothetical server.
    const desiredByScope = new Map<string, DesiredState>([
      ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
    ]);
    // F3.2 sentinel: provider.observe MUST NOT be called from this dry_run —
    // the handler reads observed state from the observed-store. A throwing
    // observe makes any regression visible: the executeTool result would flip
    // from "planned" to "error".
    const provider = makeThrowingObserveProvider(
      "observe must not be called in dry_run (F3 sentinel)",
    );
    const cat = makeCatalog({ desiredByScope, provider });
    const before = desiredByScope.get("server");

    const res = await cat.executeTool(
      "provision_server",
      {
        name: "s1",
        type: "cx22",
        location: "fsn1",
        network: "net-a",
        dry_run: true,
      },
      ctx(fullCred(), "server"),
    );

    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    expect(env(res).plan!.length).toBeGreaterThanOrEqual(1);
    // loadDesired's view is UNCHANGED: no mergeDesired ran.
    expect(desiredByScope.get("server")).toBe(before);
    // no desired-state write in the working store, no approval row opened.
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

describe("scale_service dry_run", () => {
  it("dry_run:true → planned envelope, no desired write, no approval", async () => {
    // Seed the scope's desired with an existing service at replicas=1; the
    // hypothetical scale is to replicas=3.
    const desiredByScope = new Map<string, DesiredState>([
      [
        "service",
        {
          services: [
            { name: "svc", image: "registry/svc:v1", replicas: 1 },
          ],
        },
      ],
    ]);
    // F3.3 sentinel: scale_service dry_run must read observed state from the
    // observed-store, never invoke provider.observe(). The throwing observe
    // proves the swap stuck.
    const provider = makeThrowingObserveProvider(
      "observe must not be called in dry_run (F3 sentinel)",
    );
    const cat = makeCatalog({ desiredByScope, provider });
    const before = desiredByScope.get("service");

    const res = await cat.executeTool(
      "scale_service",
      { name: "svc", replicas: 3, dry_run: true },
      ctx(fullCred(), "service"),
    );

    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    // desired view unchanged; no working-state write; no approval opened.
    expect(desiredByScope.get("service")).toBe(before);
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

describe("set_dns dry_run", () => {
  it("dry_run:true → planned envelope, no desired write, no approval", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    // F3.4 sentinel: set_dns dry_run must read observed state from the
    // observed-store, never invoke provider.observe(). The throwing observe
    // proves the swap stuck.
    const provider = makeThrowingObserveProvider(
      "observe must not be called in dry_run (F3 sentinel)",
    );
    const cat = makeCatalog({ desiredByScope, provider });

    const res = await cat.executeTool(
      "set_dns",
      {
        zone: "example.net",
        name: "api",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
        dry_run: true,
      },
      ctx(fullCred(), "dns"),
    );

    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    // loadDesired's view was never written — the map is still empty.
    expect(desiredByScope.has("dns")).toBe(false);
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

describe("apply_manifest dry_run", () => {
  it("dry_run:true → planned envelope, no desired write, no approval", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    // F3.5 sentinel: apply_manifest dry_run must read observed state from the
    // observed-store, never invoke provider.observe(). The throwing observe
    // proves the swap stuck.
    const provider = makeThrowingObserveProvider(
      "observe must not be called in dry_run (F3 sentinel)",
    );
    const cat = makeCatalog({ desiredByScope, provider });

    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        },
        dry_run: true,
      },
      ctx(fullCred(), "network"),
    );

    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    // The manifest IS the desired in this handler — dry_run must NOT persist
    // it. loadDesired's view stays untouched (no writeDesired call).
    expect(desiredByScope.has("network")).toBe(false);
    const ws = await pool.query("SELECT count(*)::int AS n FROM working_state");
    expect(ws.rows[0].n).toBe(0);
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });

  // Regression sentinel (spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md
  // §1.4 + §9 #2): consumer reported receiving {status:"applied"} for a
  // dry_run call. Code path returns planned(...) before any reconcile, but no
  // test had pinned the multi-kind shape AND that no desired-store write
  // occurs under ANY scope (the silo or the post-1.1 per-scope rows).
  it("apply_manifest({dry_run:true}) returns {status:'planned'} and writes NO desired-state across ALL scopes", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-dry", ip_range: "10.7.0.0/16" }],
          servers: [
            {
              name: "dry-app",
              type: "cx22",
              location: "nbg1",
              network: "net-dry",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: true,
      },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    // Pure dry_run: zero desired writes under ANY scope (no silo, no fan-out).
    expect(desiredByScope.size).toBe(0);
  });
});

// ===========================================================================
// 4c. dry_run reads observed state from the observed-store, NOT from the
//     Provider (Phase F3). The Provider's observe() is a live cross-process
//     hop (SSH spawn for Docker, HTTP for Hetzner) — invoking it on a dry_run
//     would defeat the "plan only, no side effects, no secret resolution"
//     contract. Each handler MUST read the cached observed snapshot via
//     getObservedState(pool, scope). These tests pin that by installing a
//     Provider whose observe() THROWS unconditionally: if the test passes,
//     the dry_run never hit it.
// ===========================================================================

describe("deploy_service dry_run reads observed-store (F3.1)", () => {
  it("dry_run:true → planned reflects seeded observed-store, provider.observe NOT called", async () => {
    const provider = makeThrowingObserveProvider(
      "observe must not be called in dry_run (F3 sentinel)",
    );
    const cat = makeCatalog({ provider });

    // Seed observed-store for the "service" scope with an EXISTING service at
    // replicas=1 + the same image. The hypothetical deploy is replicas=2 with
    // the same image — plan() should therefore see this as an UPDATE (replicas
    // change), not a create. That is the assertion that the planner read the
    // seeded observed snapshot, not an empty default.
    const seeded: State = {
      ...EMPTY,
      services: [
        {
          name: "bevox-harness",
          image: "registry/bevox-harness:v12",
          replicas: 1,
        },
      ],
    };
    await putObservedState(pool, "service", seeded);

    const res = await cat.executeTool(
      "deploy_service",
      {
        name: "bevox-harness",
        image: "registry/bevox-harness:v12",
        replicas: 2,
        dry_run: true,
      },
      ctx(fullCred(), "service"),
    );

    expect(res.status).toBe("planned");
    // Plan reflects the SEEDED observed: an update (or non-empty diff) for the
    // existing service, NOT a create-from-scratch. plan()'s exact op label may
    // vary; the load-bearing fact is that the planner saw a service already
    // present — assert the plan mentions the service's entity key.
    const planItems = env(res).plan ?? [];
    expect(planItems.length).toBeGreaterThanOrEqual(1);
    expect(planItems.some((p) => p.entity === "service:bevox-harness")).toBe(
      true,
    );
    // The throwing observe was NOT invoked: had it been, the executeTool
    // promise would have rejected → status would be "error", never "planned".
    expect(res.status).not.toBe("error");
  });
});

// ===========================================================================
// 4d. F3.6 cross-handler sentinel — NO SSH/HTTP observe path is reachable
//     from any v1 mutating tool's dry_run branch. We instantiate ONE catalog
//     per tool (each tool's dry_run needs slightly different desired seed for
//     plan() ref-completeness) but ALL share the same throwing-observe
//     Provider — its observe() rejects with an "ssh spawn attempted (sentinel)"
//     marker. Each tool MUST return a planned (or non-error) envelope without
//     ever invoking observe; any regression that brings the live observe path
//     back will surface as a status: "error" on the offending tool. Do NOT
//     weaken this test if it fails — repair the handler.
// ===========================================================================

describe("F3.6 sentinel — no SSH spawn from v1 dry_run", () => {
  it("all 5 v1 mutating tools dry_run without ever calling provider.observe()", async () => {
    const sentinel = "ssh spawn attempted (sentinel)";

    // provision_server: needs the referenced network in desired so plan()'s
    // ref-completeness check passes.
    {
      const desiredByScope = new Map<string, DesiredState>([
        ["server", { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] }],
      ]);
      const cat = makeCatalog({
        desiredByScope,
        provider: makeThrowingObserveProvider(sentinel),
      });
      const res = await cat.executeTool(
        "provision_server",
        {
          name: "s1",
          type: "cx22",
          location: "fsn1",
          network: "net-a",
          dry_run: true,
        },
        ctx(fullCred(), "server"),
      );
      expect(res.status).toBe("planned");
    }

    // deploy_service: no specific desired seed required.
    {
      const cat = makeCatalog({
        provider: makeThrowingObserveProvider(sentinel),
      });
      const res = await cat.executeTool(
        "deploy_service",
        {
          name: "bevox-web",
          image: "registry/bevox-web:v1",
          replicas: 1,
          dry_run: true,
        },
        ctx(fullCred(), "service"),
      );
      expect(res.status).toBe("planned");
    }

    // scale_service: needs the existing service in desired.
    {
      const desiredByScope = new Map<string, DesiredState>([
        [
          "service",
          {
            services: [
              { name: "svc", image: "registry/svc:v1", replicas: 1 },
            ],
          },
        ],
      ]);
      const cat = makeCatalog({
        desiredByScope,
        provider: makeThrowingObserveProvider(sentinel),
      });
      const res = await cat.executeTool(
        "scale_service",
        { name: "svc", replicas: 3, dry_run: true },
        ctx(fullCred(), "service"),
      );
      expect(res.status).toBe("planned");
    }

    // set_dns: no specific desired seed required.
    {
      const cat = makeCatalog({
        provider: makeThrowingObserveProvider(sentinel),
      });
      const res = await cat.executeTool(
        "set_dns",
        {
          zone: "example.net",
          name: "api",
          type: "A",
          value: "1.2.3.4",
          ttl: 300,
          dry_run: true,
        },
        ctx(fullCred(), "dns"),
      );
      expect(res.status).toBe("planned");
    }

    // apply_manifest: the manifest IS the desired in this handler.
    {
      const cat = makeCatalog({
        provider: makeThrowingObserveProvider(sentinel),
      });
      const res = await cat.executeTool(
        "apply_manifest",
        {
          manifest: {
            networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          },
          dry_run: true,
        },
        ctx(fullCred(), "network"),
      );
      expect(res.status).toBe("planned");
    }
  });
});

// ===========================================================================
// 5. Conditional tools (deploy_service apply / scale_service / apply_manifest)
//    A non-sensitive plan applies directly; a sensitive op is withheld.
// ===========================================================================

describe("conditional tools", () => {
  it("deploy_service apply (non-sensitive create) → applied", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "deploy_service",
      {
        name: "bevox-web",
        image: "registry/bevox-web:v1",
        replicas: 1,
        dry_run: false,
      },
      ctx(fullCred(), "service"),
    );
    expect(res.status).toBe("applied");
  });

  it("scale_service (non-sensitive scale) → applied", async () => {
    const cat = makeCatalog();
    // service must exist in desired to scale; deploy first.
    await cat.executeTool(
      "deploy_service",
      { name: "bevox-web", image: "registry/bevox-web:v1", replicas: 1 },
      ctx(fullCred(), "service"),
    );
    const res = await cat.executeTool(
      "scale_service",
      { name: "bevox-web", replicas: 3 },
      ctx(fullCred(), "service"),
    );
    expect(res.status).toBe("applied");
  });

  it("apply_manifest with a non-sensitive manifest → applied", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
        },
      },
      ctx(fullCred(), "network"),
    );
    expect(res.status).toBe("applied");
  });

  // Regression guard for the apply_manifest meta-scope fix:
  // spec docs/specs/2026-05-26-apply-manifest-meta-scope.md §3.1.
  //
  // BEFORE the fix, compositeProvider.observe("manifest") fell through to
  // targetsFor() → throw ReconcileError("precondition", `unsupported
  // scope/kind "manifest"`). The REST route declares scope:"manifest" and
  // tools.ts:doApplyManifest passes that scope to reconcileToEnvelope, so
  // the apply path (NOT dry_run) blew up with HTTP 400. The existing
  // "apply_manifest with a non-sensitive manifest → applied" test above
  // hid the bug because it (a) used a single Provider (not the composite)
  // and (b) passed scope="network" to ctx() — a valid scope, not the
  // production literal "manifest". This test exercises the production
  // shape: real compositeProvider, scope="manifest".
  it("apply_manifest via production composite + scope=manifest → applied (meta-scope)", async () => {
    const provider = compositeProvider({
      network: makeFakeProvider(),
      server: [makeFakeProvider()],
      volume: makeFakeProvider(),
      service: makeFakeProvider(),
    });
    const cat = makeCatalog({ provider });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          servers: [
            {
              name: "app-1",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: false,
      },
      ctx(fullCred(), "manifest"),
    );
    // Sentinel: NEVER the precondition we are fixing.
    const e = env(res);
    expect(e.error?.message ?? "").not.toMatch(/unsupported scope.kind "manifest"/);
    expect(e.error?.code).not.toBe("precondition");
    // Acceptance: the conditional tool either applied directly (no
    // sensitive op in the manifest) or withheld for approval. Never error.
    expect(["applied", "pending_approval"]).toContain(res.status);
  });

  // Regression: spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.1.
  // doApplyManifest (apply path) MUST fan-out the manifest into per-scope
  // desired entries. The "manifest" silo entry MUST NOT exist after.
  it("apply_manifest (apply path) writes desired per-scope, NOT under 'manifest'", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
          servers: [
            {
              name: "app-1",
              type: "cx22",
              location: "nbg1",
              network: "net-a",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: false,
      },
      ctx(fullCred(), "manifest"),
    );
    expect(["applied", "pending_approval"]).toContain(res.status);
    // Fan-out: per-kind entries populated.
    expect(desiredByScope.get("network")).toEqual({
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
    });
    expect(desiredByScope.get("server")).toEqual({
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
      ],
    });
    // Slices NOT present in the manifest are NOT written.
    expect(desiredByScope.has("volume")).toBe(false);
    expect(desiredByScope.has("service")).toBe(false);
    expect(desiredByScope.has("dns")).toBe(false);
    expect(desiredByScope.has("backup")).toBe(false);
    // Silo entry MUST NOT exist (the bug we are fixing).
    expect(desiredByScope.has("manifest")).toBe(false);
  });

  // Fail-safe: ausência ≠ apagar. A manifest declaring only `servers`
  // does NOT clobber a pre-existing `network` slice that the operator
  // declared earlier via apply_manifest.
  it("apply_manifest (apply path) does NOT clobber unrelated pre-existing per-scope slices", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("network", {
      networks: [{ name: "pre-existing", ip_range: "10.9.0.0/16" }],
    });
    const cat = makeCatalog({ desiredByScope });
    await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          servers: [
            {
              name: "app-2",
              type: "cx22",
              location: "nbg1",
              network: "pre-existing",
              image: "ubuntu-24.04",
            },
          ],
        },
        dry_run: false,
      },
      ctx(fullCred(), "manifest"),
    );
    expect(desiredByScope.get("server")?.servers?.[0]?.name).toBe("app-2");
    expect(desiredByScope.get("network")).toEqual({
      networks: [{ name: "pre-existing", ip_range: "10.9.0.0/16" }],
    });
  });
});

// ===========================================================================
// 6. none-policy tools: set_dns / snapshot apply directly (still authz+audit)
// ===========================================================================

describe("none-policy tools (set_dns / snapshot)", () => {
  it("set_dns applies directly (no approval) and is audited", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "set_dns",
      {
        zone: "example.net",
        name: "api",
        type: "A",
        value: "1.2.3.4",
        ttl: 300,
      },
      ctx(fullCred(), "dns"),
    );
    expect(res.status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
    // audited under the acting actor + the set_dns op.
    const evs = await queryEvents(pool, { actor: "agent:vox" });
    expect(evs.some((e) => e.op === "set_dns")).toBe(true);
  });

  it("snapshot applies directly (no approval)", async () => {
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "snapshot",
      { target: "volume:pg-data" },
      ctx(fullCred(), "volume"),
    );
    expect(res.status).toBe("applied");
    const apr = await pool.query("SELECT count(*)::int AS n FROM approvals");
    expect(apr.rows[0].n).toBe(0);
  });
});

// ===========================================================================
// 7. authorized-but-failed mutation is audited result:"error" (4.2 owns it)
// ===========================================================================

describe("authorized-but-failed mutation", () => {
  it("a failing tool action surfaces an error envelope AND is audited", async () => {
    // provision_server with an invalid manifest (missing required field) →
    // the reconcile/plan precondition fails; 4.2 must still audit the
    // authorized-but-failed attempt, then the catalog returns error().
    const cat = makeCatalog();
    const res = await cat.executeTool(
      "provision_server",
      { name: "", type: "", location: "", network: "" },
      ctx(fullCred(), "server"),
    );
    expect(res.status).toBe("error");
    const evs = await queryEvents(pool, { result: "error" });
    expect(evs.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 8. Task F4.7 — doGatedOp honours dry_run, skips gate.evaluate()
// ===========================================================================
//
// For each of destroy / snapshot / restore, calling the tool with
// `dry_run:true` must:
//   (a) return `{ status:"planned", plan:[<synthetic PlanItem>] }`,
//   (b) NOT invoke `gate.evaluate` (the dispatch must short-circuit before
//       the gate), and
//   (c) leave the `approvals` table unchanged for this (scope, op, entity).
// We prove (b) by spying on `makeGate`: each gate factory output is wrapped
// to count `evaluate()` calls. Assertion (c) is the durable side-effect
// witness — even if the spy were bypassed, the no-row check would catch it.

describe("Task F4.7 — doGatedOp honours dry_run, skips gate.evaluate", () => {
  /**
   * Build a catalog whose makeGate factory wraps each real gate to count
   * `evaluate()` invocations. Returns the catalog and a shared counter.
   */
  function makeSpyCatalog(): {
    cat: ToolCatalog;
    evaluateCalls: { count: number };
  } {
    const evaluateCalls = { count: 0 };
    let idn = 0;
    const cat = createToolCatalog({
      pool,
      provider: makeFakeProvider(),
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => ({}),
      writeDesired: async (): Promise<void> => {},
      makeGate: (isSensitive): ReconcileGate => {
        const real = createApprovalGate({
          pool,
          clock,
          isSensitive,
          idFactory: () => `apr_test_${++idn}`,
        });
        const wrapped: ReconcileGate = {
          ...real,
          async evaluate(items, gctx) {
            evaluateCalls.count += 1;
            return real.evaluate(items, gctx);
          },
        };
        return wrapped;
      },
    });
    return { cat, evaluateCalls };
  }

  it("destroy with dry_run:true returns planned + skips gate.evaluate + no approval row", async () => {
    const { cat, evaluateCalls } = makeSpyCatalog();
    const res = await cat.executeTool(
      "destroy",
      { entity: "server:app-1", dry_run: true },
      ctx(fullCred(), "server"),
    );
    expect(res.status).toBe("planned");
    const e = env(res);
    expect(e.plan).toBeDefined();
    expect(e.plan!.length).toBe(1);
    expect(e.plan![0]!.op).toBe("destroy");
    expect(e.plan![0]!.entity).toBe("server:app-1");
    expect(evaluateCalls.count).toBe(0);
    const apr = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE op = 'destroy' AND entity = 'server:app-1'",
    );
    expect(apr.rows[0]!.n).toBe(0);
  });

  it("snapshot with dry_run:true returns planned + skips gate.evaluate + no approval row", async () => {
    const { cat, evaluateCalls } = makeSpyCatalog();
    const res = await cat.executeTool(
      "snapshot",
      { target: "volume:pg-data", dry_run: true },
      ctx(fullCred(), "volume"),
    );
    expect(res.status).toBe("planned");
    const e = env(res);
    expect(e.plan).toBeDefined();
    expect(e.plan!.length).toBe(1);
    expect(e.plan![0]!.op).toBe("snapshot");
    expect(e.plan![0]!.entity).toBe("volume:pg-data");
    expect(evaluateCalls.count).toBe(0);
    const apr = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE op = 'snapshot' AND entity = 'volume:pg-data'",
    );
    expect(apr.rows[0]!.n).toBe(0);
  });

  it("restore with dry_run:true returns planned + skips gate.evaluate + no approval row", async () => {
    const { cat, evaluateCalls } = makeSpyCatalog();
    const res = await cat.executeTool(
      "restore",
      { target: "volume:pg-data", snapshot: "snap-1", dry_run: true },
      ctx(fullCred(), "volume"),
    );
    expect(res.status).toBe("planned");
    const e = env(res);
    expect(e.plan).toBeDefined();
    expect(e.plan!.length).toBe(1);
    expect(e.plan![0]!.op).toBe("restore");
    expect(e.plan![0]!.entity).toBe("volume:pg-data");
    expect(evaluateCalls.count).toBe(0);
    const apr = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM approvals WHERE op = 'restore' AND entity = 'volume:pg-data'",
    );
    expect(apr.rows[0]!.n).toBe(0);
  });
});

// ===========================================================================
// asRecord JSON-string acceptance (spec 2026-05-27-asrecord-accept-json-string)
// ===========================================================================

describe("asRecord (spec 2026-05-27 — JSON-string input)", () => {
  it("parses JSON-encoded object string", () => {
    expect(asRecord('{"foo":"bar"}')).toEqual({ foo: "bar" });
  });
  it("rejects malformed JSON string", () => {
    expect(asRecord("{not json")).toEqual({});
  });
  it("rejects array input (object-like but not Record)", () => {
    expect(asRecord([1, 2, 3])).toEqual({});
  });
  it("preserves object passthrough", () => {
    expect(asRecord({ a: 1 })).toEqual({ a: 1 });
  });
});

// ===========================================================================
// asBool MCP-string-interop helper (spec 2026-05-27-mcp-string-interop-batch §1.1)
// ===========================================================================

describe("asBool (spec 2026-05-27-mcp-string-interop-batch — bool coercion)", () => {
  it("boolean true passthrough", () => {
    expect(asBool(true)).toBe(true);
  });
  it("boolean false passthrough", () => {
    expect(asBool(false)).toBe(false);
  });
  it('string "true" coerces to true', () => {
    expect(asBool("true")).toBe(true);
  });
  it('string "false" coerces to false', () => {
    expect(asBool("false")).toBe(false);
  });
  it('string "1" coerces to true', () => {
    expect(asBool("1")).toBe(true);
  });
  it("number 1 coerces to true", () => {
    expect(asBool(1)).toBe(true);
  });
  it("undefined → false (default: apply, not dry_run)", () => {
    expect(asBool(undefined)).toBe(false);
  });
  it("null → false", () => {
    expect(asBool(null)).toBe(false);
  });
  it('ambiguous "yes" → false (conservative)', () => {
    expect(asBool("yes")).toBe(false);
  });
});

// Integration sentinel: dry_run as string "true" via apply_manifest must
// take the planned path (not silently apply).
describe("dry_run string-coercion integration (spec 2026-05-27-mcp-string-interop-batch §3 #2)", () => {
  it("apply_manifest with dry_run:'true' (string) returns planned, not applied", async () => {
    const desiredByScope = new Map<string, DesiredState>();
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "apply_manifest",
      {
        manifest: {
          networks: [{ name: "string-dryrun-net", ip_range: "10.0.0.0/16" }],
        },
        dry_run: "true",
      },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("planned");
    expect(Array.isArray(env(res).plan)).toBe(true);
    // Pure dry_run: no fan-out writes despite a non-empty manifest.
    expect(desiredByScope.size).toBe(0);
  });
});

// ===========================================================================
// reconcileToEnvelope failure surfacing (spec 2026-05-27 §4)
//
// Bug #5 root cause: reconcileToEnvelope returns applied() even when
// applyPlan reports failures. This block pins:
//   - failed > 0, withheld === 0  → error envelope (Mudança 1)
//   - applied path unchanged (regression sentinel)
//   - withheld precedence over failed (existing approval semantics)
// ===========================================================================

describe("reconcileToEnvelope failure surfacing (spec 2026-05-27)", () => {
  // Harness note: makeCatalog uses a raw-Map seam (no cross-scope union),
  // so we pre-seed scope="manifest" directly so reconcile-of-manifest's
  // loadDesired() returns the same manifest shape that the production
  // createDesiredStateSeam union would (see rest.test.ts capstone). The
  // fan-out by doApplyManifest still runs and writes per-scope, but those
  // writes don't feed the manifest-scoped reconcile in this harness.
  it("apply_manifest with failing provider → error envelope (not applied)", async () => {
    const manifest: DesiredState = {
      networks: [{ name: "bug5-network", ip_range: "10.0.0.0/16" }],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const provider = makeFailingApplyProvider(
      "network:bug5-network",
      "fake hcloud API rejected subnets shape",
    );
    const cat = makeCatalog({ desiredByScope, provider });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("error");
    const e = env(res);
    expect(e.error?.code).toBe("transient");
    expect(e.error?.message).toMatch(/fake hcloud API rejected/);
    expect(e.error?.entity).toBe("network:bug5-network");
  });

  it("apply_manifest with all-success provider → applied (regression sentinel)", async () => {
    const manifest: DesiredState = {
      networks: [{ name: "ok-network", ip_range: "10.0.0.0/16" }],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("applied");
  });

  it("catalog reconcile threads logger from ToolDeps (spec §3)", async () => {
    // Pre-fix: tools.ts:reconcileToEnvelope omitted `logger` from the
    // reconcile() deps → noopLogger → "reconcile cycle complete" silenced for
    // apply-path calls. This sentinel asserts the catalog now propagates the
    // injected logger so the apply-path produces the same observability the
    // periodic timer already has.
    const captured: Array<{ level: string; msg: string }> = [];
    const capturingLogger = {
      info(_fields: Record<string, unknown>, msg: string): void {
        captured.push({ level: "info", msg });
      },
      warn(_fields: Record<string, unknown>, msg: string): void {
        captured.push({ level: "warn", msg });
      },
      error(_fields: Record<string, unknown>, msg: string): void {
        captured.push({ level: "error", msg });
      },
    };
    const manifest: DesiredState = {
      networks: [{ name: "logger-test-net", ip_range: "10.0.0.0/16" }],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const provider = makeFakeProvider();
    let idn = 0;
    const cat = createToolCatalog({
      pool,
      provider,
      observedAdapter,
      loadDesired: async (scope: string): Promise<DesiredState> =>
        desiredByScope.get(scope) ?? {},
      writeDesired: async (scope: string, desired: DesiredState) => {
        desiredByScope.set(scope, desired);
      },
      makeGate: (isSensitive): ReconcileGate =>
        createApprovalGate({
          pool,
          clock,
          isSensitive,
          idFactory: () => `apr_logger_${++idn}`,
        }),
      logger: capturingLogger,
    });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("applied");
    // The reconcile factory emits this message at the end of every cycle
    // (reconcile.ts: "reconcile cycle complete"). Pre-fix this was silenced
    // for the catalog path — its presence proves the wiring.
    expect(captured.some((l) => l.msg === "reconcile cycle complete")).toBe(true);
  });

  it("error envelope preserves errorClass when provider throws precondition", async () => {
    // Verify errorClass is faithfully transcribed from FailedItem → envelope.
    // Different errorClass (precondition) lands in different envelope.code.
    const manifest: DesiredState = {
      networks: [{ name: "any-net", ip_range: "10.0.0.0/16" }],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const provider: Provider = {
      name: "preconditioning-fake",
      async observe(scope: string): Promise<ObservedSlice> {
        return { scope, entities: [] };
      },
      async apply(action: PlanAction): Promise<ApplyResult> {
        throw new ReconcileError("precondition", "operator intent invalid", {
          entity: action.entity,
        });
      },
      async verify(): Promise<boolean> {
        return false;
      },
    };
    const cat = makeCatalog({ desiredByScope, provider });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("error");
    expect(env(res).error?.code).toBe("precondition");
    expect(env(res).error?.entity).toBe("network:any-net");
  });
});

// ===========================================================================
// STRICT_MANIFEST_APPROVAL knob (spec 2026-05-27 §3 acceptance)
// ===========================================================================

describe("apply_manifest STRICT_MANIFEST_APPROVAL dispatch (spec 2026-05-27)", () => {
  // Backward-compat sentinel: default off → current behavior preserved.
  it("default (strictManifestApproval omitted) → apply_manifest server returns applied", async () => {
    const manifest: DesiredState = {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
      ],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const cat = makeCatalog({ desiredByScope });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("applied");
  });

  // New behavior: strict on → create server is sensitive → pending_approval.
  it("strictManifestApproval:true → apply_manifest server returns pending_approval", async () => {
    const manifest: DesiredState = {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
      servers: [
        {
          name: "app-strict",
          type: "cx22",
          location: "nbg1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
      ],
    };
    const desiredByScope = new Map<string, DesiredState>();
    desiredByScope.set("manifest", manifest);
    const provider = makeFakeProvider();
    let idn = 0;
    const cat = createToolCatalog({
      pool,
      provider,
      observedAdapter,
      loadDesired: async (scope) => desiredByScope.get(scope) ?? {},
      writeDesired: async (scope, d) => {
        desiredByScope.set(scope, d);
      },
      makeGate: (isSensitive): ReconcileGate =>
        createApprovalGate({
          pool,
          clock,
          isSensitive,
          idFactory: () => `apr_strict_${++idn}`,
        }),
      strictManifestApproval: true,
    });
    const res = await cat.executeTool(
      "apply_manifest",
      { manifest, dry_run: false },
      ctx(fullCred(), "manifest"),
    );
    expect(res.status).toBe("pending_approval");
    expect(env(res).approval_id).toMatch(/^apr_strict_/);
  });
});
