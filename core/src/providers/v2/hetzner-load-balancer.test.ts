/**
 * core/src/providers/v2/hetzner-load-balancer.test.ts
 *
 * Task F4.3 — HetznerLoadBalancerProvider drives observe + plan + apply +
 * verify against the in-process Hetzner v2 load_balancers fake. ZERO network.
 *
 * Central guarantees (spec-mãe + spec-filha Bloco A; F4.3 brief):
 *
 *   - plan() on a fresh backend (observed null) emits `create`. When desired ==
 *     observed (location/algorithm/targets/health_check all match), ops empty.
 *   - apply() converges then is a NO-OP on the second run (idempotency).
 *   - LOCATION change ⇒ plan emits a SINGLE `recreate` op (with the
 *     "public IP will change" impact note); apply REFUSES with `precondition`
 *     (the destroy+create flow is gated by the F4.4 tool, never auto-applied).
 *   - Algorithm change ⇒ `update_algorithm` op; apply calls
 *     actions/change_algorithm.
 *   - Target diff (servers added/removed in the manifest delta) ⇒
 *     `update_targets` op; apply emits add_target/remove_target per-server.
 *   - Targets resolved via service_selector → server_selector chain. Provider
 *     walks: matched Services → each Service's server_selector → union of
 *     matched Servers.
 *   - Drift: a target that exists on Hetzner but NOT in the desired union is
 *     reported. F4.3 simplification: managed = all observed (see module
 *     header); apply DOES re-converge but plan surfaces drift first so the
 *     agent sees the picture.
 *   - No Firewall handling: provider has zero firewall imports/calls (LB has
 *     no firewall attachment; IngressProvider in F5 handles backend-server
 *     firewall).
 *   - Error classification: 429 → transient; 422 → precondition.
 */

import { describe, it, expect } from "vitest";
import { createHetznerHttpFake } from "../../../test/fakes/hetzner-http.js";
import {
  createHetznerV2HttpClient,
  type HetznerV2HttpClient,
} from "./hetzner-cloud-v2-http.js";
import { createHetznerLoadBalancerProvider } from "./hetzner-load-balancer.js";
import type { LoadBalancer } from "../../domain/entities-v2.js";
import type { Server, Service } from "../../domain/entities.js";
import { ReconcileError } from "../../domain/errors.js";

const BASE = "https://api.hetzner.cloud/v1";

