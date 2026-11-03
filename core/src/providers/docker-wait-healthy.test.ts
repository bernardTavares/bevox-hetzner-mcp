/**
 * core/src/providers/docker-wait-healthy.test.ts
 *
 * Task 2.0.4+ — the wait-for-healthy seam. Drives the docker-http fake's
 * State.Health.Status driver through an INJECTED clock (no wall-clock wait).
 */

import { describe, it, expect } from "vitest";
import { createDockerHttpFake } from "../../test/fakes/docker-http.js";
import { createDockerProvider } from "./docker.js";
import { waitForHealthy } from "./docker-wait-healthy.js";

type Fake = ReturnType<typeof createDockerHttpFake>;

async function nameExists(fake: Fake, name: string): Promise<boolean> {
  const list = await fake.transport.request("GET", "/containers/json");
  const arr = list.json as Array<{ Names: string[] }>;
  return arr.some((c) => c.Names[0] === `/${name}`);
}

async function seedReplica(
  fake: Fake,
  service: string,
  idx: number,
): Promise<void> {
  await fake.transport.request(
    "POST",
    `/containers/create?name=${service}-${idx}`,
    {
      Image: "x:1",
      Labels: {
        "bevox.managed": "true",
        "bevox.service": service,
        "bevox.replica": String(idx),
      },
    },
  );
}

/** An injected clock whose `sleep` advances `now` — deterministic, no waiting. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number): Promise<void> => {
      t += ms;
    },
    elapsed: () => t,
  };
}

describe("waitForHealthy", () => {
  it("returns healthy once all replicas report healthy (within budget)", async () => {
    const fake = createDockerHttpFake();
    await seedReplica(fake, "db", 0);
    fake.setHealth("db-0", ["starting", "starting", "healthy"]);

    const clock = fakeClock();
    const outcome = await waitForHealthy("db", 120_000, {
      call: (m, p, b) => fake.transport.request(m, p, b),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ outcome: "healthy" });
    // Polled on the injected clock (transitioned starting→healthy), never the
    // wall clock; budget not exceeded.
    expect(clock.elapsed()).toBeGreaterThan(0);
    expect(clock.elapsed()).toBeLessThan(120_000);
  });

  it("returns healthy immediately when the only replica is already healthy", async () => {
    const fake = createDockerHttpFake();
    await seedReplica(fake, "redis", 0);
    fake.setHealth("redis-0", ["healthy"]);

    const clock = fakeClock();
    const outcome = await waitForHealthy("redis", 120_000, {
      call: (m, p, b) => fake.transport.request(m, p, b),
      now: clock.now,
      sleep: clock.sleep,
    });

    expect(outcome).toEqual({ outcome: "healthy" });
    expect(clock.elapsed()).toBe(0); // no poll needed
  });

  it("returns healthy (vacuous) when the dep has no managed replicas", async () => {
    const fake = createDockerHttpFake();
    const clock = fakeClock();
    const outcome = await waitForHealthy("ghost", 120_000, {
      call: (m, p, b) => fake.transport.request(m, p, b),
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(outcome).toEqual({ outcome: "healthy" });
    expect(clock.elapsed()).toBe(0); // never polled/slept
  });
});

// ---------------------------------------------------------------------------
// 2.0.5 — apply() wiring: no-HEALTHCHECK dep ⇒ degraded-skip
// ---------------------------------------------------------------------------

describe("DockerProvider.apply — wait-for-healthy degraded-skip (2.0.5)", () => {
  it("dep without HEALTHCHECK ⇒ dependent IS created + service.wait_skipped event", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({ transport: fake.transport });

    // Bring up the dep service; no setHealth ⇒ inspect carries no State.Health.
    await p.apply({
      op: "create",
      entity: "service:db",
      desired: { name: "db", image: "pg:16", replicas: 1 },
    });

    const res = await p.apply({
      op: "create",
      entity: "service:app",
      desired: { name: "app", image: "x:1", replicas: 1, depends_on: ["db"] },
    });

    // Degraded-skip: the dependent was still created (ordering-only fallback)…
    expect(res.changed).toBe(true);
    expect(await nameExists(fake, "app-0")).toBe(true);
    // …and the skip is surfaced as a provider event for the Record step.
    expect(res.events).toEqual([
      { op: "service.wait_skipped", after: { reason: "no_healthcheck", dep: "db" } },
    ]);
    // Fail-safe: the dep was not removed.
    expect(await nameExists(fake, "db-0")).toBe(true);
  });

  it("dep that IS healthy ⇒ dependent created with NO events", async () => {
    const fake = createDockerHttpFake();
    const p = createDockerProvider({ transport: fake.transport });

    await p.apply({
      op: "create",
      entity: "service:db",
      desired: { name: "db", image: "pg:16", replicas: 1 },
    });
    fake.setHealth("db-0", ["healthy"]);

    const res = await p.apply({
      op: "create",
      entity: "service:app",
      desired: { name: "app", image: "x:1", replicas: 1, depends_on: ["db"] },
    });

    expect(res.changed).toBe(true);
    expect(await nameExists(fake, "app-0")).toBe(true);
    expect(res.events ?? []).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2.0.6 — apply() wiring: timeout aborts by return (fail-safe)
// ---------------------------------------------------------------------------

describe("DockerProvider.apply — wait-for-healthy timeout abort (2.0.6)", () => {
  it("dep never healthy ⇒ dependent NOT created, changed:false + dep_health_timeout; nothing deleted; reconverges", async () => {
    const fake = createDockerHttpFake();
    let t = 0;
    const p = createDockerProvider({
      transport: fake.transport,
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    });

    await p.apply({
      op: "create",
      entity: "service:db",
      desired: { name: "db", image: "pg:16", replicas: 1 },
    });
    fake.setHealth("db-0", ["starting"]); // never becomes healthy

    const appAction = {
      op: "create" as const,
      entity: "service:app",
      desired: {
        name: "app",
        image: "x:1",
        replicas: 1,
        depends_on: [{ name: "db", wait_healthy_timeout: "5s" }],
      },
    };
    const res = await p.apply(appAction);

    // Abort by return — NOT a throw.
    expect(res.changed).toBe(false);
    expect(res.events).toEqual([
      {
        op: "service.dep_health_timeout",
        after: { dep: "db", status: "starting", waited_ms: 5000 },
      },
    ]);
    // FAIL-SAFE: the dependent was NOT created; the dep was NOT removed.
    expect(await nameExists(fake, "app-0")).toBe(false);
    expect(await nameExists(fake, "db-0")).toBe(true);

    // Reconverge next cycle: dep now healthy ⇒ dependent is created.
    fake.setHealth("db-0", ["healthy"]);
    const res2 = await p.apply(appAction);
    expect(res2.changed).toBe(true);
    expect(res2.events ?? []).toEqual([]);
    expect(await nameExists(fake, "app-0")).toBe(true);
  });
});
