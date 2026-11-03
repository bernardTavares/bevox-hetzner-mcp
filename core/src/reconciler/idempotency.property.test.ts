/**
 * core/src/reconciler/idempotency.property.test.ts
 *
 * Task 2.8 — THE CENTRAL GUARANTEE (spec: "idempotência por design").
 *
 * Property under test, for EVERY sample manifest in the Fase-2 entity space:
 *
 *   applying any manifest N times converges, and cycle 2..N is a strict no-op.
 *
 * "strict no-op" means, for every reconcile cycle after the first:
 *   - every `applied` item has `changed === false` (NO provider mutation), AND
 *   - `failed` is empty, AND
 *   - `recordFailures` is empty, AND
 *   - the observed reality is byte-identical to the post-cycle-1 snapshot.
 *
 * This is NOT relaxed to "few mutations" / "eventually stable": the system's
 * idempotency contract is that converged ⇒ ZERO further writes, forever.
 *
 * It drives the REAL reconcile(deps)(input) cycle (Observe→Plan→Gate→Apply→
 * Record under the per-scope advisory lock) — the same wiring style as
 * reconcile.test.ts — with:
 *   - a fresh in-memory fake provider per sample (network-free); apply() is
 *     idempotent and records the exact desired payload so observe() round-trips
 *     reality faithfully back through the adapter (cycle ≥2 ⇒ plan() = all
 *     `noop`);
 *   - resetSchema + runMigrations per sample (no cross-sample state bleed);
 *   - pass-through gate; deterministic, seeded generation (no flaky randomness,
 *     no real timers).
 *
 * Sample set spans the Fase-2 entities only (networks, servers→networks,
 * volumes→servers, multiple independent entities, the empty manifest, a single
 * entity) plus deterministic parameterized variants. DNS/backup/service-secret
 * manifests are Fase 3/5 — out of scope here (YAGNI).
 *
 * DB-touching via the pg harness; the now-proven barrier/finally discipline
 * from reconcile.test.ts is followed so the DB suite is deterministically green
 * under the FULL `npm --prefix core test` (no leaked pg client/advisory lock).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { reconcile, passThroughGate } from "./reconcile.js";
import { observedAdapter as realObservedAdapter } from "./observed-adapter.js";
import { getState as getObservedState } from "../store/observed-store.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State, Service } from "../domain/entities.js";
import type {
  Provider,
  PlanAction,
  ApplyResult,
  ObservedSlice,
} from "../providers/provider.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../../test/fakes/pg-harness.js";
import { makePgHarnessDockerExec } from "../../test/fakes/pg-harness-docker-exec.js";
import { runMigrations as runDbMigrations } from "../store/db.js";
import { runMigrations as runToolMigrations } from "../agent/v2/run-migrations.js";
import { __mintVerifiedCredentialForTest } from "../agent/capability.js";
import { createDockerProvider } from "../providers/docker.js";
import { createDockerHttpFake } from "../../test/fakes/docker-http.js";
import { createSopsAgeSecretResolver } from "../store/secrets.js";
import { createSopsCliFake } from "../../test/fakes/sops-cli.js";
import { queryEvents } from "../store/state-events.js";
import type pg from "pg";

let pool: pg.Pool;

beforeAll(async () => {
  pool = getTestPool();
});

afterAll(async () => {
  await closeTestPool();
});

beforeEach(async () => {
  await resetSchema(pool);
  await runDbMigrations(pool);
});

// ---------------------------------------------------------------------------
// Fresh fake world
//
// In-memory, network-free fake Provider that stores the EXACT desired payload
// handed to apply() keyed by its entity, and surfaces every stored entity
// through observe(). This is the faithful round-trip a real provider must
// provide for idempotency: once converged, observe()→adapter reconstructs the
// declared entity so plan() sees `noop` and apply() returns changed:false.
//
//   - apply(action): if reality already holds an equal payload ⇒ NO write,
//     changed:false (idempotent — the central provider invariant). Else store
//     the payload, count the mutation.
//   - observe(scope): reports EVERY stored entity key (not scope-filtered) so
//     the adapter can rebuild the whole observed State the planner diffs.
//   - verify(action): true iff reality holds the entity (post-apply check).
//   - mutations: number of apply() calls that actually wrote (the no-op gate).
// ---------------------------------------------------------------------------

interface FakeWorld {
  provider: Provider;
  /** Count of apply() calls that mutated reality (cycle ≥2 must add zero). */
  mutations(): number;
  /** Deterministic byte-snapshot of the fake's whole reality. */
  snapshot(): string;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) sorted[k] = o[k];
      return sorted;
    }
    return v;
  });
}

function freshFakeWorld(): FakeWorld {
  // entity key → the exact desired payload last applied for it.
  const reality = new Map<string, Record<string, unknown>>();
  let mutations = 0;

  const provider: Provider = {
    name: "fake-idempotent",
    async observe(scope: string): Promise<ObservedSlice> {
      // Report ALL reality (the adapter rebuilds the full observed State the
      // planner diffs; scope only partitions the advisory lock here). Each
      // entity now carries its stored payload so the adapter round-trips it.
      return {
        scope,
        entities: [...reality.entries()].map(([key, payload]) => ({ key, payload })),
      };
    },
    async apply(action: PlanAction): Promise<ApplyResult> {
      const want = (action.desired ?? {}) as Record<string, unknown>;
      const have = reality.get(action.entity);
      if (have !== undefined && stableStringify(have) === stableStringify(want)) {
        // Already converged ⇒ strict no-op (no write, changed:false).
        return { entity: action.entity, op: action.op, changed: false };
      }
      reality.set(action.entity, want);
      mutations += 1;
      return { entity: action.entity, op: action.op, changed: true };
    },
    async verify(action: PlanAction): Promise<boolean> {
      return reality.has(action.entity);
    },
  };

  return {
    provider,
    mutations: () => mutations,
    snapshot: () => {
      // Sort by key so the snapshot is order-independent and reproducible.
      const ordered = [...reality.entries()].sort((a, b) =>
        a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
      );
      return stableStringify(ordered);
    },
  };
}