function providerWithFake(opts?: {
  servers?: Server[];
  services?: Service[];
}) {
  const fake = createHetznerHttpFake();
  const v2: HetznerV2HttpClient = createHetznerV2HttpClient({
    token: "secret-token",
    baseUrl: BASE,
    fetchImpl: fake.fetch,
  });
  const servers: Server[] = opts?.servers ?? [];
  const services: Service[] = opts?.services ?? [];
  const p = createHetznerLoadBalancerProvider({
    http: v2,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
  });
  return { fake, v2, p, servers, services };
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

function mkService(name: string, server_selector?: Record<string, unknown>): Service {
  return {
    name,
    image: "nginx:latest",
    replicas: 1,
    server_selector,
  };
}

/**
 * Test helper: tag the given services with a `lb-backend` label key in their
 * `server_selector` so DESIRED.targets `{ label: "lb-backend" }` matches them.
 * Since v1's Service has no `labels` map, F4.3's service_selector matches
 * services by inspecting the keys of their `server_selector` (the closest
 * label-like map on a Service). See module header in the provider for the
 * convention.
 */
function withBackendLabel(services: Service[]): Service[] {
  return services.map((s) => ({
    ...s,
    server_selector: { ...(s.server_selector ?? {}), "lb-backend": "" },
  }));
}

const DESIRED: LoadBalancer = {
  name: "web-lb",
  location: "fsn1",
  algorithm: "round_robin",
  // service_selector — matches Services that have `lb-backend` in their
  // server_selector keys (see withBackendLabel helper).
  targets: { label: "lb-backend" },
  health_check: {
    protocol: "http",
    port: 80,
    interval: 15,
    timeout: 10,
    retries: 3,
    path: "/health",
  },
};

/** Seed an LB with the given shape directly via the fake's POST endpoint. */
async function seedLb(
  fake: { fetch: typeof fetch },
  body: Record<string, unknown>,
): Promise<number> {
  const res = await fake.fetch(`${BASE}/load_balancers`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const parsed = (await res.json()) as { load_balancer: { id: number } };
  return parsed.load_balancer.id;
}

/** Convenience: the LB-service shape the provider creates from DESIRED, in
 * the fake's expected nested-path wire shape. */
const DESIRED_LB_SERVICE = {
  protocol: "https",
  listen_port: 443,
  destination_port: 80,
  health_check: {
    protocol: DESIRED.health_check.protocol,
    port: DESIRED.health_check.port,
    interval: DESIRED.health_check.interval,
    timeout: DESIRED.health_check.timeout,
    retries: DESIRED.health_check.retries,
    http: { path: (DESIRED.health_check as { path?: string }).path },
  },
};

describe("HetznerLoadBalancerProvider — plan/apply/verify (F4.3)", () => {
  it("plan creates load_balancer when absent", async () => {
    const { p } = providerWithFake();
    const plan = await p.plan(DESIRED, null);
    expect(plan.ops).toEqual([
      { op: "create", entity: "load_balancer:web-lb" },
    ]);
  });

  it("plan is no-op when desired == observed (idempotency)", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p } = providerWithFake({ servers, services });
    // Drive the seed through apply() so the health-check is serialized in the
    // fake-expected nested shape ({ http: { path } }) — direct POSTs from the
    // test would lose the path since the fake reads it only when nested.
    await p.apply(DESIRED, null);
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toEqual([]);
  });

  it("apply is idempotent: second call same desired = no-op", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p } = providerWithFake({ servers, services });

    let observed = await p.observe(DESIRED.name);
    const first = await p.apply(DESIRED, observed);
    expect(first.changed).toBe(true);
    observed = await p.observe(DESIRED.name);
    const second = await p.apply(DESIRED, observed);
    expect(second.changed).toBe(false);
  });

  it("plan emits a SINGLE `recreate` op on location change (with public-IP impact)", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p, fake } = providerWithFake({ servers, services });
    await seedLb(fake, {
      name: DESIRED.name,
      load_balancer_type: "lb11",
      location: "nbg1", // differs from desired
      algorithm: { type: DESIRED.algorithm },
      services: [DESIRED_LB_SERVICE],
      targets: [{ type: "server", server: { id: 10 } }],
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toEqual([
      {
        op: "recreate",
        entity: "load_balancer:web-lb",
        impact: "public IP will change",
      },
    ]);
  });

  it("apply REJECTS recreate with `precondition` (destroy+create gated by F4.4 tool)", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p, fake } = providerWithFake({ servers, services });
    await seedLb(fake, {
      name: DESIRED.name,
      load_balancer_type: "lb11",
      location: "nbg1",
      algorithm: { type: DESIRED.algorithm },
      services: [DESIRED_LB_SERVICE],
      targets: [{ type: "server", server: { id: 10 } }],
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
    expect((raised as ReconcileError).message).toMatch(/recreation required/);
  });

  it("plan emits `update_algorithm` on algorithm change; apply calls change_algorithm", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p, fake } = providerWithFake({ servers, services });
    await seedLb(fake, {
      name: DESIRED.name,
      load_balancer_type: "lb11",
      location: DESIRED.location,
      algorithm: { type: "least_connections" }, // differs
      services: [DESIRED_LB_SERVICE],
      targets: [{ type: "server", server: { id: 10 } }],
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toContainEqual({
      op: "update_algorithm",
      entity: "load_balancer:web-lb",
    });
    const r = await p.apply(DESIRED, observed);
    expect(r.changed).toBe(true);
    const after = await p.observe(DESIRED.name);
    expect(after!.hetzner.algorithm.type).toBe(DESIRED.algorithm);
  });

  it("plan emits `update_targets` on target set change; apply emits add_target/remove_target", async () => {
    // Desired union: web-1 + web-2. Observed: web-1 + (id 99 — out-of-band).
    // Apply adds web-2 and removes id 99 (F4.3: managed = all observed).
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [
      mkServer("web-1", 10, { web: "", "lb-backend": "" }),
      mkServer("web-2", 11, { web: "", "lb-backend": "" }),
    ];
    const { p, fake } = providerWithFake({ servers, services });
    await seedLb(fake, {
      name: DESIRED.name,
      load_balancer_type: "lb11",
      location: DESIRED.location,
      algorithm: { type: DESIRED.algorithm },
      services: [DESIRED_LB_SERVICE],
      targets: [
        { type: "server", server: { id: 10 } },
        { type: "server", server: { id: 99 } },
      ],
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toContainEqual({
      op: "update_targets",
      entity: "load_balancer:web-lb",
    });
    const r = await p.apply(DESIRED, observed);
    expect(r.changed).toBe(true);
    const after = await p.observe(DESIRED.name);
    const ids = after!.hetzner.targets
      .filter((t) => t.type === "server")
      .map((t) => t.server!.id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([10, 11]);
  });

  it("targets resolved via service_selector → server_selector chain (union)", async () => {
    // service_selector {label:"lb-backend"} matches BOTH backend-svc-a and
    // backend-svc-b; backend-svc-a's server_selector matches server a-1;
    // backend-svc-b's matches b-1. Provider unions them → targets = [a-1, b-1].
    const services = withBackendLabel([
      mkService("backend-svc-a", { label: "tier-a" }),
      mkService("backend-svc-b", { label: "tier-b" }),
    ]);
    // An unrelated service (no lb-backend label) — must NOT be matched.
    services.push(mkService("other-svc", { label: "irrelevant" }));
    const servers: Server[] = [
      mkServer("a-1", 1, { "tier-a": "", "lb-backend": "" }),
      mkServer("b-1", 2, { "tier-b": "", "lb-backend": "" }),
      mkServer("irrelevant-1", 3, { irrelevant: "" }),
    ];
    const { p } = providerWithFake({ servers, services });

    const r = await p.apply(DESIRED, null);
    expect(r.changed).toBe(true);
    const after = await p.observe(DESIRED.name);
    const ids = after!.hetzner.targets
      .filter((t) => t.type === "server")
      .map((t) => t.server!.id)
      .sort((a, b) => a - b);
    expect(ids).toEqual([1, 2]);
  });

  it("drift: out-of-band target add → reported in plan (fail-safe surfaces drift)", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p, fake } = providerWithFake({ servers, services });
    await seedLb(fake, {
      name: DESIRED.name,
      load_balancer_type: "lb11",
      location: DESIRED.location,
      algorithm: { type: DESIRED.algorithm },
      services: [DESIRED_LB_SERVICE],
      targets: [
        { type: "server", server: { id: 10 } },
        { type: "server", server: { id: 999 } }, // out-of-band
      ],
    });
    const observed = await p.observe(DESIRED.name);
    const plan = await p.plan(DESIRED, observed);
    expect(plan.ops).toContainEqual({
      op: "drift",
      entity: "load_balancer:web-lb",
      target: "targets",
    });
  });

  it("verify() returns true only after observed matches desired", async () => {
    const services = withBackendLabel([
      mkService("backend-svc", { label: "web" }),
    ]);
    const servers: Server[] = [mkServer("web-1", 10, { web: "", "lb-backend": "" })];
    const { p } = providerWithFake({ servers, services });
    expect(await p.verify(DESIRED)).toBe(false);
    const observed = await p.observe(DESIRED.name);
    await p.apply(DESIRED, observed);
    expect(await p.verify(DESIRED)).toBe(true);
  });

  it("classify error: 429 → transient; 422 → precondition", async () => {
    const { p, fake } = providerWithFake();

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
      message: "load_balancer: invalid algorithm",
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
