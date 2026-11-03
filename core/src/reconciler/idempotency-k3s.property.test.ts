/**
 * core/src/reconciler/idempotency-k3s.property.test.ts
 *
 * Bloco E Task 22 — idempotency property for kind `k3s` (apply 2× ⇒ strict
 * no-op on pass 2). Mirrors the sibling `idempotency-kube.property.test.ts`
 * (Task 13) — same file location/naming convention, the HAND-ROLLED Mulberry32
 * deterministic RNG (NO fast-check), the sample loop, assertion style. Fresh
 * seed distinct from the siblings.
 *
 * Property under test, for EVERY random sample in the EnsureK3s input space:
 *
 *   Pass 1 (k3s ABSENT — `k3s --version` exits non-zero):
 *     apply(desired, null) ⇒ `changed:true` AND the install recipe WAS
 *     recorded (≥1 transport call, at least one `env … sh -c` token).
 *
 *   Pass 2 (k3s PRESENT at the SAME desired version):
 *     apply(desired, presentObserved) ⇒ `changed:false` AND ZERO transport
 *     calls recorded (strict no-op — the idempotency lock / Q-a invariant).
 *
 * Additionally, across BOTH passes, ZERO `uninstall`/`upgrade` tokens appear
 * in ANY recorded argv (install-only lock — Task 18 / fail-safe.md).
 *
 * Hand-rolled deterministic fuzz (Mulberry32 RNG, seed 0xc0ffee13). N≥30
 * random EnsureK3s samples per run, each varying `host`, `version`, and
 * `role` deterministically.
 *
 * The provider is built over the Task-3/4 `KubeTransport` wrapping the
 * in-process `ssh-exec-recorder` fake — no real SSH, no network.
 *
 * Spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md (task 22)
 */

import { describe, it, expect, beforeEach } from "vitest";

import { createSshExecRecorder } from "../../test/fakes/ssh-exec-recorder.js";
import { createKubeTransport } from "../providers/v2/kube-transport.js";
import {
  createEnsureK3sProvider,
  k3sIdentityKey,
} from "../providers/v2/ensure-k3s.js";
import type { SshConnection } from "../providers/ssh-exec.js";
import type { ObservedEntity } from "../providers/provider.js";
import type { EnsureK3s } from "../domain/entities-v2.js";
import { EnsureK3sSchema } from "../domain/entities-v2.js";
import type { EnsureK3sObservedProjection } from "../providers/v2/ensure-k3s.js";

// ---------------------------------------------------------------------------
// Deterministic RNG — Mulberry32 (32-bit, seedable, no extra dependency).
// Fresh seed distinct from siblings (0xb10c0e / 0x1a2b3c etc.).
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
// Random EnsureK3s generator. Produces shapes that pass EnsureK3sSchema.
// Each sample varies host / version / role deterministically via the seeded
// RNG. We re-parse defensively; any sample failing the schema is skipped.
// ---------------------------------------------------------------------------

const HOSTS = [
  "prod-k3s",
  "staging-k3s",
  "edge-k3s",
  "dev-k3s",
  "worker-01",
  "worker-02",
] as const;

const VERSIONS = [
  "v1.28.0+k3s1",
  "v1.29.4+k3s1",
  "v1.30.2+k3s1",
  "v1.31.0+k3s1",
  "v1.32.1+k3s2",
] as const;

const ROLES = ["server", "agent"] as const;

function genEnsureK3s(rng: () => number): EnsureK3s {
  return {
    host: pick(rng, HOSTS),
    version: pick(rng, VERSIONS),
    role: pick(rng, ROLES),
  };
}

// ---------------------------------------------------------------------------
// Helper: detect forbidden tokens in recorded argv
// ---------------------------------------------------------------------------

/** True if any recorded call's argv contains a forbidden operation token. */
function hasUninstallOrUpgrade(calls: ReadonlyArray<{ remoteArgv: readonly string[] }>): boolean {
  return calls.some((c) =>
    c.remoteArgv.some((tok) =>
      tok === "uninstall" || tok === "upgrade" ||
      tok.includes("uninstall") || tok.includes("upgrade"),
    ),
  );
}

/** True if any recorded call's argv contains an install-recipe token. */
function hasInstallRecipe(calls: ReadonlyArray<{ remoteArgv: readonly string[] }>): boolean {
  // The install recipe argv: env INSTALL_K3S_VERSION=... INSTALL_K3S_EXEC=... sh -c <script>
  // We look for the "env" prefix token OR the "get.k3s.io" / "curl" / "sh" tokens
  // that are characteristic of the install one-liner. ANY of these signals an install.
  return calls.some((c) =>
    c.remoteArgv.some((tok) =>
      tok === "env" ||
      tok === "curl" ||
      tok.includes("get.k3s.io") ||
      tok.includes("sh") ||
      tok.startsWith("INSTALL_K3S_"),
    ),
  );
}

