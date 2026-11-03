/**
 * core/test/fakes/hetzner-http-v2/certificates.ts
 *
 * Task 3.2 — In-memory Hetzner Cloud `/certificates/*` sub-fake. Mounted by
 * the parent `hetzner-http.ts` for any URL whose path contains a
 * `certificates` segment. Sufficient for the v2 Certificate provider /
 * reconciler to exercise observe + create (managed + uploaded) + poll +
 * delete with zero network.
 *
 * Wire-compatible response shapes (Hetzner Cloud API docs):
 *   - POST   /certificates          → 201 { certificate, action }
 *   - GET    /certificates          → 200 { certificates, meta.pagination }
 *   - GET    /certificates/:id      → 200 { certificate }
 *   - DELETE /certificates/:id      → 204 (no body)
 *
 * Certificates are IMMUTABLE after creation (no PUT). Managed cert issuance
 * is tracked via a per-cert poll counter that flips status from `pending` to
 * `issued`/`completed` after N GETs (default 2, per-cert override available).
 *
 * Per-instance state lives in a closure created by `createCertificateStore()`;
 * the parent's `reset()` re-creates the store so isolation matches the v1
 * model. Faults (429 / 401) are owned by the parent and applied BEFORE this
 * handler is invoked — this module is purely about routing and state.
 */

import { createHash } from "node:crypto";

export interface CertificateStatus {
  issuance: "pending" | "completed" | "failed";
  renewal: "scheduled" | "pending" | "unavailable";
}

export interface Certificate {
  id: number;
  name: string;
  type: "managed" | "uploaded";
  labels: Record<string, string>;
  fingerprint: string;
  certificate: string;
  domain_names: string[];
  not_valid_before: string | null;
  not_valid_after: string | null;
  status: CertificateStatus;
  created: string;
}

interface CertificateAction {
  id: number;
  command: string;
  status: "success";
  progress: 100;
  started: string;
  finished: string;
  resources: Array<{ id: number; type: string }>;
  error: null;
}

export interface CertificateStore {
  handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null;
  reset(): void;
  /**
   * Default # of GET polls a managed cert spends in `pending` before flipping
   * to issued. Default 2. Set to 0 for immediate issuance on first GET.
   * Per-cert latency (via setNextManagedIssuanceLatency) overrides this.
   */
  setManagedIssuanceLatency(n: number): void;
  /**
   * One-shot override: the NEXT managed cert created uses this latency
   * instead of the default. Consumed by the next POST /certificates with
   * type=managed.
   */
  setNextManagedIssuanceLatency(n: number): void;
  /**
   * One-shot: when true, the NEXT managed cert lands in
   * `status.issuance: failed` once polling finishes (instead of completed).
   * Consumed by the next POST /certificates with type=managed.
   */
  setNextManagedIssuanceFailure(on: boolean): void;
  /**
   * One-shot: when true, the NEXT managed POST returns a body whose
   * `certificate.requires_dns_challenge` flag is `true` — the hint Hetzner
   * gives when DNS-01 validation must be orchestrated externally. Consumed
   * by the next POST /certificates with type=managed.
   */
  setNextManagedRequiresDnsChallenge(on: boolean): void;
}

