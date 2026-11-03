/**
 * core/src/reconciler/idempotency-certificate.property.test.ts
 *
 * Task F3.6 — central idempotency guarantee for the v2
 * HetznerCertificateProvider. Mirrors F1.5 (firewall) and F2.5 (primary-ip)
 * verbatim (hand-rolled deterministic fuzz — no fast-check dependency).
 *
 * Property under test, for EVERY random sample in the Certificate input
 * space (both `managed` and `uploaded` branches):
 *
 *   applying any Certificate manifest N times converges, and cycles 2..N
 *   are a strict no-op (provider returns `changed:false` AND the wrapped
 *   Hetzner fake records ZERO additional non-GET HTTP calls, AND
 *   `verify()` is true).
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, fixed seed). ~10 random
 * Certificates per run — half managed, half uploaded — each with 1-3 random
 * domains. The Hetzner fake is configured with
 * `setManagedIssuanceLatency(0)` so managed certs flip to `healthy` on the
 * first `observe()` after the initial POST (no async polling — we want a
 * pure idempotency check, not a state-machine convergence check). Uploaded
 * certs use a deterministic stub PEM + a `secret:<name>` ref; the
 * secretResolver is a deterministic stub returning the matching key PEM.
 *
 * This sits in `core/src/reconciler/` (per the Bloco-A plan) but it is a
 * PROVIDER-level idempotency property — Bloco-A's v2 reconciler integration
 * lands later. The cycle ≥2 no-op guarantee IS the canonical idempotency
 * invariant the future reconciler builds on (spec-mãe §"idempotência por
 * design").
 */

import { describe, it, expect } from "vitest";

import { createHetznerHttpFake } from "../../test/fakes/hetzner-http.js";
import { createHetznerV2HttpClient } from "../providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerCertificateProvider } from "../providers/v2/hetzner-certificate.js";
import type { Certificate } from "../domain/entities-v2.js";
import { CertificateSchema } from "../domain/entities-v2.js";

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
// Random Certificate generator. Produces shapes that PASS CertificateSchema;
// any sample that fails parsing is skipped (never false-fails the property
// on a syntactically invalid sample).
//
// The mock PEM-pairing rule in hetzner-certificate.ts requires the cert and
// key inner-body to share the same trailing identifier (everything after
// the last `-`). We use a per-sample id (`web<i>`) and stamp it into both
// the cert body and the resolver's stub key body so parsePem() pairs them.
// ---------------------------------------------------------------------------

const DOMAIN_ROOTS = [
  "web",
  "api",
  "db",
  "edge",
  "admin",
  "static",
  "cdn",
] as const;

function genDomains(rng: () => number, ordinal: number): string[] {
  const count = 1 + Math.floor(rng() * 3); // 1..3
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const root = pick(rng, DOMAIN_ROOTS);
    const d = `${root}-${ordinal}-${i}.example.com`;
    if (!seen.has(d)) {
      seen.add(d);
      out.push(d);
    }
  }
  return out;
}

function genCert(rng: () => number, ordinal: number): Certificate {
  const isManaged = ordinal % 2 === 0; // half managed, half uploaded
  const domains = genDomains(rng, ordinal);
  if (isManaged) {
    return {
      name: `fuzz-cert-${ordinal}`,
      type: "managed",
      domains,
    } as Certificate;
  }
  // Uploaded — stamp a per-sample trailing id (`web<ordinal>`) so the F3.3
  // mock parsePem() pairs cert + resolved key.
  const trail = `web${ordinal}`;
  const certPem =
    `-----BEGIN CERTIFICATE-----\nfakecert-${trail}\n-----END CERTIFICATE-----`;
  return {
    name: `fuzz-cert-${ordinal}`,
    type: "uploaded",
    domains,
    certificate_pem: certPem,
    private_key_secret_ref: `secret:fuzz-cert-${ordinal}-key`,
  } as Certificate;
}

// ---------------------------------------------------------------------------
// The property: cycles 2..N per random Certificate are a strict no-op.
// ---------------------------------------------------------------------------

const SEED = 0xa17fb57; // fixed seed — reproducible failures (distinct from F1.5 / F2.5)
const SAMPLES = 10;
const CYCLES = 4;

describe("Certificate idempotency property (F3.6 — CENTRAL GUARANTEE)", () => {
  it(`applies ${SAMPLES} random Certificates ${CYCLES}× each; cycles 2..${CYCLES} are a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);
    const fake = createHetznerHttpFake();
    // Settle managed issuance on the first GET after create — keeps the
    // property focused on idempotency, not on the polling state machine.
    fake.setManagedIssuanceLatency(0);

    // Track non-GET HTTP calls into the fake; cycles ≥2 must add ZERO writes.
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

    // Deterministic stub secret resolver — returns a key PEM whose trailing
    // identifier matches the cert's (the F3.3 mock parsePem pairing rule).
    // The ref shape is `secret:fuzz-cert-<i>-key` ⇒ extract the ordinal.
    const secretResolver = async (ref: string): Promise<string> => {
      const m = /fuzz-cert-(\d+)-key$/.exec(ref);
      const ordinal = m ? Number(m[1]) : 0;
      const trail = `web${ordinal}`;
      return `-----BEGIN PRIVATE KEY-----\nfakekey-${trail}\n-----END PRIVATE KEY-----`;
    };

    const provider = createHetznerCertificateProvider({
      http: v2http,
      secretResolver,
    });

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genCert(rng, i);
      // Re-parse through the FROZEN schema; skip rare unparseable samples.
      const parsed = CertificateSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const cert = parsed.data;
      const entityKey = `certificate:${cert.name}`;

      // Cycle 1: observe → null (fresh), apply must converge & report changed.
      const obs1 = await provider.observe(cert.name);
      expect(obs1, `${cert.name}: observed is null on cycle 1`).toBeNull();
      const writesBefore1 = writeCalls.length;
      const res1 = await provider.apply(cert, obs1);
      expect(res1.entity, `${cert.name}: entity key`).toBe(entityKey);
      expect(res1.changed, `${cert.name}: cycle 1 changed===true`).toBe(true);
      expect(
        writeCalls.length,
        `${cert.name}: cycle 1 made at least one write`,
      ).toBeGreaterThan(writesBefore1);
      // verify() must report converged after cycle 1 (managed flips to
      // healthy on observe() because latency=0; uploaded is healthy
      // immediately on create).
      expect(
        await provider.verify(cert),
        `${cert.name}: verify() true after cycle 1`,
      ).toBe(true);

      // Cycles 2..N: observed reflects desired; apply must be a strict no-op.
      for (let c = 2; c <= CYCLES; c++) {
        const writesBefore = writeCalls.length;
        const obs = await provider.observe(cert.name);
        expect(obs, `${cert.name}: observed non-null on cycle ${c}`).not.toBeNull();
        const res = await provider.apply(cert, obs);
        expect(
          res.changed,
          `${cert.name}: cycle ${c} strict no-op (changed===false)`,
        ).toBe(false);
        expect(
          writeCalls.length - writesBefore,
          `${cert.name}: cycle ${c} issued ZERO HTTP writes`,
        ).toBe(0);
        expect(
          await provider.verify(cert),
          `${cert.name}: verify() true on cycle ${c}`,
        ).toBe(true);
      }
    }
  });
});
