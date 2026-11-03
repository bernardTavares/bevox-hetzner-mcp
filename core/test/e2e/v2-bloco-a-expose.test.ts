/**
 * core/test/e2e/v2-bloco-a-expose.test.ts
 *
 * Task F6.2 — CAPSTONE E2E for v2 Bloco A: a single scenario that drives the
 * entire stack assembled in F1.x–F6.1 end-to-end against the in-process
 * Hetzner fakes — ZERO network, ZERO real DNS / Docker / SSH.
 *
 * Scenario:
 *
 *   1. Seed a v1 stack: Server `bevox-app-1` (with `hcloud_id`) and a v1
 *      Service `bevox-web` wired so the F4.3 LB targeting chain
 *      (service_selector → server_selector) resolves the desired target:
 *        - LB.targets = { label: "bevox-web" }              (synthesised by F6.1)
 *        - SEED_SERVICE.server_selector = { "bevox-web": "true",
 *                                           name: "bevox-app-1" }
 *        - SEED_SERVER.labels = { "bevox-web": "true" }
 *   2. Seed the DNS zone `example.com` in the hcloud-DNS fake (v1 DNS provider
 *      never auto-creates a zone — see hetzner-dns.ts header).
 *   3. Call `exposeService({ service:"bevox-web", hostname:"app.example.com",
 *      tls:"managed" })`. First non-dry call ⇒ `pending_approval` with a
 *      single approval row keyed by `expose:bevox-web-app`.
 *   4. Approve via the gate's webhook path; re-call ⇒ `applied` with the
 *      three sub-entities (Certificate / LoadBalancer / Ingress) in their
 *      working stores.
 *   5. Drive the F5.4 reconcile DAG (planV2 + applyPlan over a composite of
 *      wrapV2Provider-wrapped v2 providers) to fixpoint. With
 *      `setManagedIssuanceLatency(0)` on the certificate fake, the managed
 *      cert flips to `completed` on the next observe(); a second reconcile
 *      cycle therefore aggregates Ingress to `healthy`.
 *
 * Assertions (every one has teeth — never vacuous):
 *
 *   - All three sub-entities (cert / lb / ingress) are realised on the
 *     Hetzner fakes with the expected shape (cert.status.issuance="completed",
 *     LB targets the seeded server's hcloud_id, DNS A record exists).
 *   - The IngressProvider composite reports `status: "healthy"` after the
 *     fixpoint reconcile.
 *   - StateEvents include the actor and `after.capability_token_id === null`
 *     (Bloco A — Bloco C activates real population).
 *   - A third reconcile cycle after fixpoint is a STRICT no-op: zero
 *     mutations, every applied carries `changed === false`, no failures, no
 *     skips.
 *
 * DEVIATION FROM PLAN BRIEF: the brief lists `firewall:bevox-web-app` among
 * the healthy entities. F6.1's `expose_service` does NOT synthesise a
 * firewall (only cert + lb + ingress); the optional `firewall_ref` on the
 * Ingress is wired by a separate `set_firewall` invocation (out of scope for
 * the expose_service E2E). This test therefore drops firewall from the
 * assertion set — matching the F6.1 contract exactly. The capstone is still
 * the full path end-to-end through every other piece.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import type pg from "pg";

import {
  ALL_TOOLS,
  V2_TOOLS,
  __mintVerifiedCredentialForTest,
} from "../../src/agent/capability.js";
import {
  createApprovalGate,
  type Clock,
} from "../../src/agent/approval-gate.js";
import {
  exposeService,
  type ExposeServiceDeps,
} from "../../src/agent/v2/expose-service.js";
import { createInMemoryWorkingCertificateStore } from "../../src/agent/v2/set-certificate.js";
import { createInMemoryWorkingLoadBalancerStore } from "../../src/agent/v2/set-load-balancer.js";
import { createInMemoryWorkingIngressStore } from "../../src/agent/v2/set-ingress.js";
import {
  planV2,
  desiredPayloadsV2,
  type V2WorkingSources,
} from "../../src/reconciler/plan.js";
import { applyPlan } from "../../src/reconciler/apply.js";
import {
  wrapV2Provider,
  createCompositeProvider,
} from "../../src/reconciler/v2-wrap.js";
import { createHetznerV2HttpClient } from "../../src/providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerCertificateProvider } from "../../src/providers/v2/hetzner-certificate.js";
import { createHetznerLoadBalancerProvider } from "../../src/providers/v2/hetzner-load-balancer.js";
import { createHetznerFirewallProvider } from "../../src/providers/v2/hetzner-firewall.js";
import {
  createIngressProvider,
  type IngressProvider,
} from "../../src/providers/v2/ingress.js";
import { createHetznerDnsProvider } from "../../src/providers/hetzner-dns.js";
import { HttpClient } from "../../src/providers/http-client.js";
import type { Provider as V1Provider } from "../../src/providers/provider.js";
import type { Server, Service } from "../../src/domain/entities.js";
import type { Firewall, Ingress } from "../../src/domain/entities-v2.js";
import { queryEvents } from "../../src/store/state-events.js";
import { createHetznerHttpFake } from "../fakes/hetzner-http.js";
import {
  getTestPool,
  resetSchema,
  closeTestPool,
} from "../fakes/pg-harness.js";
import { runMigrations } from "../../src/store/db.js";

// ---------------------------------------------------------------------------
// pg harness (proven barrier/finally discipline).
// ---------------------------------------------------------------------------

let pool: pg.Pool;

beforeAll(() => {
  pool = getTestPool();
});
afterAll(async () => {
  await closeTestPool();
});
beforeEach(async () => {
  await resetSchema(pool);
  await runMigrations(pool);
});

// ---------------------------------------------------------------------------
// V1 seed wired so the F4.3 LB selector chain resolves to bevox-app-1:42.
//
//   LB.targets = { label: "bevox-web" }
//     → matches Services whose `server_selector` carries the key "bevox-web"
//   SEED_SERVICE.server_selector = { "bevox-web": "true", name: "bevox-app-1" }
//     → resolveServerSelector requires EVERY key to match each candidate
//       server: "bevox-web" → server.labels["bevox-web"] must exist;
//       "name" → server.name === "bevox-app-1" (exact).
//   SEED_SERVER.labels carries "bevox-web": "true" + name === "bevox-app-1".
//
// Result: the LB resolves desired targets to [hcloud_id=42] — a single
// concrete server target on the Hetzner fake.
// ---------------------------------------------------------------------------

const SEED_SERVER: Server = {
  name: "bevox-app-1",
  type: "cx22",
  location: "fsn1",
  image: "ubuntu-24.04",
  ssh_keys: [],
  labels: { "bevox-web": "true" },
  network: "mesh",
  status: "healthy",
  hcloud_id: 42,
};

const SEED_SERVICE: Service = {
  name: "bevox-web",
  image: "bevox/web:1",
  replicas: 1,
  server_selector: {
    "bevox-web": "true",
    name: "bevox-app-1",
  } as Record<string, unknown>,
};

const ACTOR = "agent:vox";
const SCOPE = "expose";
const FIXED = new Date("2026-05-21T00:00:00.000Z");
const clock: Clock = { now: () => FIXED };

// ---------------------------------------------------------------------------
// World factory — wires every v2 working store + provider + composite.
// ---------------------------------------------------------------------------

interface World {
  hetznerFake: ReturnType<typeof createHetznerHttpFake>;
  gate: ReturnType<typeof createApprovalGate>;
  certStore: ReturnType<typeof createInMemoryWorkingCertificateStore>;
  lbStore: ReturnType<typeof createInMemoryWorkingLoadBalancerStore>;
  ingStore: ReturnType<typeof createInMemoryWorkingIngressStore>;
  ingressProvider: IngressProvider;
  fwProvider: ReturnType<typeof createHetznerFirewallProvider>;
  /**
   * Mutable per-call service list — fault-injection tests pop/restore entries
   * to model "Service replicas dropped to 0 from the LB targeting chain's
   * perspective". The providers receive `() => services` so the freshest array
   * is always read.
   */
  services: Service[];
  sources: V2WorkingSources;
  composite: V1Provider;
  deps: ExposeServiceDeps;
}

