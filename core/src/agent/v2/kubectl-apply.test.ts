/**
 * core/src/agent/v2/kubectl-apply.test.ts
 *
 * Bloco E Task 14 — TDD teeth for `kubectl_apply` (v2 write tool, the Phase 1
 * capstone). Asserts on the single `kubectlApply(input, ctx, deps)` function,
 * the shared core for the REST `POST /api/v2/kube/apply` route and the MCP
 * `kubectl_apply` tool call.
 *
 * Mirrors `run-migrations.test.ts` build-up:
 *
 *   - capability gate (deny-before-write): an out-of-scope credential
 *     short-circuits the path — no parse, no host resolution, no namespace
 *     precondition, no gate, no apply, no StateEvent;
 *   - input parse via the FROZEN `KubeManifestSchema` (value-free precondition);
 *   - Q-c: the named `host` resolves to a SERVER-SIDE SSH/provider config via a
 *     deps seam (the credential is NEVER in the tool input);
 *   - Q-d: the target namespace MUST exist BEFORE apply — a missing namespace is
 *     a precondition error (never created), checked BEFORE the always-sensitive
 *     gate (a pending_approval path NEVER touches the cluster);
 *   - always-sensitive Approval Gate: EVERY invocation consults `evaluate`; a
 *     denial ⇒ `pending_approval` envelope; an approval ⇒ apply runs;
 *   - actor sourced from the verified credential (state-event-actor.md);
 *   - NO throw — every failure becomes a contract-shaped v2 error envelope.
 *
 * Spec: docs/specs/2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 14)
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import type pg from "pg";
import {
  kubectlApply,
  type KubectlApplyDeps,
  type KubeHostConfig,
} from "./kubectl-apply.js";
import { __mintVerifiedCredentialForTest } from "../capability.js";
import { passThroughGate, type ReconcileGate } from "../../reconciler/reconcile.js";
import {
  kubeIdentityKey,
  manifestHash,
  type KubernetesProvider,
  type KubeApplyResult,
} from "../../providers/v2/kube-apply.js";
import type { KubeManifest } from "../../domain/entities-v2.js";
import type { ObservedEntity } from "../../providers/provider.js";
import type { ApplyContext } from "../../store/secrets.js";
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

const MANIFEST = {
  host: "k3s-server-1",
  apiVersion: "v1",
  kind: "ConfigMap",
  metadata: { name: "demo" },
  namespace: "bevox",
  body: "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n",
};

/** A SERVER-SIDE host config — the credential/key never travels in tool input. */
const HOST_CONFIG: KubeHostConfig = {
  host: "k3s-server-1",
};

/** A spy provider: records apply calls so a deny path can assert zero applies. */
function makeFakeProvider(): {
  provider: KubernetesProvider;
  applies: KubeManifest[];
} {
  const applies: KubeManifest[] = [];
  const provider: KubernetesProvider = {
    name: "kubernetes-fake",
    async observe(): Promise<ObservedEntity | null> {
      return null;
    },
    async apply(
      desired: KubeManifest,
      _observed: ObservedEntity | null,
      _ctx?: ApplyContext,
    ): Promise<KubeApplyResult> {
      applies.push(desired);
      return { entity: `kube:${desired.host}`, changed: true };
    },
    async verify(): Promise<boolean> {
      return true;
    },
    async destroy(desired: KubeManifest): Promise<KubeApplyResult> {
      return { entity: `kube:${desired.host}`, changed: true };
    },
  };
  return { provider, applies };
}

interface DepsParts {
  applies: KubeManifest[];
  gateCalls: number;
  /** namespaces the deps seam reports as EXISTING. */
  namespaces: string[];
}

function makeDeps(
  overrides: Partial<KubectlApplyDeps> = {},
  parts: Partial<DepsParts> = {},
): { deps: KubectlApplyDeps; parts: DepsParts } {
  const fake = makeFakeProvider();
  const accounting: DepsParts = {
    applies: fake.applies,
    gateCalls: 0,
    namespaces: parts.namespaces ?? ["bevox"],
  };
  const base: KubectlApplyDeps = {
    resolveHost: async (host: string): Promise<KubeHostConfig> => {
      if (host !== HOST_CONFIG.host) throw new Error("unknown host");
      return HOST_CONFIG;
    },
    getProvider: () => fake.provider,
    namespaceExists: async (_cfg, ns): Promise<boolean> =>
      accounting.namespaces.includes(ns),
    approvalGate: passThroughGate,
    makeApplyContext: () => ({}) as unknown as ApplyContext,
  };
  return { deps: { ...base, ...overrides }, parts: accounting };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("kubectlApply — capability gate (deny-before-write)", () => {
  it("credential without kubectl_apply cap → 403-class error envelope; NO apply", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "resolve_selector",
    ]);
    const { deps, parts } = makeDeps();
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("fatal");
    expect(env.error?.message).toMatch(/kubectl_apply/);
    // Deny-before-write: nothing applied, gate never consulted.
    expect(parts.applies).toHaveLength(0);
    expect(parts.gateCalls).toBe(0);
  });
});

describe("kubectlApply — input parse (precondition)", () => {
  it("invalid manifest (empty host) → error envelope precondition, value-free", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
    const { deps, parts } = makeDeps();
    const env = await kubectlApply(
      { ...MANIFEST, host: "" } as unknown as KubeManifest,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    // Value-free: never echo the manifest body / names.
    expect(env.error?.message).not.toMatch(/ConfigMap|demo|apiVersion/);
    expect(parts.applies).toHaveLength(0);
  });
});

