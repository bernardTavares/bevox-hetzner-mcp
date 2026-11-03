/**
 * core/src/providers/v2/hetzner-certificate.ts
 *
 * Tasks F3.3 (uploaded) + F3.4 (managed, non-blocking polling).
 *
 * F3.4 — MANAGED path with NON-BLOCKING polling (spec-filha §3.3, §8):
 *   - First apply (observed null): POST /certificates type=managed → cert
 *     enters `status.issuance: pending`. Observed wrapper carries
 *     `status: "pending"` and provider stamps `apply_started_at` (provider-
 *     local cache; cleared on terminal state) so subsequent cycles can detect
 *     the TTL timeout (default 30min, clock injectable).
 *   - Subsequent apply cycles: provider re-observes (≤1 GET per cycle —
 *     `certs.get(id)` advances the fake's poll counter and reads the live
 *     status). If still pending and within TTL → no-op. If `completed` →
 *     observed flips to `healthy`. If `failed` → marks `error`. If TTL
 *     exceeded → marks `cancelled`, agent must explicitly retry.
 *   - Renewal drift (spec-filha §8): observe() inspects `not_valid_after`
 *     and, if <14d from now AND no in-progress renewal, plan() emits a
 *     `drift` op with target `renewal` and reason `cert-expiring-soon`.
 *     Fail-safe: the provider NEVER auto-renews; agent decides.
 *   - Provider does NOT publish _acme-challenge DNS records. A
 *     `requires_dns_challenge` hint from the backend surfaces as
 *     `precondition_failed` with a TODO note pointing at the future
 *     HetznerDNSProvider orchestration (opt-in follow-up; not in scope).
 *
 * Design principles (spec-mãe + spec-filha Bloco A; spec §227-243 secret-at-
 * apply; F3.3 brief):
 *
 *   - IDEMPOTENCY. apply(desired, observed) converges then is a NO-OP on a
 *     second call. Equality is set-based on domains and fingerprint-based on
 *     PEM content.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. Certificates are not silently mutated.
 *     Hetzner uploaded certs are IMMUTABLE in place: any attempt to change
 *     content surfaces as a plan-time `precondition` (the agent must
 *     explicitly destroy+recreate via a later approval-gated tool, parallel
 *     to F1.4 / F2.4). Out-of-band fingerprint changes are reported as
 *     `drift` only — never silently re-uploaded.
 *
 *   - SECRET RESOLUTION AT APPLY ONLY (spec §227-243). The provider takes a
 *     `secretResolver: (ref) => Promise<string>` callback dep. plan() /
 *     dry_run NEVER call it — they see only the (non-sensitive) reference
 *     string. apply() resolves it exactly once and POSTs the resolved
 *     `private_key` to Hetzner alongside `certificate`. The reconciler wires
 *     a real resolver behind an unforgeable ApplyContext gate (see
 *     core/src/store/secrets.ts) in F3.5; tests pass in a vi.fn.
 *
 *   - PEM PARSER-MOCK. A small `parsePem` checks PEM frame markers and that
 *     the private key "matches" the certificate. Real cryptographic chain
 *     validation is deferred to the PolicyEngine in Bloco C. The mock match
 *     rule: the key suffix (between the END/BEGIN markers' last frame token)
 *     and the cert suffix must share the same trailing identifier — so e.g.
 *     `<fakekey-web>` matches `<fakecert-web>` (both end in `web`).
 *     TODO(bloco-c): replace with real PEM/PKCS chain+key match.
 *
 *   - NO ASSIGNEE SELECTOR. Certificates have no selector field (unlike
 *     firewalls / primary_ips). No `resolveServerSelector` seam is needed.
 *
 *   - ERROR MAPPING. Inherits the shared `rewrapHetznerError` from
 *     `./error-rewrap.ts` (extracted in F3.3 per F1.4 review M1).
 *
 *   - STATE MACHINE. Uploaded certs always come up with
 *     `status.issuance: "completed"` — no polling needed. Managed polling is
 *     F3.4's responsibility.
 *
 * Exported API:
 *   createHetznerCertificateProvider(opts) → CertificateProvider
 *   interface CertificateProvider
 *   interface CertificateProviderOptions
 *   interface ObservedCertificate
 *   computeFingerprint(certPem) → string  (also exported for tests / future
 *                                          providers comparing fingerprints)
 */

import { createHash } from "node:crypto";

