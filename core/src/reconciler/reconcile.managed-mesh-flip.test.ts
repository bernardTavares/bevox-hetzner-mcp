/**
 * core/src/reconciler/reconcile.managed-mesh-flip.test.ts
 *
 * Task 5.1 — Q4 integration: drift on `MANAGED_MESH` on→off, NEVER deletes peers.
 *
 * Spec invariant under test (`docs/specs/2026-05-26-server-scope-transport-decoupling.md`
 * §4.3 + §5 row I3): when an operator flips `MANAGED_MESH` from "on" to "off"
 * on a deploy where managed WireGuard peers already exist, the reconciler:
 *
 *   - REMOVES WireGuard from `routes.server` for the NEXT cycle (the wiring
 *     contract — already covered mechanically by `entrypoint-wiring.test.ts`);
 *   - REPORTS the divergence between the prior observed surface (which
 *     included the mesh peer) and the new observed surface (no WG) as a drift
 *     StateEvent — informational, append-only, value-free;
 *   - NEVER invokes `wg-quick down` / `wg set ... remove` / any controller
 *     `removePeer()` call — the peer in the device's memory is left
 *     untouched. Cleanup, if desired by the operator, is manual out-of-band.
 *
 * This file is the SIBLING of `reconcile.services.test.ts` (Task 3.5). It
 * SHARES the same fakes-only rig pattern (Hetzner HTTP + WireGuard control +
 * pg-harness; ZERO real network/SSH/wg/Docker), and the SAME composite-provider
 * dispatch — but it constructs the composite TWICE within a single test
 * session against ONE Postgres pool: once with `routes.server = [hetznerCloud,
 * wireguard]` (Phase A, MANAGED_MESH="on"), once with
 * `routes.server = [hetznerCloud]` (Phase B, MANAGED_MESH="off"). The flip is
 * thus exercised on a SHARED state store (same `scope`, same observed-store
 * rows, same `state_events` log).
 *
 * What is asserted (every assertion has TEETH — never vacuous):
 *
 *   (a) Phase A: a single reconcile cycle converges; the WireGuard fake holds
 *       BOTH the derived mesh peer for the declared server (`wgpub:app-1`)
 *       AND a RESIDUAL managed peer (`wgpub:legacy-1`) from a previously
 *       decommissioned server. The residual peer surfaces in Phase A's
 *       observe (it lives in WG's managed namespace) and is an observed-side
 *       orphan vs desired in Phase A.
 *   (b) The composite is rebuilt with the WG route REMOVED — same pool, same
 *       desired manifest. The Phase-A peers remain in the fake device's
 *       memory (the device was not touched between phases).
 *   (c) Phase B: a single reconcile cycle runs against the new composite.
 *   (d) The observed-store for `scope="server"` is rewritten to reflect the
 *       new (no-WG) observe surface — the entity row count shrinks: the
 *       residual peer's `server:legacy-1` row is gone (full-replace semantics
 *       of `putState`), and only `server:app-1` (hetzner-sourced) remains.
 *   (e) A drift StateEvent exists in `state_events` naming the disappeared
 *       peer entity (`server:legacy-1`). The event's `result` is `"drift"`
 *       per the state_events writer convention; it never carries a mutating
 *       op ("remove"/"destroy" are forbidden in this flow).
 *   (f) The WireGuard controller fake recorded ZERO `removePeer()` calls
 *       across the ENTIRE test (Phase A + Phase B). Both Phase-A peers are
 *       still present in `wgFake.peers()` after Phase B. This is the
 *       fail-safe / never-fail-deleting tooth.
 *
 * THE WG-CONTROLLER INVOCATION TALLY (assertion f). The existing WireGuard
 * control fake (`core/test/fakes/wireguard-control.ts`) does NOT expose a
 * per-method invocation counter (its scope was set-peer + list-peer only). To
 * keep this test infrastructure-only addition truly minimal — and to keep the
 * fake untouched (its existing callers are byte-stable) — this file WRAPS the
 * fake's controller in a tiny in-test counting proxy that delegates every
 * call to the real fake while tallying invocations per method. The proxy is
 * defined inline below; it is NOT a global, it is NOT a new export from the
 * fake, and it is scoped to ONE test rig.
 *
 * DB-touching via the pg harness; the proven barrier/finally discipline from
 * `reconcile.services.test.ts` is followed so this DB-suite test stays
 * deterministically green under the FULL `npm --prefix core test` (no leaked
 * pg client / advisory lock).
 *
 * Spec reference:  `docs/specs/2026-05-26-server-scope-transport-decoupling.md` §4.3, §5 (I3).
 * Plan reference:  `docs/superpowers/plans/2026-05-26-server-scope-transport-decoupling.md`
 *                  Fase 5 / Task 5.1.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type pg from "pg";

import { reconcile, passThroughGate } from "./reconcile.js";
import { compositeProvider } from "./composite-provider.js";
import { createHetznerCloudProvider } from "../providers/hetzner-cloud.js";
import { createWireGuardProvider, derivePeer } from "../providers/wireguard.js";
import { HttpClient } from "../providers/http-client.js";
import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import {
  createWireGuardControlFake,
  type WireGuardControlFake,
} from "../../test/fakes/wireguard-control.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type {
  ObservedSlice,
  PlanAction,
  ApplyResult,
  Provider,
} from "../providers/provider.js";
import type { WireGuardController } from "../providers/wireguard-transport.js";
import { queryEvents } from "../store/state-events.js";
import { getState as getObservedState } from "../store/observed-store.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { runMigrations } from "../store/db.js";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

// ---------------------------------------------------------------------------
// The shared desired manifest — same in both phases. The smallest manifest
// that exercises the server scope across the composite. No service / volume /
// dns / backup needed: this test isolates the `MANAGED_MESH` flip's effect on
// the server scope. Hetzner entity-schema fidelity (subnets, ssh_keys, labels,
// status) matches the Fase-3 precedent (see reconcile.services.test.ts notes).
// ---------------------------------------------------------------------------

const MANIFEST: DesiredState = {
  networks: [{ name: "mesh-net", ip_range: "10.20.0.0/16", subnets: [] }],
  servers: [
    {
      name: "app-1",
      type: "cx22",
      location: "nbg1",
      network: "mesh-net",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      status: "healthy",
    },
  ],
} as unknown as DesiredState;

// ---------------------------------------------------------------------------
// Observed adapter — the canonical inverse of plan.ts's "<kind>:<name>"
// keying. Mirrors reconcile.services.test.ts so the converged cross-backend
// reality round-trips to a State plan() diffs as all-`noop`.
// ---------------------------------------------------------------------------

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

function observedAdapter(slice: ObservedSlice): State {
  const networks: State["networks"] = [];
  const servers: State["servers"] = [];
  // A minimal placeholder shape for orphan entities not present in the
  // manifest — the observed-store schema validates ServerSchema, so every
  // surfaced `server:<name>` must round-trip a valid Server object. We reuse
  // the manifest entry when the name matches; otherwise synthesise a
  // schema-valid stand-in carrying the observed name. (No secret material,
  // no live fields — just enough to satisfy StateSchema.parse.)
  const placeholderServer = (name: string): State["servers"][number] =>
    ({
      name,
      type: "cx22",
      location: "nbg1",
      network: "mesh-net",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      status: "healthy",
    }) as unknown as State["servers"][number];
  for (const e of slice.entities) {
    const entityKey = e.key;
    const idx = entityKey.indexOf(":");
    const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
    const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
    if (kind === "network") {
      const m = MANIFEST.networks?.find((n) => n.name === name);
      if (m) networks.push(m as State["networks"][number]);
    } else if (kind === "server") {
      const m = MANIFEST.servers?.find((s) => s.name === name);
      // An entity surfaced by observe() that is NOT in the manifest is an
      // observed-side orphan (e.g. a residual WG peer). It MUST still be
      // recorded in observed-store so downstream drift detection can see it.
      servers.push(m ? (m as State["servers"][number]) : placeholderServer(name));
    }
  }
  return { ...EMPTY_STATE, networks, servers };
}

// ---------------------------------------------------------------------------
// Counting WG controller proxy — a tiny invocation tally that delegates every
// call to the underlying fake controller. Scoped per-rig (no global state),
// trivial implementation, structurally incapable of altering the fake's
// behaviour. The presence of `removePeerCount` is the SINGLE ASSERTION TOOTH
// that catches a regression introducing destructive cleanup.
// ---------------------------------------------------------------------------

interface CountingController {
  readonly controller: WireGuardController;
  listPeerCount(): number;
  setPeerCount(): number;
  removePeerCount(): number;
  /** Reset every counter (used between phases for clarity in the test). */
  resetCounts(): void;
}