// ---------------------------------------------------------------------------
// Observed adapter — reconstruct the typed observed State from the fake's
// reported entity keys + their stored desired payloads. This is the exact
// inverse of how plan.ts keys entities ("<kind>:<name>"), so a converged
// reality round-trips to a State the planner diffs as all-`noop`.
// ---------------------------------------------------------------------------

const EMPTY_STATE: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

/**
 * Build an observedAdapter bound to a FakeWorld's stored payloads. The
 * ObservedSlice only carries entity KEYS; the concrete declared fields come
 * from what apply() stored — so the round-trip is faithful (no fabricated
 * fields that would make plan() see a spurious `update`).
 */
function makeObservedAdapter(
  payloadOf: (entity: string) => Record<string, unknown> | undefined,
): (slice: ObservedSlice) => State {
  return (slice: ObservedSlice): State => {
    const servers: State["servers"] = [];
    const networks: State["networks"] = [];
    const volumes: State["volumes"] = [];
    const services: State["services"] = [];
    for (const e of slice.entities) {
      const entityKey = e.key;
      const idx = entityKey.indexOf(":");
      const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
      const ePayload =
        e.payload && typeof e.payload === "object"
          ? (e.payload as Record<string, unknown>)
          : undefined;
      const payload =
        (ePayload && Object.keys(ePayload).length
          ? ePayload
          : payloadOf(entityKey)) ?? {};
      if (kind === "server") {
        servers.push(payload as State["servers"][number]);
      } else if (kind === "network") {
        networks.push(payload as State["networks"][number]);
      } else if (kind === "volume") {
        volumes.push(payload as State["volumes"][number]);
      } else if (kind === "service") {
        // gap #2 sample: the fake round-trips the exact stored payload
        // (incl. command/restart/depends_on) so a converged service diffs
        // as a noop on cycle 2.
        services.push(payload as State["services"][number]);
      }
      // dns/backups: not in this sample set (YAGNI).
    }
    return { ...EMPTY_STATE, servers, networks, volumes, services };
  };
}

// ---------------------------------------------------------------------------
// Sample manifests — the property's input space (hand-rolled + generated)
//
// Each is reconciled under a single scope; the fake's observe() reports all
// reality so multi-kind manifests still converge to all-`noop` on cycle 2.
// ---------------------------------------------------------------------------

type Net = NonNullable<DesiredState["networks"]>[number];
type Srv = NonNullable<DesiredState["servers"]>[number];

function genNetworks(n: number): Net[] {
  const out: Net[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ name: `net-${i}`, ip_range: `10.${i}.0.0/16` });
  }
  return out;
}

function genServers(n: number, network: string): Srv[] {
  const out: Srv[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      name: `srv-${i}`,
      type: "cx22",
      location: "nbg1",
      network,
      image: "ubuntu-24.04",
    });
  }
  return out;
}

