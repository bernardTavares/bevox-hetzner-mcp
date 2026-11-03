/**
 * core/src/reconciler/observed-adapter.test.ts
 *
 * Task 5 (spec 2026-06-02-observed-state-adapter §1.2): the PURE observed
 * adapter `(slice) => State`. Validates each entity payload against the
 * entities.ts Zod schema for its kind, pushes valid objects into the matching
 * collection, and SKIPS (never throws — Q3) any payload that fails. The result
 * always satisfies StateSchema.parse (degrade-safe, L4).
 */

import { describe, it, expect } from "vitest";
import { observedAdapter } from "./observed-adapter.js";
import { StateSchema } from "../domain/entities.js";
import type { ObservedSlice } from "../providers/provider.js";

const SERVER = {
  name: "bevox-prod-1",
  type: "cpx22",
  location: "nbg1",
  image: "ubuntu-24.04",
  ssh_keys: [],
  labels: {},
  network: "bevox-priv",
};
const NETWORK = { name: "bevox-priv", ip_range: "10.0.0.0/16", subnets: ["10.0.1.0/24"] };
const VOLUME = { name: "pg-data", size: "20Gi", fs: "ext4" };
const SERVICE = { name: "backend", image: "ghcr.io/x:v1", replicas: 1 };

describe("observedAdapter", () => {
  it("maps a multi-kind slice into a Zod-valid State", () => {
    const slice: ObservedSlice = {
      scope: "manifest",
      entities: [
        { key: "server:bevox-prod-1", payload: SERVER },
        { key: "network:bevox-priv", payload: NETWORK },
        { key: "volume:pg-data", payload: VOLUME },
        { key: "service:backend", payload: SERVICE },
      ],
    };
    const state = observedAdapter(slice);
    expect(state.servers.map((s) => s.name)).toEqual(["bevox-prod-1"]);
    expect(state.networks.map((n) => n.name)).toEqual(["bevox-priv"]);
    expect(state.volumes.map((v) => v.name)).toEqual(["pg-data"]);
    expect(state.services.map((s) => s.name)).toEqual(["backend"]);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  it("degrade-safe: a malformed payload is SKIPPED; valid siblings survive; no throw", () => {
    const slice: ObservedSlice = {
      scope: "server",
      entities: [
        { key: "server:good", payload: SERVER },
        { key: "server:bad", payload: { name: "bad" } }, // missing required fields
        { key: "server:null", payload: null },
      ],
    };
    const state = observedAdapter(slice);
    expect(state.servers.map((s) => s.name)).toEqual(["bevox-prod-1"]);
    expect(StateSchema.safeParse(state).success).toBe(true);
  });

  it("skips an entity whose key has an unknown kind prefix", () => {
    const slice: ObservedSlice = {
      scope: "manifest",
      entities: [
        { key: "firewall:edge", payload: { name: "edge" } },
        { key: "service:backend", payload: SERVICE },
      ],
    };
    const state = observedAdapter(slice);
    expect(state.services.map((s) => s.name)).toEqual(["backend"]);
    // no collection grew from the unknown kind
    expect(state.servers).toEqual([]);
  });

  it("is deterministic: the same slice yields a deeply-equal State", () => {
    const slice: ObservedSlice = {
      scope: "manifest",
      entities: [{ key: "service:backend", payload: SERVICE }],
    };
    expect(observedAdapter(slice)).toEqual(observedAdapter(slice));
  });

  it("empty slice → empty State (StateSchema-valid)", () => {
    const state = observedAdapter({ scope: "server", entities: [] });
    expect(StateSchema.safeParse(state).success).toBe(true);
    expect(state.servers).toEqual([]);
  });

  it("BLOCO-E regression lock (Task 19): k3s: key is skipped degrade-safe; v1 State is NOT corrupted", () => {
    // A `k3s:` key carries a Bloco E host spec payload.
    // The adapter does NOT have a `k3s` entry in KIND_TABLE — it is reconciled per-entity via
    // KubernetesProvider-family verify(), NOT via this v1 State snapshot.
    // This test LOCKS the intentional degrade-safe SKIP: a future developer who adds a half-baked
    // `k3s` KIND_TABLE entry pointing at a v1 collection (e.g. "servers") will break this test
    // immediately — the k3s entity would land as a Server named "prod-host" and flip the
    // `toBe(false)` assertion below.
    //
    // Red-proof (verified locally, not committed): temporarily adding
    //   k3s: { schema: ServerSchema, collection: "servers" }
    // to KIND_TABLE and using a server-schema-compatible payload causes this test to FAIL with
    // "expected true to be false" — confirming the lock is genuine, not vacuous.
    //
    // We use a payload that matches ServerSchema so the schema-validation guard does NOT rescue
    // a mistaken KIND_TABLE addition (i.e. the lock fires at the collection-routing level).
    const k3sPayload = {
      // Valid ServerSchema shape — so if KIND_TABLE were extended with k3s→servers,
      // this would land as a Server named "prod-host" and the assertion below would fail.
      name: "prod-host",
      type: "cpx22",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      network: "bevox-priv",
    };
    const slice: ObservedSlice = {
      scope: "manifest",
      entities: [
        // A k3s entity (Bloco E) alongside a valid v1 server entity — proving coexistence.
        { key: "k3s:prod-host", payload: k3sPayload },
        { key: "server:bevox-prod-1", payload: SERVER },
      ],
    };

    // Must not throw.
    const state = observedAdapter(slice);

    // The k3s entry must NOT land in any v1 collection.
    expect(state.servers.some((s) => s.name === "prod-host")).toBe(false);
    expect(state.networks).toEqual([]);
    expect(state.volumes).toEqual([]);
    expect(state.services).toEqual([]);
    expect(state.dns).toEqual([]);
    expect(state.backups).toEqual([]);

    // The valid v1 server entry still landed correctly (coexistence).
    expect(state.servers.map((s) => s.name)).toEqual(["bevox-prod-1"]);

    // The resulting State must always satisfy StateSchema (degrade-safe guarantee).
    expect(StateSchema.parse(state)).toBeDefined();
  });

  it("BLOCO-E regression lock: kube: key is skipped degrade-safe; v1 State is NOT corrupted", () => {
    // A `kube:` key carries a Bloco E projection payload (what KubernetesProvider.observe returns).
    // The adapter does NOT have a `kube` entry in KIND_TABLE — it is reconciled per-entity via
    // KubernetesProvider.verify(), NOT via this v1 State snapshot.
    // This test LOCKS the intentional degrade-safe SKIP: a future developer who adds a half-baked
    // `kube` KIND_TABLE entry pointing at a v1 collection will break this test immediately.
    const kubePayload = {
      apiVersion: "apps/v1",
      kind: "Deployment",
      namespace: "bevox",
      name: "api",
      manifestHash: "sha256:abc123",
    };
    const slice: ObservedSlice = {
      scope: "manifest",
      entities: [
        // A kube entity (Bloco E) alongside a valid v1 server entity — proving coexistence.
        { key: "kube:prod-k3s/bevox/Deployment/api", payload: kubePayload },
        { key: "server:bevox-prod-1", payload: SERVER },
      ],
    };

    // Must not throw.
    const state = observedAdapter(slice);

    // The kube entry must NOT land in any v1 collection.
    expect(state.servers.some((s) => s.name === "api")).toBe(false);
    expect(state.networks).toEqual([]);
    expect(state.volumes).toEqual([]);
    expect(state.services).toEqual([]);
    expect(state.dns).toEqual([]);
    expect(state.backups).toEqual([]);

    // The valid v1 server entry still landed correctly (coexistence).
    expect(state.servers.map((s) => s.name)).toEqual(["bevox-prod-1"]);

    // The resulting State must always satisfy StateSchema (degrade-safe guarantee).
    expect(StateSchema.parse(state)).toBeDefined();
  });
});
