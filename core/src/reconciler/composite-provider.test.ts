/**
 * core/src/reconciler/composite-provider.test.ts
 *
 * Spec docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md §2
 * (Mudança B — tolerant meta-scope):
 *
 *   composite.observe("manifest") MUST tolerate a per-backend observe()
 *   failure. The meta-scope is the UNION of every reachable backend's native
 *   observe; an unreachable backend (e.g. Docker with placeholder SSH_HOST
 *   in a k3s deploy) MUST NOT propagate up — the apply path is fail-safe by
 *   construction (drift detection of the offline backend remains the periodic
 *   reconcile cycle's responsibility, the canonical drift channel — cf. v1 §5).
 *
 *   On a per-backend throw the visit emits ONE structured `console.warn`
 *   carrying { subsystem: "composite-meta-scope", kind, error } and continues
 *   visiting the next backend. The warn is VALUE-FREE (cite spec §4 #4 —
 *   secrets at apply only): NEVER `err.message` (an upstream HTTP/SSH error
 *   body may carry a token); only `err.name` or constructor name.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

import { compositeProvider } from "./composite-provider.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "../providers/provider.js";

// ---------------------------------------------------------------------------
// Helpers — minimal Provider doubles (no fake imports, no I/O)
// ---------------------------------------------------------------------------

function makeFakeProvider(
  name: string,
  entities: readonly string[] = [],
): Provider {
  return {
    name,
    async observe(scope: string): Promise<ObservedSlice> {
      return {
        scope,
        entities: [...entities].map((k) => ({
          key: k,
          payload: { name: k.slice(k.lastIndexOf(":") + 1) },
        })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      return { entity: action.entity, op: action.op, changed: false };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

function makeThrowingObserveProvider(name: string, message: string): Provider {
  return {
    name,
    async observe(): Promise<ObservedSlice> {
      throw new Error(message);
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      return { entity: action.entity, op: action.op, changed: false };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compositeProvider.observe('manifest') — tolerant meta-scope (spec 2026-05-26 §2)", () => {
  it("tolerates a per-backend observe() failure: returns union of the OTHER backends' entities, emits one structured warn, NEVER throws", async () => {
    // Capture console.warn (single canonical warn channel for the composite,
    // which has no logger seam today — see spec §2 follow-up note).
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const network = makeFakeProvider("hetzner-cloud-net", ["network:n-a"]);
    const host = makeFakeProvider("hetzner-cloud-srv", ["server:app-1"]);
    const volume = makeFakeProvider("hetzner-cloud-vol", ["volume:v-pg"]);
    // The Docker provider in the k3s scenario: SSH placeholder ⇒ throw on observe.
    // The error message includes the sentinel-style string to prove we DO NOT
    // forward it into the warn (avoiding accidental secret leakage).
    const service = makeThrowingObserveProvider(
      "docker",
      "ssh: connection failed (test sentinel: must-never-leak)",
    );

    const provider = compositeProvider({
      network,
      server: [host],
      volume,
      service,
    });

    // Must NOT throw — the meta-scope union continues past the throwing backend.
    const slice = await provider.observe("manifest");

    expect(slice.scope).toBe("manifest");
    // Returns the union of every backend that DID succeed.
    expect(slice.entities.map((e) => e.key).sort()).toEqual(
      ["network:n-a", "server:app-1", "volume:v-pg"].sort(),
    );

    // Exactly one structured warn — value-free (no err.message).
    expect(warn).toHaveBeenCalledTimes(1);
    const [arg] = warn.mock.calls[0]!;
    expect(typeof arg).toBe("string");
    const parsed = JSON.parse(arg as string) as Record<string, unknown>;
    expect(parsed.subsystem).toBe("composite-meta-scope");
    expect(parsed.kind).toBe("service");
    // Must NOT echo the upstream error message (which may carry secret material).
    expect(arg as string).not.toContain("must-never-leak");
    expect(arg as string).not.toContain("ssh: connection failed");
    // Actionable message present.
    expect(typeof parsed.msg).toBe("string");
    expect((parsed.msg as string).length).toBeGreaterThan(0);
  });
});

describe("compositeProvider.observe — enriched union dedups by key, first-wins (task 6)", () => {
  function providerWithEntity(name: string, key: string, payload: unknown): Provider {
    return {
      name,
      async observe(scope: string): Promise<ObservedSlice> {
        return { scope, entities: [{ key, payload }] };
      },
      async apply(action: PlanAction): Promise<ApplyResult> {
        return { entity: action.entity, op: action.op, changed: false };
      },
      async verify(): Promise<boolean> {
        return true;
      },
    };
  }

  it("two backends surfacing the SAME key ⇒ ONE entry carrying the FIRST backend's payload", async () => {
    const first = providerWithEntity("first", "server:app-1", { name: "app-1", type: "first" });
    const second = providerWithEntity("second", "server:app-1", { name: "app-1", type: "second" });
    const provider = compositeProvider({
      network: providerWithEntity("net", "network:n", { name: "n" }),
      server: [first, second], // both own the server scope
      volume: providerWithEntity("vol", "volume:v", { name: "v" }),
    });

    const slice = await provider.observe("server");
    const appEntries = slice.entities.filter((e) => e.key === "server:app-1");
    expect(appEntries).toHaveLength(1); // deduped
    expect((appEntries[0]!.payload as { type: string }).type).toBe("first"); // first-wins
  });

  it("distinct keys across backends ⇒ all present", async () => {
    const a = providerWithEntity("a", "server:a", { name: "a" });
    const b = providerWithEntity("b", "server:b", { name: "b" });
    const provider = compositeProvider({
      network: providerWithEntity("net", "network:n", { name: "n" }),
      server: [a, b],
      volume: providerWithEntity("vol", "volume:v", { name: "v" }),
    });
    const slice = await provider.observe("server");
    expect(slice.entities.map((e) => e.key).sort()).toEqual(["server:a", "server:b"]);
  });
});
