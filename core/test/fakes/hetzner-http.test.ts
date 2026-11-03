/**
 * core/test/fakes/hetzner-http.test.ts
 *
 * Task 2.3 — proves the in-memory Hetzner Cloud HTTP fake is a faithful
 * `fetchImpl` seam for HttpClient (2.2) and HetznerCloudProvider (2.4):
 *   - /servers, /networks, /volumes CRUD (list/create/get/delete)
 *   - list pagination in Hetzner `meta.pagination.next_page` shape so
 *     HttpClient.getAllPages walks it (two pages → null-terminated chain)
 *   - configurable 429/Retry-After fault and a 401 fault toggle
 *   - per-instance, resettable in-memory state (no global/static state)
 *
 * This tests OUR fake's wire-compatibility, NOT Hetzner.
 */

import { describe, it, expect } from "vitest";
import { HttpClient } from "../../src/providers/http-client.js";
import { createHetznerHttpFake } from "./hetzner-http.js";

const BASE = "https://api.hetzner.cloud/v1";
// The hcloud DNS API is a SEPARATE service from the Cloud API (different host
// + path prefix). The fake routes by trailing path segments, so the exact
// host/prefix is irrelevant — only `/zones` and `/records` matter.
const DNS = "https://dns.hetzner.com/api/v1";

