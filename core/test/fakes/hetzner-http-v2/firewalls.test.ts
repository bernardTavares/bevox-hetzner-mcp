/**
 * core/test/fakes/hetzner-http-v2/firewalls.test.ts
 *
 * Task 1.2 — proves the Firewall sub-fake (mounted on the Cloud-API fake) is
 * a faithful `fetchImpl` seam for the v2 Firewall provider/reconciler:
 *   - POST /firewalls / GET /firewalls/:id / GET /firewalls (paginated)
 *   - PUT /firewalls/:id/actions/set_rules
 *   - POST /firewalls/:id/actions/apply_to_resources
 *   - DELETE /firewalls/:id
 *   - 404 on unknown id
 *   - 429/Retry-After via the existing setRateLimitFault hook
 *
 * Wire-compat only: NOT a Hetzner spec emulator.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "../../../src/providers/http-client.js";
import { createHetznerHttpFake } from "../hetzner-http.js";

const BASE = "https://api.hetzner.cloud/v1";

interface FirewallRule {
  direction: "in" | "out";
  protocol: string;
  port?: string;
  source_ips?: string[];
  destination_ips?: string[];
}

interface Firewall {
  id: number;
  name: string;
  labels: Record<string, string>;
  created: string;
  rules: FirewallRule[];
  applied_to: Array<{ type: "server"; server: { id: number } }>;
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

describe("createHetznerHttpFake — /firewalls routes (1.2)", () => {
  it("POST /firewalls creates a firewall and returns { firewall, actions }", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: "web-fw",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "443",
            source_ips: ["0.0.0.0/0"],
            destination_ips: [],
          },
        ],
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { firewall: Firewall; actions: Action[] };
    expect(body.firewall.id).toBe(1);
    expect(body.firewall.name).toBe("web-fw");
    expect(body.firewall.labels).toEqual({});
    expect(typeof body.firewall.created).toBe("string");
    expect(body.firewall.rules).toHaveLength(1);
    expect(body.firewall.rules[0]?.port).toBe("443");
    expect(body.firewall.applied_to).toEqual([]);
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]?.command).toBe("create_firewall");
    expect(body.actions[0]?.status).toBe("success");
  });

  it("POST /firewalls accepts an optional apply_to[] and reflects it on the resource", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: "fw-with-targets",
        rules: [],
        apply_to: [{ type: "server", server: { id: 42 } }],
      }),
    });
    expect(res.status).toBe(201);
    const { firewall } = (await res.json()) as { firewall: Firewall };
    expect(firewall.applied_to).toEqual([{ type: "server", server: { id: 42 } }]);
  });

  it("POST /firewalls without name → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ rules: [] }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("POST /firewalls with malformed body → 400 invalid_input", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("GET /firewalls/:id returns the firewall just created", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ name: "fw-1", rules: [] }),
    });
    const got = await fake.fetch(`${BASE}/firewalls/1`);
    expect(got.status).toBe(200);
    const { firewall } = (await got.json()) as { firewall: Firewall };
    expect(firewall.id).toBe(1);
    expect(firewall.name).toBe("fw-1");
  });

  it("GET /firewalls/:id unknown → 404 not_found", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls/999`);
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("GET /firewalls paginates with per_page=2 over 5 items (1→2→3→null)", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/firewalls`, {
        method: "POST",
        body: JSON.stringify({ name, rules: [] }),
      });
    }

    const p1 = (await (
      await fake.fetch(`${BASE}/firewalls?per_page=2&page=1`)
    ).json()) as {
      firewalls: Firewall[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p1.firewalls).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p2 = (await (
      await fake.fetch(`${BASE}/firewalls?per_page=2&page=2`)
    ).json()) as {
      firewalls: Firewall[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p2.firewalls).toHaveLength(2);
    expect(p2.meta.pagination.next_page).toBe(3);

    const p3 = (await (
      await fake.fetch(`${BASE}/firewalls?per_page=2&page=3`)
    ).json()) as {
      firewalls: Firewall[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(p3.firewalls).toHaveLength(1);
    expect(p3.meta.pagination.next_page).toBeNull();
  });

  it("HttpClient.getAllPages walks /firewalls next_page chain to completion", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/firewalls`, {
        method: "POST",
        body: JSON.stringify({ name, rules: [] }),
      });
    }
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const all = await client.getAllPages<Firewall>(
      `${BASE}/firewalls?per_page=2`,
      "firewalls",
    );
    expect(all.map((f) => f.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("PUT /firewalls/:id/actions/set_rules replaces rules in place", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({
        name: "fw",
        rules: [{ direction: "in", protocol: "tcp", port: "22", source_ips: ["0.0.0.0/0"] }],
      }),
    });

    const newRules: FirewallRule[] = [
      { direction: "in", protocol: "tcp", port: "443", source_ips: ["10.0.0.0/8"] },
      { direction: "in", protocol: "tcp", port: "80", source_ips: ["10.0.0.0/8"] },
    ];
    const res = await fake.fetch(`${BASE}/firewalls/1/actions/set_rules`, {
      method: "PUT",
      body: JSON.stringify({ rules: newRules }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: Action[] };
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0]?.command).toBe("set_firewall_rules");
    expect(body.actions[0]?.status).toBe("success");

    const after = (await (await fake.fetch(`${BASE}/firewalls/1`)).json()) as {
      firewall: Firewall;
    };
    expect(after.firewall.rules).toEqual(newRules);
  });

  it("PUT /firewalls/:id/actions/set_rules on unknown id → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls/999/actions/set_rules`, {
      method: "PUT",
      body: JSON.stringify({ rules: [] }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("POST /firewalls/:id/actions/apply_to_resources updates applied_to[] in place", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ name: "fw", rules: [] }),
    });

    const apply_to = [
      { type: "server" as const, server: { id: 10 } },
      { type: "server" as const, server: { id: 20 } },
    ];
    const res = await fake.fetch(`${BASE}/firewalls/1/actions/apply_to_resources`, {
      method: "POST",
      body: JSON.stringify({ apply_to }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { actions: Action[] };
    expect(body.actions[0]?.command).toBe("apply_firewall_to_resources");

    const after = (await (await fake.fetch(`${BASE}/firewalls/1`)).json()) as {
      firewall: Firewall;
    };
    expect(after.firewall.applied_to).toEqual(apply_to);
  });

  it("POST /firewalls/:id/actions/apply_to_resources on unknown id → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls/999/actions/apply_to_resources`, {
      method: "POST",
      body: JSON.stringify({ apply_to: [] }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE /firewalls/:id removes the firewall (subsequent GET → 404)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ name: "fw", rules: [] }),
    });
    const del = await fake.fetch(`${BASE}/firewalls/1`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const gone = await fake.fetch(`${BASE}/firewalls/1`);
    expect(gone.status).toBe(404);
  });

  it("DELETE /firewalls/:id unknown → 404", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/firewalls/999`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  it("reuses the rate-limit fault hook on a /firewalls request (429 + Retry-After)", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 1, retryAfter: 3 });
    const limited = await fake.fetch(`${BASE}/firewalls`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("3");
    expect((await fake.fetch(`${BASE}/firewalls`)).status).toBe(200);
  });

  it("reset() clears firewall state and id counter independently", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ name: "fw-a", rules: [] }),
    });
    fake.reset();

    const created = await fake.fetch(`${BASE}/firewalls`, {
      method: "POST",
      body: JSON.stringify({ name: "fw-b", rules: [] }),
    });
    expect(created.status).toBe(201);
    expect((await created.json()).firewall.id).toBe(1);

    const list = (await (await fake.fetch(`${BASE}/firewalls`)).json()) as {
      firewalls: unknown[];
    };
    expect(list.firewalls).toHaveLength(1);
  });
});