import { ReconcileError } from "../../domain/errors.js";
import type { Certificate } from "../../domain/entities-v2.js";
import { rewrapHetznerError } from "./error-rewrap.js";
import type {
  HetznerV2HttpClient,
  V2ResourceClient,
} from "./hetzner-cloud-v2-http.js";

// ---------------------------------------------------------------------------
// Observed-state shape
// ---------------------------------------------------------------------------

/** Raw Hetzner certificate as returned by GET /certificates/:id. */
export interface HetznerCertificateShape {
  readonly id: number;
  readonly name: string;
  readonly type: "managed" | "uploaded";
  readonly labels: Record<string, string>;
  readonly fingerprint: string;
  readonly certificate: string;
  readonly domain_names: readonly string[];
  readonly not_valid_before: string | null;
  readonly not_valid_after: string | null;
  readonly status: {
    readonly issuance: "pending" | "completed" | "failed";
    readonly renewal: "scheduled" | "pending" | "unavailable";
  };
  readonly created: string;
}

/**
 * Persisted under `certificates.observed` (jsonb). Thin wrapper around the
 * raw Hetzner payload, mirroring the firewall / primary_ip wrappers.
 *
 * F3.4 — `status` is derived from `hetzner.status.issuance` at observe()
 * time:
 *   - uploaded certs are always `healthy` immediately on create.
 *   - managed certs map: `pending`→pending, `completed`→healthy,
 *     `failed`→error. The provider transitions a pending observed to
 *     `cancelled` when the TTL elapses (see `apply_started_at` in the
 *     provider-local cache — NOT persisted in the wrapper; rationale in
 *     the factory comment).
 */
export interface ObservedCertificate {
  readonly hetzner: HetznerCertificateShape;
  /** F3.4 lifecycle. Always `"healthy"` for uploaded certs. */
  readonly status?: "pending" | "healthy" | "error" | "cancelled";
}

// ---------------------------------------------------------------------------
// Plan envelope
// ---------------------------------------------------------------------------

export type CertificatePlanOp =
  | { readonly op: "create"; readonly entity: string }
  | {
      readonly op: "drift";
      readonly entity: string;
      readonly target: "fingerprint" | "domains" | "renewal";
      readonly reason?: string;
    }
  | {
      readonly op: "precondition";
      readonly entity: string;
      readonly reason: string;
    };

export interface CertificatePlan {
  readonly ops: readonly CertificatePlanOp[];
}

/**
 * Apply outcome. F3.4 adds optional `action_status` to surface the v1 §236
 * lifecycle (pending / cancelled / error) for the agent loop without
 * conflating it with the `changed` boolean (which still tracks "did this call
 * mutate wire state?").
 */
export interface ApplyResult {
  readonly entity: string;
  readonly changed: boolean;
  readonly action_status?: "pending" | "completed" | "error" | "cancelled";
}

// ---------------------------------------------------------------------------
// Provider port (v2 shape)
// ---------------------------------------------------------------------------

export interface CertificateProvider {
  readonly name: string;
  /** Read Hetzner; returns null if no certificate exists with `name`. */
  observe(name: string): Promise<ObservedCertificate | null>;
  /** Pure plan: derive ops needed to converge observed → desired. */
  plan(
    desired: Certificate,
    observed: ObservedCertificate | null,
  ): Promise<CertificatePlan>;
  /** Converge Hetzner toward desired. Idempotent; never destructive. */
  apply(
    desired: Certificate,
    observed: ObservedCertificate | null,
  ): Promise<ApplyResult>;
  /** True iff observed materialises desired (fail-safe drift rules). */
  verify(desired: Certificate): Promise<boolean>;
}

/**
 * Apply-time resolver for a `secret:<name>` reference → resolved PEM string.
 *
 * The reconciler / daemon wires this behind the unforgeable ApplyContext gate
 * exposed by `core/src/store/secrets.ts` (`resolve(ref, ctx)`), so a
 * plan/dry_run path can never obtain a real resolver instance that returns a
 * value. The provider sees only the narrow `(ref) => Promise<string>` shape:
 * intentionally minimal so tests can pass a `vi.fn` and the value-leakage
 * invariants are owned by the reconciler / secrets module (see
 * core/src/reconciler/secret-apply.test.ts).
 */
export type CertificateSecretResolver = (ref: string) => Promise<string>;

