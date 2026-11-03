/**
 * core/test/live/v2-managed-cert.live.test.ts
 *
 * Task F6.4 — `@live` managed-certificate smoke (opt-in, manual).
 *
 * What this verifies
 * ------------------
 * The F3.4 `HetznerCertificateProvider`, wired against the REAL Hetzner Cloud
 * API (no fake), can:
 *   1. apply a managed cert for a fresh sub-domain of the operator-supplied
 *      DNS zone (returns `action_status: "pending"`);
 *   2. converge to `action_status: "completed"` within 30 minutes of polling
 *      (real wall clock);
 *   3. expose a usable `not_valid_after` once issued.
 * The test ALWAYS attempts to delete the cert in `afterAll`, regardless of
 * pass/fail, so a leftover certificate never lingers in the sandbox project.
 *
 * How to run
 * ----------
 *   HETZNER_LIVE_TOKEN=<sandbox-cloud-token>            \
 *   HETZNER_LIVE_ZONE=sandbox.example.com               \
 *     npx vitest run --cwd core test/live/v2-managed-cert.live.test.ts
 *
 * (We invoke vitest directly with the file path rather than going through
 * the `npm run live` / `--project live` script: vitest 2.1's `--project`
 * filter does not discover this file under the current inline-`projects`
 * config layout, while the path-based invocation correctly routes the file
 * to the project whose include glob matches — the unit project's
 * live-suffix EXCLUDE keeps it out of `npm --prefix core test`.
 * TODO: revisit once `projects` is migrated to a dedicated
 * `vitest.workspace.ts`.)
 *
 * Required env:
 *   - HETZNER_LIVE_TOKEN — Hetzner Cloud API token with cert read/write
 *     scope, scoped to a SANDBOX project (this test will mutate cert state).
 *   - HETZNER_LIVE_ZONE  — a DNS zone you control via Hetzner DNS, e.g.
 *     `sandbox.example.com`. The cert subject becomes
 *     `live-test-<timestamp>.<zone>`.
 *
 * Behaviour when env is absent
 * ----------------------------
 * `describe.skipIf(!process.env.HETZNER_LIVE_TOKEN)` skips the entire file
 * cleanly — no error, no hang. The default `npm --prefix core test` run does
 * NOT pick up `*.live.test.ts` (see `core/vitest.config.ts`, unit project
 * excludes the glob), so CI is never affected.
 *
 * Expected duration
 * -----------------
 * 30 s – ~10 min in the happy path (Hetzner managed issuance via HTTP-01 +
 * Let's Encrypt). Worst-case wall TTL: 30 min — after that the test fails
 * `cancelled`. Polls every 30 s.
 *
 * Fail-safe stance
 * ----------------
 * - We never delete a pre-existing cert: the test generates a unique
 *   `live-test-<ms>` name so collisions are impossible in practice.
 * - The cleanup hook tolerates absent / already-gone certs (404 swallowed).
 * - Plan-only failures still trigger cleanup so a `pending` cert is reaped.
 */

import { describe, it, afterAll, expect } from "vitest";

import {
  createHetznerV2HttpClient,
  type HetznerV2HttpClient,
} from "../../src/providers/v2/hetzner-cloud-v2-http.js";
import {
  createHetznerCertificateProvider,
  type CertificateProvider,
  type HetznerCertificateShape,
} from "../../src/providers/v2/hetzner-certificate.js";
import type { Certificate } from "../../src/domain/entities-v2.js";

const HETZNER_API_BASE_URL = "https://api.hetzner.cloud/v1";
const POLL_INTERVAL_MS = 30 * 1000; // 30 s
const ISSUANCE_TTL_MS = 30 * 60 * 1000; // 30 min
// Test timeout slightly higher than the issuance TTL so a real TTL-cancel
// case still surfaces as a clean assertion failure, not a Vitest timeout.
const TEST_TIMEOUT_MS = ISSUANCE_TTL_MS + 2 * 60 * 1000;

const token = process.env.HETZNER_LIVE_TOKEN;
const zone = process.env.HETZNER_LIVE_ZONE;

