/**
 * core/src/providers/hetzner-dns.test.ts
 *
 * Task 5.2 — drives HetznerDNSProvider against the in-process Hetzner HTTP
 * fake's hcloud DNS routes (core/test/fakes/hetzner-http.ts, extended in 5.1).
 * ZERO network / DB / filesystem.
 *
 * Central guarantee under test (spec §"idempotência por design"; §"fail-safe,
 * nunca fail-deleting"):
 *
 *   - apply(set_dns) is a NON-DESTRUCTIVE UPSERT: create when absent, update
 *     when a stable field differs, NO-OP (changed:false, ZERO writes) when
 *     already equal. Converged re-apply does ZERO writes (no flap).
 *   - proven by the provider-agnostic conformanceHarness (with its observe
 *     scope teeth) AND by an independent write-count assertion.
 *   - NEVER deletes: a destructive op (remove/destroy) is a safe no-op; an
 *     unmanaged record present in the zone is never removed.
 *   - error mapping flows strictly through domain/errors.ts: 429 → transient,
 *     401 → fatal, missing zone → precondition (BEFORE any write), malformed
 *     desired → precondition (no crash). Token never leaked.
 *   - the request body shape sent to POST/PUT /records is asserted
 *     INDEPENDENTLY (the fake is lax on value/ttl — see 5.1 reviewer note).
 */

import { describe, it, expect } from "vitest";
import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { HttpClient } from "./http-client.js";
import { createHetznerDnsProvider } from "./hetzner-dns.js";
import { conformanceHarness, type PlanAction } from "./provider.js";
import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Harness: a provider wired to a fresh fake, zero-delay retry seams so the
// 429 path is deterministic and fast. A capturing fetch wrapper lets tests
// assert the EXACT request-body shape the provider sends (the fake itself is
// lax on record value/ttl, so we never rely on it to catch a malformed body).
// ---------------------------------------------------------------------------

interface Capture {
  method: string;
  url: string;
  body: unknown;
}

function makeRig() {
  const fake = createHetznerHttpFake();
  const calls: Capture[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown;
    if (init?.body != null) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    calls.push({ method, url, body });
    return fake.fetch(input, init);
  };
  const makeProvider = () =>
    createHetznerDnsProvider({
      token: "secret-token",
      baseUrl: "https://dns.hetzner.com/api/v1",
      http: new HttpClient({
        fetchImpl,
        sleep: async () => {},
        random: () => 0,
        defaultHeaders: { Authorization: "Bearer secret-token" },
      }),
    });
  /** Count write requests (record create/update) the provider performed. */
  const writeCount = () =>
    calls.filter(
      (c) =>
        (c.method === "POST" && c.url.includes("/records")) ||
        (c.method === "PUT" && c.url.includes("/records")),
    ).length;
  return { fake, makeProvider, calls, writeCount };
}

/** Seed a zone directly via the fake so `zone` resolution succeeds. */
async function seedZone(fake: ReturnType<typeof createHetznerHttpFake>, name: string) {
  await fake.fetch("https://dns.hetzner.com/api/v1/zones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

const RECORD_ACTION: PlanAction = {
  op: "upsert",
  entity: "dns:www.example.com",
  desired: {
    zone: "example.com",
    name: "www",
    type: "A",
    value: "203.0.113.10",
    ttl: 300,
  },
};

const RECORD_ACTION_2: PlanAction = {
  op: "upsert",
  entity: "dns:api.example.com",
  desired: {
    zone: "example.com",
    name: "api",
    type: "A",
    value: "203.0.113.20",
    ttl: 600,
  },
};

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — observe", () => {
  it("lists records across pages via getAllPages", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    // 60 records (fake default per_page=25 → 3 pages) proves the cursor walk.
    for (let i = 0; i < 60; i++) {
      await p.apply({
        op: "upsert",
        entity: `dns:r${i}.example.com`,
        desired: {
          zone: "example.com",
          name: `r${i}`,
          type: "A",
          value: `203.0.113.${i}`,
          ttl: 300,
        },
      });
    }

    const obs = await p.observe("dns");
    expect(obs.scope).toBe("dns");
    expect(obs.entities).toHaveLength(60);
    expect(obs.entities.map((e) => e.key)).toContain("dns:r0.example.com");
    expect(obs.entities.map((e) => e.key)).toContain("dns:r59.example.com");
    fake.reset();
  });
});

