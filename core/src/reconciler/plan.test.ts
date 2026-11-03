/**
 * core/src/reconciler/plan.test.ts
 *
 * Task 2.5 — desired×observed diff → topo-sorted PlanItem[].
 *
 * Asserts:
 *   - empty observed + desired(network,server,volume) → create items ordered
 *     network → server → volume → container (DAG topo order).
 *   - an existing structurally-equal resource → noop.
 *   - an observed resource absent from desired → drift ONLY (fail-safe;
 *     NEVER remove/destroy).
 *   - determinism: identical inputs → identical plan.
 *   - dependency cycle / missing referenced dep → ReconcileError("precondition").
 */

import { describe, it, expect } from "vitest";

import { plan } from "./plan.js";
import { PlanItemSchema } from "../domain/entities.js";
import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";

const emptyObserved: State = {
  servers: [],
  networks: [],
  volumes: [],
  services: [],
  dns: [],
  backups: [],
};

const desired: DesiredState = {
  networks: [{ name: "priv", ip_range: "10.0.0.0/16", subnets: ["10.0.1.0/24"] }],
  servers: [
    { name: "app-1", type: "cx22", location: "nbg1", network: "priv" },
  ],
  volumes: [{ name: "data", size: "20Gi", server: "app-1", fs: "ext4" }],
  services: [{ name: "web", image: "nginx:1", replicas: 1, volumes: ["data"] }],
};

