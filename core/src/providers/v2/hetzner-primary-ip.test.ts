/**
 * core/src/providers/v2/hetzner-primary-ip.test.ts
 *
 * Task F2.3 — HetznerPrimaryIPProvider drives observe + plan + apply + verify
 * against the in-process Hetzner v2 primary_ips fake. ZERO network.
 *
 * Central guarantees (spec-mãe §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; spec-filha Bloco A; F2.3 brief):
 *
 *   - plan() on a fresh backend (observed null) emits `create`. When desired ==
 *     observed (same name, type, location, same assignment), ops is empty.
 *   - apply() converges then is a NO-OP on the second run (idempotency).
 *   - Selector resolution: matches 1 server ⇒ `assign`; matches 0 servers AND
 *     observed is assigned ⇒ `unassign`; matches >1 servers ⇒ provider raises
 *     `precondition` (inline ≤1 invariant; PolicyEngine moves this in Bloco
 *     C).
 *   - Selector ABSENT is NOT an unassign command. Currently-assigned state is
 *     reported as drift in plan; apply leaves it untouched (fail-safe).
 *   - Location/type changes ⇒ `precondition` (immutable; recreation via F2.4).
 *   - Error classification: 429 → transient; 422 → precondition.
 */

import { describe, it, expect } from "vitest";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import {
  createHetznerV2HttpClient,
  type HetznerV2HttpClient,
} from "./hetzner-cloud-v2-http.js";
import { createHetznerPrimaryIPProvider } from "./hetzner-primary-ip.js";
import type { PrimaryIP } from "../../domain/entities-v2.js";
import type { Server } from "../../domain/entities.js";
import { ReconcileError } from "../../domain/errors.js";

const BASE = "https://api.hetzner.cloud/v1";

function providerWithFake(opts?: { servers?: Server[] }) {
  const fake = createHetznerHttpFake();
  const v2: HetznerV2HttpClient = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fake.fetch,
  });
  const servers: Server[] = opts?.servers ?? [];
  const p = createHetznerPrimaryIPProvider({
    http: v2,
    serversProvider: async () => servers,
  });
  return { fake, v2, p, servers };
}

function mkServer(
  name: string,
  hcloud_id: number,
  labels: Record<string, string> = {},
): Server {
  return {
    name,
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-22.04",
    ssh_keys: [],
    labels,
    network: "mesh",
    status: "healthy",
    hcloud_id,
  };
}

const DESIRED: PrimaryIP = {
  name: "web-ip",
  type: "ipv4",
  location: "fsn1-dc14",
  assignee_selector: { label: "web" },
};

const DESIRED_NO_SELECTOR: PrimaryIP = {
  name: "web-ip",
  type: "ipv4",
  location: "fsn1-dc14",
};

