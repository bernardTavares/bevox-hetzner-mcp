/**
 * core/src/agent/v2/ensure-k3s.test.ts
 *
 * Bloco E Task 23 — TDD teeth for `ensure_k3s` (v2 write tool, the Phase-2
 * production capstone). Asserts on the single `ensureK3s(input, ctx, deps)`
 * function, the shared core for the REST `POST /api/v2/k3s/ensure` route and
 * the MCP `ensure_k3s` tool call.
 *
 * Mirrors `kubectl-apply.test.ts` (Task 14) build-up — the differences are:
 *
 *   - parse via the FROZEN `EnsureK3sSchema` (host/version/role; .strict());
 *   - NO namespace precondition (that was kube-specific, Q-d) — EnsureK3s is a
 *     host-axis recipe;
 *   - drives `EnsureK3sProvider.apply(desired, observed)` — apply takes NO
 *     ApplyContext (the install recipe resolves no secret);
 *   - the `result:"drift"` outcome (version-divergence, Q-a) is surfaced in the
 *     envelope appropriately (still status:"applied", changed:false).
 *
 * Identical to kubectl_apply on: deny-before-write capability gate; Q-c
 * server-side host resolution (the credential/key never in input); the
 * always-sensitive Approval Gate (`makeGate(() => true)`); actor sourced from
 * the verified credential; NO-throw contract envelope.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 23)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import {
  ensureK3s,
  type EnsureK3sToolDeps,
  type EnsureK3sHostConfig,
} from "./ensure-k3s.js";
import { __mintVerifiedCredentialForTest } from "../capability.js";
import {
  passThroughGate,
  type ReconcileGate,
} from "../../reconciler/reconcile.js";
import {
  k3sIdentityKey,
  type EnsureK3sProvider,
  type EnsureK3sApplyResult,
} from "../../providers/v2/ensure-k3s.js";
import type { EnsureK3s } from "../../domain/entities-v2.js";
import type { ObservedEntity } from "../../providers/provider.js";
import { appendEvent } from "../../store/state-events.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../../test/fakes/pg-harness.js";
import { runMigrations } from "../../store/db.js";

// ---------------------------------------------------------------------------
// Fixtures + fakes
// ---------------------------------------------------------------------------

const INPUT = {
  host: "k3s-server-1",
  version: "v1.30.2+k3s1",
  role: "server",
};

/** A SERVER-SIDE host config — the credential/key never travels in tool input. */
const HOST_CONFIG: EnsureK3sHostConfig = {
  host: "k3s-server-1",
};

/** A spy provider: records apply calls so a deny path can assert zero applies. */
function makeFakeProvider(result?: EnsureK3sApplyResult): {
  provider: EnsureK3sProvider;
  applies: EnsureK3s[];
} {
  const applies: EnsureK3s[] = [];
  const provider: EnsureK3sProvider = {
    name: "ensure-k3s-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(desired: EnsureK3s): Promise<EnsureK3sApplyResult> {
      applies.push(desired);
      return result ?? { entity: `k3s:${desired.host}`, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
  return { provider, applies };
}

interface DepsParts {
  applies: EnsureK3s[];
}

function makeDeps(
  overrides: Partial<EnsureK3sToolDeps> = {},
  result?: EnsureK3sApplyResult,
): { deps: EnsureK3sToolDeps; parts: DepsParts } {
  const fake = makeFakeProvider(result);
  const accounting: DepsParts = { applies: fake.applies };
  const base: EnsureK3sToolDeps = {
    resolveHost: async (host: string): Promise<EnsureK3sHostConfig> => {
      if (host !== HOST_CONFIG.host) throw new Error("unknown host");
      return HOST_CONFIG;
    },
    getEnsureK3sProvider: () => fake.provider,
    approvalGate: passThroughGate,
  };
  return { deps: { ...base, ...overrides }, parts: accounting };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ensureK3s — capability gate (deny-before-write)", () => {
  it("credential without ensure_k3s cap → 403-class error envelope; NO apply", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "resolve_selector",
    ]);
    const { deps, parts } = makeDeps();
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("fatal");
    expect(env.error?.message).toMatch(/ensure_k3s/);
    // Deny-before-write: nothing applied.
    expect(parts.applies).toHaveLength(0);
  });
});