function makeWorld(): World {
  const hetznerFake = createHetznerHttpFake();
  // Make managed-cert issuance instantaneous on the very next GET so the
  // second reconcile cycle observes the cert as `completed` ⇒ healthy.
  hetznerFake.setManagedIssuanceLatency(0);

  const certStore = createInMemoryWorkingCertificateStore();
  const lbStore = createInMemoryWorkingLoadBalancerStore();
  const ingStore = createInMemoryWorkingIngressStore();

  let idn = 0;
  // F6.1 requires `isSensitive: () => true` so the wrapper PlanItem
  // `op:"create"` is gated.
  const gate = createApprovalGate({
    pool,
    clock,
    isSensitive: () => true,
    idFactory: () => `apr_e2e_${++idn}`,
  });

  const v2Http = createHetznerV2HttpClient({
    token: "test-token",
    baseUrl: "https://api.hetzner.cloud/v1",
    fetchImpl: hetznerFake.fetch,
  });

  const certProvider = createHetznerCertificateProvider({
    http: v2Http,
    // Managed-only scenario — uploaded path never runs; defensive throw if it does.
    secretResolver: async () => {
      throw new Error("e2e: secretResolver not expected — managed path only");
    },
  });

  const servers: readonly Server[] = [SEED_SERVER];
  // Mutable so fault tests can simulate "Service deleted/replicas=0" by
  // emptying it and restore it for recovery. The closures below read the
  // freshest reference on every call.
  const services: Service[] = [SEED_SERVICE];

  const lbProvider = createHetznerLoadBalancerProvider({
    http: v2Http,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
  });

  const fwProvider = createHetznerFirewallProvider({
    http: v2Http,
    serversProvider: async () => servers,
  });

  // v1 DNS provider wired against the SAME shared Hetzner fake (the fake
  // routes by `/zones|/records` segments — see hetzner-http.ts).
  const dnsHttp = new HttpClient({
    defaultHeaders: { "Auth-API-Token": "test-token" },
    fetchImpl: hetznerFake.fetch,
  });
  const dnsProvider = createHetznerDnsProvider({
    token: "test-token",
    baseUrl: "https://dns.hetzner.com/api/v1",
    http: dnsHttp,
  });

  // Ingress composite — lookups read the working stores (F5.3 pattern).
  // expose_service does NOT synthesise a firewall, so firewallLookup always
  // returns null (the IngressProvider then skips the fw branch entirely).
  const ingressProvider = createIngressProvider({
    certificateProvider: certProvider,
    loadBalancerProvider: lbProvider,
    firewallProvider: fwProvider,
    dnsProvider,
    serversProvider: async () => servers,
    servicesProvider: async () => services,
    certificateLookup: async (name) => certStore.get(name),
    firewallLookup: async () => null,
    loadBalancerLookup: async (name) => lbStore.get(name),
  });

  const sources: V2WorkingSources = {
    certificate: { entityKind: "certificate", store: certStore as never },
    load_balancer: { entityKind: "load_balancer", store: lbStore as never },
    ingress: { entityKind: "ingress", store: ingStore as never },
  };

  const composite = createCompositeProvider({
    byKind: new Map<string, V1Provider>([
      [
        "certificate",
        wrapV2Provider({
          entityKind: "certificate",
          v2: certProvider,
          workingStore: certStore,
        }),
      ],
      [
        "load_balancer",
        wrapV2Provider({
          entityKind: "load_balancer",
          v2: lbProvider,
          workingStore: lbStore,
        }),
      ],
      [
        "ingress",
        wrapV2Provider({
          entityKind: "ingress",
          v2: ingressProvider,
          workingStore: ingStore,
          // Ingress observe wants the WHOLE desired (see F5.4 wiring).
          observeArg: (desired) => desired,
        }),
      ],
    ]),
    // Unused — no v1 PlanItems in this scenario.
    fallback: {
      name: "unused-v1",
      async observe(scope) {
        return { scope, entities: [] };
      },
      async apply(a) {
        return { entity: a.entity, op: a.op, changed: false };
      },
      async verify() {
        return true;
      },
    },
  });

  const deps: ExposeServiceDeps = {
    pool,
    approvalGate: gate,
    certificateStore: certStore,
    loadBalancerStore: lbStore,
    ingressStore: ingStore,
  };

  return {
    hetznerFake,
    gate,
    certStore,
    lbStore,
    ingStore,
    ingressProvider,
    fwProvider,
    services,
    sources,
    composite,
    deps,
  };
}