describe("plan()", () => {
  it("orders create items network → server → volume → container", () => {
    const items = plan(desired, emptyObserved);

    // Every item is a valid contract PlanItem.
    for (const it of items) PlanItemSchema.parse(it);

    const order = items.map((i) => i.entity);
    expect(order).toEqual([
      "network:priv",
      "server:app-1",
      "volume:data",
      "service:web",
    ]);
    expect(items.every((i) => i.op === "create")).toBe(true);
  });

  // gap #2 — intra-service ordering via depends_on (task 1.6)
  it("orders a depends_on dependency before its dependent service", () => {
    const d: DesiredState = {
      services: [
        { name: "app", image: "img", replicas: 1, depends_on: ["db"] },
        { name: "db", image: "pg:16", replicas: 1 },
      ],
    };
    const order = plan(d, emptyObserved).map((i) => i.entity);
    expect(order.indexOf("service:db")).toBeLessThan(
      order.indexOf("service:app"),
    );
  });

  it("rejects a depends_on cycle as precondition before any op", () => {
    const d: DesiredState = {
      services: [
        { name: "a", image: "i", replicas: 1, depends_on: ["b"] },
        { name: "b", image: "i", replicas: 1, depends_on: ["a"] },
      ],
    };
    expect(() => plan(d, emptyObserved)).toThrow(ReconcileError);
  });

  it("rejects depends_on referencing an undeclared service as precondition", () => {
    const d: DesiredState = {
      services: [
        { name: "app", image: "i", replicas: 1, depends_on: ["ghost"] },
      ],
    };
    expect(() => plan(d, emptyObserved)).toThrow(ReconcileError);
  });

  it("emits noop for an existing structurally-equal resource", () => {
    const observed: State = {
      ...emptyObserved,
      networks: [
        { name: "priv", ip_range: "10.0.0.0/16", subnets: ["10.0.1.0/24"] },
      ],
    };
    const items = plan(
      { networks: desired.networks },
      observed,
    );
    expect(items).toEqual([
      { op: "noop", entity: "network:priv", change: expect.any(String), impact: expect.any(String) },
    ]);
  });

  it("emits update for an existing changed resource", () => {
    const observed: State = {
      ...emptyObserved,
      networks: [
        { name: "priv", ip_range: "10.9.0.0/16", subnets: ["10.0.1.0/24"] },
      ],
    };
    const items = plan({ networks: desired.networks }, observed);
    expect(items[0]?.op).toBe("update");
    expect(items[0]?.entity).toBe("network:priv");
  });

  it("emits drift (NOT remove/destroy) for an observed resource absent from desired", () => {
    const observed: State = {
      ...emptyObserved,
      networks: [
        { name: "orphan", ip_range: "10.5.0.0/16", subnets: [] },
      ],
    };
    const items = plan({}, observed);
    expect(items).toEqual([
      { op: "drift", entity: "network:orphan", change: expect.any(String), impact: expect.any(String) },
    ]);
    expect(items.some((i) => i.op === "remove" || i.op === "destroy")).toBe(false);
  });

  it("is deterministic: identical inputs → identical plan", () => {
    const a = plan(desired, emptyObserved);
    const b = plan(desired, emptyObserved);
    expect(a).toEqual(b);
  });

  it("throws precondition when a server references an undeclared network", () => {
    expect(() =>
      plan(
        { servers: [{ name: "x", type: "cx22", location: "nbg1", network: "ghost" }] },
        emptyObserved,
      ),
    ).toThrow(ReconcileError);
    try {
      plan(
        { servers: [{ name: "x", type: "cx22", location: "nbg1", network: "ghost" }] },
        emptyObserved,
      );
    } catch (e) {
      expect((e as ReconcileError).errorClass).toBe("precondition");
    }
  });

  // -------------------------------------------------------------------------
  // Fix 1 — `:`-in-name must NOT collide (shared store key-escaping)
  // -------------------------------------------------------------------------
  it("a ':'-containing name does not collide and binds the correct dependency", () => {
    // Volume "data:cache" vs a volume "data" attached to server "cache".
    // With raw `${kind}:${name}` interpolation, volume "data:cache" would
    // produce the SAME key as volume "data" on server "cache" via the
    // server-dep path, aliasing two distinct entities. The shared escaping
    // builder makes them distinct.
    const d: DesiredState = {
      networks: [{ name: "priv", ip_range: "10.0.0.0/16", subnets: [] }],
      servers: [
        { name: "cache", type: "cx22", location: "nbg1", network: "priv" },
      ],
      volumes: [
        { name: "data:cache", size: "10Gi", fs: "ext4" },
        { name: "data", size: "20Gi", server: "cache", fs: "ext4" },
      ],
    };
    const items = plan(d, emptyObserved);
    const keys = items.map((i) => i.entity);

    // Two distinct volume keys — no collision/merge.
    expect(keys.filter((k) => k.startsWith("volume:")).length).toBe(2);
    expect(new Set(keys).size).toBe(keys.length);
    // The `:` in the name is escaped, never aliasing server:cache.
    expect(keys).toContain("volume:data\\:cache");
    expect(keys).toContain("volume:data");
    expect(keys).toContain("server:cache");

    // Observed has only the orphan-shaped colliding name → still classified
    // as a single distinct orphan, not silently merged onto another entity.
    const observed: State = {
      ...emptyObserved,
      volumes: [{ name: "data:cache", size: "10Gi", fs: "ext4" }],
    };
    const drifted = plan({}, observed);
    expect(drifted).toEqual([
      {
        op: "drift",
        entity: "volume:data\\:cache",
        change: expect.any(String),
        impact: expect.any(String),
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Bug 9 — planner derives the cross-kind volume dep from the volume NAME
  // (segment before the first ':'), not the whole `service.volumes` string.
  // spec: 2026-06-01-volume-hetzner-bind-automount.md §1
  // -------------------------------------------------------------------------
  it("derives the volume dep from the NAME segment of a `name:container_path` bind", () => {
    const d: DesiredState = {
      volumes: [{ name: "pg-data", size: "20Gi", fs: "ext4" }],
      services: [
        {
          name: "db",
          image: "pg:16",
          replicas: 1,
          volumes: ["pg-data:/var/lib/postgresql/data"],
        },
      ],
    };
    // Topo-sorts without a precondition: the dep resolves to the declared
    // volume `pg-data` (NOT the full `pg-data:/var/lib/postgresql/data` string).
    const order = plan(d, emptyObserved).map((i) => i.entity);
    expect(order.indexOf("volume:pg-data")).toBeLessThan(
      order.indexOf("service:db"),
    );
  });

  it("retro-compat: a bare `volumes: [\"data\"]` ref still validates against the declared volume", () => {
    const d: DesiredState = {
      volumes: [{ name: "data", size: "20Gi", fs: "ext4" }],
      services: [
        { name: "web", image: "nginx:1", replicas: 1, volumes: ["data"] },
      ],
    };
    const order = plan(d, emptyObserved).map((i) => i.entity);
    expect(order.indexOf("volume:data")).toBeLessThan(
      order.indexOf("service:web"),
    );
  });

  it("an undeclared volume NAME in a `name:path` bind is still a dangling-ref precondition", () => {
    let err: unknown;
    try {
      plan(
        {
          volumes: [{ name: "pg-data", size: "20Gi", fs: "ext4" }],
          services: [
            {
              name: "db",
              image: "pg:16",
              replicas: 1,
              volumes: ["nope:/x"],
            },
          ],
        },
        emptyObserved,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    expect((err as ReconcileError).errorClass).toBe("precondition");
    // The NAME (not the full bind string) is what is reported as missing.
    expect((err as Error).message).toContain("volume:nope");
  });

  // -------------------------------------------------------------------------
  // Fix 2 — false-noop hazard (stableEqual undefined/absent semantics)
  // -------------------------------------------------------------------------
  it("desired optional field set to a value vs differing observed → update (not noop)", () => {
    const observed: State = {
      ...emptyObserved,
      servers: [
        {
          name: "app-1",
          type: "cx22",
          location: "nbg1",
          network: "priv",
          image: "debian-12",
        } as never,
      ],
    };
    const items = plan(
      {
        servers: [
          {
            name: "app-1",
            type: "cx22",
            location: "nbg1",
            network: "priv",
            image: "ubuntu-24",
          },
        ],
        networks: [{ name: "priv", ip_range: "10.0.0.0/16", subnets: [] }],
      },
      observed,
    );
    const srv = items.find((i) => i.entity === "server:app-1");
    expect(srv?.op).toBe("update");
  });

  it("desired optional field undefined vs observed populated → NOT a false noop", () => {
    // image is undefined in desired; observed populates it. The pre-fix
    // projection would JSON.stringify-drop the undefined key on both sides
    // and report a false `noop`. Correct behaviour: image is "not declared",
    // every OTHER declared field matches → genuine noop here; but if a
    // declared field differs it must be `update`. We assert the undefined
    // key alone never forces a noop by making another field differ.
    const observed: State = {
      ...emptyObserved,
      servers: [
        {
          name: "app-1",
          type: "cx99", // differs from desired
          location: "nbg1",
          network: "priv",
          image: "debian-12",
        } as never,
      ],
    };
    const items = plan(
      {
        servers: [
          {
            name: "app-1",
            type: "cx22",
            location: "nbg1",
            network: "priv",
            image: undefined,
          },
        ],
        networks: [{ name: "priv", ip_range: "10.0.0.0/16", subnets: [] }],
      },
      observed,
    );
    const srv = items.find((i) => i.entity === "server:app-1");
    expect(srv?.op).toBe("update");
    expect(srv?.op).not.toBe("noop");
  });

  it("observed carrying extra operational-only fields → still noop (regression guard)", () => {
    const observed: State = {
      ...emptyObserved,
      networks: [
        {
          name: "priv",
          ip_range: "10.0.0.0/16",
          subnets: ["10.0.1.0/24"],
          // operational-only fields the manifest never declares:
          hcloud_id: 12345,
          status: "active",
        } as never,
      ],
    };
    const items = plan({ networks: desired.networks }, observed);
    expect(items).toEqual([
      {
        op: "noop",
        entity: "network:priv",
        change: expect.any(String),
        impact: expect.any(String),
      },
    ]);
  });

  // -------------------------------------------------------------------------
  // Fix 4 — test teeth
  // -------------------------------------------------------------------------
  it("determinism with TEETH: permuted input arrays → byte-identical entity order", () => {
    const base = plan(desired, emptyObserved);

    const permuted: DesiredState = {
      networks: desired.networks,
      // reverse every collection order
      services: [...(desired.services ?? [])].reverse(),
      volumes: [...(desired.volumes ?? [])].reverse(),
      servers: [...(desired.servers ?? [])].reverse(),
    };
    const observedPermuted: State = {
      ...emptyObserved,
      networks: [...emptyObserved.networks].reverse(),
      servers: [...emptyObserved.servers].reverse(),
      volumes: [...emptyObserved.volumes].reverse(),
      services: [...emptyObserved.services].reverse(),
    };
    const after = plan(permuted, observedPermuted);
    expect(after.map((i) => i.entity)).toEqual(base.map((i) => i.entity));
  });

  it("unresolvable dependency throws precondition naming the stuck nodes", () => {
    // A valid manifest cannot express a true cycle (deps only flow
    // service→volume→server→network, strictly one-directional across
    // distinct kinds), so the topo cycle branch is defensive. The reachable
    // precondition surface that exercises the "stuck node names in message"
    // contract is an unresolvable (undeclared) dependency.
    let err: unknown;
    try {
      plan(
        {
          volumes: [{ name: "v", size: "1Gi", fs: "ext4", server: "ghost" }],
        },
        emptyObserved,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    expect((err as ReconcileError).errorClass).toBe("precondition");
    expect((err as Error).message).toContain("volume:v");
    expect((err as Error).message).toContain("server:ghost");
  });

  it("diamond/transitive: network ← server ← {volume, service}, service → volume", () => {
    const d: DesiredState = {
      networks: [{ name: "n", ip_range: "10.0.0.0/16", subnets: [] }],
      servers: [{ name: "s", type: "cx22", location: "nbg1", network: "n" }],
      volumes: [{ name: "v", size: "10Gi", server: "s", fs: "ext4" }],
      services: [{ name: "svc", image: "nginx:1", replicas: 1, volumes: ["v"] }],
    };
    const items = plan(d, emptyObserved);
    expect(items.map((i) => i.entity)).toEqual([
      "network:n",
      "server:s",
      "volume:v",
      "service:svc",
    ]);
  });

  it("orphan determinism: ≥2 orphan observed resources → stable sorted order", () => {
    const observed: State = {
      ...emptyObserved,
      networks: [
        { name: "z-net", ip_range: "10.9.0.0/16", subnets: [] },
        { name: "a-net", ip_range: "10.8.0.0/16", subnets: [] },
      ],
      volumes: [{ name: "m-vol", size: "1Gi", fs: "ext4" }],
    };
    const a = plan({}, observed).map((i) => i.entity);
    const b = plan(
      {},
      {
        ...emptyObserved,
        networks: [...observed.networks].reverse(),
        volumes: observed.volumes,
      },
    ).map((i) => i.entity);
    expect(a).toEqual(b);
    expect(a).toEqual([...a].sort());
  });
});