describe.skipIf(!token)("@live HetznerCertificateProvider — managed", () => {
  // Stable per-suite identifiers. Computed at module load (cheap, no I/O) so
  // both the test body and the afterAll cleanup share the same cert name.
  const certName = `live-test-${Date.now()}`;
  const domain = `${certName}.${zone ?? "missing-zone.invalid"}`;

  // Lazily constructed so the unit-project's collection of this file (when it
  // does pick it up) doesn't blow up at module-init on a missing token —
  // `describe.skipIf` skips the `it`, but Vitest still walks the describe
  // body and any throwing top-level expression would mark the file as failed
  // even in a token-less run. The `!` non-null assertions below are safe
  // because the only paths that reach them have already cleared `skipIf`.
  let http: HetznerV2HttpClient | undefined;
  let provider: CertificateProvider | undefined;
  const getClients = (): {
    http: HetznerV2HttpClient;
    provider: CertificateProvider;
  } => {
    if (!http || !provider) {
      http = createHetznerV2HttpClient({
        token: token!,
        baseUrl: HETZNER_API_BASE_URL,
      });
      // Secret resolver is unused for managed certs (Hetzner generates the
      // key server-side via ACME). Guard against accidental misuse.
      provider = createHetznerCertificateProvider({
        http,
        secretResolver: async () => {
          throw new Error(
            "secretResolver called for managed cert — should never happen",
          );
        },
        managedIssuanceTimeoutMs: ISSUANCE_TTL_MS,
      });
    }
    return { http, provider };
  };

  afterAll(async () => {
    // Best-effort delete. We list and match by name (no id leak to assert on
    // in test scope), and tolerate 404 / not-found. Only runs if the test
    // body actually constructed a client.
    if (!http) return;
    try {
      const res = await http.certificates.list();
      const body = (await res.json().catch(() => ({}))) as {
        certificates?: Array<Pick<HetznerCertificateShape, "id" | "name">>;
      };
      const found = (body.certificates ?? []).find((c) => c.name === certName);
      if (found) {
        await http.certificates.delete(found.id).catch(() => undefined);
      }
    } catch {
      // Cleanup is best-effort; surface nothing.
    }
  });

  it(
    "issues a managed cert and reaches completed within TTL",
    async () => {
      // Guard against an obviously misconfigured run: missing zone would have
      // produced a `*.missing-zone.invalid` domain which Hetzner would reject
      // instantly. Fail fast with an actionable message.
      expect(zone, "HETZNER_LIVE_ZONE must be set for the @live smoke").toBeTruthy();

      const { provider } = getClients();
      const desired: Certificate = {
        name: certName,
        type: "managed",
        domains: [domain],
      };

      // First apply — provider POSTs to /certificates and stamps pending.
      const first = await provider.apply(desired, null);
      expect(first.changed).toBe(true);
      expect(first.action_status).toBe("pending");

      // Poll loop: observe → apply until terminal or TTL.
      const deadline = Date.now() + ISSUANCE_TTL_MS;
      let lastStatus: string | undefined;
      let finalObserved = await provider.observe(certName);

      while (Date.now() < deadline) {
        const observed = await provider.observe(certName);
        finalObserved = observed;
        const result = await provider.apply(desired, observed);
        lastStatus = result.action_status;
        if (
          result.action_status === "completed" ||
          result.action_status === "error" ||
          result.action_status === "cancelled"
        ) {
          break;
        }
        await sleep(POLL_INTERVAL_MS);
      }

      expect(lastStatus, "managed cert did not reach a terminal state").toBe(
        "completed",
      );
      expect(finalObserved).not.toBeNull();
      expect(finalObserved?.status).toBe("healthy");
      expect(finalObserved?.hetzner.type).toBe("managed");
      expect(finalObserved?.hetzner.domain_names).toContain(domain);
      expect(finalObserved?.hetzner.not_valid_after).toBeTruthy();
      // not_valid_after must be a parseable RFC3339 timestamp in the future.
      const expiry = Date.parse(finalObserved!.hetzner.not_valid_after!);
      expect(Number.isNaN(expiry)).toBe(false);
      expect(expiry).toBeGreaterThan(Date.now());
    },
    TEST_TIMEOUT_MS,
  );
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