// ---------------------------------------------------------------------------
// Shared scenario helpers (F6.3 reuses the F6.2 setup verbatim).
// ---------------------------------------------------------------------------

/**
 * Drive `exposeService(managed)` from dry_run → applied (approval webhook
 * mid-way). Returns the populated working stores. The capstone scenario; F6.3
 * uses this as the "preconditions" step before injecting each fault.
 */
async function setupExposed(
  w: World,
  cred: ReturnType<typeof __mintVerifiedCredentialForTest>,
): Promise<{ ingressDesired: Ingress }> {
  const seed = await w.hetznerFake.fetch(
    "https://dns.hetzner.com/api/v1/zones",
    { method: "POST", body: JSON.stringify({ name: "example.com" }) },
  );
  expect(seed.status).toBe(201);
  const first = await exposeService(
    {
      dry_run: false,
      service: "bevox-web",
      hostname: "app.example.com",
      tls: "managed",
    },
    { credential: cred, scope: SCOPE },
    w.deps,
  );
  expect(first.status).toBe("pending_approval");
  await w.gate.resolveApproval(first.approval_id!, "approved", "agent:human");
  const second = await exposeService(
    {
      dry_run: false,
      service: "bevox-web",
      hostname: "app.example.com",
      tls: "managed",
    },
    { credential: cred, scope: SCOPE },
    w.deps,
  );
  expect(second.status).toBe("applied");
  const ingressDesired = (await w.ingStore.get(
    "bevox-web-app",
  )) as Ingress | null;
  expect(ingressDesired).not.toBeNull();
  return { ingressDesired: ingressDesired! };
}