// ---------------------------------------------------------------------------
// idempotency — conformanceHarness oracle + write-count teeth
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — idempotency (conformanceHarness oracle)", () => {
  it("passes the conformance harness for a record (observe scope teeth)", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    await conformanceHarness(makeProvider, RECORD_ACTION, "dns");
  });

  it("passes the conformance harness for a SECOND record", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    await conformanceHarness(makeProvider, RECORD_ACTION_2, "dns");
  });

  it("create then re-apply = no-op the 2nd time (ZERO writes, no flap)", async () => {
    const { fake, makeProvider, writeCount } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    const first = await p.apply(RECORD_ACTION);
    expect(first.changed).toBe(true);
    expect(writeCount()).toBe(1); // exactly one create
    expect(await p.verify(RECORD_ACTION)).toBe(true);

    // Re-converge several times — must stay changed:false with NO new writes.
    for (let i = 0; i < 3; i++) {
      const again = await p.apply(RECORD_ACTION);
      expect(again.changed).toBe(false);
    }
    expect(writeCount()).toBe(1); // STILL exactly one — zero extra writes
    expect(await p.verify(RECORD_ACTION)).toBe(true);

    // Exactly one record exists — no duplicate created.
    expect((await p.observe("dns")).entities.map((e) => e.key)).toEqual([
      "dns:www.example.com",
    ]);
  });

  it("updates in place (PUT, no resurrection) when a stable field differs", async () => {
    const { fake, makeProvider, calls, writeCount } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    await p.apply(RECORD_ACTION);
    expect(writeCount()).toBe(1);

    const changed: PlanAction = {
      ...RECORD_ACTION,
      desired: { ...(RECORD_ACTION.desired as object), value: "203.0.113.99", ttl: 120 },
    };
    const res = await p.apply(changed);
    expect(res.changed).toBe(true);

    // The 2nd write is a PUT /records/<id> (update), NOT a POST (no duplicate,
    // no delete-then-recreate).
    const writes = calls.filter(
      (c) =>
        (c.method === "POST" || c.method === "PUT") && c.url.includes("/records"),
    );
    expect(writes).toHaveLength(2);
    expect(writes[1]!.method).toBe("PUT");
    expect(writes[1]!.url).toMatch(/\/records\/\d+/);

    expect(await p.verify(changed)).toBe(true);
    // Still exactly one record — updated, not duplicated.
    expect((await p.observe("dns")).entities.map((e) => e.key)).toEqual([
      "dns:www.example.com",
    ]);
    // And it has converged again.
    expect((await p.apply(changed)).changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// request-body shape — asserted INDEPENDENTLY of the lax fake (5.1 note)
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — request body shape (independent of fake)", () => {
  it("POST /records carries a well-typed {zone_id,name,type,value,ttl}", async () => {
    const { fake, makeProvider, calls } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    await p.apply(RECORD_ACTION);

    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/records"),
    );
    expect(post).toBeDefined();
    const body = post!.body as Record<string, unknown>;
    expect(typeof body.zone_id).toBe("string");
    expect((body.zone_id as string).length).toBeGreaterThan(0);
    expect(body.name).toBe("www");
    expect(body.type).toBe("A");
    expect(body.value).toBe("203.0.113.10");
    expect(body.ttl).toBe(300);
    expect(typeof body.ttl).toBe("number");
  });

  it("PUT /records/<id> carries the full well-typed body on update", async () => {
    const { fake, makeProvider, calls } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    await p.apply(RECORD_ACTION);
    const changed: PlanAction = {
      ...RECORD_ACTION,
      desired: { ...(RECORD_ACTION.desired as object), value: "198.51.100.7", ttl: 900 },
    };
    await p.apply(changed);

    const put = calls.find(
      (c) => c.method === "PUT" && c.url.includes("/records"),
    );
    expect(put).toBeDefined();
    const body = put!.body as Record<string, unknown>;
    expect(typeof body.zone_id).toBe("string");
    expect(body.name).toBe("www");
    expect(body.type).toBe("A");
    expect(body.value).toBe("198.51.100.7");
    expect(body.ttl).toBe(900);
    expect(typeof body.ttl).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// fail-safe — NEVER deletes
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — fail-safe (never deletes)", () => {
  it("destructive ops (remove/destroy) are a safe no-op, record kept", async () => {
    const { fake, makeProvider, calls } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    await p.apply(RECORD_ACTION);

    for (const op of ["remove", "destroy"] as const) {
      const res = await p.apply({ ...RECORD_ACTION, op });
      expect(res.changed).toBe(false);
    }
    // No DELETE was ever issued by the provider.
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    // Fail-safe: the record still exists.
    expect((await p.observe("dns")).entities.map((e) => e.key)).toEqual([
      "dns:www.example.com",
    ]);
  });

  it("an unmanaged record in the zone is never removed by an unrelated apply", async () => {
    const { fake, makeProvider, calls } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    // Pre-existing unmanaged record (not in any desired action).
    await p.apply({
      op: "upsert",
      entity: "dns:legacy.example.com",
      desired: {
        zone: "example.com",
        name: "legacy",
        type: "A",
        value: "10.0.0.1",
        ttl: 60,
      },
    });

    // Apply a DIFFERENT record — must not touch the unmanaged one.
    await p.apply(RECORD_ACTION);

    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    const obs = await p.observe("dns");
    expect(obs.entities.map((e) => e.key)).toContain("dns:legacy.example.com");
    expect(obs.entities.map((e) => e.key)).toContain("dns:www.example.com");
  });
});

// ---------------------------------------------------------------------------
// error mapping — strictly via domain/errors.ts
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — error mapping (via domain/errors.ts)", () => {
  it("429 from the API → transient ReconcileError", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();
    fake.setRateLimitFault({ times: 5, retryAfter: 1 });

    await expect(p.observe("dns")).rejects.toMatchObject({
      errorClass: "transient",
    });
  });

  it("401 from the API → fatal ReconcileError", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setAuthFault(true);

    await expect(p.observe("dns")).rejects.toMatchObject({
      errorClass: "fatal",
    });
  });

  it("missing zone → precondition (BEFORE any write)", async () => {
    const { makeProvider, writeCount } = makeRig();
    const p = makeProvider();

    let caught: unknown;
    try {
      await p.apply(RECORD_ACTION); // "example.com" zone does not exist
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ReconcileError);
    expect((caught as ReconcileError).errorClass).toBe("precondition");
    // Fail-safe: nothing written by the failed precondition path.
    expect(writeCount()).toBe(0);
  });

  it("malformed desired → precondition (no crash)", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();

    await expect(
      p.apply({
        op: "upsert",
        entity: "dns:bad.example.com",
        desired: { zone: "example.com", name: "bad", type: "", value: 42 },
      }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });

  it("does not leak the token in error messages", async () => {
    const { fake, makeProvider } = makeRig();
    const p = makeProvider();
    fake.setAuthFault(true);

    try {
      await p.observe("dns");
      throw new Error("expected a ReconcileError");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret-token");
    }
  });

  it("does not leak the token when the create path fails", async () => {
    const { fake, makeProvider } = makeRig();
    await seedZone(fake, "example.com");
    const p = makeProvider();
    fake.setAuthFault(true);

    try {
      await p.apply(RECORD_ACTION);
      throw new Error("expected a ReconcileError");
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("secret-token");
    }
  });
});

// ---------------------------------------------------------------------------
// scope guard + construction
// ---------------------------------------------------------------------------

describe("HetznerDNSProvider — scope guard / construction", () => {
  it("rejects an unknown scope as precondition (no silent crash)", async () => {
    const { makeProvider } = makeRig();
    await expect(makeProvider().observe("server")).rejects.toMatchObject({
      errorClass: "precondition",
    });
  });

  it("a missing token is a fatal construction error", () => {
    expect(() => createHetznerDnsProvider({ token: "" })).toThrow(
      ReconcileError,
    );
  });
});