describe("ensureK3s — input parse (precondition)", () => {
  it("invalid input (empty host) → error envelope precondition, value-free", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps, parts } = makeDeps();
    const env = await ensureK3s(
      { ...INPUT, host: "" } as unknown as EnsureK3s,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    // Value-free: never echo the input values.
    expect(env.error?.message).not.toMatch(/k3s1|v1\.30/);
    expect(parts.applies).toHaveLength(0);
  });

  it("unknown extra key rejected by .strict() schema → precondition; NO apply", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps, parts } = makeDeps();
    const env = await ensureK3s(
      { ...INPUT, command: "rm -rf /" } as unknown as EnsureK3s,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    expect(parts.applies).toHaveLength(0);
  });
});

describe("ensureK3s — always-sensitive Approval Gate", () => {
  it("every invocation consults the gate's evaluate()", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    let gateCalls = 0;
    let seenItems = 0;
    const countingGate: ReconcileGate = {
      name: "counting",
      async evaluate(items) {
        gateCalls += 1;
        seenItems = items.length;
        return { approved: [...items], denied: [] };
      },
    };
    const { deps } = makeDeps({ approvalGate: countingGate });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(gateCalls).toBe(1); // EVERY call routes through evaluate
    expect(seenItems).toBe(1);
    expect(env.status).toBe("applied");
  });

  it("gate denial → pending_approval envelope; NO apply (fail-safe)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const denyOnceGate: ReconcileGate = {
      name: "deny-once",
      async evaluate(items) {
        return {
          approved: [],
          denied: items,
          pendingApprovals: items.map((it, i) => ({
            op: it.op,
            entity: it.entity,
            approvalId: `apr_${i}`,
          })),
        };
      },
    };
    const { deps, parts } = makeDeps({ approvalGate: denyOnceGate });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBe("apr_0");
    // A pending approval NEVER mutates the host.
    expect(parts.applies).toHaveLength(0);
  });

  it("approval → apply runs against the resolved host's provider", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps, parts } = makeDeps(); // passThroughGate approves
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(parts.applies).toHaveLength(1);
    expect(parts.applies[0]?.host).toBe("k3s-server-1");
  });
});

describe("ensureK3s — apply outcome surfacing", () => {
  it("changed:true install → applied envelope with the op changed:true", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps } = makeDeps(undefined, {
      entity: "k3s:k3s-server-1",
      changed: true,
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("applied");
    const op = (env.plan?.ops ?? [])[0] as
      | { changed: boolean; result?: string }
      | undefined;
    expect(op?.changed).toBe(true);
    expect(op?.result).toBeUndefined();
  });

  it("changed:false converged no-op → applied envelope, op changed:false, no drift", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps } = makeDeps(undefined, {
      entity: "k3s:k3s-server-1",
      changed: false,
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("applied");
    const op = (env.plan?.ops ?? [])[0] as
      | { changed: boolean; result?: string }
      | undefined;
    expect(op?.changed).toBe(false);
    expect(op?.result).toBeUndefined();
  });

  it("result:'drift' (version divergence, Q-a) → applied envelope surfacing result:'drift'", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps } = makeDeps(undefined, {
      entity: "k3s:k3s-server-1",
      changed: false,
      result: "drift",
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    // Q-a: NEVER auto-upgrade; the divergence is surfaced as a drift result
    // (value-free) but is not a transport failure ⇒ status stays "applied".
    expect(env.status).toBe("applied");
    const op = (env.plan?.ops ?? [])[0] as
      | { changed: boolean; result?: string }
      | undefined;
    expect(op?.changed).toBe(false);
    expect(op?.result).toBe("drift");
  });
});

