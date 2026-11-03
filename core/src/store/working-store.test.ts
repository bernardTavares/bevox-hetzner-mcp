/**
 * core/src/store/working-store.test.ts
 *
 * TDD tests for working-store.ts — typed CRUD over `working_state` table.
 *
 * The working_state table holds the desired state as last applied by the
 * reconciler. The API surface is identical to observed-store; these tests
 * verify the same 5 behavioural properties against `working_state`.
 *
 * Note: this test file shares pg-harness state management with
 * observed-store.test.ts. Both files run serially (fileParallelism:false),
 * and each file uses its own scope prefixes, so they do not interfere.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getTestPool } from "../../test/fakes/pg-harness.js";
import { runMigrations } from "./db.js";
import { putState, getState } from "./working-store.js";
import { StateSchema } from "../domain/entities.js";
import type pg from "pg";
import type { State } from "../domain/entities.js";

let pool: pg.Pool;

const baseState: State = {
  servers: [
    {
      name: "w-app-1",
      type: "cx32",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: ["ci-key"],
      labels: { role: "app" },
      network: "w-priv",
      status: "pending",
    },
    {
      name: "w-db-1",
      type: "cx22",
      location: "nbg1",
      image: "ubuntu-24.04",
      ssh_keys: ["ci-key"],
      labels: { role: "db" },
      network: "w-priv",
      status: "pending",
      hcloud_id: 999,
    },
  ],
  networks: [
    {
      name: "w-priv",
      ip_range: "10.1.0.0/16",
      subnets: ["10.1.1.0/24"],
    },
  ],
  volumes: [
    {
      name: "w-data",
      size: "50GB",
      fs: "ext4",
      server: "w-db-1",
    },
  ],
  services: [
    {
      name: "w-backend",
      image: "ghcr.io/bevox/backend:stable",
      replicas: 3,
      ports: ["3000:3000"],
    },
  ],
  dns: [
    {
      zone: "example.net",
      name: "backend",
      type: "CNAME",
      value: "lb.example.net",
      ttl: 60,
    },
  ],
  backups: [
    {
      target: "w-db-1",
      schedule: "0 3 * * *",
      retention: "14d",
      repo: "b2:bevox-backups",
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
  await pool.query(
    "DELETE FROM working_state WHERE scope LIKE 'w-%'"
  );
});

describe("working-store — putState / getState", () => {
  it("round-trip: putState then getState returns structurally-equal, StateSchema-valid State", async () => {
    const scope = "w-scope-roundtrip";
    await putState(pool, scope, baseState);
    const result = await getState(pool, scope);

    expect(() => StateSchema.parse(result)).not.toThrow();

    expect(result.servers).toHaveLength(2);
    expect(result.networks).toHaveLength(1);
    expect(result.volumes).toHaveLength(1);
    expect(result.services).toHaveLength(1);
    expect(result.dns).toHaveLength(1);
    expect(result.backups).toHaveLength(1);

    const dbServer = result.servers.find((s) => s.name === "w-db-1");
    expect(dbServer).toBeDefined();
    expect(dbServer?.hcloud_id).toBe(999);

    const vol = result.volumes[0];
    expect(vol?.name).toBe("w-data");
    expect(vol?.size).toBe("50GB");

    const svc = result.services[0];
    expect(svc?.replicas).toBe(3);

    const dns = result.dns[0];
    expect(dns?.type).toBe("CNAME");
    expect(dns?.ttl).toBe(60);
  });

  it("idempotent upsert: putting the same state twice keeps row count stable", async () => {
    const scope = "w-scope-idempotent";
    await putState(pool, scope, baseState);

    const before = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM working_state WHERE scope = $1",
      [scope]
    );

    await putState(pool, scope, baseState);

    const after = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM working_state WHERE scope = $1",
      [scope]
    );

    // 2 servers + 1 net + 1 vol + 1 svc + 1 dns + 1 backup = 7
    expect(Number(after.rows[0]?.count)).toBe(
      Number(before.rows[0]?.count)
    );
    expect(Number(after.rows[0]?.count)).toBe(7);
  });

  it("replace semantics: removed entities are deleted from working_state", async () => {
    const scope = "w-scope-replace";
    await putState(pool, scope, baseState);

    const reduced: State = {
      ...baseState,
      servers: [baseState.servers[0]!],
      volumes: [],
      backups: [],
    };
    await putState(pool, scope, reduced);

    const result = await getState(pool, scope);
    expect(result.servers).toHaveLength(1);
    expect(result.volumes).toHaveLength(0);
    expect(result.backups).toHaveLength(0);

    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM working_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    const entities = rows.rows.map((r) => r.entity);
    expect(entities.some((e) => e === "server:w-db-1")).toBe(false);
    expect(entities.some((e) => e === "volume:w-data")).toBe(false);
    expect(entities.some((e) => e === "backup:w-db-1")).toBe(false);
  });

  it("scope isolation: two scopes do not bleed into each other", async () => {
    const scopeX = "w-scope-iso-x";
    const scopeY = "w-scope-iso-y";

    const stateX: State = {
      ...baseState,
      servers: [
        {
          name: "x-server",
          type: "cx22",
          location: "hel1",
          image: "ubuntu-24.04",
          ssh_keys: [],
          labels: {},
          network: "x-net",
          status: "applying",
        },
      ],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    };

    const stateY: State = {
      ...baseState,
      servers: [],
      networks: [],
      volumes: [],
      services: [
        {
          name: "y-service",
          image: "nginx:latest",
          replicas: 1,
        },
      ],
      dns: [],
      backups: [],
    };

    await putState(pool, scopeX, stateX);
    await putState(pool, scopeY, stateY);

    const rx = await getState(pool, scopeX);
    const ry = await getState(pool, scopeY);

    expect(rx.servers).toHaveLength(1);
    expect(rx.servers[0]?.name).toBe("x-server");
    expect(rx.services).toHaveLength(0);

    expect(ry.servers).toHaveLength(0);
    expect(ry.services).toHaveLength(1);
    expect(ry.services[0]?.name).toBe("y-service");

    // Wipe Y; X must be unaffected
    await putState(pool, scopeY, {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [],
    });
    const rxAfter = await getState(pool, scopeX);
    expect(rxAfter.servers).toHaveLength(1);
  });

  it("empty scope: getState on an unknown scope returns a valid empty State", async () => {
    const result = await getState(pool, "w-scope-nonexistent");
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

  it("does NOT write to observed_state (tables are isolated)", async () => {
    const scope = "w-table-isolation";
    await putState(pool, scope, baseState);

    const rows = await pool.query<{ count: string }>(
      "SELECT COUNT(*) AS count FROM observed_state WHERE scope = $1",
      [scope]
    );
    expect(Number(rows.rows[0]?.count)).toBe(0);
  });

  // C1 regression — entity-key collision guard (working_state)
  // Mirrors the observed-store collision tests to confirm the fix applies to
  // both store facades (they share state-store-helper, so one fix covers both,
  // but both are tested for defence-in-depth).

  it("collision-free keys: DNS records whose old unescaped keys would collide are stored as two distinct rows in working_state", async () => {
    const scope = "w-collision-dns";

    // Collision pair under OLD (unescaped) scheme:
    //   A: zone="a",   name="b:c", type="A" → OLD key "dns:a:b:c:A"
    //   B: zone="a:b", name="c",   type="A" → OLD key "dns:a:b:c:A"  ← COLLISION
    // With escaping they diverge:
    //   A → "dns:a:b\:c:A"
    //   B → "dns:a\:b:c:A"

    const stateWithTwoDns: State = {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [
        { zone: "a",   name: "b:c", type: "A", value: "10.0.0.1", ttl: 60 },
        { zone: "a:b", name: "c",   type: "A", value: "10.0.0.2", ttl: 60 },
      ],
      backups: [],
    };

    await putState(pool, scope, stateWithTwoDns);
    const result = await getState(pool, scope);

    expect(result.dns).toHaveLength(2);
    const values = result.dns.map((d) => d.value).sort();
    expect(values).toEqual(["10.0.0.1", "10.0.0.2"]);

    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM working_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.entity).not.toBe(rows.rows[1]?.entity);
  });

  it("collision-free keys: backup targets containing `:` are stored as two distinct rows in working_state", async () => {
    const scope = "w-collision-backup";

    const stateWithTwoBackups: State = {
      servers: [],
      networks: [],
      volumes: [],
      services: [],
      dns: [],
      backups: [
        {
          target: "volume:pg-data",
          schedule: "0 1 * * *",
          retention: "7d",
          repo: "b2:bevox/bak",
        },
        {
          target: "volume:redis-data",
          schedule: "0 2 * * *",
          retention: "14d",
          repo: "b2:bevox/bak",
        },
      ],
    };

    await putState(pool, scope, stateWithTwoBackups);
    const result = await getState(pool, scope);

    expect(result.backups).toHaveLength(2);
    const targets = result.backups.map((b) => b.target).sort();
    expect(targets).toEqual(["volume:pg-data", "volume:redis-data"]);

    const rows = await pool.query<{ entity: string }>(
      "SELECT entity FROM working_state WHERE scope = $1 ORDER BY entity",
      [scope]
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0]?.entity).not.toBe(rows.rows[1]?.entity);
  });
});
