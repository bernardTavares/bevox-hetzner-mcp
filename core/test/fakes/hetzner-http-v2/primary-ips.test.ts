/**
 * core/test/fakes/hetzner-http-v2/primary-ips.test.ts
 *
 * Task 2.2 — proves the PrimaryIP sub-fake (mounted on the Cloud-API fake) is
 * a faithful `fetchImpl` seam for the v2 PrimaryIP provider/reconciler:
 *   - POST /primary_ips / GET /primary_ips/:id / GET /primary_ips (paginated)
 *   - PUT /primary_ips/:id (update mutable fields)
 *   - POST /primary_ips/:id/actions/assign | /unassign
 *   - DELETE /primary_ips/:id
 *   - 404 on unknown id (item + actions)
 *   - 429/Retry-After via the existing setRateLimitFault hook
 *
 * Wire-compat only: NOT a Hetzner spec emulator.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/providers/http-client.js";
import { createHetznerHttpFake } from "../hetzner-http.js";

const BASE = "https://api.hetzner.cloud/v1";

interface PrimaryIp {
  id: number;
  name: string;
  type: string;
  ip: string;
  datacenter: { name: string };
  assignee_type: string | null;
  assignee_id: number | null;
  labels: Record<string, string>;
  auto_delete: boolean;
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

describe("createHetznerHttpFake — /primary_ips routes (2.2)", () => {
  it("POST /primary_ips creates a primary_ip and returns { primary_ip, action }", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: "static-ip-1",
        type: "ipv4",
        datacenter: "fsn1-dc14",
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { primary_ip: PrimaryIp; action: Action };
    expect(body.primary_ip.id).toBe(1);
    expect(body.primary_ip.name).toBe("static-ip-1");
    expect(body.primary_ip.type).toBe("ipv4");
    expect(body.primary_ip.datacenter).toEqual({ name: "fsn1-dc14" });
    expect(body.primary_ip.labels).toEqual({});
    expect(body.primary_ip.auto_delete).toBe(false);
    expect(body.primary_ip.assignee_type).toBeNull();
    expect(body.primary_ip.assignee_id).toBeNull();
    expect(typeof body.primary_ip.created).toBe("string");
    expect(typeof body.primary_ip.ip).toBe("string");
    expect(body.action.command).toBe("create_primary_ip");
    expect(body.action.status).toBe("success");
  });

  it("POST /primary_ips with assignee fields reflects them on the resource", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: "ip-with-server",
        type: "ipv4",
        assignee_type: "server",
        assignee_id: 42,
        auto_delete: true,
        labels: { env: "prod" },
      }),
    });
    expect(res.status).toBe(201);
    const { primary_ip } = (await res.json()) as { primary_ip: PrimaryIp };
    expect(primary_ip.assignee_type).toBe("server");
    expect(primary_ip.assignee_id).toBe(42);
    expect(primary_ip.auto_delete).toBe(true);
    expect(primary_ip.labels).toEqual({ env: "prod" });
  });

  it("POST /primary_ips without name → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ type: "ipv4" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("POST /primary_ips with malformed body → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("GET /primary_ips/:id returns the resource just created", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "ip-1", type: "ipv4" }),
    });
    const got = await fake.fetch(`${BASE}/primary_ips/1`);
    expect(got.status).toBe(200);
    const { primary_ip } = (await got.json()) as { primary_ip: PrimaryIp };
    expect(primary_ip.id).toBe(1);
    expect(primary_ip.name).toBe("ip-1");
  });

  it("GET /primary_ips/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips/999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("GET /primary_ips paginates with per_page=2 over 5 items (1→2→3→null)", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/primary_ips`, {
        method: "POST",
        body: JSON.stringify({ name, type: "ipv4" }),
      });
    }

    const p1 = (await (
      await fake.fetch(`${BASE}/primary_ips?per_page=2&page=1`)
    ).json()) as {
      primary_ips: PrimaryIp[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p1.primary_ips).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p2 = (await (
      await fake.fetch(`${BASE}/primary_ips?per_page=2&page=2`)
    ).json()) as {
      primary_ips: PrimaryIp[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p2.primary_ips).toHaveLength(2);
    expect(p2.meta.pagination.next_page).toBe(3);

    const p3 = (await (
      await fake.fetch(`${BASE}/primary_ips?per_page=2&page=3`)
    ).json()) as {
      primary_ips: PrimaryIp[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p3.primary_ips).toHaveLength(1);
    expect(p3.meta.pagination.next_page).toBeNull();
  });

  it("HttpClient.getAllPages walks /primary_ips next_page chain to completion", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/primary_ips`, {
        method: "POST",
        body: JSON.stringify({ name, type: "ipv4" }),
      });
    }
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const all = await client.getAllPages<PrimaryIp>(
      `${BASE}/primary_ips?per_page=2`,
      "primary_ips",
    );
    expect(all.map((p) => p.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("PUT /primary_ips/:id updates mutable fields (name, labels, auto_delete)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "old-name", type: "ipv4" }),
    });

    const res = await fake.fetch(`${BASE}/primary_ips/1`, {
      method: "PUT",
      body: JSON.stringify({
        name: "new-name",
        labels: { tier: "edge" },
        auto_delete: true,
      }),
    });
    expect(res.status).toBe(200);
    const { primary_ip } = (await res.json()) as { primary_ip: PrimaryIp };
    expect(primary_ip.name).toBe("new-name");
    expect(primary_ip.labels).toEqual({ tier: "edge" });
    expect(primary_ip.auto_delete).toBe(true);

    const after = (await (await fake.fetch(`${BASE}/primary_ips/1`)).json()) as {
      primary_ip: PrimaryIp;
    };
    expect(after.primary_ip.name).toBe("new-name");
    expect(after.primary_ip.labels).toEqual({ tier: "edge" });
    expect(after.primary_ip.auto_delete).toBe(true);
  });

  it("PUT /primary_ips/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips/999`, {
      method: "PUT",
      body: JSON.stringify({ name: "x" }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("POST /primary_ips/:id/actions/assign sets assignee_type and assignee_id", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "ip", type: "ipv4" }),
    });

    const res = await fake.fetch(`${BASE}/primary_ips/1/actions/assign`, {
      method: "POST",
      body: JSON.stringify({ assignee_type: "server", assignee_id: 77 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: Action };
    expect(body.action.command).toBe("assign_primary_ip");
    expect(body.action.status).toBe("success");

    const after = (await (await fake.fetch(`${BASE}/primary_ips/1`)).json()) as {
      primary_ip: PrimaryIp;
    };
    expect(after.primary_ip.assignee_type).toBe("server");
    expect(after.primary_ip.assignee_id).toBe(77);
  });

  it("POST /primary_ips/:id/actions/assign on unknown id → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips/999/actions/assign`, {
      method: "POST",
      body: JSON.stringify({ assignee_type: "server", assignee_id: 1 }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /primary_ips/:id/actions/unassign clears assignee fields", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: "ip",
        type: "ipv4",
        assignee_type: "server",
        assignee_id: 42,
      }),
    });

    const res = await fake.fetch(`${BASE}/primary_ips/1/actions/unassign`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { action: Action };
    expect(body.action.command).toBe("unassign_primary_ip");

    const after = (await (await fake.fetch(`${BASE}/primary_ips/1`)).json()) as {
      primary_ip: PrimaryIp;
    };
    expect(after.primary_ip.assignee_type).toBeNull();
    expect(after.primary_ip.assignee_id).toBeNull();
  });

  it("POST /primary_ips/:id/actions/unassign on unknown id → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips/999/actions/unassign`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /primary_ips/:id removes the resource (subsequent GET → 404)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "ip", type: "ipv4" }),
    });
    const del = await fake.fetch(`${BASE}/primary_ips/1`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const gone = await fake.fetch(`${BASE}/primary_ips/1`);
    expect(gone.status).toBe(404);
  });

  it("DELETE /primary_ips/:id unknown → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/primary_ips/999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("reuses the rate-limit fault hook on a /primary_ips request (429 + Retry-After)", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 1, retryAfter: 3 });
    const limited = await fake.fetch(`${BASE}/primary_ips`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3");
    expect((await fake.fetch(`${BASE}/primary_ips`)).status).toBe(200);
  });

  it("reset() clears primary_ip state and id counter independently", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "ip-a", type: "ipv4" }),
    });
    fake.reset();

    const created = await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({ name: "ip-b", type: "ipv4" }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).primary_ip.id).toBe(1);

    const list = (await (await fake.fetch(`${BASE}/primary_ips`)).json()) as {
      primary_ips: unknown[];
    };
    expect(list.primary_ips).toHaveLength(1);
  });
});