describe("ensureK3s — Q-c host resolution keeps the credential out of input", () => {
  it("the host ref is resolved server-side via deps.resolveHost(host)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const resolved: string[] = [];
    const { deps } = makeDeps({
      resolveHost: async (host: string): Promise<EnsureK3sHostConfig> => {
        resolved.push(host);
        return HOST_CONFIG;
      },
    });
    await ensureK3s(INPUT, { credential: cred, scope: "server" }, deps);
    // The ONLY host identity that crosses is the named ref from the input;
    // the SSH key / config is resolved server-side, never present in `input`.
    expect(resolved).toEqual(["k3s-server-1"]);
  });

  it("unknown host ref → error envelope; NO apply", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", ["ensure_k3s"]);
    const { deps, parts } = makeDeps({
      resolveHost: async (): Promise<EnsureK3sHostConfig> => {
        throw new Error("unknown host");
      },
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(parts.applies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StateEvent on apply (Task 25, ground rule #5) — DB-backed via pg-harness.
//
// ensure_k3s installs k3s on the live host on the approved-apply path, so it
// MUST emit ONE StateEvent — actor sourced from the verified credential
// (state-event-actor.md). The payload is SECRET-FREE and VALUE-FREE: identity +
// the install outcome (`changed` / value-free `result:"drift"`). For the
// version-divergence DRIFT branch (Q-a) it records the drift OUTCOME only — NO
// version string is ever copied (do NOT leak versions; mirror the value-free
// drift representation the provider already exposes). deny/pending/precondition/
// parse paths emit NOTHING (only the successful apply emits).
// ---------------------------------------------------------------------------

describe("ensureK3s — StateEvent on apply (Task 25, DB-backed)", () => {
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

  function dbDeps(
    overrides: Partial<EnsureK3sToolDeps> = {},
    result?: EnsureK3sApplyResult,
  ): EnsureK3sToolDeps {
    const { deps } = makeDeps(
      {
        pool,
        appendEvent: async (p, event): Promise<void> => {
          await appendEvent(p as pg.Pool, event);
        },
        ...overrides,
      },
      result,
    );
    return deps;
  }

  it("approved install (changed:true) emits exactly ONE StateEvent with the credential's actor + value-free payload", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", ["ensure_k3s"]);
    const deps = dbDeps(undefined, {
      entity: "k3s:k3s-server-1",
      changed: true,
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("applied");

    const ev = await pool.query<{
      actor: string;
      scope: string;
      op: string;
      entity: string;
      result: string;
      after: unknown;
    }>(
      "SELECT actor, scope, op, entity, result, after FROM state_events ORDER BY seq DESC",
    );
    expect(ev.rows).toHaveLength(1);
    const row = ev.rows[0]!;
    expect(row.actor).toBe("agent:vox");
    expect(row.scope).toBe("server");
    expect(row.op).toBe("create");
    expect(row.entity).toBe(k3sIdentityKey(INPUT as EnsureK3s));
    expect(row.result).toBe("applied");
    const after = row.after as Record<string, unknown>;
    expect(after.changed).toBe(true);
    expect(after.capability_token_id).toBeNull();
    // VALUE-FREE: the desired/observed version strings NEVER reach the payload.
    expect(JSON.stringify(row.after)).not.toContain("v1.30");
    expect(JSON.stringify(row.after)).not.toContain("k3s1");
  });

  it("version-divergence (result:'drift', Q-a) records the drift outcome value-free — NO version in the payload", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", ["ensure_k3s"]);
    const deps = dbDeps(undefined, {
      entity: "k3s:k3s-server-1",
      changed: false,
      result: "drift",
    });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("applied");

    const ev = await pool.query<{ result: string; after: unknown }>(
      "SELECT result, after FROM state_events ORDER BY seq DESC",
    );
    expect(ev.rows).toHaveLength(1);
    const row = ev.rows[0]!;
    const after = row.after as Record<string, unknown>;
    // Record the value-free drift marker; NEVER changed:true, NEVER a version.
    expect(after.result).toBe("drift");
    expect(after.changed).toBe(false);
    expect(JSON.stringify(row.after)).not.toContain("v1.30");
    expect(JSON.stringify(row.after)).not.toContain("k3s1");
  });

  it("deny-before-write (out-of-scope credential) emits ZERO StateEvents", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      "resolve_selector",
    ]);
    const deps = dbDeps();
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("error");
    const n = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(n.rows[0].n).toBe(0);
  });

  it("gate denial (pending_approval) emits ZERO StateEvents (fail-safe)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", ["ensure_k3s"]);
    const denyOnceGate: ReconcileGate = {
      name: "deny-once",
      async evaluate(items) {
        return {
          approved: [],
          denied: items,
          pendingApprovals: items.map((it, i) => ({
            op: it.op,
            entity: it.entity,
            approvalId: `apr_${i}`,
          })),
        };
      },
    };
    const deps = dbDeps({ approvalGate: denyOnceGate });
    const env = await ensureK3s(
      INPUT,
      { credential: cred, scope: "server" },
      deps,
    );
    expect(env.status).toBe("pending_approval");
    const n = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(n.rows[0].n).toBe(0);
  });
});