describe("kubectlApply — Q-d namespace precondition (before the gate)", () => {
  it("missing namespace → precondition envelope; namespace NEVER created; gate NOT consulted", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
    let gateCalls = 0;
    const countingGate: ReconcileGate = {
      name: "counting",
      async evaluate(items) {
        gateCalls += 1;
        return { approved: [...items], denied: [] };
      },
    };
    const { deps, parts } = makeDeps(
      { approvalGate: countingGate },
      { namespaces: [] }, // namespace "bevox" is ABSENT
    );
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(env.error?.code).toBe("precondition");
    // Namespace never created (no apply), and the precondition is checked
    // BEFORE the always-sensitive gate (fail-safe — no cluster mutation, no
    // approval row).
    expect(parts.applies).toHaveLength(0);
    expect(gateCalls).toBe(0);
  });
});

describe("kubectlApply — always-sensitive Approval Gate", () => {
  it("every invocation consults the gate's evaluate()", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
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
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(gateCalls).toBe(1); // EVERY call routes through evaluate
    expect(seenItems).toBe(1);
    expect(env.status).toBe("applied");
  });

  it("gate denial → pending_approval envelope; NO apply (fail-safe)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
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
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("pending_approval");
    expect(env.approval_id).toBe("apr_0");
    // A pending approval NEVER mutates the cluster.
    expect(parts.applies).toHaveLength(0);
  });

  it("approval → apply runs against the resolved host's provider", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
    const { deps, parts } = makeDeps(); // passThroughGate approves
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("applied");
    expect(parts.applies).toHaveLength(1);
    expect(parts.applies[0]?.host).toBe("k3s-server-1");
  });
});

describe("kubectlApply — Q-c host resolution keeps the credential out of input", () => {
  it("the host ref is resolved server-side via deps.resolveHost(host)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
    const resolved: string[] = [];
    const { deps } = makeDeps({
      resolveHost: async (host: string): Promise<KubeHostConfig> => {
        resolved.push(host);
        return HOST_CONFIG;
      },
    });
    await kubectlApply(MANIFEST, { credential: cred, scope: "service" }, deps);
    // The ONLY host identity that crosses is the named ref from the manifest;
    // the SSH key / config is resolved server-side, never present in `input`.
    expect(resolved).toEqual(["k3s-server-1"]);
  });

  it("unknown host ref → error envelope; NO apply", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:test", [
      "kubectl_apply",
    ]);
    const { deps, parts } = makeDeps({
      resolveHost: async (): Promise<KubeHostConfig> => {
        throw new Error("unknown host");
      },
    });
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    expect(parts.applies).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// StateEvent on apply (Task 25, ground rule #5) — DB-backed via pg-harness.
//
// Every mutation that converges desired→observed MUST emit ONE StateEvent
// with the actor sourced from the verified credential (state-event-actor.md).
// kubectl_apply mutates the live cluster on the approved-apply path, so it
// MUST append exactly ONE StateEvent — mirroring set-firewall.ts (the only
// successful apply emits; deny/pending/precondition/parse emit nothing) and a
// SECRET-FREE payload (identity + manifest-hash; NEVER the manifest body, NEVER
// a resolved secret — mirrors observe's minimal projection).
// ---------------------------------------------------------------------------

describe("kubectlApply — StateEvent on apply (Task 25, DB-backed)", () => {
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

  it("approved apply emits exactly ONE StateEvent with the credential's actor + secret-free payload", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", ["kubectl_apply"]);
    const { deps } = makeDeps({
      pool,
      appendEvent: async (p, event): Promise<void> => {
        await appendEvent(p as pg.Pool, event);
      },
    });
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
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
    // Exactly ONE mutation event for this apply.
    expect(ev.rows).toHaveLength(1);
    const row = ev.rows[0]!;
    // Actor is sourced from the verified credential — never synthesised.
    expect(row.actor).toBe("agent:vox");
    expect(row.scope).toBe("service");
    expect(row.op).toBe("create");
    expect(row.entity).toBe(kubeIdentityKey(MANIFEST as KubeManifest));
    expect(row.result).toBe("applied");
    // Secret-free payload: identity + manifest-hash only. capability_token_id
    // null in Bloco-A posture (mirrors set-firewall). NEVER the manifest body.
    const after = row.after as Record<string, unknown>;
    expect(after.manifest_hash).toBe(manifestHash(MANIFEST.body));
    expect(after.capability_token_id).toBeNull();
    // No manifest body / secret / names leak into the persisted payload.
    expect(JSON.stringify(row.after)).not.toContain("apiVersion: v1");
    expect(JSON.stringify(row.after)).not.toContain("secret:");
  });

  it("deny-before-write (out-of-scope credential) emits ZERO StateEvents", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", [
      "resolve_selector",
    ]);
    const { deps } = makeDeps({
      pool,
      appendEvent: async (p, event): Promise<void> => {
        await appendEvent(p as pg.Pool, event);
      },
    });
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("error");
    const n = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(n.rows[0].n).toBe(0);
  });

  it("gate denial (pending_approval) emits ZERO StateEvents (fail-safe)", async () => {
    const cred = __mintVerifiedCredentialForTest("agent:vox", ["kubectl_apply"]);
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
    const { deps } = makeDeps({
      pool,
      approvalGate: denyOnceGate,
      appendEvent: async (p, event): Promise<void> => {
        await appendEvent(p as pg.Pool, event);
      },
    });
    const env = await kubectlApply(
      MANIFEST,
      { credential: cred, scope: "service" },
      deps,
    );
    expect(env.status).toBe("pending_approval");
    const n = await pool.query("SELECT count(*)::int AS n FROM state_events");
    expect(n.rows[0].n).toBe(0);
  });
});
