/**
 * core/src/reconciler/idempotency-ingress.property.test.ts
 *
 * Task F5.5 — central idempotency guarantee for the v2 IngressProvider
 * composite (F5.2). Mirrors F1.5 (firewall), F2.5 (primary-ip), F3.6
 * (certificate), and F4.5 (load-balancer) verbatim — hand-rolled
 * deterministic fuzz, no fast-check dependency.
 *
 * Property under test, for EVERY random sample in the Ingress input space:
 *
 *   applying any Ingress manifest N times converges, and cycles 2..N are a
 *   strict no-op (composite changed:false AND the wrapped Hetzner fake
 *   records ZERO additional non-GET HTTP calls into the Hetzner sub-
 *   providers AND verify() is true).
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, fixed seed). ~8 random
 * Ingresses per run, each with 1..3 deterministic routes; deterministic
 * refs into a SHARED pre-existing pool of cert / lb / fw fixtures (so the
 * IngressProvider's lookups always resolve and the strict-equality
 * boundary the F4.3 LB provider walks as a no-op on cycle ≥2 stays
 * intact). Cert is managed with `setManagedIssuanceLatency(0)` so
 * issuance settles synchronously on cycle 1.
 *
 * Both servicesProvider and serversProvider return `[]` so the LB target
 * set resolves to ∅ for every fuzz sample (same posture as F4.5).
 *
 * This sits in `core/src/reconciler/` (per the Bloco-A plan) but it is a
 * PROVIDER-level idempotency property — Bloco-A's v2 reconciler
 * integration lands later. The cycle ≥2 no-op guarantee IS the canonical
 * idempotency invariant the future reconciler builds on (spec-mãe
 * §"idempotência por design").
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerCertificateProvider } from "../providers/v2/hetzner-certificate.js";
import { createHetznerFirewallProvider } from "../providers/v2/hetzner-firewall.js";
import { createHetznerLoadBalancerProvider } from "../providers/v2/hetzner-load-balancer.js";
import { createIngressProvider } from "../providers/v2/ingress.js";
import type {
  Certificate,
  Firewall,
  Ingress,
  LoadBalancer,
} from "../domain/entities-v2.js";
import { IngressSchema } from "../domain/entities-v2.js";
import type {
  ApplyResult as DnsApplyResult,
  ObservedSlice as DnsObservedSlice,
  PlanAction as DnsPlanAction,
  Provider as DnsProvider,
} from "../providers/provider.js";

const BASE = "https://api.hetzner.cloud/v1";

// ---------------------------------------------------------------------------
// Deterministic RNG — Mulberry32 (32-bit, seedable, no extra dependency).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rng() * xs.length)]!;
}

// ---------------------------------------------------------------------------
// Shared pool of pre-existing cert / lb / fw fixtures the fuzzed Ingresses'
// refs resolve into. Stable identifiers ⇒ deterministic LB / cert state on
// the Hetzner fake (each fuzz Ingress that picks `web-lb` shares the SAME
// observed LB, so cycle ≥2 stays a no-op).
// ---------------------------------------------------------------------------

const CERTS: Record<string, Certificate> = {
  "web-cert": {
    name: "web-cert",
    type: "managed",
    domains: ["web.example.com"],
  },
  "api-cert": {
    name: "api-cert",
    type: "managed",
    domains: ["api.example.com"],
  },
};

const LBS: Record<string, LoadBalancer> = {
  "web-lb": {
    name: "web-lb",
    location: "fsn1",
    algorithm: "round_robin",
    targets: { label: "lb-backend" },
    health_check: {
      protocol: "http",
      port: 80,
      interval: 15,
      timeout: 10,
      retries: 3,
      path: "/health",
    },
  },
  "api-lb": {
    name: "api-lb",
    location: "fsn1",
    algorithm: "round_robin",
    targets: { label: "lb-backend" },
    health_check: {
      protocol: "http",
      port: 80,
      interval: 15,
      timeout: 10,
      retries: 3,
      path: "/health",
    },
  },
};

const FWS: Record<string, Firewall> = {
  "web-fw": {
    name: "web-fw",
    rules: [
      {
        direction: "in",
        protocol: "tcp",
        port: "80",
        source_ips: ["0.0.0.0/0"],
      },
    ],
    applied_to: { label: "lb-backend" },
  },
};

const CERT_REFS = Object.keys(CERTS);
const LB_REFS = Object.keys(LBS);
// firewall_ref is optional — `null` selects the "no firewall" branch.
const FW_REFS_OR_NULL: ReadonlyArray<string | null> = [
  null,
  null,
  ...Object.keys(FWS),
];

// ---------------------------------------------------------------------------
// Random Ingress generator. Hostnames are pinned to the cert's `domains[0]`
// so cycle ≥2 stays a no-op (the IngressProvider's DNS upsert is also
// idempotent on the v1 DnsProvider port). Routes carry 1..3 deterministic
// paths from a fixed pool.
// ---------------------------------------------------------------------------

const ROUTE_PATHS = ["/", "/api", "/v1", "/health"] as const;
const ROUTE_PORTS = [80, 443, 8080] as const;
const ROUTE_LABELS = ["web", "api", "edge"] as const;

function genRoutes(rng: () => number): Ingress["routes"] {
  const n = 1 + Math.floor(rng() * 3); // 1..3
  // Dedup paths within an ingress (schema doesn't reject dupes but the LB
  // provider's downstream wouldn't either; we keep paths unique for
  // determinism / readability).
  const used = new Set<string>();
  const routes: Ingress["routes"] = [] as unknown as Ingress["routes"];
  let attempts = 0;
  while ((routes as unknown[]).length < n && attempts < 16) {
    attempts++;
    const path = pick(rng, ROUTE_PATHS);
    if (used.has(path)) continue;
    used.add(path);
    (routes as unknown[]).push({
      path,
      backend: {
        service_selector: { label: pick(rng, ROUTE_LABELS) },
        port: pick(rng, ROUTE_PORTS),
      },
    });
  }
  return routes;
}

function genIngress(rng: () => number, ordinal: number): Ingress {
  const certRef = pick(rng, CERT_REFS);
  const cert = CERTS[certRef]!;
  // Pin hostname to the cert's domain to keep cross-cycle DNS state stable.
  const hostname = cert.domains[0]!;
  const lbRef = pick(rng, LB_REFS);
  const fwRef = pick(rng, FW_REFS_OR_NULL);
  const base: Ingress = {
    name: `fuzz-ing-${ordinal}`,
    hostname,
    tls: { certificate_ref: certRef },
    routes: genRoutes(rng),
    load_balancer_ref: lbRef,
    ...(fwRef ? { firewall_ref: fwRef } : {}),
  };
  return base;
}

// ---------------------------------------------------------------------------
// Trivial idempotent DNS fake. The v1 DnsProvider port has no plan(); the
// composite calls apply({op:"upsert",...}) on each cycle. To preserve the
// "ZERO writes on cycle ≥2" invariant we track upserts internally and only
// report changed:true on the FIRST upsert per (zone,name,type,value).
// ---------------------------------------------------------------------------

function makeIdempotentDns(): DnsProvider {
  const seen = new Set<string>();
  return {
    name: "fake-dns-idempotent",
    async observe(scope: string): Promise<DnsObservedSlice> {
      return { scope, entities: [] };
    },
    async apply(action: DnsPlanAction): Promise<DnsApplyResult> {
      // Key on the full desired record so a real value change re-flips
      // changed:true (defensive — the fuzz never mutates a record under us,
      // so this branch is exercise-only).
      const d = (action as { desired?: unknown }).desired ?? {};
      const key = `${action.op}|${action.entity}|${JSON.stringify(d)}`;
      const fresh = !seen.has(key);
      if (fresh) seen.add(key);
      return { entity: action.entity, op: action.op, changed: fresh };
    },
    async verify(): Promise<boolean> {
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// The property: cycles 2..N per random Ingress are a strict no-op.
// ---------------------------------------------------------------------------

const SEED = 0x3121607; // fixed seed — reproducible (distinct from F1.5–F4.5)
const SAMPLES = 8;
const CYCLES = 4;

describe("Ingress idempotency property (F5.5 — CENTRAL GUARANTEE)", () => {
  it(`applies ${SAMPLES} random Ingresses ${CYCLES}× each; cycles 2..${CYCLES} are a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    const fake = createHetznerHttpFake();
    // Managed cert issuance settles synchronously on cycle 1 so the
    // composite reaches healthy / changed:false on cycle 2.
    fake.setManagedIssuanceLatency(0);

    // Track non-GET HTTP calls into the Hetzner fake; cycles ≥2 must add
    // ZERO writes.
    const writeCalls: { url: string; method: string }[] = [];
    const wrappedFetch: typeof fake.fetch = async (url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (method !== "GET") {
        writeCalls.push({ url: String(url), method });
      }
      return fake.fetch(url, init);
    };
    const v2http = createHetznerV2HttpClient({
      token: "secret-token",
      baseUrl: BASE,
      fetchImpl: wrappedFetch,
    });

    const certProvider = createHetznerCertificateProvider({
      http: v2http,
      // Uploaded path never reached (managed-only pool); stub kept valid.
      secretResolver: async () =>
        "-----BEGIN PRIVATE KEY-----\nunused\n-----END PRIVATE KEY-----",
    });
    const lbProvider = createHetznerLoadBalancerProvider({
      http: v2http,
      serversProvider: async () => [],
      servicesProvider: async () => [],
    });
    const fwProvider = createHetznerFirewallProvider({
      http: v2http,
      serversProvider: async () => [],
    });
    const dnsProvider = makeIdempotentDns();

    const provider = createIngressProvider({
      certificateProvider: certProvider,
      loadBalancerProvider: lbProvider,
      firewallProvider: fwProvider,
      dnsProvider,
      serversProvider: async () => [],
      servicesProvider: async () => [],
      certificateLookup: async (name: string) => CERTS[name] ?? null,
      loadBalancerLookup: async (name: string) => LBS[name] ?? null,
      firewallLookup: async (name: string) => FWS[name] ?? null,
    });

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genIngress(rng, i);
      // Re-parse through the FROZEN schema; skip rare unparseable samples.
      const parsed = IngressSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const ing = parsed.data;
      const entityKey = `ingress:${ing.name}`;

      // Cycle 1: observe → null (fresh), apply must converge & report changed.
      const obs1 = await provider.observe(ing);
      // observe() returns null when ALL sub-observed are null. Across fuzz
      // samples the shared cert/LB pool means later samples MAY see a non-
      // null observed if a previous sample already created it. So we DON'T
      // assert observed===null here — we assert at-least-one-write was
      // issued on cycle 1 across the composite, and cycles 2..N are
      // strictly zero.
      const writesBefore1 = writeCalls.length;
      const res1 = await provider.apply(ing, obs1);
      expect(res1.entity, `${ing.name}: entity key`).toBe(entityKey);
      // For shared-pool samples that re-converge on the SAME observed cert/LB,
      // cycle 1 may already be a no-op — that's actually STRONGER than the
      // property (idempotency wins). We only assert "changed reflects writes".
      const writesAfter1 = writeCalls.length;
      const wroteOnCycle1 = writesAfter1 > writesBefore1;
      if (wroteOnCycle1) {
        expect(
          res1.changed,
          `${ing.name}: cycle 1 changed===true when writes were issued`,
        ).toBe(true);
      }
      // verify() must report true after cycle 1.
      expect(
        await provider.verify(ing),
        `${ing.name}: verify() true after cycle 1`,
      ).toBe(true);

      // Cycles 2..N: apply must be a strict no-op (composite changed:false
      // AND zero non-GET HTTP into the Hetzner fake).
      for (let c = 2; c <= CYCLES; c++) {
        const writesBefore = writeCalls.length;
        const obs = await provider.observe(ing);
        const res = await provider.apply(ing, obs);
        expect(
          res.changed,
          `${ing.name}: cycle ${c} strict no-op (changed===false)`,
        ).toBe(false);
        expect(
          writeCalls.length - writesBefore,
          `${ing.name}: cycle ${c} issued ZERO HTTP writes into Hetzner`,
        ).toBe(0);
        expect(
          await provider.verify(ing),
          `${ing.name}: verify() true on cycle ${c}`,
        ).toBe(true);
      }
    }

    // The fuzz pool spans 2 distinct certs + 2 distinct LBs ⇒ across 8
    // samples we must have issued at LEAST one write on cycle 1 for the
    // first sample (the fake starts empty). Sanity guard so a degenerate
    // RNG choice can't silently degrade the property to vacuously-true.
    expect(writeCalls.length).toBeGreaterThan(0);
  });
});