/** Build a fresh per-instance store. The parent fake owns its lifecycle. */
export function createCertificateStore(): CertificateStore {
  let certificates = new Map<number, Certificate>();
  /** Remaining GET polls before this managed cert flips. */
  let pendingPolls = new Map<number, number>();
  /** Managed cert ids destined to land at `failed` instead of `completed`. */
  let failTargets = new Set<number>();
  let certSeq = 0;
  let actionSeq = 0;
  let defaultLatency = 2;
  let nextLatency: number | null = null;
  let nextFailure = false;
  let nextRequiresDnsChallenge = false;

  function reset(): void {
    certificates = new Map();
    pendingPolls = new Map();
    failTargets = new Set();
    certSeq = 0;
    actionSeq = 0;
    defaultLatency = 2;
    nextLatency = null;
    nextFailure = false;
    nextRequiresDnsChallenge = false;
  }

  function json(body: unknown, status: number): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function err(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
  }

  function parseBody(
    init: RequestInit | undefined,
  ): Record<string, unknown> | Response {
    try {
      return init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
    } catch {
      return err(400, "invalid_input", "malformed JSON body");
    }
  }

  function nowIso(): string {
    return new Date().toISOString();
  }

  function makeAction(
    command: string,
    resources: Array<{ id: number; type: string }>,
  ): CertificateAction {
    actionSeq += 1;
    const ts = nowIso();
    return {
      id: actionSeq,
      command,
      status: "success",
      progress: 100,
      started: ts,
      finished: ts,
      resources,
      error: null,
    };
  }

  function clampInt(raw: string | null, fallback: number): number {
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : fallback;
  }

  function readLabels(raw: unknown): Record<string, string> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      return raw as Record<string, string>;
    }
    return {};
  }

  function readDomains(raw: unknown): string[] {
    if (Array.isArray(raw)) {
      return raw.filter((d): d is string => typeof d === "string");
    }
    return [];
  }

  function fingerprintFor(name: string, id: number): string {
    return createHash("sha256").update(`${name}:${id}`).digest("hex");
  }

  function synthCertContent(id: number, issuedAt: string): string {
    return `-----BEGIN CERTIFICATE-----\n<synth-${id}-${issuedAt}>\n-----END CERTIFICATE-----`;
  }

  function ninetyDaysFrom(iso: string): string {
    const t = new Date(iso).getTime();
    return new Date(t + 90 * 24 * 60 * 60 * 1000).toISOString();
  }

  function listResponse(url: URL): Response {
    const all = [...certificates.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    return json(
      {
        certificates: slice,
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: page < lastPage ? page + 1 : null,
            last_page: lastPage,
            total_entries: all.length,
          },
        },
      },
      200,
    );
  }

  /** Advance polling state for managed pending certs on each GET. */
  function tickManagedPoll(cert: Certificate): Certificate {
    if (cert.type !== "managed" || cert.status.issuance !== "pending") {
      return cert;
    }
    const remaining = pendingPolls.get(cert.id) ?? 0;
    if (remaining <= 0) {
      // Latency already exhausted (e.g. 0 default) — flip on this GET.
      return flip(cert);
    }
    const next = remaining - 1;
    pendingPolls.set(cert.id, next);
    if (next <= 0) {
      return flip(cert);
    }
    return cert;
  }

  function flip(cert: Certificate): Certificate {
    const failed = failTargets.delete(cert.id);
    const issuedAt = nowIso();
    const updated: Certificate = failed
      ? {
          ...cert,
          status: { issuance: "failed", renewal: "unavailable" },
        }
      : {
          ...cert,
          fingerprint: fingerprintFor(cert.name, cert.id),
          certificate: synthCertContent(cert.id, issuedAt),
          not_valid_before: issuedAt,
          not_valid_after: ninetyDaysFrom(issuedAt),
          status: { issuance: "completed", renewal: "scheduled" },
        };
    certificates.set(cert.id, updated);
    pendingPolls.delete(cert.id);
    return updated;
  }

  function handle(
    url: URL,
    method: string,
    init: RequestInit | undefined,
  ): Response | null {
    const segs = url.pathname.split("/").filter(Boolean);
    const idx = segs.lastIndexOf("certificates");
    if (idx < 0) return null;

    const tail = segs.slice(idx + 1);

    // Collection-level: /certificates
    if (tail.length === 0) {
      if (method === "GET") return listResponse(url);
      if (method === "POST") {
        const parsed = parseBody(init);
        if (parsed instanceof Response) return parsed;
        if (typeof parsed.name !== "string" || parsed.name.length === 0) {
          return err(400, "invalid_input", "missing required field: name");
        }
        const type = parsed.type === "uploaded" ? "uploaded" : "managed";
        const id = (certSeq += 1);
        const created = nowIso();

        if (type === "uploaded") {
          const certBody =
            typeof parsed.certificate === "string" ? parsed.certificate : "";
          if (certBody.length === 0) {
            return err(
              400,
              "invalid_input",
              "missing required field: certificate",
            );
          }
          if (
            typeof parsed.private_key !== "string" ||
            parsed.private_key.length === 0
          ) {
            return err(
              400,
              "invalid_input",
              "missing required field: private_key",
            );
          }
          const certificate: Certificate = {
            id,
            name: parsed.name,
            type: "uploaded",
            labels: readLabels(parsed.labels),
            fingerprint: fingerprintFor(parsed.name, id),
            certificate: certBody,
            domain_names: readDomains(parsed.domain_names),
            not_valid_before: created,
            not_valid_after: ninetyDaysFrom(created),
            status: { issuance: "completed", renewal: "unavailable" },
            created,
          };
          certificates.set(id, certificate);
          return json(
            {
              certificate,
              action: makeAction("create_certificate", [
                { id, type: "certificate" },
              ]),
            },
            201,
          );
        }

        // managed — real Hetzner expects `domain_names` (parity with the
        // uploaded branch). Accept legacy `domains` as an alias so older
        // test fixtures don't regress.
        const domains = readDomains(parsed.domain_names ?? parsed.domains);
        if (domains.length === 0) {
          return err(
            400,
            "invalid_input",
            "missing required field: domains",
          );
        }
        const latency = nextLatency !== null ? nextLatency : defaultLatency;
        nextLatency = null;
        if (nextFailure) {
          failTargets.add(id);
          nextFailure = false;
        }
        pendingPolls.set(id, latency);
        const certificate: Certificate = {
          id,
          name: parsed.name,
          type: "managed",
          labels: readLabels(parsed.labels),
          fingerprint: "",
          certificate: "",
          domain_names: domains,
          not_valid_before: null,
          not_valid_after: null,
          status: { issuance: "pending", renewal: "unavailable" },
          created,
        };
        certificates.set(id, certificate);
        const requiresDns = nextRequiresDnsChallenge;
        nextRequiresDnsChallenge = false;
        return json(
          {
            certificate: requiresDns
              ? { ...certificate, requires_dns_challenge: true }
              : certificate,
            action: makeAction("create_certificate", [
              { id, type: "certificate" },
            ]),
          },
          201,
        );
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // Item-level: /certificates/:id
    const idRaw = tail[0]!;
    if (!/^\d+$/.test(idRaw)) {
      return err(404, "not_found", `unknown certificate route ${url.pathname}`);
    }
    const id = Number(idRaw);

    if (tail.length === 1) {
      if (method === "GET") {
        const found = certificates.get(id);
        if (!found) {
          return err(404, "not_found", `certificate ${id} not found`);
        }
        const ticked = tickManagedPoll(found);
        return json({ certificate: ticked }, 200);
      }
      if (method === "DELETE") {
        if (!certificates.delete(id)) {
          return err(404, "not_found", `certificate ${id} not found`);
        }
        pendingPolls.delete(id);
        failTargets.delete(id);
        return json(null, 204);
      }
      return err(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    return err(404, "not_found", `unknown certificate route ${url.pathname}`);
  }

  return {
    handle,
    reset,
    setManagedIssuanceLatency(n: number) {
      defaultLatency = Math.max(0, Math.floor(n));
    },
    setNextManagedIssuanceLatency(n: number) {
      nextLatency = Math.max(0, Math.floor(n));
    },
    setNextManagedIssuanceFailure(on: boolean) {
      nextFailure = !!on;
    },
    setNextManagedRequiresDnsChallenge(on: boolean) {
      nextRequiresDnsChallenge = !!on;
    },
  };
}
