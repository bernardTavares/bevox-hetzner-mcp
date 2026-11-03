/**
 * core/src/reconciler/idempotency-kube.property.test.ts
 *
 * Bloco E Task 13 — central idempotency guarantee for the v2
 * KubernetesProvider (kind `kube`). Mirrors the v2 provider-level property
 * tests verbatim (hand-rolled deterministic fuzz — NO fast-check dependency;
 * none is declared in core/package.json). Sibling template:
 * `idempotency-load-balancer.property.test.ts` (F4.5).
 *
 * Property under test, for EVERY random sample in the KubeManifest input
 * space:
 *
 *   applying any KubeManifest converges, and the SECOND pass is ALWAYS a
 *   strict no-op:
 *     - pass 1 (observed null): apply ⇒ `changed:true` AND exactly ONE
 *       `kubectl apply -f -` call recorded;
 *     - feed back the observed projection observe() would return AFTER that
 *       apply (carrying the live hash == desired hash, because the same body
 *       was applied), then apply again ⇒ `changed:false` AND ZERO `kubectl
 *       apply` calls recorded (strict, hash-driven no-op — Q-b).
 *
 * The idempotency signal is the `hetzner-mcp/manifest-hash` content-hash (Q-b):
 * apply computes `manifestHash(desired.body)` over the PLAN/OBSERVE form
 * (refs, not resolved values) and compares to `observed.manifestHash`; equal
 * ⇒ `{changed:false}` with ZERO kubectl calls. The 2nd-pass observed hash is
 * the REAL `manifestHash` export (never hardcoded), so the property is the
 * idempotency LOCK ground-rule #2 / spec §"idempotência por design" require.
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, fixed seed). N≥30 random
 * KubeManifests per run, each varying `host`, `namespace`, `kind`,
 * `metadata.name`, and `body` deterministically.
 *
 * The provider is built over the Task-3/4 `KubeTransport` (`createKubeTransport`)
 * wrapping the in-process `ssh-exec-recorder` fake (no real SSH, no network),
 * scripting `kubectl apply` → exit 0. This sits in `core/src/reconciler/` (the
 * Bloco-A/E property-test home) but is a PROVIDER-level idempotency property —
 * the strict 2nd-pass no-op IS the canonical invariant the reconciler builds on.
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createSshExecRecorder } from "../../test/fakes/ssh-exec-recorder.js";
import { createKubeTransport } from "../providers/v2/kube-transport.js";
import {
  createKubernetesProvider,
  kubeIdentityKey,
  manifestHash,
} from "../providers/v2/kube-apply.js";
import type { SshConnection } from "../providers/ssh-exec.js";
import { createApplyContext } from "../store/secrets.js";
import type { ObservedEntity } from "../providers/provider.js";
import type { KubeManifest } from "../domain/entities-v2.js";
import { KubeManifestSchema } from "../domain/entities-v2.js";

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
// Random KubeManifest generator. Produces shapes that PASS KubeManifestSchema
// (we re-parse defensively; any sample that fails parsing is skipped — never
// false-fails the property on a syntactically invalid sample).
//
// Each sample varies host / namespace / kind / metadata.name AND the opaque
// `body`. The body is a small, deterministically-varied YAML document so two
// distinct samples produce DISTINCT hashes (the hash is over the body bytes).
// ---------------------------------------------------------------------------

const HOSTS = ["prod-k3s", "staging-k3s", "edge-k3s", "dev-k3s"] as const;
const NAMESPACES = ["bevox", "kube-system", "default", "harness"] as const;
const KINDS = ["Deployment", "Service", "ConfigMap", "Secret"] as const;
const API_VERSIONS = ["apps/v1", "v1", "batch/v1"] as const;
const NAMES = ["api", "web", "worker", "harness", "cache"] as const;
const REPLICAS = [1, 2, 3, 5] as const;
const IMAGES = [
  "ghcr.io/bevox/api:1",
  "ghcr.io/bevox/web:2",
  "nginx:stable",
  "redis:7",
] as const;

function genBody(
  rng: () => number,
  kind: string,
  apiVersion: string,
  name: string,
  namespace: string,
): string {
  // A deterministically-varied single-document YAML. Varying replicas/image
  // ensures distinct samples yield distinct manifestHash values; the exact
  // shape is irrelevant to the provider (the body is opaque — piped verbatim).
  return [
    `apiVersion: ${apiVersion}`,
    `kind: ${kind}`,
    "metadata:",
    `  name: ${name}`,
    `  namespace: ${namespace}`,
    "spec:",
    `  replicas: ${pick(rng, REPLICAS)}`,
    "  template:",
    "    spec:",
    "      containers:",
    `        - name: ${name}`,
    `          image: ${pick(rng, IMAGES)}`,
  ].join("\n");
}

function genKubeManifest(rng: () => number): KubeManifest {
  const apiVersion = pick(rng, API_VERSIONS);
  const kind = pick(rng, KINDS);
  const name = pick(rng, NAMES);
  const namespace = pick(rng, NAMESPACES);
  return {
    host: pick(rng, HOSTS),
    apiVersion,
    kind,
    metadata: { name },
    namespace,
    body: genBody(rng, kind, apiVersion, name, namespace),
  };
}

// ---------------------------------------------------------------------------
// The property: apply 2× per random KubeManifest is a strict no-op on pass 2.
// ---------------------------------------------------------------------------

const SEED = 0xb10c0e; // fixed seed — reproducible failures (distinct from F1.5/F4.5)
const SAMPLES = 36; // N≥30

describe("Kube idempotency property (Task 13 — CENTRAL GUARANTEE)", () => {
  const conn: SshConnection = {
    host: "prod-k3s",
    user: "root",
    port: 22,
    privateKey: "FAKE-KEY-not-secret-in-test",
    hostKeyPolicy: "accept-new",
  };

  const recorder = createSshExecRecorder();
  const transport = createKubeTransport({ run: recorder.run, conn });
  const provider = createKubernetesProvider({ transport });
  // A valid apply-only capability token (kube apply accepts an optional ctx).
  const ctx = createApplyContext();

  beforeEach(() => {
    recorder.reset();
    // kubectl apply exits 0 for every sample.
    recorder.setResultByMatcher((argv) => argv.includes("apply"), {
      code: 0,
      stdout: "configured",
      stderr: "",
    });
  });

  /** Count `kubectl apply` calls the transport recorded so far. */
  function applyCallCount(): number {
    return recorder.calls.filter((c) => c.remoteArgv.includes("apply")).length;
  }

  it(`applies ${SAMPLES} random KubeManifests; the 2nd pass is ALWAYS a strict no-op (seed=${SEED.toString(16)})`, async () => {
    const rng = mulberry32(SEED);

    for (let i = 0; i < SAMPLES; i++) {
      const candidate = genKubeManifest(rng);
      // Re-parse through the FROZEN schema; skip rare unparseable samples.
      const parsed = KubeManifestSchema.safeParse(candidate);
      if (!parsed.success) continue;
      const manifest = parsed.data;
      const entityKey = kubeIdentityKey(manifest);

      // -- Pass 1: observed null (fresh). apply must converge & report changed,
      //    with EXACTLY ONE `kubectl apply -f -` call. Fresh recorder per sample.
      recorder.reset();
      recorder.setResultByMatcher((argv) => argv.includes("apply"), {
        code: 0,
        stdout: "configured",
        stderr: "",
      });

      const res1 = await provider.apply(manifest, null, ctx);
      expect(res1.entity, `${entityKey}: pass 1 entity key`).toBe(entityKey);
      expect(res1.changed, `${entityKey}: pass 1 changed===true`).toBe(true);
      expect(
        applyCallCount(),
        `${entityKey}: pass 1 recorded exactly ONE kubectl apply`,
      ).toBe(1);

      // -- Build the observed projection observe() would return AFTER that
      //    apply: identity + the LIVE hash, which equals the DESIRED hash
      //    because the same body was applied. Uses the REAL manifestHash export.
      const liveHash = manifestHash(manifest.body);
      const observed: ObservedEntity = {
        key: entityKey,
        payload: {
          apiVersion: manifest.apiVersion,
          kind: manifest.kind,
          namespace: manifest.namespace,
          name: manifest.metadata.name,
          manifestHash: liveHash,
        },
      };

      // -- Pass 2: hash MATCH ⇒ STRICT no-op. Reset the recorder so we count
      //    ONLY pass-2 calls: apply must return changed:false AND record ZERO
      //    `kubectl apply` calls (not even a read).
      recorder.reset();
      recorder.setResultByMatcher((argv) => argv.includes("apply"), {
        code: 0,
        stdout: "configured",
        stderr: "",
      });

      const res2 = await provider.apply(manifest, observed, ctx);
      expect(res2.entity, `${entityKey}: pass 2 entity key`).toBe(entityKey);
      expect(
        res2.changed,
        `${entityKey}: pass 2 strict no-op (changed===false)`,
      ).toBe(false);
      expect(
        applyCallCount(),
        `${entityKey}: pass 2 recorded ZERO kubectl apply calls`,
      ).toBe(0);
      // Absolutely nothing crossed the transport on a strict no-op.
      expect(
        recorder.calls.length,
        `${entityKey}: pass 2 made ZERO transport calls`,
      ).toBe(0);
    }
  });
});