function makeCountingController(
  inner: WireGuardController,
): CountingController {
  let listN = 0;
  let setN = 0;
  let removeN = 0;
  const controller: WireGuardController = {
    async listPeers() {
      listN += 1;
      return inner.listPeers();
    },
    async setPeer(peer) {
      setN += 1;
      return inner.setPeer(peer);
    },
    async removePeer(publicKey) {
      removeN += 1;
      return inner.removePeer(publicKey);
    },
  };
  return {
    controller,
    listPeerCount: () => listN,
    setPeerCount: () => setN,
    removePeerCount: () => removeN,
    resetCounts: () => {
      listN = 0;
      setN = 0;
      removeN = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Rig — shared Hetzner fake + shared WG fake (the on-device peer set persists
// across phases — the whole point of the flip test), plus a SINGLE counting
// proxy wrapping the WG controller for the lifetime of the test. The composite
// is rebuilt per phase via the `withRoute(...)` helper, holding the SAME pool.
// ---------------------------------------------------------------------------

interface Rig {
  pool: pg.Pool;
  hetznerFake: ReturnType<typeof createHetznerHttpFake>;
  wgFake: WireGuardControlFake;
  counts: CountingController;
  hetzner: Provider;
  wireguard: Provider;
  /** Build a fresh reconcile() trigger bound to the given route topology. */
  buildRunForRoutes(serverRoute: readonly Provider[]): (input: {
    scope: string;
    actor: string;
  }) => Promise<unknown>;
}

function makeRig(): Rig {
  const hetznerFake = createHetznerHttpFake();
  const wgFake = createWireGuardControlFake();
  const counts = makeCountingController(wgFake.controller);

  const hetzner = createHetznerCloudProvider({
    token: "test-token",
    http: new HttpClient({ fetchImpl: hetznerFake.fetch }),
  });
  const wireguard = createWireGuardProvider({ controller: counts.controller });

  function buildRunForRoutes(serverRoute: readonly Provider[]) {
    const provider = compositeProvider({
      network: hetzner,
      server: serverRoute, // the knob: [hetzner, wg] (on) | [hetzner] (off)
      volume: hetzner,
      service: hetzner, // unused in this test (no services declared)
    });
    return reconcile({
      pool,
      provider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => MANIFEST,
    });
  }

  return {
    pool,
    hetznerFake,
    wgFake,
    counts,
    hetzner,
    wireguard,
    buildRunForRoutes,
  };
}

// ---------------------------------------------------------------------------
// The single integration test — Phase A converges; Phase B flips MANAGED_MESH
// off and asserts (d)+(e)+(f). Phase B intentionally LEAVES Phase A's WG fake
// state in place: the on-device peer set must survive the flip untouched.
// ---------------------------------------------------------------------------

describe("5.1 — MANAGED_MESH on→off: drift reported, peers NEVER deleted (spec §4.3 / I3)", () => {
  it("emits a drift StateEvent for the orphaned peer and records ZERO removePeer calls across phases", async () => {
    const rig = makeRig();

    // Pre-seed a RESIDUAL managed peer to model "a previously decommissioned
    // server whose mesh peer was never cleaned up out-of-band". It lives in
    // the WG managed namespace (`wgpub:<name>`), so WG observe() surfaces it
    // as `server:legacy-1` — a Phase-A orphan vs desired. Phase B's observe
    // will no longer enumerate the WG device, so this entity DISAPPEARS from
    // the new observed surface — exactly the spec §4.3 transition the drift
    // signal must catch.
    rig.wgFake.seedPeer({
      publicKey: "wgpub:legacy-1",
      allowedIps: ["10.20.0.99/32"],
      tags: { "bevox.managed": "true" },
    });

    // ---- PHASE A — MANAGED_MESH="on": converge against [hetzner, wg]. ----
    const runOn = rig.buildRunForRoutes([rig.hetzner, rig.wireguard]);
    // The reconcile cycle plans for ONE scope at a time. We exercise both
    // `network` (to provision the network the server joins) and `server` (to
    // exercise the WG fan-out) — matching the Fase-3 multi-scope pattern.
    await runOn({ scope: "network", actor: "agent:vox" });
    await runOn({ scope: "server", actor: "agent:vox" });

    // TEETH (Phase A): the derived mesh peer IS on the device.
    const wantPeer = derivePeer({
      name: "app-1",
      type: "cx22",
      location: "nbg1",
      network: "mesh-net",
      image: "ubuntu-24.04",
      ssh_keys: [],
      labels: {},
      status: "healthy",
    });
    const peersA = rig.wgFake.peers();
    expect(
      peersA.some((p) => p.publicKey === wantPeer.publicKey),
      "Phase A converged: derived mesh peer is on the device",
    ).toBe(true);
    expect(
      peersA.some((p) => p.publicKey === "wgpub:legacy-1"),
      "Phase A pre-seeded: residual peer is on the device",
    ).toBe(true);

    // Snapshot the observed-store after Phase A — the union of hetzner +
    // wireguard observe slices should contain BOTH the managed server and
    // the residual peer (the WG provider surfaces managed-namespace peers as
    // `server:<name>` entities; the residual is an observed-side orphan).
    const observedA = await getObservedState(pool, "server");
    expect(
      observedA.servers.map((s) => s.name).sort(),
      "Phase A observed: server:app-1 + the residual peer's entity present",
    ).toEqual(["app-1", "legacy-1"]);

    // Sanity: Phase A set the peer at least once (so the counter tally has
    // teeth — a "zero removePeer" assertion would be vacuous if Phase A
    // itself never touched the device).
    expect(
      rig.counts.setPeerCount(),
      "Phase A: setPeer was called at least once (peer was programmed)",
    ).toBeGreaterThanOrEqual(1);
    expect(
      rig.counts.removePeerCount(),
      "Phase A: zero removePeer calls (no destructive op in convergence)",
    ).toBe(0);

    // Reset the counters at the phase boundary so Phase B's assertion isolates
    // ONLY the on→off flip's effect on the WG device.
    rig.counts.resetCounts();

    // Snapshot the drift StateEvents count BEFORE Phase B so assertion (e) is
    // PHASE-B-SPECIFIC: existing observed-side drift events recorded in
    // Phase A (the residual peer was an orphan vs desired under MANAGED_MESH=on,
    // so the legacy `detectDrift` already emitted events for it) must NOT
    // satisfy assertion (e) on their own. The Phase B cycle MUST contribute
    // at least one NEW drift event referencing the disappeared entity.
    const driftEventsBeforePhaseB = await queryEvents(pool, { result: "drift" });
    const driftCountBeforePhaseB = driftEventsBeforePhaseB.length;
    const phaseAdriftTimestamps = new Set(
      driftEventsBeforePhaseB.map((ev) => `${ev.ts}|${ev.entity}|${ev.op}`),
    );

    // ---- PHASE B — MANAGED_MESH="off": flip removes WG from routes.server. ----
    // SAME pool, SAME desired manifest, SAME WG fake device (peers untouched).
    // The composite is rebuilt with `[hetzner]` ONLY for the server scope.
    const runOff = rig.buildRunForRoutes([rig.hetzner]);

    // Run a single reconcile cycle on the server scope post-flip.
    const resultB = await runOff({ scope: "server", actor: "agent:vox" });
    // Defensive: the cycle acquired the lock and completed without failure
    // (the cycle must NOT crash; fail-safe).
    const r = resultB as {
      acquired: boolean;
      failed: { entity: string; op: string }[];
      recordFailures: { entity: string; op: string; message: string }[];
    };
    expect(r.acquired, "Phase B: cycle acquired the lock").toBe(true);
    expect(r.failed, "Phase B: zero apply failures").toEqual([]);
    expect(
      r.recordFailures,
      "Phase B: zero state-events record failures",
    ).toEqual([]);

    // (d) The observed-store reflects the new (no-WG) surface: only the
    // hetzner-sourced `server:app-1` row remains. The residual peer's
    // `server:legacy-1` row is gone (full-replace semantics of `putState`).
    const observedB = await getObservedState(pool, "server");
    expect(
      observedB.servers.map((s) => s.name).sort(),
      "Phase B observed: only server:app-1 (the residual peer's entity is gone)",
    ).toEqual(["app-1"]);

    // (f) THE FAIL-SAFE TOOTH — zero WG-device deletion calls across Phase B.
    // If a regression added a destructive code path (`wg-quick down`, `wg set
    // ... remove`, `removePeer(...)`) on the flip, this assertion catches it.
    expect(
      rig.counts.removePeerCount(),
      "Phase B: ZERO removePeer calls — the WG device is never touched on flip",
    ).toBe(0);

    // The Phase-A peers survive untouched in the device's memory: both the
    // managed mesh peer for `app-1` AND the residual `legacy-1`.
    const peersB = rig.wgFake.peers();
    expect(
      peersB.some((p) => p.publicKey === wantPeer.publicKey),
      "Phase B: the managed peer for app-1 survives in device memory",
    ).toBe(true);
    expect(
      peersB.some((p) => p.publicKey === "wgpub:legacy-1"),
      "Phase B: the residual peer survives in device memory (never deleted)",
    ).toBe(true);
    expect(
      peersB.length,
      "Phase B: device peer count is unchanged from Phase A",
    ).toBe(peersA.length);

    // (e) Drift StateEvent existence — PHASE-B-SPECIFIC: the spec invariant
    // (§4.3) requires that the transition is recorded as drift (informational,
    // never destructive). The drift events are the SINGLE place the operator
    // learns the residual peer disappeared from the observe surface even
    // though it remains on the device (Phase A had it; Phase B does not).
    //
    // We isolate Phase-B-only events by subtracting Phase-A's drift trail
    // (snapshotted just above). Any drift event recorded ONLY because the
    // existing observed-side detector flagged the residual peer as an orphan
    // vs desired under MANAGED_MESH=on is in the pre-snapshot — it does NOT
    // by itself satisfy this assertion. Phase B must contribute its OWN
    // drift event for the disappeared entity.
    const driftEventsAfter = await queryEvents(pool, { result: "drift" });
    expect(
      driftEventsAfter.length,
      "Phase B contributed at least one new drift StateEvent",
    ).toBeGreaterThan(driftCountBeforePhaseB);
    const newDriftEvents = driftEventsAfter.filter(
      (ev) => !phaseAdriftTimestamps.has(`${ev.ts}|${ev.entity}|${ev.op}`),
    );
    expect(
      newDriftEvents.length,
      "Phase B emitted at least one NEW drift StateEvent (not just inherited from Phase A)",
    ).toBeGreaterThanOrEqual(1);
    // Every drift event recorded by Phase B respects the writer invariants
    // (actor required; value-free entity ref; never a mutating op like
    // remove/destroy — fail-safe).
    for (const ev of newDriftEvents) {
      expect(ev.actor, "Phase B drift event carries an actor").toBeTruthy();
      expect(ev.scope, "Phase B drift event scoped").toBe("server");
      expect(
        ev.op,
        "Phase B drift event op is never a mutating op (fail-safe)",
      ).not.toMatch(/^(remove|destroy|delete)$/);
    }
    // The (e) tooth: at least one Phase-B drift event names the disappeared
    // peer's `server:` entity. A generic "any drift" check would be too weak
    // to catch a regression that emitted drift for the WRONG entity.
    expect(
      newDriftEvents.some(
        (ev) => String(ev.entity) === "server:legacy-1",
      ),
      "Phase B drift event names the residual (orphaned) peer's entity",
    ).toBe(true);
  });
});