describe("HetznerPrimaryIPProvider — plan/apply/verify (F2.3)", () => {
  it("plan creates primary_ip when absent", async () => {
    const { p } = providerWithFake();
    const plan = await p.plan(DESIRED, null);
    expect(plan.ops).toEqual([{ op: "create", entity: "primary_ip:web-ip" }]);
  });

  it("plan is no-op when desired == observed (idempotency)", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: DESIRED.location,
        assignee_type: "server",
        assignee_id: 10,
      }),
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toEqual([]);
  });

  it("apply is idempotent: second call same desired = no-op", async () => {
    const { p } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    let observed = await p.observe(DESIRED.name);
    const first = await p.apply(DESIRED, observed);
    expect(first.changed).toBe(true);
    observed = await p.observe(DESIRED.name);
    const second = await p.apply(DESIRED, observed);
    expect(second.changed).toBe(false);
  });

  it("apply assigns when selector matches 1 server and observed is unassigned", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Seed an UNASSIGNED primary_ip with the desired shape.
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: DESIRED.location,
      }),
    });
    const observed = await p.observe(DESIRED.name);
    expect(observed!.hetzner.assignee_id).toBeNull();
    const r = await p.apply(DESIRED, observed);
    expect(r.changed).toBe(true);
    const after = await p.observe(DESIRED.name);
    expect(after!.hetzner.assignee_type).toBe("server");
    expect(after!.hetzner.assignee_id).toBe(10);
  });

  it("apply unassigns when selector matches 0 servers AND observed is assigned", async () => {
    // Seed with an assignment to server 10, but the per-cycle servers
    // snapshot has NO server matching the selector → selector resolves to [].
    const { p, fake } = providerWithFake({ servers: [] });
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: DESIRED.location,
        assignee_type: "server",
        assignee_id: 10,
      }),
    });
    const observed = await p.observe(DESIRED.name);
    expect(observed!.hetzner.assignee_id).toBe(10);
    const r = await p.apply(DESIRED, observed);
    expect(r.changed).toBe(true);
    const after = await p.observe(DESIRED.name);
    expect(after!.hetzner.assignee_type).toBeNull();
    expect(after!.hetzner.assignee_id).toBeNull();
  });

  it("apply returns precondition_failed when selector matches >1 server (inline ≤1 invariant)", async () => {
    const { p } = providerWithFake({
      servers: [
        mkServer("web-1", 10, { web: "" }),
        mkServer("web-2", 11, { web: "" }),
      ],
    });
    const observed = await p.observe(DESIRED.name);
    let raised: unknown;
    try {
      await p.apply(DESIRED, observed);
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(ReconcileError);
    expect((raised as ReconcileError).errorClass).toBe("precondition");
    expect((raised as ReconcileError).message).toMatch(/at most one server/);
  });

  it("apply returns precondition when location-change is attempted (recreation needed)", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Seed in a different datacenter than desired.
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: "nbg1-dc3",
      }),
    });
    const observed = await p.observe(DESIRED.name);
    let raised: unknown;
    try {
      await p.apply(DESIRED, observed);
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(ReconcileError);
    expect((raised as ReconcileError).errorClass).toBe("precondition");
    expect((raised as ReconcileError).message).toMatch(/location immutable/);
  });

  it("drift in assignment (out-of-band reassign) is reported in plan", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    // Seed assigned to a DIFFERENT (out-of-band) server id.
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: DESIRED.location,
        assignee_type: "server",
        assignee_id: 999,
      }),
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    // Desired's selector resolves to id=10; observed has id=999.
    // That's a strict mismatch which is convergeable → `update`, not `drift`.
    // But the test brief says "drift in assignment is reported": when the
    // agent did NOT declare a selector (DESIRED_NO_SELECTOR) and observed is
    // assigned, that IS pure drift (fail-safe never silently unassigns).
    expect(plan.ops).toEqual([
      { op: "update", entity: "primary_ip:web-ip", target: "assignment" },
    ]);
    // The fail-safe drift case: no selector declared, observed assigned.
    const driftPlan = await p.plan(DESIRED_NO_SELECTOR, observed);
    expect(driftPlan.ops).toEqual([
      { op: "drift", entity: "primary_ip:web-ip", target: "assignment" },
    ]);
    // And apply on that drift plan is a no-op (never silently unassign).
    const r = await p.apply(DESIRED_NO_SELECTOR, observed);
    expect(r.changed).toBe(false);
    const after = await p.observe(DESIRED_NO_SELECTOR.name);
    expect(after!.hetzner.assignee_id).toBe(999);
  });

  it("verify() returns true only after observed matches desired", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });
    expect(await p.verify(DESIRED)).toBe(false);
    await fake.fetch(`${BASE}/primary_ips`, {
      method: "POST",
      body: JSON.stringify({
        name: DESIRED.name,
        type: DESIRED.type,
        datacenter: DESIRED.location,
        assignee_type: "server",
        assignee_id: 999, // wrong assignment
      }),
    });
    expect(await p.verify(DESIRED)).toBe(false);
    const observed = await p.observe(DESIRED.name);
    await p.apply(DESIRED, observed);
    expect(await p.verify(DESIRED)).toBe(true);
  });

  it("classify error: 429 → transient; 422 → precondition", async () => {
    const { p, fake } = providerWithFake({
      servers: [mkServer("web-1", 10, { web: "" })],
    });

    // 429 retried until exhaustion → surfaces as transient.
    fake.setRateLimitFault({ times: 10, retryAfter: 0 });
    let raised: unknown;
    try {
      await p.observe(DESIRED.name);
    } catch (e) {
      raised = e;
    }
    expect(raised).toBeInstanceOf(ReconcileError);
    expect((raised as ReconcileError).errorClass).toBe("transient");

    fake.reset();
    fake.setNextRequestFault({
      status: 422,
      code: "invalid_input",
      message: "primary_ip: invalid datacenter",
    });
    let raised422: unknown;
    try {
      await p.observe(DESIRED.name);
    } catch (e) {
      raised422 = e;
    }
    expect(raised422).toBeInstanceOf(ReconcileError);
    expect((raised422 as ReconcileError).errorClass).toBe("precondition");
  });
});
