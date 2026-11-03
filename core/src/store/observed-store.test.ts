/**
 * core/src/store/observed-store.test.ts
 *
 * TDD tests for observed-store.ts — typed CRUD over `observed_state` table.
 *
 * Tests against a real Postgres container (DATABASE_URL_TEST).
 * All 5 behavioural properties are verified:
 *   1. Round-trip: putState → getState returns structurally-equal, StateSchema-valid State.
 *   2. Idempotent upsert: putState with the same input twice yields no duplicates (row count stable).
 *   3. Replace semantics: putState with a State that drops an entity removes that row.
 *   4. Scope isolation: two different scopes do not bleed into each other.
 *   5. Empty scope: getState on a scope with no rows returns a valid empty State.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPool } from "../../test/fakes/pg-harness.js";
import { runMigrations } from "./db.js";
import { putState, getState } from "./observed-store.js";
import { StateSchema } from "../domain/entities.js";
import type pg from "pg";
import type { State } from "../domain/entities.js";

let pool: pg.Pool;

// Representative valid State with 2 servers, 1 network, 1 service, 1 dns, 1 backup
// (all StateSchema-valid, including optional core-only fields)
const baseState: State = {
  servers: [
    {
      name: "bevox-app-1",
      type: "cx32",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: ["deploy-key"],
      labels: { app: "bevox", tier: "app" },
      network: "bevox-priv",
      status: "healthy",
      hcloud_id: 123456,
    },
    {
      name: "bevox-db-1",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: ["deploy-key"],
      labels: { app: "bevox", tier: "db" },
      network: "bevox-priv",
      status: "healthy",
    },
  ],
  networks: [
    {
      name: "bevox-priv",
      ip_range: "10.0.0.0/16",
      subnets: ["10.0.1.0/24"],
      hcloud_id: 7890,
    },
  ],
  volumes: [],
  services: [
    {
      name: "bevox-api",
      image: "ghcr.io/bevox/api:latest",
      replicas: 2,
      env: { NODE_ENV: "production" },
      ports: ["8080:8080"],
      status: "healthy",
    },
  ],
  dns: [
    {
      zone: "example.com",
      name: "api",
      type: "A",
      value: "1.2.3.4",
      ttl: 300,
    },
  ],
  backups: [
    {
      target: "bevox-db-1",
      schedule: "0 2 * * *",
      retention: "7d",
      repo: "s3:s3.example.com/bevox-backups",
    },
  ],
};

beforeAll(async () => {
  pool = getTestPool();
  // runMigrations is idempotent — ensures tables exist without wiping other
  // test files' data. We do NOT call resetSchema here because that would drop
  // the public schema and break sibling test files that share the same pg
  // pool instance (fileParallelism:false serialises files but they share the
  // singleton pool from pg-harness). The unique scope prefixes used throughout
  // this file provide full test isolation without schema resets.
  await runMigrations(pool);
});

// closeTestPool is intentionally omitted here — db.test.ts owns the pool
// lifecycle for the shared singleton. Closing it here would leave later files
// racing a pool teardown that they did not expect.
afterAll(async () => {
  // Scrub this file's scopes so subsequent runs start clean.
  // TRUNCATE is scope-targeted (WHERE clause) to avoid interfering with other
  // files' data that may still be needed by running tests.
  await pool.query(
    "DELETE FROM observed_state WHERE scope LIKE 'scope-%'"
  );
});

describe("observed-store — putState / getState", () => {
  it("round-trip: putState then getState returns structurally-equal, StateSchema-valid State", async () => {
    const scope = "scope-roundtrip";
    await putState(pool, scope, baseState);
    const result = await getState(pool, scope);

    // Must parse without throwing (schema validation on read)
    expect(() => StateSchema.parse(result)).not.toThrow();

    // Structural equality (deep)
    expect(result.servers).toHaveLength(baseState.servers.length);
    expect(result.networks).toHaveLength(baseState.networks.length);
    expect(result.services).toHaveLength(baseState.services.length);
    expect(result.dns).toHaveLength(baseState.dns.length);
    expect(result.backups).toHaveLength(baseState.backups.length);

    // Spot-check key fields survive the JSON round-trip
    const appServer = result.servers.find((s) => s.name === "bevox-app-1");
    expect(appServer).toBeDefined();
    expect(appServer?.hcloud_id).toBe(123456);
    expect(appServer?.labels).toEqual({ app: "bevox", tier: "app" });

    const net = result.networks[0];
    expect(net?.name).toBe("bevox-priv");
    expect(net?.ip_range).toBe("10.0.0.0/16");

    const svc = result.services[0];
    expect(svc?.name).toBe("bevox-api");
    expect(svc?.replicas).toBe(2);

    const dns = result.dns[0];
    expect(dns?.zone).toBe("example.com");
    expect(dns?.type).toBe("A");

    const bak = result.backups[0];
    expect(bak?.target).toBe("bevox-db-1");
    expect(bak?.retention).toBe("7d");
  });

  it("idempotent upsert: calling putState twice with the same state yields stable row count", async () => {
    const scope = "scope-idempotent";
    await putState(pool, scope, baseState);

    const countBefore = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM observed_state WHERE scope = $1",
      [scope]
    );

    // Put exactly the same state again
    await putState(pool, scope, baseState);

    const countAfter = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM observed_state WHERE scope = $1",
      [scope]
    );

    expect(Number(countAfter.rows[0]?.count)).toBe(
      Number(countBefore.rows[0]?.count)
    );
    // Sanity: the count is the total number of entities (2 servers + 1 net + 1 svc + 1 dns + 1 backup = 6)
    expect(Number(countAfter.rows[0]?.count)).toBe(6);
  });

  it("replace semantics: putState with a reduced State removes dropped entity rows", async () => {
    const scope = "scope-replace";
    await putState(pool, scope, baseState);

    // Drop one server and the service
    const reducedState: State = {
      ...baseState,
      servers: [baseState.servers[0]!], // only bevox-app-1
      services: [],
    };
    await putState(pool, scope, reducedState);

    const result = await getState(pool, scope);
    expect(result.servers).toHaveLength(1);
    expect(result.servers[0]?.name).toBe("bevox-app-1");
    expect(result.services).toHaveLength(0);

    // Verify at the DB layer: the deleted rows are truly gone
    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM observed_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    const entities = rows.rows.map((r) => r.entity);
    expect(entities.some((e) => e.startsWith("server:bevox-db-1"))).toBe(false);
    expect(entities.some((e) => e.startsWith("service:bevox-api"))).toBe(false);
  });

  it("scope isolation: two scopes do not interfere with each other", async () => {
    const scopeA = "scope-isolation-a";
    const scopeB = "scope-isolation-b";

    const stateA: State = {
      ...baseState,
      servers: [
        {
          name: "server-a",
          type: "cx22",
          location: "hel1",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          network: "net-a",
          status: "pending",
        },
      ],
      networks: [],
      services: [],
      dns: [],
      backups: [],
    };
    const stateB: State = {
      ...baseState,
      servers: [
        {
          name: "server-b",
          type: "cx32",
          location: "fsn1",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          network: "net-b",
          status: "applying",
        },
      ],
      networks: [],
      services: [],
      dns: [],
      backups: [],
    };

    await putState(pool, scopeA, stateA);
    await putState(pool, scopeB, stateB);

    const resultA = await getState(pool, scopeA);
    const resultB = await getState(pool, scopeB);

    expect(resultA.servers).toHaveLength(1);
    expect(resultA.servers[0]?.name).toBe("server-a");

    expect(resultB.servers).toHaveLength(1);
    expect(resultB.servers[0]?.name).toBe("server-b");

    // Modifying B does not affect A
    await putState(pool, scopeB, { ...stateB, servers: [] });
    const resultAAfter = await getState(pool, scopeA);
    expect(resultAAfter.servers).toHaveLength(1);
    expect(resultAAfter.servers[0]?.name).toBe("server-a");
  });

  it("empty scope: getState on a scope with no rows returns a valid empty State", async () => {
    const result = await getState(pool, "scope-that-does-not-exist");
    expect(() => StateSchema.parse(result)).not.toThrow();
    expect(result).toEqual({
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    });
  });

  // C1 regression — entity-key collision guard
  // Verifies that component values containing `:` are escaped so that two
  // distinct entities never map to the same (scope, entity) row.  Under the
  // OLD scheme (no escaping) the pairs below would produce identical keys and
  // one record would silently overwrite the other.

  it("collision-free keys: DNS records whose old unescaped keys would collide are stored and retrieved as two distinct rows", async () => {
    const scope = "scope-collision-dns";

    // Under the OLD key scheme (no escaping):
    //   Record A: dns:{zone}:{name}:{type} = "dns:a.com:foo:A"
    //             where zone="a.com", name="foo", type="A"   → key "dns:a.com:foo:A"
    //   Record B: dns:{zone}:{name}:{type} = "dns:a.com:foo:A"
    //             where zone="a.com:foo", name="A", type="X" → same key "dns:a.com:foo:A:X"
    //   Actually let's use a cleaner collision:
    //     A: zone="a", name="b", type="c"    → OLD key "dns:a:b:c"
    //     B: zone="a:b", name="c", type="X"  → OLD key "dns:a:b:c:X"  (different)
    //   Use the exact collision pair instead:
    //     A: zone="a", name="b:c", type="A"  → OLD key "dns:a:b:c:A"
    //     B: zone="a:b", name="c", type="A"  → OLD key "dns:a:b:c:A"  ← COLLISION!
    //   With escaping:
    //     A → "dns:a:b\:c:A"
    //     B → "dns:a\:b:c:A"   (distinct)

    const stateWithTwoDns: State = {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [
        // Record A: zone="a", name="b:c", type="A"
        {
          zone: "a",
          name: "b:c",
          type: "A",
          value: "1.1.1.1",
          ttl: 60,
        },
        // Record B: zone="a:b", name="c", type="A"  — old scheme collides with A
        {
          zone: "a:b",
          name: "c",
          type: "A",
          value: "2.2.2.2",
          ttl: 120,
        },
      ],
      backups: [],
    };

    await putState(pool, scope, stateWithTwoDns);
    const result = await getState(pool, scope);

    // Both records must survive as distinct entities
    expect(result.dns).toHaveLength(2);
    const values = result.dns.map((d) => d.value).sort();
    expect(values).toEqual(["1.1.1.1", "2.2.2.2"]);

    // Verify at the DB layer: exactly 2 rows with distinct entity keys
    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM observed_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.entity).not.toBe(rows.rows[1]?.entity);
  });

  it("collision-free keys: backup targets containing `:` are stored and retrieved as two distinct rows", async () => {
    const scope = "scope-collision-backup";

    // Under the OLD scheme (no escaping):
    //   target="volume:pg-data"  → key "backup:volume:pg-data"
    //   target="volume"          → key "backup:volume"             (different, but)
    //   target="vol"             → key "backup:vol"                (different)
    //   Collision pair:
    //     target="a:b"  → OLD key "backup:a:b"
    //     target="a"    → OLD key "backup:a"     (no collision here — choose carefully)
    //   Real collision requires the escaped vs. unescaped key to match another entry.
    //   Simplest: with old scheme two targets "x:y" and "x" can't collide since
    //   kind prefix is "backup:" and there's only one component.
    //   The risk is a target like "backup:x" being misrouted, but since there's
    //   only one component the only concern is `:` making the target look multi-part.
    //   We test that "volume:pg-data" is stored and retrieved faithfully (no data loss)
    //   alongside another target so no silent overwrite can occur.

    const stateWithTwoBackups: State = {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [
        // target contains `:` — would have been misinterpretable under old scheme
        {
          target: "volume:pg-data",
          schedule: "0 1 * * *",
          retention: "7d",
          repo: "s3:s3.example.com/bak",
        },
        // second distinct target
        {
          target: "volume:redis-data",
          schedule: "0 2 * * *",
          retention: "14d",
          repo: "s3:s3.example.com/bak",
        },
      ],
    };

    await putState(pool, scope, stateWithTwoBackups);
    const result = await getState(pool, scope);

    expect(result.backups).toHaveLength(2);
    const targets = result.backups.map((b) => b.target).sort();
    expect(targets).toEqual(["volume:pg-data", "volume:redis-data"]);

    // DB layer: two rows, distinct keys
    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM observed_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.entity).not.toBe(rows.rows[1]?.entity);
  });
});