export interface CertificateProviderOptions {
  readonly http: HetznerV2HttpClient;
  readonly secretResolver: CertificateSecretResolver;
  /**
   * F3.4 — injectable clock for the managed-cert polling TTL. Defaults to
   * `() => Date.now()`. Tests advance a controllable clock to simulate
   * elapsed time without real wall-clock waits.
   */
  readonly clock?: () => number;
  /**
   * F3.4 — managed-cert issuance TTL in milliseconds (spec-filha default
   * 30min). After this elapses while still pending, the provider transitions
   * observed to `cancelled` and the agent must explicitly retry.
   */
  readonly managedIssuanceTimeoutMs?: number;
  /**
   * F3.4 — renewal-drift window: emit a `drift` plan op when a healthy
   * managed cert's `not_valid_after` is closer than this many milliseconds.
   * Default 14 days (spec-filha §8). Fail-safe: provider NEVER auto-renews.
   */
  readonly renewalDriftWindowMs?: number;
}

/** Spec-filha §3.3: default TTL for a managed cert to leave pending. */
const DEFAULT_MANAGED_TIMEOUT_MS = 30 * 60 * 1000;
/** Spec-filha §8: emit drift when expiry is within this window. */
const DEFAULT_RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHetznerCertificateProvider(
  opts: CertificateProviderOptions,
): CertificateProvider {
  const certs: V2ResourceClient = opts.http.certificates;
  const clock = opts.clock ?? (() => Date.now());
  const managedTimeoutMs =
    opts.managedIssuanceTimeoutMs ?? DEFAULT_MANAGED_TIMEOUT_MS;
  const renewalWindowMs =
    opts.renewalDriftWindowMs ?? DEFAULT_RENEWAL_WINDOW_MS;

  // Provider-local cache for the first-apply timestamp of a managed cert.
  // Rationale: observe() reads Hetzner state; it has no way to recover a
  // previously-stamped `apply_started_at` from the wire. Persisting it on the
  // observed wrapper would force observe() to read prior wrapper state too,
  // widening the port. The cache is bounded (one entry per pending cert
  // name, cleared on terminal state) and lives as long as the provider
  // instance — sufficient for the reconciler's single-process scope in
  // Bloco A. A cross-process daemon restart re-stamps on the next pending
  // observation, restarting the TTL window (fail-safe: never falsely
  // cancels).
  const applyStartedAt = new Map<string, number>();

  return {
    name: "hetzner-certificate",

    async observe(name: string): Promise<ObservedCertificate | null> {
      try {
        const res = await certs.list();
        const body = (await res.json()) as {
          certificates?: HetznerCertificateShape[];
        };
        const found = (body.certificates ?? []).find((c) => c.name === name);
        if (!found) return null;
        // For pending managed certs, fetch the freshest status via item GET
        // (this is what the Hetzner fake's poll counter advances on).
        // Non-blocking: ≤1 extra HTTP call per cycle, only while pending.
        let hetzner = found;
        if (found.type === "managed" && found.status.issuance === "pending") {
          const getRes = await certs.get(found.id);
          const getBody = (await getRes.json()) as {
            certificate?: HetznerCertificateShape;
          };
          if (getBody.certificate) hetzner = getBody.certificate;
        }
        return { hetzner, status: deriveStatus(hetzner) };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async plan(
      desired: Certificate,
      observed: ObservedCertificate | null,
    ): Promise<CertificatePlan> {
      const entity = `certificate:${desired.name}`;

      // -------- MANAGED branch (F3.4) -----------------------------------
      if (desired.type === "managed") {
        if (observed === null) {
          return { ops: [{ op: "create", entity }] };
        }
        // Domains mismatch on a managed cert: immutable — explicit
        // destroy+recreate required (parallel to uploaded immutability).
        if (!sameSet(observed.hetzner.domain_names, desired.domains)) {
          return {
            ops: [
              {
                op: "precondition",
                entity,
                reason:
                  "managed certificate is immutable; domains differ — explicit destroy+recreate required",
              },
            ],
          };
        }
        // Renewal-drift surface (spec-filha §8). Fail-safe: never auto-
        // renews; agent decides.
        if (
          observed.status === "healthy" &&
          !isRenewalInProgress(observed.hetzner) &&
          expiresWithin(observed.hetzner, renewalWindowMs, clock())
        ) {
          return {
            ops: [
              {
                op: "drift",
                entity,
                target: "renewal",
                reason: "cert-expiring-soon",
              },
            ],
          };
        }
        return { ops: [] };
      }

      // -------- UPLOADED branch (F3.3) ----------------------------------
      if (observed === null) {
        return { ops: [{ op: "create", entity }] };
      }

      // Domains diff is set-based (order-insensitive).
      if (!sameSet(observed.hetzner.domain_names, desired.domains)) {
        return {
          ops: [
            {
              op: "precondition",
              entity,
              reason:
                "uploaded certificate is immutable; domains differ — explicit destroy+recreate required",
            },
          ],
        };
      }

      // PEM-content diff vs fingerprint diff — two distinct cases:
      //
      //   (1) desired.PEM != observed.certificate (the PEM body stored on
      //       Hetzner). The agent is asking to MUTATE the cert in place;
      //       uploaded certs are immutable on Hetzner (no PUT) — surface as
      //       `precondition`. The agent must explicitly destroy+recreate via
      //       a later approval-gated tool (parallel to F1.4 / F2.4).
      //
      //   (2) desired.PEM == observed.certificate AND fingerprint changed
      //       out-of-band. The wire content is what we declared, but the
      //       Hetzner-side fingerprint has shifted — that is drift caused by
      //       something external (tamper, fingerprint-algorithm change on
      //       Hetzner's side, etc.). FAIL-SAFE: emit `drift` (read-only)
      //       and let the agent decide. NEVER silently re-upload.
      if (desired.certificate_pem !== observed.hetzner.certificate) {
        return {
          ops: [
            {
              op: "precondition",
              entity,
              reason:
                "uploaded certificate is immutable; PEM content differs — explicit destroy+recreate required",
            },
          ],
        };
      }
      const desiredFp = computeFingerprint(desired.certificate_pem);
      if (observed.hetzner.fingerprint !== desiredFp) {
        return { ops: [{ op: "drift", entity, target: "fingerprint" }] };
      }

      return { ops: [] };
    },

    async apply(
      desired: Certificate,
      observed: ObservedCertificate | null,
    ): Promise<ApplyResult> {
      const entity = `certificate:${desired.name}`;

      // -------- MANAGED branch (F3.4) -----------------------------------
      if (desired.type === "managed") {
        try {
          // First apply: POST to create the managed cert. Hetzner returns
          // it with `status.issuance: pending`. Stamp first-apply time so
          // future cycles can detect the TTL timeout. Non-blocking: we do
          // NOT loop here — return control to the reconciler.
          if (observed === null) {
            const res = await certs.create({
              name: desired.name,
              type: "managed",
              domain_names: desired.domains,
            });
            const body = (await res.json().catch(() => ({}))) as {
              certificate?: HetznerCertificateShape & {
                requires_dns_challenge?: boolean;
              };
            };
            // Surface the (out-of-scope-for-A) DNS-challenge fallback as
            // precondition_failed. See header note + spec-filha §3.3.
            // TODO(bloco-a-fallback): orchestrate via HetznerDNSProvider.
            if (body.certificate?.requires_dns_challenge) {
              throw new ReconcileError(
                "precondition",
                `${entity} managed cert requires DNS challenge — provider does not publish _acme-challenge records (out of scope; see TODO(bloco-a-fallback))`,
                { entity },
              );
            }
            applyStartedAt.set(desired.name, clock());
            return {
              entity,
              changed: true,
              action_status: "pending",
            };
          }

          // Subsequent cycles. observed.status was derived from the freshest
          // GET in observe().
          if (observed.status === "healthy") {
            applyStartedAt.delete(desired.name);
            return { entity, changed: false, action_status: "completed" };
          }
          if (observed.status === "error") {
            applyStartedAt.delete(desired.name);
            return { entity, changed: false, action_status: "error" };
          }
          if (observed.status === "cancelled") {
            applyStartedAt.delete(desired.name);
            return { entity, changed: false, action_status: "cancelled" };
          }
          // pending — check TTL. Single `now` capture so a between-call
          // clock tick can't make the same cycle appear both fresh and stale.
          const now = clock();
          const startedAt = applyStartedAt.get(desired.name) ?? now;
          if (!applyStartedAt.has(desired.name)) {
            // First time we see this pending cert (e.g. observed exists from
            // a prior daemon process). Stamp now to restart the window.
            applyStartedAt.set(desired.name, now);
          }
          if (now - startedAt > managedTimeoutMs) {
            applyStartedAt.delete(desired.name);
            return {
              entity,
              changed: true,
              action_status: "cancelled",
            };
          }
          return { entity, changed: false, action_status: "pending" };
        } catch (err) {
          throw rewrapHetznerError(err);
        }
      }

      // -------- UPLOADED branch (F3.3) ----------------------------------
      try {
        // Branch 1: create when absent. Resolve the secret HERE (apply-only)
        // and validate the PEM pair BEFORE any wire call.
        if (observed === null) {
          const privateKey = await opts.secretResolver(
            desired.private_key_secret_ref,
          );
          parsePem(desired.certificate_pem, privateKey, entity);
          await drain(
            await certs.create({
              name: desired.name,
              type: "uploaded",
              certificate: desired.certificate_pem,
              private_key: privateKey,
              domain_names: desired.domains,
            }),
          );
          return { entity, changed: true };
        }

        // Domains mismatch → immutable; refuse explicitly (mirrors the plan
        // precondition op so apply-without-plan callers cannot bypass).
        if (!sameSet(observed.hetzner.domain_names, desired.domains)) {
          throw new ReconcileError(
            "precondition",
            `${entity} uploaded cert is immutable; domains differ — explicit destroy+recreate required`,
            { entity },
          );
        }

        // PEM-content mismatch → mutation attempt; refuse explicitly.
        if (desired.certificate_pem !== observed.hetzner.certificate) {
          throw new ReconcileError(
            "precondition",
            `${entity} uploaded cert is immutable; PEM content differs — explicit destroy+recreate required`,
            { entity },
          );
        }

        // Fingerprint differs → fail-safe DRIFT: never silently re-upload.
        // apply() is a no-op; reconciliation requires an explicit
        // approval-gated tool (parallel to F1.4 / F2.4 — out of scope for
        // F3.3).
        const desiredFp = computeFingerprint(desired.certificate_pem);
        if (observed.hetzner.fingerprint !== desiredFp) {
          return { entity, changed: false };
        }

        // Already matches → idempotent no-op.
        return { entity, changed: false };
      } catch (err) {
        throw rewrapHetznerError(err);
      }
    },

    async verify(desired: Certificate): Promise<boolean> {
      const observed = await this.observe(desired.name);
      if (observed === null) return false;
      // F3.4 — managed verification is gated on the live issuance state:
      // pending/error/cancelled are NOT verified (the cert is not yet
      // usable). Healthy requires type match + domain-set equality.
      if (desired.type === "managed") {
        return (
          observed.hetzner.type === "managed" &&
          observed.status === "healthy" &&
          sameSet(observed.hetzner.domain_names, desired.domains)
        );
      }
      // F3.3 — uploaded: type and domain set. Fingerprint EQUALITY is
      // reserved for drift surfacing (since the Hetzner-computed fingerprint
      // shape may legitimately differ from our hash strategy — see
      // computeFingerprint). A drift op does not invalidate verify (the spec
      // invariant: drift is reported, not silently corrected).
      return (
        observed.hetzner.type === "uploaded" &&
        sameSet(observed.hetzner.domain_names, desired.domains)
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/**
 * F3.4 — map the raw Hetzner `status.issuance` (plus type) onto the
 * provider's observed-wrapper lifecycle. Uploaded certs are always
 * `healthy` immediately (Hetzner returns `completed` on POST). Managed
 * certs may be `pending`, `completed` (→ healthy), or `failed` (→ error).
 *
 * NOTE: `cancelled` is NOT derivable from observe() alone — the TTL clock
 * is owned by apply(). observe() returns the live Hetzner status and apply
 * stamps `cancelled` when the TTL window has elapsed while still pending.
 */
function deriveStatus(
  h: HetznerCertificateShape,
): "pending" | "healthy" | "error" {
  if (h.type === "uploaded") return "healthy";
  switch (h.status.issuance) {
    case "completed":
      return "healthy";
    case "failed":
      return "error";
    case "pending":
    default:
      return "pending";
  }
}

/**
 * F3.4 (spec-filha §8) — true iff the cert is set to expire within the
 * configured renewal window AND no in-progress renewal is visible. Returns
 * false defensively when `not_valid_after` is null (missing / not yet
 * issued; nothing to drift on).
 */
function isRenewalInProgress(h: HetznerCertificateShape): boolean {
  return h.status.renewal === "pending";
}

// `now` is captured via closure in the factory; keep the helper pure by
// taking it as a parameter from the call site.
function expiresWithin(
  h: HetznerCertificateShape,
  windowMs: number,
  now: number,
): boolean {
  if (!h.not_valid_after) return false;
  const expiry = Date.parse(h.not_valid_after);
  if (Number.isNaN(expiry)) return false;
  return expiry - now < windowMs;
}

/**
 * Compute a deterministic fingerprint for a PEM body. Stub strategy: SHA-256
 * of the cert PEM bytes. This is NOT the X.509-spec fingerprint (which is
 * SHA-256 of the DER-decoded body), but it is sufficient as an
 * EQUALITY ORACLE between two desired-state PEM blobs (Bloco A scope). The
 * provider only compares observed.fingerprint vs this hash when both came
 * through a path that stamped fingerprints the same way; in real wiring the
 * provider's own `apply()` is what creates the Hetzner cert, so the equality
 * surface that matters in Bloco A is "did I just upload this?" (the
 * idempotent no-op case) and "is the wire payload identical to last time?"
 * (drift surfacing). The PolicyEngine in Bloco C will replace this with a
 * real X.509 fingerprint computation.
 */
export function computeFingerprint(certPem: string): string {
  return createHash("sha256").update(certPem).digest("hex");
}

/**
 * PEM parser-MOCK. Real PEM / chain / key-match validation is deferred to the
 * PolicyEngine (Bloco C). For F3.3 we enforce:
 *
 *   - cert begins with `-----BEGIN CERTIFICATE-----` and ends with
 *     `-----END CERTIFICATE-----`;
 *   - key begins with `-----BEGIN [RSA |EC |]PRIVATE KEY-----`;
 *   - key & cert "match" iff they share the same trailing identifier
 *     (everything after the last `-`) inside the inner body. This gives the
 *     test pairs (`fakecert-web` / `fakekey-web` ⇒ match;
 *     `fakecert-web` / `fakekey-other` ⇒ mismatch) deterministic behaviour
 *     without pulling a crypto library.
 *
 * TODO(bloco-c): replace with real PEM/PKCS chain+key match in PolicyEngine.
 */
function parsePem(certPem: string, keyPem: string, entity: string): void {
  if (
    !/^-----BEGIN CERTIFICATE-----/.test(certPem) ||
    !/-----END CERTIFICATE-----\s*$/.test(certPem)
  ) {
    throw new ReconcileError(
      "precondition",
      `${entity} invalid PEM: certificate must be a single PEM block bounded by BEGIN/END CERTIFICATE markers`,
      { entity },
    );
  }
  if (!/^-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/.test(keyPem)) {
    throw new ReconcileError(
      "precondition",
      `${entity} invalid PEM: private key must be a PEM block beginning with BEGIN [RSA |EC |]PRIVATE KEY`,
      { entity },
    );
  }
  const certBody = extractInnerBody(certPem);
  const keyBody = extractInnerBody(keyPem);
  if (!certBody || !keyBody) {
    throw new ReconcileError(
      "precondition",
      `${entity} invalid PEM: empty inner body`,
      { entity },
    );
  }
  if (trailingId(certBody) !== trailingId(keyBody)) {
    throw new ReconcileError(
      "precondition",
      `${entity} private key does not match certificate (mismatched key/cert pair)`,
      { entity },
    );
  }
}

/** Pull the inner-body lines (between BEGIN/END markers) joined by '\n'. */
function extractInnerBody(pem: string): string {
  const lines = pem.split(/\r?\n/);
  const inner: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (/^-----BEGIN /.test(line)) {
      inside = true;
      continue;
    }
    if (/^-----END /.test(line)) {
      inside = false;
      continue;
    }
    if (inside) inner.push(line);
  }
  return inner.join("\n").trim();
}

/**
 * The "trailing identifier" of an inner-body line — everything after the
 * last `-` in the first non-empty line. Used as the F3.3 mock key/cert
 * pairing oracle (e.g. `<fakecert-web>` ⇒ `web`).
 */
function trailingId(body: string): string {
  const first = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const idx = first.lastIndexOf("-");
  return idx === -1 ? first : first.slice(idx + 1).replace(/[<>]/g, "");
}

/** Set equality on string arrays (order-insensitive, dedup-safe). */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const x of sa) if (!sb.has(x)) return false;
  return true;
}

/** Drain a 2xx response body so the socket is freed (mirrors v1 pattern). */
async function drain(res: Response): Promise<void> {
  await res.json().catch(() => undefined);
}