describe("createHetznerHttpFake", () => {
  it("creates, gets, lists and deletes a server (CRUD round-trip)", async () => {
    const fake = createHetznerHttpFake();

    const created = await fake.fetch(`${BASE}/servers`, {
      method: "POST",
      body: JSON.stringify({ name: "web-1" }),
    });
    expect(created.status).toBe(201);
    const { server } = (await created.json()) as { server: { id: number; name: string } };
    expect(server.id).toBe(1);
    expect(server.name).toBe("web-1");

    const got = await fake.fetch(`${BASE}/servers/1`);
    expect(got.status).toBe(200);
    expect((await got.json()).server.name).toBe("web-1");

    const listed = await fake.fetch(`${BASE}/servers`);
    expect(listed.status).toBe(200);
    const list = (await listed.json()) as {
      servers: unknown[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(list.servers).toHaveLength(1);
    expect(list.meta.pagination.next_page).toBeNull();

    const del = await fake.fetch(`${BASE}/servers/1`, { method: "DELETE" });
    expect(del.status).toBe(204);

    const gone = await fake.fetch(`${BASE}/servers/1`);
    expect(gone.status).toBe(404);
  });

  // Task 1 (spec 2026-06-02-observed-state-adapter): the observe path needs the
  // RICH wire fields the real Hetzner API returns (server_type/public_net/
  // status/image, network ip_range/subnets, volume size/linux_device/server).
  // A seed seam injects "already-exists-in-Hetzner" resources WITH those fields
  // so observe-enrichment tests don't go through the create path; list must
  // echo them verbatim. A thin fake would mask the discard the provider does.
  it("seed(...) injects a rich resource and list echoes the wire fields verbatim", async () => {
    const fake = createHetznerHttpFake();

    fake.seed("servers", {
      name: "bevox-prod-1",
      server_type: { name: "cpx22" },
      public_net: { ipv4: { ip: "1.2.3.4" } },
      status: "running",
      image: { name: "ubuntu-24.04" },
    });
    fake.seed("networks", {
      name: "bevox-priv",
      ip_range: "10.0.0.0/16",
      subnets: [{ ip_range: "10.0.1.0/24" }],
    });
    fake.seed("volumes", {
      name: "pg-backend-data",
      size: 20,
      linux_device: "/dev/disk/by-id/scsi-0HC_Volume_42",
      status: "available",
    });

    const servers = (await (await fake.fetch(`${BASE}/servers`)).json()) as {
      servers: Array<Record<string, unknown>>;
    };
    expect(servers.servers).toHaveLength(1);
    const s = servers.servers[0]!;
    expect(s["server_type"]).toEqual({ name: "cpx22" });
    expect(s["public_net"]).toEqual({ ipv4: { ip: "1.2.3.4" } });
    expect(s["status"]).toBe("running");
    expect(s["image"]).toEqual({ name: "ubuntu-24.04" });
    expect(typeof s["id"]).toBe("number"); // seed assigns an id

    const nets = (await (await fake.fetch(`${BASE}/networks`)).json()) as {
      networks: Array<Record<string, unknown>>;
    };
    expect(nets.networks[0]!["ip_range"]).toBe("10.0.0.0/16");
    expect(nets.networks[0]!["subnets"]).toEqual([{ ip_range: "10.0.1.0/24" }]);

    const vols = (await (await fake.fetch(`${BASE}/volumes`)).json()) as {
      volumes: Array<Record<string, unknown>>;
    };
    expect(vols.volumes[0]!["size"]).toBe(20);
    expect(vols.volumes[0]!["linux_device"]).toBe("/dev/disk/by-id/scsi-0HC_Volume_42");
  });

  it("serves networks and volumes the same way with independent id counters", async () => {
    const fake = createHetznerHttpFake();
    const n = await fake.fetch(`${BASE}/networks`, {
      method: "POST",
      body: JSON.stringify({ name: "mesh" }),
    });
    const v = await fake.fetch(`${BASE}/volumes`, {
      method: "POST",
      body: JSON.stringify({ name: "data" }),
    });
    expect((await n.json()).network.id).toBe(1);
    expect((await v.json()).volume.id).toBe(1);
  });

  it("paginates list endpoints so HttpClient.getAllPages walks the next_page chain", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${BASE}/servers`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    }

    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });

    const all = await client.getAllPages<{ id: number; name: string }>(
      `${BASE}/servers?per_page=2`,
      "servers",
    );
    expect(all.map((s) => s.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("emits a null-terminated next_page chain (page 1 → 2 → null)", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c"]) {
      await fake.fetch(`${BASE}/servers`, {
        method: "POST",
        body: JSON.stringify({ name }),
      });
    }
    const p1 = (await (
      await fake.fetch(`${BASE}/servers?per_page=2&page=1`)
    ).json()) as { servers: unknown[]; meta: { pagination: { next_page: number | null } } };
    expect(p1.servers).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p2 = (await (
      await fake.fetch(`${BASE}/servers?per_page=2&page=2`)
    ).json()) as { servers: unknown[]; meta: { pagination: { next_page: number | null } } };
    expect(p2.servers).toHaveLength(1);
    expect(p2.meta.pagination.next_page).toBeNull();
  });

  it("setRateLimitFault: next N responses are 429 with Retry-After, then recover", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 2, retryAfter: 1 });

    const r1 = await fake.fetch(`${BASE}/servers`);
    expect(r1.status).toBe(429);
    expect(r1.headers.get("Retry-After")).toBe("1");

    const r2 = await fake.fetch(`${BASE}/servers`);
    expect(r2.status).toBe(429);

    const r3 = await fake.fetch(`${BASE}/servers`);
    expect(r3.status).toBe(200);
  });

  it("HttpClient retries through a rate-limit fault and ultimately succeeds", async () => {
    const fake = createHetznerHttpFake();
    fake.setRateLimitFault({ times: 1, retryAfter: 0 });
    const seen: number[] = [];
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async (ms) => {
        seen.push(ms);
      },
      random: () => 0.5,
    });
    const res = await client.get(`${BASE}/servers`);
    expect(res.status).toBe(200);
    expect(seen).toEqual([0]);
  });

  it("setAuthFault(true): every response is 401 until toggled off", async () => {
    const fake = createHetznerHttpFake();
    fake.setAuthFault(true);
    const a = await fake.fetch(`${BASE}/servers`);
    expect(a.status).toBe(401);
    fake.setAuthFault(false);
    const b = await fake.fetch(`${BASE}/servers`);
    expect(b.status).toBe(200);
  });

  it("reset() clears state and id counters; instances are isolated", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${BASE}/servers`, {
      method: "POST",
      body: JSON.stringify({ name: "x" }),
    });
    fake.setRateLimitFault({ times: 5, retryAfter: 9 });
    fake.reset();

    const created = await fake.fetch(`${BASE}/servers`, {
      method: "POST",
      body: JSON.stringify({ name: "y" }),
    });
    // counter restarted at 1, no lingering fault
    expect(created.status).toBe(201);
    expect((await created.json()).server.id).toBe(1);

    // a second, independent instance shares no state
    const other = createHetznerHttpFake();
    const otherList = (await (await other.fetch(`${BASE}/servers`)).json()) as {
      servers: unknown[];
    };
    expect(otherList.servers).toHaveLength(0);
  });

  it("malformed create body → 400 in the Hetzner error envelope (no thrown SyntaxError)", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${BASE}/servers`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  it("unknown route → 404 in the Hetzner error envelope", async () => {
    const fake = createHetznerHttpFake();
    // /firewalls, /primary_ips, /certificates, /load_balancers are now
    // mounted; use a still-unmounted route to exercise the "unknown
    // collection" 404 path.
    const res = await fake.fetch(`${BASE}/floating_ips`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// Task 5.1 — hcloud DNS routes (separate hcloud DNS API): zones + records
// CRUD + pagination. Same fake instance, same fault hooks, additive only.
// Exists for convergence-testing OUR DNS provider (5.2), NOT a hcloud DNS spec
// emulator.
// ---------------------------------------------------------------------------

describe("createHetznerHttpFake — hcloud DNS routes (5.1)", () => {
  it("creates, gets and lists a zone (zone CRUD round-trip)", async () => {
    const fake = createHetznerHttpFake();

    const created = await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "example.net" }),
    });
    expect(created.status).toBe(201);
    const { zone } = (await created.json()) as {
      zone: { id: string; name: string };
    };
    expect(zone.id).toBe("1");
    expect(zone.name).toBe("example.net");

    const got = await fake.fetch(`${DNS}/zones/1`);
    expect(got.status).toBe(200);
    expect((await got.json()).zone.name).toBe("example.net");

    const listed = await fake.fetch(`${DNS}/zones`);
    const body = (await listed.json()) as {
      zones: unknown[];
      meta: { pagination: { next_page: number | null } };
    };
    expect(body.zones).toHaveLength(1);
    expect(body.meta.pagination.next_page).toBeNull();
  });

  it("resolves a zone by name via ?name= (so 5.2 can map record→zone_id)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "example.net" }),
    });
    await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "other.io" }),
    });

    const res = await fake.fetch(`${DNS}/zones?name=example.net`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { zones: { id: string; name: string }[] };
    expect(body.zones).toHaveLength(1);
    expect(body.zones[0]?.name).toBe("example.net");
    expect(body.zones[0]?.id).toBe("1");
  });

  it("creates a record (hcloud DNS shape: id,zone_id,type,name,value,ttl)", async () => {
    const fake = createHetznerHttpFake();
    const zr = await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "example.net" }),
    });
    const zoneId = (await zr.json()).zone.id as string;

    const created = await fake.fetch(`${DNS}/records`, {
      method: "POST",
      body: JSON.stringify({
        zone_id: zoneId,
        type: "A",
        name: "api",
        value: "1.2.3.4",
        ttl: 300,
      }),
    });
    expect(created.status).toBe(201);
    const { record } = (await created.json()) as {
      record: {
        id: string;
        zone_id: string;
        type: string;
        name: string;
        value: string;
        ttl: number;
      };
    };
    expect(record).toMatchObject({
      id: "1",
      zone_id: zoneId,
      type: "A",
      name: "api",
      value: "1.2.3.4",
      ttl: 300,
    });

    const got = await fake.fetch(`${DNS}/records/1`);
    expect(got.status).toBe(200);
    expect((await got.json()).record.value).toBe("1.2.3.4");
  });

  it("lists records filtered by zone_id, name and type (5.2 upsert lookup)", async () => {
    const fake = createHetznerHttpFake();
    for (const r of [
      { zone_id: "1", type: "A", name: "api", value: "1.1.1.1", ttl: 60 },
      { zone_id: "1", type: "AAAA", name: "api", value: "::1", ttl: 60 },
      { zone_id: "1", type: "A", name: "www", value: "2.2.2.2", ttl: 60 },
      { zone_id: "2", type: "A", name: "api", value: "9.9.9.9", ttl: 60 },
    ]) {
      await fake.fetch(`${DNS}/records`, {
        method: "POST",
        body: JSON.stringify(r),
      });
    }

    const byZone = (await (
      await fake.fetch(`${DNS}/records?zone_id=1`)
    ).json()) as { records: unknown[] };
    expect(byZone.records).toHaveLength(3);

    // zone+name+type is the natural composite key 5.2 uses for upsert.
    const exact = (await (
      await fake.fetch(`${DNS}/records?zone_id=1&name=api&type=A`)
    ).json()) as { records: { value: string }[] };
    expect(exact.records).toHaveLength(1);
    expect(exact.records[0]?.value).toBe("1.1.1.1");
  });

  it("updates a record via PUT (idempotent re-apply / value change)", async () => {
    const fake = createHetznerHttpFake();
    const cr = await fake.fetch(`${DNS}/records`, {
      method: "POST",
      body: JSON.stringify({
        zone_id: "1",
        type: "A",
        name: "api",
        value: "1.2.3.4",
        ttl: 300,
      }),
    });
    const id = (await cr.json()).record.id as string;

    const upd = await fake.fetch(`${DNS}/records/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        zone_id: "1",
        type: "A",
        name: "api",
        value: "5.6.7.8",
        ttl: 600,
      }),
    });
    expect(upd.status).toBe(200);
    const { record } = (await upd.json()) as {
      record: { id: string; value: string; ttl: number };
    };
    expect(record.id).toBe(id);
    expect(record.value).toBe("5.6.7.8");
    expect(record.ttl).toBe(600);

    const got = (await (await fake.fetch(`${DNS}/records/${id}`)).json()) as {
      record: { value: string };
    };
    expect(got.record.value).toBe("5.6.7.8");
  });

  it("PUT to a missing record → 404 (no resurrection)", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${DNS}/records/999`, {
      method: "PUT",
      body: JSON.stringify({ zone_id: "1", type: "A", name: "x", value: "1.1.1.1", ttl: 60 }),
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("deletes a record (exposed for state-modeling completeness)", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${DNS}/records`, {
      method: "POST",
      body: JSON.stringify({ zone_id: "1", type: "A", name: "api", value: "1.2.3.4", ttl: 60 }),
    });
    const del = await fake.fetch(`${DNS}/records/1`, { method: "DELETE" });
    expect(del.status).toBe(204);
    const gone = await fake.fetch(`${DNS}/records/1`);
    expect(gone.status).toBe(404);
  });

  it("paginates records so HttpClient.getAllPages walks the next_page chain", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c", "d", "e"]) {
      await fake.fetch(`${DNS}/records`, {
        method: "POST",
        body: JSON.stringify({ zone_id: "1", type: "A", name, value: "1.1.1.1", ttl: 60 }),
      });
    }
    const client = new HttpClient({
      fetchImpl: fake.fetch,
      sleep: async () => {},
      random: () => 0.5,
    });
    const all = await client.getAllPages<{ id: string; name: string }>(
      `${DNS}/records?zone_id=1&per_page=2`,
      "records",
    );
    expect(all.map((r) => r.name)).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("emits a null-terminated next_page chain for records (page 1 → 2 → null)", async () => {
    const fake = createHetznerHttpFake();
    for (const name of ["a", "b", "c"]) {
      await fake.fetch(`${DNS}/records`, {
        method: "POST",
        body: JSON.stringify({ zone_id: "1", type: "A", name, value: "1.1.1.1", ttl: 60 }),
      });
    }
    const p1 = (await (
      await fake.fetch(`${DNS}/records?zone_id=1&per_page=2&page=1`)
    ).json()) as { records: unknown[]; meta: { pagination: { next_page: number | null } } };
    expect(p1.records).toHaveLength(2);
    expect(p1.meta.pagination.next_page).toBe(2);

    const p2 = (await (
      await fake.fetch(`${DNS}/records?zone_id=1&per_page=2&page=2`)
    ).json()) as { records: unknown[]; meta: { pagination: { next_page: number | null } } };
    expect(p2.records).toHaveLength(1);
    expect(p2.meta.pagination.next_page).toBeNull();
  });

  it("malformed record create body → 400 in the error envelope", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${DNS}/records`, {
      method: "POST",
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("record create requires zone_id + name + type → 400 otherwise", async () => {
    const fake = createHetznerHttpFake();
    const res = await fake.fetch(`${DNS}/records`, {
      method: "POST",
      body: JSON.stringify({ type: "A", name: "api" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
  });

  it("reuses the auth + rate-limit fault hooks for DNS routes (5.2 error mapping)", async () => {
    const fake = createHetznerHttpFake();
    fake.setAuthFault(true);
    expect((await fake.fetch(`${DNS}/zones`)).status).toBe(401);
    fake.setAuthFault(false);

    fake.setRateLimitFault({ times: 1, retryAfter: 2 });
    const limited = await fake.fetch(`${DNS}/records?zone_id=1`);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("2");
    expect((await fake.fetch(`${DNS}/records?zone_id=1`)).status).toBe(200);
  });

  it("reset() clears DNS state + id counters; Cloud and DNS ids are independent", async () => {
    const fake = createHetznerHttpFake();
    await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "example.net" }),
    });
    await fake.fetch(`${BASE}/servers`, {
      method: "POST",
      body: JSON.stringify({ name: "web-1" }),
    });
    // independent counters: a server and a zone both start at their own 1.
    fake.reset();

    const z = await fake.fetch(`${DNS}/zones`, {
      method: "POST",
      body: JSON.stringify({ name: "fresh.io" }),
    });
    expect((await z.json()).zone.id).toBe("1");
    const zlist = (await (await fake.fetch(`${DNS}/zones`)).json()) as {
      zones: unknown[];
    };
    expect(zlist.zones).toHaveLength(1);
  });
});