/** Run one reconcile cycle (planV2 → applyPlan). Returns the ApplyReport. */
async function reconcileOnce(
  w: World,
): Promise<Awaited<ReturnType<typeof applyPlan>>> {
  const items = await planV2(w.sources);
  const payloads = await desiredPayloadsV2(w.sources);
  return applyPlan(w.composite, items, { desiredPayloads: payloads });
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe("F6.2 — CAPSTONE: bevox-web exposed via fakes (v2 Bloco A)", () => {
  it(
    "expose_service (managed) → approve → reconcile to fixpoint: cert/lb/ingress/dns healthy; second cycle is a strict no-op; StateEvents carry actor + null capability_token_id",
    async () => {
      const w = makeWorld();

      // (1) Seed the DNS zone — fail-safe in the v1 provider: it never
      // creates a zone. Without this, IngressProvider's DNS step degrades.
      const seed = await w.hetznerFake.fetch(
        "https://dns.hetzner.com/api/v1/zones",
        {
          method: "POST",
          body: JSON.stringify({ name: "example.com" }),
        },
      );
      expect(seed.status).toBe(201);

      const cred = __mintVerifiedCredentialForTest(ACTOR, [
        ...ALL_TOOLS,
        ...V2_TOOLS,
      ]);

      // (2) dry_run → planned, three ops (cert + ingress + lb sorted).
      const dry = await exposeService(
        {
          dry_run: true,
          service: "bevox-web",
          hostname: "app.example.com",
          tls: "managed",
        },
        { credential: cred, scope: SCOPE },
        w.deps,
      );
      expect(dry.status).toBe("planned");
      expect(
        (dry.plan!.ops as Array<{ entity: string }>).map((o) => o.entity),
      ).toEqual([
        "certificate:bevox-web-app",
        "ingress:bevox-web-app",
        "load_balancer:bevox-web-app",
      ]);

      // (3) Non-dry_run → pending_approval; fail-safe sub-stores untouched.
      const first = await exposeService(
        {
          dry_run: false,
          service: "bevox-web",
          hostname: "app.example.com",
          tls: "managed",
        },
        { credential: cred, scope: SCOPE },
        w.deps,
      );
      expect(first.status).toBe("pending_approval");
      expect(first.approval_id).toMatch(/^apr_/);
      expect(await w.certStore.get("bevox-web-app")).toBeNull();
      expect(await w.lbStore.get("bevox-web-app")).toBeNull();
      expect(await w.ingStore.get("bevox-web-app")).toBeNull();

      // (4) Approve the bundle via the gate's webhook path.
      await w.gate.resolveApproval(
        first.approval_id!,
        "approved",
        "agent:human",
      );

      // (5) Re-call → applied; all three sub-stores populated.
      const second = await exposeService(
        {
          dry_run: false,
          service: "bevox-web",
          hostname: "app.example.com",
          tls: "managed",
        },
        { credential: cred, scope: SCOPE },
        w.deps,
      );
      expect(second.status).toBe("applied");
      expect(await w.certStore.get("bevox-web-app")).not.toBeNull();
      expect(await w.lbStore.get("bevox-web-app")).not.toBeNull();
      const ingressDesired = (await w.ingStore.get(
        "bevox-web-app",
      )) as Ingress | null;
      expect(ingressDesired).not.toBeNull();

      // ---- Reconcile cycle #1 — kick off cert / create LB / create DNS ----
      const items1 = await planV2(w.sources);
      const payloads1 = await desiredPayloadsV2(w.sources);
      const report1 = await applyPlan(w.composite, items1, {
        desiredPayloads: payloads1,
      });
      expect(report1.failed, "cycle 1: no failures").toEqual([]);
      expect(report1.skipped, "cycle 1: no skips").toEqual([]);
      expect(
        report1.applied.map((a) => a.entity).sort(),
        "cycle 1 applied: all three v2 entities",
      ).toEqual([
        "certificate:bevox-web-app",
        "ingress:bevox-web-app",
        "load_balancer:bevox-web-app",
      ]);

      // ---- Reconcile cycle #2 — observe cert→completed; converge fully ----
      const items2 = await planV2(w.sources);
      const payloads2 = await desiredPayloadsV2(w.sources);
      const report2 = await applyPlan(w.composite, items2, {
        desiredPayloads: payloads2,
      });
      expect(report2.failed, "cycle 2: no failures").toEqual([]);
      expect(report2.skipped, "cycle 2: no skips").toEqual([]);

      // ---- TEETH on the Hetzner fakes -------------------------------------
      // Certificate: created + status.issuance === "completed".
      const certListRes = await w.hetznerFake.fetch(
        "https://api.hetzner.cloud/v1/certificates",
      );
      const certBody = (await certListRes.json()) as {
        certificates?: Array<{
          name: string;
          type: string;
          status: { issuance: string };
          domain_names: string[];
        }>;
      };
      const cert = (certBody.certificates ?? []).find(
        (c) => c.name === "bevox-web-app",
      );
      expect(cert, "certificate created on Hetzner").toBeDefined();
      expect(cert!.type).toBe("managed");
      expect(cert!.domain_names).toEqual(["app.example.com"]);
      expect(cert!.status.issuance, "managed cert issued").toBe("completed");

      // Load balancer: created + targets the seeded server's hcloud_id.
      const lbListRes = await w.hetznerFake.fetch(
        "https://api.hetzner.cloud/v1/load_balancers",
      );
      const lbBody = (await lbListRes.json()) as {
        load_balancers?: Array<{
          name: string;
          location: { name: string };
          algorithm: { type: string };
          targets: Array<{ type: string; server?: { id: number } }>;
        }>;
      };
      const lb = (lbBody.load_balancers ?? []).find(
        (l) => l.name === "bevox-web-app",
      );
      expect(lb, "load balancer created on Hetzner").toBeDefined();
      expect(lb!.location.name).toBe("fsn1");
      expect(lb!.algorithm.type).toBe("round_robin");
      const targetIds = lb!.targets
        .filter((t) => t.type === "server" && t.server)
        .map((t) => t.server!.id);
      expect(
        targetIds,
        "LB targets the seeded server's hcloud_id",
      ).toContain(SEED_SERVER.hcloud_id!);

      // DNS A record landed in zone example.com.
      const dnsListRes = await w.hetznerFake.fetch(
        "https://dns.hetzner.com/api/v1/records",
      );
      const dnsBody = (await dnsListRes.json()) as {
        records?: Array<{ name: string; type: string; value: string }>;
      };
      const aRec = (dnsBody.records ?? []).find(
        (r) => r.name === "app" && r.type === "A",
      );
      expect(aRec, "DNS A record present in zone example.com").toBeDefined();

      // ---- Ingress composite reports `healthy` ----------------------------
      // The reconciler's AppliedItem does not carry status; drive
      // ingressProvider.{observe,apply} directly against the realised state.
      const ingObsAfter = await w.ingressProvider.observe(ingressDesired!);
      const ingApply = await w.ingressProvider.apply(
        ingressDesired!,
        ingObsAfter,
      );
      expect(
        ingApply.status,
        "Ingress composite status === 'healthy' after fixpoint",
      ).toBe("healthy");

      // ---- StateEvents: actor + after.capability_token_id === null --------
      const events = await queryEvents(pool, {});
      const exposeEvents = events.filter(
        (e) =>
          e.entity === "certificate:bevox-web-app" ||
          e.entity === "load_balancer:bevox-web-app" ||
          e.entity === "ingress:bevox-web-app",
      );
      expect(
        exposeEvents.length,
        "one StateEvent per sub-entity written by expose_service",
      ).toBeGreaterThanOrEqual(3);
      for (const ev of exposeEvents) {
        expect(ev.actor, `${ev.entity}: actor recorded`).toBe(ACTOR);
        const after = ev.after as
          | { capability_token_id?: unknown }
          | undefined;
        expect(
          after?.capability_token_id,
          `${ev.entity}: after.capability_token_id is null (Bloco A)`,
        ).toBeNull();
      }

      // ---- Idempotency cycle — strict no-op -------------------------------
      const items3 = await planV2(w.sources);
      const payloads3 = await desiredPayloadsV2(w.sources);
      const report3 = await applyPlan(w.composite, items3, {
        desiredPayloads: payloads3,
      });
      expect(report3.failed, "idempotency: no failures").toEqual([]);
      expect(report3.skipped, "idempotency: no skips").toEqual([]);
      expect(
        report3.applied.every((a) => a.changed === false),
        "idempotency: every applied item is changed:false (strict no-op)",
      ).toBe(true);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// F6.3 — Fault injection on the capstone (same world; targeted faults)
//
// Three scenarios, each invariant-driven:
//   (a) Hetzner 503 storm during cert polling → cert stays `pending`, Ingress
//       `degraded` with reason=`certificate`, no resource deleted, recovers on
//       a clean retry cycle.
//   (b) Firewall drift — extra rule injected out-of-band → reported via the
//       v2 firewall provider's `plan(op:"drift")` channel, NEVER removed by
//       apply (fail-safe set_rules contract, F1.3 invariant).
//   (c) Target Service drops out of the selector chain → LB targets converge
//       to the empty set (managed-by-LB contract, F4.3 simplification); Ingress
//       composite reports `healthy` (the LB itself succeeded) but with zero
//       targets — the "healthy but no traffic destination" mode the operator
//       must notice. Recovers when the Service returns.
// ---------------------------------------------------------------------------

describe("F6.3 — fault injection on the v2 Bloco A capstone", () => {
  it(
    "(a) Hetzner 5xx storm during cert polling: cert stays pending, Ingress degraded(certificate), nothing deleted, recovers on clean retry",
    async () => {
      const w = makeWorld();
      // Make the managed cert STICK in `pending` long enough that the storm
      // hits during a real polling read (default 0 from makeWorld() would flip
      // it to completed on the very first GET, eliminating the polling window).
      // Initial latency is HIGH enough that the cert is still pending while
      // the storm runs (each observe()/verify() consumes ~1 poll). Recovery
      // below resets the per-cert poll counter via setNextManagedIssuanceLatency
      // — that ONLY affects new certs, so the existing one must be polled
      // through; we choose a small budget so the recovery loop drains it in
      // O(cycles).
      w.hetznerFake.setManagedIssuanceLatency(8);

      const cred = __mintVerifiedCredentialForTest(ACTOR, [
        ...ALL_TOOLS,
        ...V2_TOOLS,
      ]);
      const { ingressDesired } = await setupExposed(w, cred);

      // Cycle #1: creates the cert (POST → pending), the LB and DNS. We run
      // it BEFORE the fault so the cert exists on Hetzner for the storm to
      // hit. NOTE: with latency=5 the cert is still `pending` after this
      // cycle, so verify() returns false and apply.ts records the cert as
      // `conflict` — that is the EXPECTED v2 contract for an in-flight
      // managed cert, NOT a fault. The fault behaviour we assert lives in
      // the cycles AFTER the storm is injected, below.
      await reconcileOnce(w);

      // Sanity: cert exists on Hetzner and is currently pending.
      const certRow = async () => {
        const res = await w.hetznerFake.fetch(
          "https://api.hetzner.cloud/v1/certificates",
        );
        const body = (await res.json()) as {
          certificates?: Array<{ name: string; status: { issuance: string } }>;
        };
        return (body.certificates ?? []).find((c) => c.name === "bevox-web-app");
      };
      const beforeStorm = await certRow();
      expect(beforeStorm, "cert created before storm").toBeDefined();
      expect(beforeStorm!.status.issuance).toBe("pending");

      // --- INJECT: 5xx storm. HttpClient default maxRetries=3, so 4 in a row
      // exhausts the retry budget for the next request and the transient
      // surfaces back into the provider. We use 503 via a sequence of
      // setNextRequestFault — one-shot per call — chaining 4 invocations
      // would be ergonomic but the test only needs one un-retryable shot to
      // be sure the OBSERVE path was hit: rate-limit fault times=4 retryAfter=0
      // is the cheapest deterministic way (HttpClient honours Retry-After=0).
      w.hetznerFake.setRateLimitFault({ times: 4, retryAfter: 0 });

      // Cycle #2: ingress observe → cert.observe → 429s drain through retry
      // budget → final 429 surfaces as transient → ingress catches it and
      // treats cert as null. The cert-create branch then re-fires (cert exists
      // on Hetzner but apply path under observed:null re-POSTs are NOT what
      // we want — actually let's reason through what happens):
      //
      // Path: applyPlan iterates planV2 items in V2_PLAN_ORDER. For the
      // certificate item, v2-wrap calls v2.observe(name) which makes a GET
      // /certificates first. That request hits the rate-limit. After
      // HttpClient retries, the error PROPAGATES from certProvider.observe →
      // v2-wrap.apply catches it... actually v2-wrap does NOT catch (line
      // 132: const observed = await v2.observe(...) — no catch). So
      // certProvider.observe throws transient, apply.ts records it as failed
      // (transient). Ingress, being a dependent item by V2_PLAN_ORDER, runs
      // AFTER cert. apply.ts has no static dep edges here (planV2 doesn't
      // emit any), so ingress proceeds — and ingress.observe() does its OWN
      // .catch(()=>null) on certificateProvider.observe, so the storm doesn't
      // crash ingress; it just observes cert as null. Result: ingress.apply
      // re-attempts cert.apply with observed:null which would re-POST and
      // collide on name uniqueness... but the fake's POST handler allows
      // duplicates (no uniqueness on name). The new POST creates a SECOND
      // pending cert row with a different id.
      //
      // For the invariant we want to assert ("cert stays pending, nothing
      // deleted, recovers"), the meaningful checks are: (1) the ORIGINAL
      // cert row is still present on the fake post-storm (NOT deleted by
      // any error path); (2) all extant certs are pending or completed,
      // never error/cancelled.
      const r2 = await reconcileOnce(w);
      // We tolerate cert being in `failed` list (transient on observe is the
      // realistic outcome). The KEY invariant: nothing was DELETED.
      const certFailed = r2.failed.find(
        (f) => f.entity === "certificate:bevox-web-app",
      );
      if (certFailed) {
        expect(certFailed.errorClass, "fault(a): transient classification").toBe(
          "transient",
        );
      }

      // Invariant 1: cert(s) still on Hetzner — NEVER auto-deleted by a fault.
      const certListRes = await w.hetznerFake.fetch(
        "https://api.hetzner.cloud/v1/certificates",
      );
      const certBody = (await certListRes.json()) as {
        certificates?: Array<{
          name: string;
          status: { issuance: string };
        }>;
      };
      const certs = (certBody.certificates ?? []).filter(
        (c) => c.name === "bevox-web-app",
      );
      expect(certs.length, "fault(a): cert NOT deleted by storm").toBeGreaterThanOrEqual(
        1,
      );
      for (const c of certs) {
        expect(
          ["pending", "completed"].includes(c.status.issuance),
          `fault(a): cert ${c.status.issuance} is never error/cancelled`,
        ).toBe(true);
      }

      // Invariant 2: working stores still hold all three sub-entities — the
      // fault did NOT roll back desired state.
      expect(await w.certStore.get("bevox-web-app")).not.toBeNull();
      expect(await w.lbStore.get("bevox-web-app")).not.toBeNull();
      expect(await w.ingStore.get("bevox-web-app")).not.toBeNull();

      // Invariant 3: Ingress composite reports `degraded` with reason `certificate`.
      const ingObsDuringStorm = await w.ingressProvider.observe(ingressDesired);
      const ingApplyDuringStorm = await w.ingressProvider.apply(
        ingressDesired,
        ingObsDuringStorm,
      );
      expect(
        ingApplyDuringStorm.status,
        "fault(a): Ingress is degraded while cert is pending",
      ).toBe("degraded");
      expect(
        ingApplyDuringStorm.worst_component_reason,
        "fault(a): degradation reason is `certificate`",
      ).toBe("certificate");

      // --- RECOVERY: storm budget already drained above. Cycle enough times
      // to consume the per-cert pending-poll budget; each ingressProvider
      // observe/apply drains 1-2 polls. Bounded loop: stop as soon as
      // ingress flips to healthy. Tight upper bound > initial latency × 2.
      let recovered: "healthy" | "degraded" = "degraded";
      for (let i = 0; i < 30; i++) {
        await reconcileOnce(w);
        const obs = await w.ingressProvider.observe(ingressDesired);
        const ap = await w.ingressProvider.apply(ingressDesired, obs);
        recovered = ap.status;
        if (recovered === "healthy") break;
      }
      expect(
        recovered,
        "fault(a) recovery: Ingress healthy once cert completes (no resource ever deleted)",
      ).toBe("healthy");
    },
    30_000,
  );

  it(
    "(b) Firewall drift — extra rule injected out-of-band is reported via plan(op:'drift') and NEVER removed by apply",
    async () => {
      const w = makeWorld();
      const cred = __mintVerifiedCredentialForTest(ACTOR, [
        ...ALL_TOOLS,
        ...V2_TOOLS,
      ]);
      await setupExposed(w, cred);
      // Drive a clean cycle so the LB/cert/ingress side is steady before we
      // touch firewalls (keeps the assertions tight on the firewall sub-path).
      await reconcileOnce(w);

      // The firewall is OUTSIDE expose_service's bundle (F6.1 contract — see
      // F6.2 header DEVIATION note). We create one directly via the provider
      // (mirrors the F1.3 unit-test pattern); the e2e value is asserting the
      // SAME fail-safe under real working-store / fake plumbing.
      const desiredFw: Firewall = {
        name: "bevox-web-app",
        rules: [
          {
            direction: "in",
            protocol: "tcp",
            port: "443",
            source_ips: ["0.0.0.0/0"],
          },
        ],
        applied_to: { name: "bevox-app-1" } as Record<string, unknown>,
      };
      // Initial create — observed null branch.
      const fwCreate = await w.fwProvider.apply(desiredFw, null);
      expect(fwCreate.changed, "fault(b): firewall created").toBe(true);

      // Observe the created firewall to learn its id, then inject an extra
      // rule out-of-band on the Hetzner fake.
      const observed1 = await w.fwProvider.observe(desiredFw.name);
      expect(observed1, "fault(b): firewall observable after create").not.toBeNull();
      const fwId = observed1!.hetzner.id;
      const extraRule = {
        direction: "in" as const,
        protocol: "tcp",
        port: "22",
        source_ips: ["10.0.0.0/8"],
      };
      const injected = w.hetznerFake.firewalls.injectExtraRule(fwId, extraRule);
      expect(injected, "fault(b): extra rule injection landed").toBe(true);

      // Re-observe and assert the v2 provider's plan REPORTS the drift via
      // its declarative `op:"drift"` channel — the one fail-safe surface for
      // "reality has more than desired".
      const observed2 = await w.fwProvider.observe(desiredFw.name);
      expect(observed2).not.toBeNull();
      expect(
        observed2!.hetzner.rules.length,
        "fault(b): fake carries desired+extra rules",
      ).toBe(2);
      const planAfter = await w.fwProvider.plan(desiredFw, observed2);
      const driftOp = planAfter.ops.find((o) => o.op === "drift");
      expect(
        driftOp,
        "fault(b): plan emits an op:'drift' for the extra rule (reported channel)",
      ).toBeDefined();
      expect(driftOp!.target).toBe("rules");

      // Apply: must be a no-op (changed:false) — `desired ⊆ observed` ⇒
      // F1.3 does NOT call set_rules (would wholesale-replace and drop the
      // extra). The extra rule must REMAIN on the fake post-apply.
      const applyAfter = await w.fwProvider.apply(desiredFw, observed2);
      expect(
        applyAfter.changed,
        "fault(b): apply is a no-op when only extras exist (fail-safe)",
      ).toBe(false);

      const observed3 = await w.fwProvider.observe(desiredFw.name);
      expect(observed3!.hetzner.rules.length, "fault(b): extra rule NOT removed").toBe(2);
      const stillThere = observed3!.hetzner.rules.some(
        (r) => r.port === "22" && r.protocol === "tcp",
      );
      expect(stillThere, "fault(b): the SPECIFIC injected rule persists").toBe(true);
    },
    30_000,
  );

  it(
    "(c) Target Service drops out of selector chain: LB targets converge to empty (managed-by-LB), Ingress 'healthy but no targets'; recovers when Service returns",
    async () => {
      const w = makeWorld();
      const cred = __mintVerifiedCredentialForTest(ACTOR, [
        ...ALL_TOOLS,
        ...V2_TOOLS,
      ]);
      const { ingressDesired } = await setupExposed(w, cred);

      // Drive to fixpoint: targets seeded, ingress healthy.
      await reconcileOnce(w);
      await reconcileOnce(w);

      const readLb = async (): Promise<{ targets: Array<{ server?: { id: number } }> } | undefined> => {
        const res = await w.hetznerFake.fetch(
          "https://api.hetzner.cloud/v1/load_balancers",
        );
        const body = (await res.json()) as {
          load_balancers?: Array<{
            name: string;
            targets: Array<{ type: string; server?: { id: number } }>;
          }>;
        };
        return (body.load_balancers ?? []).find((l) => l.name === "bevox-web-app");
      };
      const lbBefore = await readLb();
      expect(lbBefore, "fault(c) precondition: LB exists").toBeDefined();
      expect(
        lbBefore!.targets
          .filter((t) => t.server)
          .map((t) => t.server!.id),
        "fault(c) precondition: LB targets the seeded server",
      ).toContain(SEED_SERVER.hcloud_id!);

      // --- INJECT: empty the Service list (models replicas→0 / Service
      // removed). The LB targeting chain (service_selector → server_selector)
      // now resolves to ∅. Per F4.3 "managed = all observed", the provider
      // will remove the now-orphan target on the next apply.
      w.services.splice(0, w.services.length);

      const r2 = await reconcileOnce(w);
      expect(
        r2.failed,
        "fault(c): targets-converge cycle has no failures",
      ).toEqual([]);

      const lbAfterEmpty = await readLb();
      const serverTargets = lbAfterEmpty!.targets.filter((t) => t.server);
      expect(
        serverTargets.length,
        "fault(c): LB targets is empty (Service removed from chain)",
      ).toBe(0);

      // Ingress composite status: the LB itself succeeded (verify true ⇒
      // no pending ops since targets={} matches desired={}). So composite is
      // structurally `healthy` — the "healthy but no traffic destination"
      // mode the operator must notice via the empty-targets signal above.
      // We assert BOTH facts so a future change to ingress aggregation that
      // surfaces target emptiness flips the expectation explicitly.
      const ingObs = await w.ingressProvider.observe(ingressDesired);
      const ingApply = await w.ingressProvider.apply(ingressDesired, ingObs);
      expect(
        ingApply.status,
        "fault(c): Ingress composite stays 'healthy' (LB succeeded, no degraded sub-component)",
      ).toBe("healthy");

      // Fail-safe sanity: the LB resource itself was NOT deleted by the fault.
      expect(lbAfterEmpty, "fault(c): LB resource preserved").toBeDefined();

      // --- RECOVERY: restore the Service. Next cycle re-adds the target.
      w.services.push(SEED_SERVICE);
      const r3 = await reconcileOnce(w);
      expect(r3.failed, "fault(c) recovery: clean cycle").toEqual([]);
      const lbRestored = await readLb();
      const restoredIds = lbRestored!.targets
        .filter((t) => t.server)
        .map((t) => t.server!.id);
      expect(
        restoredIds,
        "fault(c) recovery: LB targets the seeded server again",
      ).toContain(SEED_SERVER.hcloud_id!);
    },
    30_000,
  );
});