// ---------------------------------------------------------------------------
// The property: apply 2× per random EnsureK3s is a strict no-op on pass 2.
// ---------------------------------------------------------------------------

const SEED = 0xc0ffee13; // fresh seed — distinct from 0xb10c0e (kube) siblings
const SAMPLES = 36; // N≥30

describe("k3s idempotency property (Task 22 — CENTRAL GUARANTEE)", () => {
  const conn: SshConnection = {
    host: "prod-k3s",
    user: "root",
    port: 22,
    privateKey: "FAKE-KEY-not-secret-in-test",
    hostKeyPolicy: "accept-new",
  };

  const recorder = createSshExecRecorder();
  const transport = createKubeTransport({ run: recorder.run, conn });
  const provider = createEnsureK3sProvider({ transport });

  beforeEach(() => {
    recorder.reset();
  });

  it(
    `applies ${SAMPLES} random EnsureK3s samples; pass 2 (PRESENT same version) is ALWAYS a strict no-op (seed=0x${SEED.toString(16)})`,
    async () => {
      const rng = mulberry32(SEED);

      for (let i = 0; i < SAMPLES; i++) {
        const candidate = genEnsureK3s(rng);
        // Re-parse through the FROZEN schema; skip rare unparseable samples.
        const parsed = EnsureK3sSchema.safeParse(candidate);
        if (!parsed.success) continue;
        const desired = parsed.data;
        const entityKey = k3sIdentityKey(desired);

        // -- Pass 1: k3s ABSENT (`k3s --version` exits non-zero). apply must
        //    report changed:true and the install recipe must be recorded.
        recorder.reset();
        recorder.setResultByMatcher(
          (argv) => argv[0] === "k3s" && argv[1] === "--version",
          { code: 1, stdout: "", stderr: "k3s: not found" },
        );
        // All other commands fall through to default (code:0, stdout:"", stderr:"").

        const res1 = await provider.apply(desired, null);
        expect(res1.entity, `${entityKey} [i=${i}]: pass 1 entity key`).toBe(entityKey);
        expect(res1.changed, `${entityKey} [i=${i}]: pass 1 changed===true (install ran)`).toBe(true);
        // The install recipe must have been recorded (at least one call with install tokens).
        expect(
          hasInstallRecipe(recorder.calls),
          `${entityKey} [i=${i}]: pass 1 install recipe was recorded`,
        ).toBe(true);
        // No uninstall/upgrade token on EITHER pass.
        expect(
          hasUninstallOrUpgrade(recorder.calls),
          `${entityKey} [i=${i}]: pass 1 no uninstall/upgrade argv`,
        ).toBe(false);

        // -- Build the PRESENT observed projection: same host, same version, installed.
        const presentProjection: EnsureK3sObservedProjection = {
          installed: true,
          version: desired.version,
          active: true,
          ready: true,
        };
        const presentObserved: ObservedEntity = {
          key: entityKey,
          payload: presentProjection,
        };

        // -- Pass 2: k3s PRESENT at the SAME desired version. Reset the recorder so
        //    we count ONLY pass-2 calls. apply must return changed:false AND record
        //    ZERO transport calls (strict no-op — Q-a / idempotency lock).
        recorder.reset();
        // Script k3s --version to exit 0 (present). Even if apply() calls observe
        // internally before deciding, it should short-circuit on the observed argument.
        recorder.setResultByMatcher(
          (argv) => argv[0] === "k3s" && argv[1] === "--version",
          {
            code: 0,
            stdout: `k3s version ${desired.version} (abcdef12)`,
            stderr: "",
          },
        );
        recorder.setResultByMatcher(
          (argv) => argv[0] === "systemctl",
          { code: 0, stdout: "active", stderr: "" },
        );

        const res2 = await provider.apply(desired, presentObserved);
        expect(res2.entity, `${entityKey} [i=${i}]: pass 2 entity key`).toBe(entityKey);
        expect(
          res2.changed,
          `${entityKey} [i=${i}]: pass 2 strict no-op (changed===false)`,
        ).toBe(false);
        // No `result:"drift"` — same version means converged no-op, not drift.
        expect(
          res2.result,
          `${entityKey} [i=${i}]: pass 2 no drift signal (same version)`,
        ).toBeUndefined();
        // ZERO transport calls — the no-op is STRICT (does not even probe the host).
        expect(
          recorder.calls.length,
          `${entityKey} [i=${i}]: pass 2 ZERO transport calls (strict no-op)`,
        ).toBe(0);
        // Belt-and-suspenders: no install or uninstall tokens on pass 2.
        expect(
          hasInstallRecipe(recorder.calls),
          `${entityKey} [i=${i}]: pass 2 no install recipe recorded`,
        ).toBe(false);
        expect(
          hasUninstallOrUpgrade(recorder.calls),
          `${entityKey} [i=${i}]: pass 2 no uninstall/upgrade argv`,
        ).toBe(false);
      }
    },
  );
});