const sampleManifests: { name: string; manifest: DesiredState }[] = [
  // 1. Empty manifest — nothing desired; must stay an empty no-op forever.
  { name: "empty", manifest: {} },

  // 2. Single network only.
  {
    name: "single-network",
    manifest: { networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }] },
  },

  // 3. Single server referencing its declared network.
  {
    name: "server-on-network",
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
  },

  // 4. Volume referencing a server referencing a network (full Fase-2 chain).
  {
    name: "network-server-volume-chain",
    manifest: {
      networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
      servers: [
        {
          name: "db-1",
          type: "cx32",
          location: "fsn1",
          network: "net-a",
          image: "ubuntu-24.04",
        },
      ],
      volumes: [
        { name: "data-1", size: "50G", server: "db-1", fs: "ext4" },
      ],
    },
  },

  // 5. Multiple independent entities (two networks, no cross-refs).
  {
    name: "multiple-independent-networks",
    manifest: { networks: genNetworks(3) },
  },

  // 6. Deterministically generated: a network + several servers on it.
  {
    name: "generated-fanout-5-servers",
    manifest: {
      networks: [{ name: "net-fan", ip_range: "10.9.0.0/16" }],
      servers: genServers(5, "net-fan"),
    },
  },

  // 7. Deterministically generated larger mixed graph: 2 networks, servers
  //    split across them, a volume per server — exercises the topo DAG.
  {
    name: "generated-mixed-graph",
    manifest: {
      networks: genNetworks(2),
      servers: [
        ...genServers(2, "net-0").map((s, i) => ({ ...s, name: `a-${i}` })),
        ...genServers(2, "net-1").map((s, i) => ({ ...s, name: `b-${i}` })),
      ],
      volumes: [
        { name: "v-a-0", size: "10G", server: "a-0", fs: "xfs" },
        { name: "v-b-1", size: "20G", server: "b-1", fs: "ext4" },
      ],
    },
  },

  // 8. gap #2/#1/#4: services declaring command, restart and depends_on
  //    (acyclic). Proves the new optional fields converge and the 2nd cycle
  //    is a strict no-op (no flap from command/restart/depends_on).
  {
    name: "services-command-restart-depends-on",
    manifest: {
      services: [
        {
          name: "db",
          image: "postgres:16",
          replicas: 1,
          command: ["postgres", "-c", "max_connections=200"],
          restart: "always",
          healthcheck: {
            test: ["CMD", "pg_isready", "-U", "bevox"],
            interval: "10s",
            retries: 5,
          },
        },
        {
          name: "app",
          image: "bevox/app:1",
          replicas: 1,
          restart: "on-failure",
          depends_on: ["db"],
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// The property
// ---------------------------------------------------------------------------

describe("idempotency property (CENTRAL GUARANTEE)", () => {
  it("applying any manifest N times converges; cycle 2..N is a strict no-op", async () => {
    for (const { name, manifest } of sampleManifests) {
      // Fresh fake world + clean schema per sample (no cross-sample bleed).
      await resetSchema(pool);
      await runDbMigrations(pool);

      const world = freshFakeWorld();
      const payloads = new Map<string, Record<string, unknown>>();
      // Capture every applied payload so the adapter round-trips reality
      // faithfully (mirrors what the fake provider stores).
      const trackingProvider: Provider = {
        name: world.provider.name,
        observe: (s) => world.provider.observe(s),
        async apply(action: PlanAction): Promise<ApplyResult> {
          payloads.set(
            action.entity,
            (action.desired ?? {}) as Record<string, unknown>,
          );
          return world.provider.apply(action);
        },
        verify: (a) => world.provider.verify(a),
      };

      const run = reconcile({
        pool,
        provider: trackingProvider,
        gate: passThroughGate,
        observedAdapter: makeObservedAdapter((e) => payloads.get(e)),
        loadDesired: async (): Promise<DesiredState> => manifest,
      });

      const scope = `prop-${name}`;

      // --- Cycle 1: may mutate to converge. ---
      const c1 = await run({ scope, actor: "agent:prop" });
      expect(c1.acquired).toBe(true);
      expect(c1.failed).toEqual([]);
      expect(c1.recordFailures).toEqual([]);

      // --- Cycle 1 MUST non-trivially build the declared world. ---
      // Declared-entity count = networks + servers + volumes lengths (the
      // Fase-2 entity space; services/dns/backups are out of scope). The
      // empty manifest legitimately produces 0 mutations and is excluded;
      // for every non-empty sample cycle 1 must apply EXACTLY one mutation
      // per declared entity (proving every node of the dependency
      // chain/fan-out/mixed-DAG was applied, not just the root) — otherwise
      // every cycle-2..N assertion below would pass vacuously.
      const declaredCount =
        (manifest.networks?.length ?? 0) +
        (manifest.servers?.length ?? 0) +
        (manifest.volumes?.length ?? 0) +
        (manifest.services?.length ?? 0);
      if (declaredCount > 0) {
        expect(
          world.mutations(),
          `${name} cycle 1: provider mutations === declared-entity count`,
        ).toBe(declaredCount);
        expect(
          c1.applied.some((a) => a.changed === true),
          `${name} cycle 1: at least one applied changed===true`,
        ).toBe(true);
        expect(
          c1.applied.length,
          `${name} cycle 1: applied count === declared-entity count`,
        ).toBe(declaredCount);
        expect(
          world.snapshot(),
          `${name} cycle 1: reality is not the empty snapshot`,
        ).not.toEqual(stableStringify([]));
      }

      const after1 = world.snapshot();

      // --- Cycles 2..5: STRICT no-op. ---
      for (let i = 0; i < 4; i++) {
        const mutBefore = world.mutations();
        const c = await run({ scope, actor: "agent:prop" });

        expect(c.acquired, `${name} cycle ${i + 2}: acquired`).toBe(true);
        // ZERO provider mutations on this cycle.
        expect(
          world.mutations() - mutBefore,
          `${name} cycle ${i + 2}: provider mutations`,
        ).toBe(0);
        // Every applied item is a converged no-op.
        expect(
          c.applied.every((a) => a.changed === false),
          `${name} cycle ${i + 2}: every applied changed===false`,
        ).toBe(true);
        // ...and for non-empty samples the no-op set must cover EVERY
        // declared entity (each repeat cycle demonstrably re-evaluated
        // every entity as a no-op — not "applied nothing", which would make
        // the `.every()` above vacuously true).
        if (declaredCount > 0) {
          expect(
            c.applied.length,
            `${name} cycle ${i + 2}: applied count === declared-entity count`,
          ).toBe(declaredCount);
        }
        // No failures, no record failures.
        expect(c.failed, `${name} cycle ${i + 2}: failed`).toEqual([]);
        expect(
          c.recordFailures,
          `${name} cycle ${i + 2}: recordFailures`,
        ).toEqual([]);
        // Observed reality byte-identical to the post-cycle-1 snapshot.
        expect(
          world.snapshot(),
          `${name} cycle ${i + 2}: reality stable vs after1`,
        ).toEqual(after1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 6.1 — idempotency under the REAL sops-age resolver
//
// The central idempotency property above runs over the Fase-2 entity space
// (network/server/volume) against an in-memory fake provider that round-trips
// the EXACT desired payload. That harness does not exercise the real secret
// resolver, so it cannot prove the invariant we need here:
//
//   APPLYING A SERVICE WITH `env: { K: "secret:<ref>" }` ANY NUMBER OF TIMES
//   CONVERGES — cycle 2 emits ZERO mutations even though apply() spawns the
//   sops subprocess and resolves the value.
//
// This locks the contract: value resolution at apply-time is byte-identical
// for the same ref → the value injected into the container env on cycle 1
// matches what an idempotency check sees on cycle 2 → no spurious "drift".
//
// Setup mirrors `reconcile.services.test.ts`'s rig but uses the PRODUCTION
// `createSopsAgeSecretResolver` (not the test sentinel resolver) — driven by
// `createSopsCliFake()` so ZERO real sops subprocess runs. This is the only
// place in the suite that wires the production resolver into a reconcile
// cycle; the assertion is the narrow idempotency invariant Task 6.1 names,
// not a full secret-leak / e2e re-proof (that's already covered by
// `reconcile.services.test.ts` and `secret-apply.test.ts`).
//
// Approach (concrete regression case): one manifest with one service +
// `secret:<ref>` env, applied twice via reconcile(). The "property" aspect
// "this should hold for any service-with-secret manifest" is honoured by the
// underlying resolver being deterministic for a given ref; one sample is
// sufficient per the Task 6.1 brief.
// ---------------------------------------------------------------------------

describe("idempotency under real sops-age resolver (Task 6.1)", () => {
  it("service with secret:<ref> env: cycle 2 reconcile mutates zero times", async () => {
    // Fresh schema for this isolated test (the suite-level beforeEach already
    // does this, but we also reset between cycles below to mirror the
    // discipline of the main property test — no cross-cycle state bleed).
    await resetSchema(pool);
    await runDbMigrations(pool);

    // The fake spawn drives the real createSopsAgeSecretResolver. A constant
    // response models the production invariant the resolver provides for a
    // given ref: same input → same output.
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setResponse({
      exitCode: 0,
      stdout: Buffer.from("resolved-value"),
      stderr: Buffer.alloc(0),
    });

    const dockerFake = createDockerHttpFake();
    const dockerProvider = createDockerProvider({
      transport: dockerFake.transport,
      secretResolver: createSopsAgeSecretResolver({
        // Paths are NEVER touched — fakeSpawn replies before any fs/exec.
        secretsFile: "/test/secrets.yaml",
        ageKeyFile: "/test/age.key",
        spawn: fakeSpawn.spawn,
      }),
      // No options.applyContext — the token is minted INSIDE reconcile() and
      // forwarded via PlanAction.applyContext (the production apply-boundary
      // channel; same pattern as reconcile.services.test.ts).
    });

    // Single-service manifest; the secret-bound env key is the locus of the
    // invariant under test.
    const MANIFEST: DesiredState = {
      services: [
        {
          name: "billing",
          image: "bevox/billing:1",
          replicas: 1,
          env: { LOG_LEVEL: "info", DB_PASSWORD: "secret:db-password" },
        },
      ],
    };

    // Observed adapter: inverse of plan.ts's "<kind>:<name>" keying for the
    // service kind only (this isolated test does not span backends).
    const observedAdapter = (slice: ObservedSlice): State => {
      const services: State["services"] = [];
      for (const e of slice.entities) {
        const entityKey = e.key;
        const idx = entityKey.indexOf(":");
        const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
        const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
        if (kind === "service") {
          const m = MANIFEST.services?.find((s) => s.name === name);
          if (m) services.push(m as State["services"][number]);
        }
      }
      return { ...EMPTY_STATE, services };
    };

    const run = reconcile({
      pool,
      provider: dockerProvider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => MANIFEST,
    });

    // Cycle 1: builds the world. AT LEAST one apply must mutate (otherwise
    // cycle-2 assertions below would pass vacuously).
    const c1 = await run({ scope: "service", actor: "agent:prop" });
    expect(c1.acquired).toBe(true);
    expect(c1.failed).toEqual([]);
    expect(c1.recordFailures).toEqual([]);
    expect(
      c1.applied.some((a) => a.changed === true),
      "cycle 1: at least one applied changed===true",
    ).toBe(true);
    // The resolver was actually invoked (proves the apply-boundary channel
    // reached the production resolver — not vacuously short-circuited).
    expect(
      fakeSpawn.callLog.length,
      "cycle 1: sops spawn invoked at least once",
    ).toBeGreaterThanOrEqual(1);

    const c1Spawns = fakeSpawn.callLog.length;

    // Cycle 2: STRICT no-op — every applied item is changed===false and the
    // provider state is unchanged. This is the Task 6.1 invariant: re-running
    // the reconcile cycle against an already-converged service-with-secret
    // produces ZERO mutations even though apply() may re-resolve the secret.
    const c2 = await run({ scope: "service", actor: "agent:prop" });
    expect(c2.acquired, "cycle 2: acquired").toBe(true);
    expect(c2.failed, "cycle 2: failed").toEqual([]);
    expect(c2.recordFailures, "cycle 2: recordFailures").toEqual([]);
    // Non-vacuous: cycle 2 DID re-evaluate the service (applied is non-empty)
    // — it didn't simply skip planning. Every applied item is a no-op.
    expect(
      c2.applied.length,
      "cycle 2: applied non-empty (re-evaluated, not skipped)",
    ).toBeGreaterThanOrEqual(1);
    expect(
      c2.applied.every((a) => a.changed === false),
      "cycle 2: every applied changed===false",
    ).toBe(true);

    // Cycle 2 may or may not re-resolve the secret (current implementation
    // does NOT call resolve when the converged path skips create); the
    // invariant under test is NOT about resolver call count — it is about
    // provider-state mutation count. Either way, the call log is permitted to
    // grow (idempotent resolution is safe).
    void c1Spawns;
  });
});

// ---------------------------------------------------------------------------
// Property — `run_migrations` v2 tool batch idempotency (Task 9.1)
//
// Spec docs/specs/2026-05-28-migration-runner-v1.md §5 "Property": every
// migration batch must converge in 1 cycle — applying the SAME batch N times
// MUST leave `schema_migrations` byte-identical from cycle 2 onwards (the M7
// invariant the runner promises beyond a single integration test sample).
//
// Pattern: hand-rolled deterministic seed (no `fast-check` — none is declared
// in core/package.json; the project convention is seeded fixtures per sample).
// For each seed we synthesise a small distinct batch (1..5 `CREATE TABLE IF
// NOT EXISTS` migrations — safe SQL: idempotent at the DB level AND deduped
// by the runner's noop branch, so re-runs MUST all be noops).
//
// The exec seam is the SHARED `makePgHarnessDockerExec` adapter from
// `core/test/fakes/pg-harness-docker-exec.ts` (8.1 + 9.1 callers).
// ---------------------------------------------------------------------------

/** Deterministic 1..5 migration batch per seed (no cross-seed name collision). */
function generateMigrationBatch(
  seed: number,
): { target_service: string; database: string; migrations: { filename: string; sql: string }[] } {
  // Seeded N in [1,5] so every sample is a different shape.
  const n = (seed % 5) + 1;
  const migrations: { filename: string; sql: string }[] = [];
  for (let i = 0; i < n; i++) {
    // Safe SQL — `CREATE TABLE IF NOT EXISTS` is idempotent at the DB level,
    // and the table name is seed+index unique so seeds do not collide.
    const tableName = `t_${seed}_${i}`;
    migrations.push({
      filename: `${String(i).padStart(3, "0")}_${tableName}.sql`,
      sql: `CREATE TABLE IF NOT EXISTS ${tableName} (id INT PRIMARY KEY)`,
    });
  }
  return {
    target_service: "pg",
    database: "core_test",
    migrations,
  };
}

describe("Property — migration batches converge in 1 cycle (9.1)", () => {
  it("N applies of the same batch → schema_migrations byte-identical from cycle 2", async () => {
    const validCred = __mintVerifiedCredentialForTest("agent:test", [
      "run_migrations",
    ]);
    const validCtx = { credential: validCred, scope: "service" as const };
    const SEEDS = 5;

    for (let seed = 0; seed < SEEDS; seed++) {
      // Fresh schema per seed (no cross-seed bleed: each batch's
      // schema_migrations starts empty).
      await resetSchema(pool);
      await runDbMigrations(pool);

      const batch = generateMigrationBatch(seed);
      const dockerExec = makePgHarnessDockerExec(pool);
      const deps = {
        approvalGate: passThroughGate,
        dockerExec,
        servicesProvider: async (): Promise<readonly Service[]> => [
          {
            name: "pg",
            image: "postgres:16",
            replicas: 1,
            container_ids: ["cid1"],
          },
        ],
      };

      // Cycle 1: may mutate.
      const env1 = await runToolMigrations(batch, validCtx, deps);
      expect(
        env1.status,
        `seed ${seed} cycle 1: applied envelope`,
      ).toBe("applied");
      // Every per-migration entry MUST be "ok" (every CREATE was first-time
      // for this seed). If the runner shipped any "error"/"noop" here, the
      // batch never built a stable cycle-1 baseline and cycle ≥2 assertions
      // would be vacuously satisfied.
      expect(
        env1.report?.applied.every((a) => a.result === "ok"),
        `seed ${seed} cycle 1: every applied result === "ok"`,
      ).toBe(true);

      const snap1 = await pool.query<{ filename: string }>(
        "SELECT filename FROM schema_migrations ORDER BY filename",
      );

      // Cycles 2..5: STRICT no-op — schema_migrations byte-identical AND
      // every per-migration entry surfaces as "noop".
      for (let cycle = 2; cycle <= 5; cycle++) {
        const envN = await runToolMigrations(batch, validCtx, deps);
        expect(
          envN.status,
          `seed ${seed} cycle ${cycle}: applied envelope`,
        ).toBe("applied");
        expect(
          envN.report?.applied.every((a) => a.result === "noop"),
          `seed ${seed} cycle ${cycle}: every applied result === "noop"`,
        ).toBe(true);

        const snapN = await pool.query<{ filename: string }>(
          "SELECT filename FROM schema_migrations ORDER BY filename",
        );
        expect(
          snapN.rows,
          `seed ${seed} cycle ${cycle}: schema_migrations byte-identical vs cycle 1`,
        ).toEqual(snap1.rows);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Task 2.0.7 — idempotency with depends_on + wait-for-healthy
//
// The central property above uses an in-memory fake provider that does not
// model Docker health, so it cannot exercise the Phase-2.0 wait gate. This
// drives the REAL DockerProvider (against the docker-http fake) through the
// reconcile loop and locks the invariant: a converged manifest with
// `depends_on` re-applies as a STRICT no-op — the wait gate is skipped when no
// replica needs creating, so cycle 2 emits ZERO mutations and ZERO new wait
// events. secret-apply.test.ts stays byte-identical (no edit; run-only).
// ---------------------------------------------------------------------------

describe("idempotency with depends_on + wait-for-healthy (Task 2.0.7)", () => {
  it("a converged depends_on manifest re-applies as a strict no-op (no wait, no spurious events)", async () => {
    await resetSchema(pool);
    await runDbMigrations(pool);

    const dockerFake = createDockerHttpFake();
    // Bug 4: force cycle 1 to PULL (images absent until pulled) so the
    // idempotency property exercises the pull path. Convergence + a strict
    // cycle-2 no-op then proves the pull integrates without flipping `changed`.
    dockerFake.setImageAbsent("postgres:16");
    dockerFake.setImageAbsent("bevox/app:1");
    let t = 0;
    const dockerProvider = createDockerProvider({
      transport: dockerFake.transport,
      now: () => t,
      sleep: async (ms: number): Promise<void> => {
        t += ms;
      },
    });

    const MANIFEST: DesiredState = {
      services: [
        { name: "db", image: "postgres:16", replicas: 1 },
        { name: "app", image: "bevox/app:1", replicas: 1, depends_on: ["db"] },
      ],
    };

    const observedAdapter = (slice: ObservedSlice): State => {
      const services: State["services"] = [];
      for (const e of slice.entities) {
        const entityKey = e.key;
        const idx = entityKey.indexOf(":");
        const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
        const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
        if (kind === "service") {
          const m = MANIFEST.services?.find((s) => s.name === name);
          if (m) services.push(m as State["services"][number]);
        }
      }
      return { ...EMPTY_STATE, services };
    };

    const run = reconcile({
      pool,
      provider: dockerProvider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => MANIFEST,
    });

    const waitOps = (rows: { op: string }[]): number =>
      rows.filter(
        (e) =>
          e.op === "service.wait_skipped" ||
          e.op === "service.dep_health_timeout",
      ).length;

    // Cycle 1: builds both; app waits on db (no HEALTHCHECK ⇒ degraded skip).
    const c1 = await run({ scope: "service", actor: "agent:prop" });
    expect(c1.acquired).toBe(true);
    expect(c1.failed).toEqual([]);
    expect(c1.applied.some((a) => a.changed === true)).toBe(true);

    // db now healthy for any future wait.
    dockerFake.setHealth("db-0", ["healthy"]);
    const waitBefore = waitOps(await queryEvents(pool, {}));

    // Cycle 2: everything converged ⇒ needsCreate false ⇒ wait gate SKIPPED ⇒
    // zero mutations AND zero new wait events.
    const c2 = await run({ scope: "service", actor: "agent:prop" });
    expect(c2.acquired).toBe(true);
    expect(c2.failed).toEqual([]);
    expect(c2.applied.length).toBeGreaterThanOrEqual(2);
    expect(
      c2.applied.every((a) => a.changed === false),
      "cycle 2: every applied changed===false",
    ).toBe(true);

    const waitAfter = waitOps(await queryEvents(pool, {}));
    expect(waitAfter, "no spurious wait events on the converged cycle").toBe(
      waitBefore,
    );
  });
});

// ---------------------------------------------------------------------------
// Resolved volume bind idempotency
// (spec: 2026-06-01-volume-hetzner-bind-automount.md §3/§F5)
//
// Locks the highest-risk invariant of this feature at the reconciler property
// layer: a manifest with a declared+observed volume and a service whose
// `volumes: ["<name>:<container_path>"]` bind is resolved to the real Hetzner
// mount `/mnt/HC_Volume_<id>:<container_path>` converges on cycle 1 and emits
// ZERO mutating actions on cycle 2 (createBody and isConverged resolve the
// bind THROUGH THE SAME helper — asymmetry would flap into infinite re-create).
// Drives the REAL DockerProvider against the docker-http fake with a real
// resolveVolumeMount seam (fakes-only, no real DB/SSH/Docker).
// ---------------------------------------------------------------------------

describe("idempotency over a resolved volume bind (volume-hetzner-bind-automount)", () => {
  it("a service with a resolved Hetzner volume bind converges; cycle 2 is a strict no-op", async () => {
    await resetSchema(pool);
    await runDbMigrations(pool);

    const dockerFake = createDockerHttpFake();
    const dockerProvider = createDockerProvider({
      transport: dockerFake.transport,
      // The observed volume `pg-data` carries hcloud_id 42 ⇒ mount /mnt/HC_Volume_42.
      resolveVolumeMount: async (n) =>
        n === "pg-data" ? "/mnt/HC_Volume_42" : undefined,
    });

    // The manifest declares the volume `pg-data` (so the service→volume
    // cross-kind dep — Bug 9 / F1 — validates against the NAME segment) and a
    // service whose bind references it. The volume is reported already-observed
    // (with its hcloud_id) so it diffs as a noop and never routes a volume
    // action to the docker provider — the focus here is the SERVICE bind.
    const VOLUME = {
      name: "pg-data",
      size: "20Gi",
      fs: "ext4",
      hcloud_id: 42,
    } as const;
    const MANIFEST: DesiredState = {
      volumes: [{ name: VOLUME.name, size: VOLUME.size, fs: VOLUME.fs }],
      services: [
        {
          name: "db",
          image: "postgres:16",
          replicas: 1,
          volumes: ["pg-data:/var/lib/postgresql/data"],
        },
      ],
    };

    const observedAdapter = (slice: ObservedSlice): State => {
      const services: State["services"] = [];
      const volumes: State["volumes"] = [];
      for (const e of slice.entities) {
        const entityKey = e.key;
        const idx = entityKey.indexOf(":");
        const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
        const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
        if (kind === "service") {
          const m = MANIFEST.services?.find((s) => s.name === name);
          if (m) services.push(m as State["services"][number]);
        }
      }
      // The volume is always observed (the Hetzner provider already created it
      // on a prior cycle) — desired sends {name,size,fs}, observed carries the
      // same plus hcloud_id (a core-only field plan() ignores ⇒ noop).
      volumes.push({ name: VOLUME.name, size: VOLUME.size, fs: VOLUME.fs });
      return { ...EMPTY_STATE, services, volumes };
    };

    const run = reconcile({
      pool,
      provider: dockerProvider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => MANIFEST,
    });

    // Cycle 1: creates the container with the RESOLVED bind.
    const c1 = await run({ scope: "service", actor: "agent:prop" });
    expect(c1.acquired).toBe(true);
    expect(c1.failed).toEqual([]);
    expect(c1.recordFailures).toEqual([]);
    expect(
      c1.applied.some((a) => a.changed === true),
      "cycle 1: at least one applied changed===true",
    ).toBe(true);

    // The container's observed bind is the RESOLVED Hetzner mount.
    const list = await dockerFake.transport.request("GET", "/containers/json");
    const items = list.json as { Id: string; Names: string[] }[];
    const db0 = items.find((c) => c.Names[0] === "/db-0");
    expect(db0, "db-0 container exists").toBeDefined();
    const insp = await dockerFake.transport.request(
      "GET",
      `/containers/${db0!.Id}/json`,
    );
    const binds = (insp.json as { HostConfig: { Binds: string[] } }).HostConfig
      .Binds;
    expect(binds).toEqual(["/mnt/HC_Volume_42:/var/lib/postgresql/data"]);

    // Cycle 2: STRICT no-op — isConverged resolves `pg-data:...` to the same
    // `/mnt/HC_Volume_42:...` before comparing ⇒ zero mutations.
    const c2 = await run({ scope: "service", actor: "agent:prop" });
    expect(c2.acquired).toBe(true);
    expect(c2.failed).toEqual([]);
    expect(c2.recordFailures).toEqual([]);
    expect(
      c2.applied.length,
      "cycle 2: applied non-empty (re-evaluated, not skipped)",
    ).toBeGreaterThanOrEqual(1);
    expect(
      c2.applied.every((a) => a.changed === false),
      "cycle 2: every applied changed===false (no re-create flap)",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Private-registry skip+pull idempotency (docker-private-registry-auth, Bug 11)
//
// A service whose image lives in a PRIVATE registry (registryAuthRefs
// configured) pulls WITH an X-Registry-Auth header resolved through the REAL
// reconcile path (the applyContext is minted per cycle by reconcile.ts and
// threaded to ensureImage). Cycle 1 creates; cycle 2 is a strict no-op — the
// container is converged so ensureImage is never re-entered (no re-pull). The
// cycle-1 capture is the load-bearing reconcile-integration assertion.
// ---------------------------------------------------------------------------
describe("idempotency over a private-registry service (docker-private-registry-auth)", () => {
  it("a private-image service converges with X-Registry-Auth; cycle 2 is a strict no-op", async () => {
    await resetSchema(pool);
    await runDbMigrations(pool);

    const dockerFake = createDockerHttpFake();
    // Real sops+age resolver fed by a fake `sops` that decrypts the ghcr ref to
    // a {username,password} JSON (the production resolution path, not a stub).
    const sopsFake = createSopsCliFake();
    sopsFake.setResponse({
      exitCode: 0,
      stdout: Buffer.from(JSON.stringify({ username: "bevox-bot", password: "ghp_x" })),
      stderr: Buffer.alloc(0),
    });
    const secretResolver = createSopsAgeSecretResolver({
      secretsFile: "/tmp/secrets.yaml",
      ageKeyFile: "/tmp/age.key",
      timeoutMs: 5000,
      spawn: sopsFake.spawn,
    });
    const IMAGE = "ghcr.io/example-org/bevox-backend@sha256:abc";
    const dockerProvider = createDockerProvider({
      transport: dockerFake.transport,
      secretResolver,
      registryAuthRefs: { "ghcr.io": "ghcr-pat" },
    });

    const MANIFEST: DesiredState = {
      services: [{ name: "backend", image: IMAGE, replicas: 1 }],
    };
    const observedAdapter = (slice: ObservedSlice): State => {
      const services: State["services"] = [];
      for (const e of slice.entities) {
        const entityKey = e.key;
        const idx = entityKey.indexOf(":");
        const kind = idx >= 0 ? entityKey.slice(0, idx) : entityKey;
        const name = idx >= 0 ? entityKey.slice(idx + 1) : entityKey;
        if (kind === "service") {
          const m = MANIFEST.services?.find((s) => s.name === name);
          if (m) services.push(m as State["services"][number]);
        }
      }
      return { ...EMPTY_STATE, services };
    };

    const run = reconcile({
      pool,
      provider: dockerProvider,
      gate: passThroughGate,
      observedAdapter,
      loadDesired: async (): Promise<DesiredState> => MANIFEST,
    });

    // Cycle 1: image absent ⇒ pull WITH the resolved auth header, then create.
    const c1 = await run({ scope: "service", actor: "agent:prop" });
    expect(c1.acquired).toBe(true);
    expect(c1.failed).toEqual([]);
    expect(c1.recordFailures).toEqual([]);
    expect(
      c1.applied.some((a) => a.changed === true),
      "cycle 1: at least one applied changed===true",
    ).toBe(true);

    // LOAD-BEARING: the pull carried the X-Registry-Auth the provider built
    // from the credential resolved behind the reconcile-minted applyContext.
    const expected = Buffer.from(
      JSON.stringify({ username: "bevox-bot", password: "ghp_x", serveraddress: "ghcr.io" }),
    ).toString("base64url");
    expect(dockerFake.capturedRegistryAuth(IMAGE)).toBe(expected);

    // Cycle 2: STRICT no-op — container converged ⇒ no re-create, no re-pull.
    const c2 = await run({ scope: "service", actor: "agent:prop" });
    expect(c2.acquired).toBe(true);
    expect(c2.failed).toEqual([]);
    expect(c2.recordFailures).toEqual([]);
    expect(
      c2.applied.length,
      "cycle 2: applied non-empty (re-evaluated, not skipped)",
    ).toBeGreaterThanOrEqual(1);
    expect(
      c2.applied.every((a) => a.changed === false),
      "cycle 2: every applied changed===false (no re-create, no re-pull)",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 11 (spec 2026-06-02-observed-state-adapter): with the REAL adapter, a
// non-empty observed reality converges and stays a strict no-op (snapshot
// byte-stable). Fail-safe: an observed-but-NOT-desired resource is never
// destroyed — a truer observed cannot drive a terminate (spec §3 L2 / Q3).
// ---------------------------------------------------------------------------
describe("idempotency + fail-safe over a non-empty observed (observed-state-adapter)", () => {
  const SERVER_PAYLOAD = {
    name: "app-1",
    type: "cx22",
    location: "nbg1",
    network: "net-a",
    image: "ubuntu-24.04",
    ssh_keys: [],
    labels: {},
  };
  const DESIRED: DesiredState = {
    networks: [{ name: "net-a", ip_range: "10.0.0.0/16" }],
    servers: [{ name: "app-1", type: "cx22", location: "nbg1", network: "net-a", image: "ubuntu-24.04" }],
  };

  function richServerProvider(reality: Set<string>, extras: readonly string[] = []): Provider {
    return {
      name: "fake-rich",
      async observe(scope: string): Promise<ObservedSlice> {
        const prefix = `${scope}:`;
        const keys = [...reality, ...extras].filter((k) => k.startsWith(prefix));
        return {
          scope,
          entities: keys.map((k) => ({
            key: k,
            payload:
              k === "server:app-1"
                ? SERVER_PAYLOAD
                : { name: k.slice(k.lastIndexOf(":") + 1), type: "cx22", location: "nbg1", network: "net-a", image: "ubuntu-24.04", ssh_keys: [], labels: {} },
          })),
        };
      },
      async apply(action: PlanAction): Promise<ApplyResult> {
        if (reality.has(action.entity)) return { entity: action.entity, op: action.op, changed: false };
        reality.add(action.entity);
        return { entity: action.entity, op: action.op, changed: true };
      },
      async verify(action: PlanAction): Promise<boolean> {
        return reality.has(action.entity);
      },
    };
  }

  it("non-empty observed converges; cycle 2+ is a strict no-op; snapshot byte-stable", async () => {
    await resetSchema(pool);
    await runDbMigrations(pool);
    const reality = new Set<string>();
    const run = reconcile({
      pool,
      provider: richServerProvider(reality),
      gate: passThroughGate,
      observedAdapter: realObservedAdapter,
      loadDesired: async (): Promise<DesiredState> => DESIRED,
    });

    await run({ scope: "server", actor: "agent:claude-code" }); // create
    const c2 = await run({ scope: "server", actor: "agent:claude-code" });
    const snap2 = await getObservedState(pool, "server");
    const c3 = await run({ scope: "server", actor: "agent:claude-code" });
    const snap3 = await getObservedState(pool, "server");

    expect(c2.applied.every((a) => a.changed === false)).toBe(true);
    expect(c3.applied.every((a) => a.changed === false)).toBe(true);
    expect(snap2.servers.map((s) => s.name)).toEqual(["app-1"]);
    expect(snap3).toEqual(snap2); // byte-stable across steady-state cycles
  });

  it("fail-safe: an observed-but-not-desired resource is NEVER destroyed", async () => {
    await resetSchema(pool);
    await runDbMigrations(pool);
    const reality = new Set<string>();
    // The provider observes an EXTRA server the manifest does not declare (the
    // volume-model divergence class, Q5). The reconciler must not destroy it.
    const run = reconcile({
      pool,
      provider: richServerProvider(reality, ["server:orphan"]),
      gate: passThroughGate,
      observedAdapter: realObservedAdapter,
      loadDesired: async (): Promise<DesiredState> => DESIRED,
    });

    const c1 = await run({ scope: "server", actor: "agent:claude-code" });
    const c2 = await run({ scope: "server", actor: "agent:claude-code" });

    // NO destroy/remove op was ever applied for the orphan (or anything).
    const allOps = [...c1.applied, ...c2.applied].map((a) => a.op);
    expect(allOps).not.toContain("destroy");
    expect(allOps).not.toContain("remove");
    expect(c1.failed).toEqual([]);
    expect(c2.failed).toEqual([]);
    // The orphan is still observed (left in place) — reality untouched.
    const snap = await getObservedState(pool, "server");
    expect(snap.servers.map((s) => s.name).sort()).toEqual(["app-1", "orphan"]);
  });
});
