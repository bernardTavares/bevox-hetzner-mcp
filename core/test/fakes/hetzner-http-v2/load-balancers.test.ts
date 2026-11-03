/**
 * core/test/fakes/hetzner-http-v2/load-balancers.test.ts
 *
 * Task 4.2 — proves the LoadBalancer sub-fake (mounted on the Cloud-API fake)
 * is a faithful `fetchImpl` seam for the v2 LoadBalancer provider/reconciler:
 *   - POST /load_balancers / GET /load_balancers/:id / GET /load_balancers
 *     (paginated)
 *   - PUT /load_balancers/:id (update mutable fields: name, labels)
 *   - POST /load_balancers/:id/actions/add_target | remove_target
 *   - POST /load_balancers/:id/actions/change_algorithm
 *   - POST /load_balancers/:id/actions/add_service | update_service |
 *     delete_service
 *   - POST /load_balancers/:id/actions/change_type
 *   - DELETE /load_balancers/:id
 *   - 404 on unknown id (item + actions)
 *   - 429/Retry-After via the existing setRateLimitFault hook
 *
 * Wire-compat only: NOT a Hetzner spec emulator.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/providers/http-client.js";
import { createHetznerHttpFake } from "../hetzner-http.js";

const BASE = "https://api.hetzner.cloud/v1";

interface LoadBalancer {
  id: number;
  name: string;
  load_balancer_type: { name: string };
  location: { name: string };
  algorithm: { type: string };
  services: Array<{
    protocol: string;
    listen_port: number;
    destination_port: number;
    health_check: {
      protocol: string;
      port: number;
      interval: number;
      timeout: number;
      retries: number;
    };
  }>;
  targets: Array<{ type: string; server?: { id: number } }>;
  labels: Record<string, string>;
  public_net: {
    enabled: boolean;
    ipv4: { ip: string };
    ipv6: { ip: string };
  };
  created: string;
}

interface Action {
  id: number;
  command: string;
  status: "success";
  progress: number;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

describe("createHetznerHttpFake — /load_balancers routes (4.2)", () => {
  it("POST /load_balancers creates an LB and returns { load_balancer, action }", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "web-lb",
        load_balancer_type: "lb11",
        location: "fsn1",
        algorithm: { type: "round_robin" },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      load_balancer: LoadBalancer;
      action: Action;
    };
    expect(body.load_balancer.id).toBe(1);
    expect(body.load_balancer.name).toBe("web-lb");
    expect(body.load_balancer.load_balancer_type).toEqual({ name: "lb11" });
    expect(body.load_balancer.location).toEqual({ name: "fsn1" });
    expect(body.load_balancer.algorithm).toEqual({ type: "round_robin" });
    expect(body.load_balancer.services).toEqual([]);
    expect(body.load_balancer.targets).toEqual([]);
    expect(body.load_balancer.labels).toEqual({});
    expect(body.load_balancer.public_net.enabled).toBe(true);
    expect(typeof body.load_balancer.public_net.ipv4.ip).toBe("string");
    expect(typeof body.load_balancer.public_net.ipv6.ip).toBe("string");
    expect(typeof body.load_balancer.created).toBe("string");
    expect(body.action.command).toBe("create_load_balancer");
    expect(body.action.status).toBe("success");
  });

  it("POST /load_balancers without name → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({ load_balancer_type: "lb11", location: "fsn1" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("POST /load_balancers with malformed body → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("GET /load_balancers/:id returns the resource just created", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb-1",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });
    const got = await fake.fetch(`${BASE}/load_balancers/1`);
    expect(got.status).toBe(200);
    const { load_balancer } = (await got.json()) as {
      load_balancer: LoadBalancer;
    };
    expect(load_balancer.id).toBe(1);
    expect(load_balancer.name).toBe("lb-1");
  });

  it("GET /load_balancers/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers/999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("GET /load_balancers paginates with per_page=2 over 5 items", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/load_balancers`, {
        method: "POST",
        body: JSON.stringify({
          name,
          load_balancer_type: "lb11",
          location: "fsn1",
        }),
      });
    }

    const p1 = (await (
      await fake.fetch(`${BASE}/load_balancers?per_page=2&page=1`)
    ).json()) as {
      load_balancers: LoadBalancer[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p1.load_balancers).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p3 = (await (
      await fake.fetch(`${BASE}/load_balancers?per_page=2&page=3`)
    ).json()) as {
      load_balancers: LoadBalancer[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p3.load_balancers).toHaveLength(1);
    expect(p3.meta.pagination.next_page).toBeNull();
  });

  it("HttpClient.getAllPages walks /load_balancers next_page chain", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/load_balancers`, {
        method: "POST",
        body: JSON.stringify({
          name,
          load_balancer_type: "lb11",
          location: "fsn1",
        }),
      });
    }
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const all = await client.getAllPages<LoadBalancer>(
      `${BASE}/load_balancers?per_page=2`,
      "load_balancers",
    );
    expect(all.map((p) => p.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("PUT /load_balancers/:id updates mutable fields (name, labels)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "old-name",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });

    const res = await fake.fetch(`${BASE}/load_balancers/1`, {
      method: "PUT",
      body: JSON.stringify({
        name: "new-name",
        labels: { tier: "edge" },
        load_balancer_type: "lb31", // should be IGNORED (immutable via PUT)
      }),
    });
    expect(res.status).toBe(200);
    const { load_balancer } = (await res.json()) as {
      load_balancer: LoadBalancer;
    };
    expect(load_balancer.name).toBe("new-name");
    expect(load_balancer.labels).toEqual({ tier: "edge" });
    expect(load_balancer.load_balancer_type).toEqual({ name: "lb11" });
  });

  it("PUT /load_balancers/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers/999`, {
      method: "PUT",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST .../actions/add_target appends to targets[]", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });

    const res = await fake.fetch(`${BASE}/load_balancers/1/actions/add_target`, {
      method: "POST",
      body: JSON.stringify({ type: "server", server: { id: 42 } }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: Action };
    expect(body.action.command).toBe("add_target");

    const after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.targets).toEqual([
      { type: "server", server: { id: 42 } },
    ]);
  });

  it("POST .../actions/remove_target removes a matching server target", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });
    await fake.fetch(`${BASE}/load_balancers/1/actions/add_target`, {
      method: "POST",
      body: JSON.stringify({ type: "server", server: { id: 42 } }),
    });
    await fake.fetch(`${BASE}/load_balancers/1/actions/add_target`, {
      method: "POST",
      body: JSON.stringify({ type: "server", server: { id: 43 } }),
    });

    const res = await fake.fetch(
      `${BASE}/load_balancers/1/actions/remove_target`,
      {
        method: "POST",
        body: JSON.stringify({ type: "server", server: { id: 42 } }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: Action }).action.command).toBe(
      "remove_target",
    );

    const after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.targets).toEqual([
      { type: "server", server: { id: 43 } },
    ]);
  });

  it("POST .../actions/change_algorithm updates algorithm.type", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });

    const res = await fake.fetch(
      `${BASE}/load_balancers/1/actions/change_algorithm`,
      {
        method: "POST",
        body: JSON.stringify({ type: "least_connections" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: Action }).action.command).toBe(
      "change_algorithm",
    );

    const after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.algorithm).toEqual({
      type: "least_connections",
    });
  });

  it("POST .../actions/add_service appends, update_service mutates, delete_service removes", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });

    const add = await fake.fetch(
      `${BASE}/load_balancers/1/actions/add_service`,
      {
        method: "POST",
        body: JSON.stringify({
          protocol: "http",
          listen_port: 80,
          destination_port: 8080,
          health_check: {
            protocol: "http",
            port: 8080,
            interval: 15,
            timeout: 10,
            retries: 3,
          },
        }),
      },
    );
    expect(add.status).toBe(200);
    expect(((await add.json()) as { action: Action }).action.command).toBe(
      "add_service",
    );

    let after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.services).toHaveLength(1);
    expect(after.load_balancer.services[0]!.destination_port).toBe(8080);

    const upd = await fake.fetch(
      `${BASE}/load_balancers/1/actions/update_service`,
      {
        method: "POST",
        body: JSON.stringify({
          listen_port: 80,
          destination_port: 9090,
          protocol: "http",
          health_check: {
            protocol: "http",
            port: 9090,
            interval: 15,
            timeout: 10,
            retries: 3,
          },
        }),
      },
    );
    expect(upd.status).toBe(200);
    expect(((await upd.json()) as { action: Action }).action.command).toBe(
      "update_service",
    );
    after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.services[0]!.destination_port).toBe(9090);

    const del = await fake.fetch(
      `${BASE}/load_balancers/1/actions/delete_service`,
      {
        method: "POST",
        body: JSON.stringify({ listen_port: 80 }),
      },
    );
    expect(del.status).toBe(200);
    expect(((await del.json()) as { action: Action }).action.command).toBe(
      "delete_service",
    );
    after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.services).toEqual([]);
  });

  it("POST .../actions/change_type updates load_balancer_type.name", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });

    const res = await fake.fetch(
      `${BASE}/load_balancers/1/actions/change_type`,
      {
        method: "POST",
        body: JSON.stringify({ load_balancer_type: "lb31" }),
      },
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: Action }).action.command).toBe(
      "change_type",
    );

    const after = (await (await fake.fetch(`${BASE}/load_balancers/1`)).json()) as {
      load_balancer: LoadBalancer;
    };
    expect(after.load_balancer.load_balancer_type).toEqual({ name: "lb31" });
  });

  it("POST .../actions/<x> on unknown LB id → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(
      `${BASE}/load_balancers/999/actions/add_target`,
      {
        method: "POST",
        body: JSON.stringify({ type: "server", server: { id: 1 } }),
      },
    );
    expect(res.status).toBe(404);
  });

  it("DELETE /load_balancers/:id removes the resource (subsequent GET → 404)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });
    const del = await fake.fetch(`${BASE}/load_balancers/1`, {
      method: "DELETE",
    });
    expect(del.status).toBe(204);
    const gone = await fake.fetch(`${BASE}/load_balancers/1`);
    expect(gone.status).toBe(404);
  });

  it("DELETE /load_balancers/:id unknown → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/load_balancers/999`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("reuses the rate-limit fault hook on a /load_balancers request (429 + Retry-After)", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 1, retryAfter: 3 });
    const limited = await fake.fetch(`${BASE}/load_balancers`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3");
    expect((await fake.fetch(`${BASE}/load_balancers`)).status).toBe(200);
  });

  it("reset() clears LB state and id counter independently", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb-a",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });
    fake.reset();

    const created = await fake.fetch(`${BASE}/load_balancers`, {
      method: "POST",
      body: JSON.stringify({
        name: "lb-b",
        load_balancer_type: "lb11",
        location: "fsn1",
      }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).load_balancer.id).toBe(1);

    const list = (await (await fake.fetch(`${BASE}/load_balancers`)).json()) as {
      load_balancers: unknown[];
    };
    expect(list.load_balancers).toHaveLength(1);
  });
});
