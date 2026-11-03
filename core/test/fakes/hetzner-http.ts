/**
 * core/test/fakes/hetzner-http.ts
 *
 * In-memory, per-instance fake of the Hetzner Cloud HTTP API. Its sole job is
 * to be a deterministic `fetchImpl` seam for HttpClient (2.2) and
 * HetznerCloudProvider (2.4) so the reconciler's translation/convergence logic
 * can be exercised in-process with ZERO network, DB or filesystem.
 *
 * ⚠ THIS IS NOT A TEST OF HETZNER and is NOT a spec-faithful Hetzner
 * emulator. It models only the MINIMAL surface the reconciler needs:
 *   - Cloud API (Fase 2): servers/networks/volumes — list/create/get/delete
 *   - hcloud DNS API (Fase 5, Task 5.1): zones (list w/ pagination + ?name=,
 *     get) + records (list by zone w/ name/type filter + pagination, create,
 *     get, update via PUT, delete) — just enough truth for the DNS provider
 *     (5.2) to do non-destructive upsert and for the DNS endpoint (5.4).
 * The hcloud DNS API is a SEPARATE service from the Cloud API; the fake
 * routes purely by trailing `/zones` & `/records` path segments so host/prefix
 * is irrelevant. Plus two deterministic fault toggles shared by BOTH APIs.
 * No backup / firewall / SSH-key endpoints, no attach/detach, no auth scheme
 * — out of scope (YAGNI; later phases or never).
 *
 * Design principles (mirrors core/test/fakes/pg-harness.ts isolation
 * philosophy):
 *
 *   - PER-INSTANCE, RESETTABLE. `createHetznerHttpFake()` returns a fresh
 *     isolated instance; state and id counters live in a closure (no
 *     global/static state). `reset()` returns it to pristine — each test
 *     gets full isolation.
 *
 *   - WIRE-COMPATIBLE. `fetch` is a real `(input, init?) => Promise<Response>`
 *     handler usable directly as HttpClient's `fetchImpl`. List responses
 *     emit Hetzner's exact `meta.pagination.next_page` shape so
 *     HttpClient.getAllPages walks them and terminates on `null`.
 *
 *   - DETERMINISTIC FAULTS. `setRateLimitFault` makes the next N responses a
 *     429 with `Retry-After`; `setAuthFault` forces 401 until toggled off.
 *     Both are per-instance and consumed predictably.
 *
 * Exported API (minimal — only what Fase 2 needs):
 *   createHetznerHttpFake(): HetznerHttpFake
 *   interface HetznerHttpFake {
 *     fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
 *     reset(): void
 *     setRateLimitFault(opts: { times: number; retryAfter: number }): void
 *     setAuthFault(on: boolean): void
 *   }
 */

import { createCertificateStore } from "./hetzner-http-v2/certificates.js";
import { createFirewallStore } from "./hetzner-http-v2/firewalls.js";
import { createLoadBalancerStore } from "./hetzner-http-v2/load-balancers.js";
import { createPrimaryIpStore } from "./hetzner-http-v2/primary-ips.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface HetznerHttpFake {
  /** Drop-in `fetchImpl` for HttpClient — never touches the network. */
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Clear all resources, id counters and pending faults. */
  reset(): void;
  /** Next `times` responses → 429 with `Retry-After: <retryAfter>` (seconds). */
  setRateLimitFault(opts: { times: number; retryAfter: number }): void;
  /** While true, every response → 401 (fatal, not retried by HttpClient). */
  setAuthFault(on: boolean): void;
  /**
   * Seed an "already exists in Hetzner" Cloud resource WITH its rich wire
   * fields (server_type/public_net/status/image, network ip_range/subnets,
   * volume size/linux_device/server) so observe-enrichment tests do not go
   * through the create path. Assigns an id and returns it; `list`/`get` echo
   * the resource verbatim. Spec 2026-06-02-observed-state-adapter §1.1.
   */
  seed(
    collection: "servers" | "networks" | "volumes",
    resource: Record<string, unknown> & { name: string },
  ): number;
  /**
   * Inject a ONE-SHOT custom error response consumed by the very next request.
   * Used by v2 provider tests to exercise non-default error-class mappings
   * (e.g. 422 invalid rules) deterministically. Cleared after one use.
   */
  setNextRequestFault(opts: { status: number; code: string; message: string }): void;
  /**
   * Managed Certificate issuance polling — set the default number of GETs a
   * managed cert spends in `pending` before flipping to `issued`/`completed`.
   * Per-cert overrides via `setNextManagedIssuanceLatency`. Default 2.
   */
  setManagedIssuanceLatency(n: number): void;
  /** One-shot: NEXT managed cert uses this poll count instead of the default. */
  setNextManagedIssuanceLatency(n: number): void;
  /** One-shot: NEXT managed cert lands at `status.issuance: failed`. */
  setNextManagedIssuanceFailure(on: boolean): void;
  /**
   * One-shot: NEXT managed POST response carries
   * `certificate.requires_dns_challenge: true` — the Hetzner hint that DNS-01
   * validation must be orchestrated externally (out of scope for F3.4).
   */
  setNextManagedRequiresDnsChallenge(on: boolean): void;
  /**
   * Test-only access to the firewalls sub-store. Exposed so e2e fault-
   * injection tests can mutate Hetzner-side state out-of-band (e.g. inject an
   * extra rule on an existing firewall to assert the v2 provider reports drift
   * and never silently removes it). Read-only escape hatch — production code
   * MUST NOT depend on this surface.
   */
  readonly firewalls: {
    injectExtraRule(
      id: number,
      rule: {
        direction: "in" | "out";
        protocol: string;
        port?: string;
        source_ips?: string[];
        destination_ips?: string[];
      },
    ): boolean;
  };
}

/** The three resource collections Fase 2 needs (plural path → singular key). */
const COLLECTIONS = {
  servers: "server",
  networks: "network",
  volumes: "volume",
} as const;

type Plural = keyof typeof COLLECTIONS;

type Resource = { id: number; name: string } & Record<string, unknown>;

// --- hcloud DNS model ------------------------------------------------------
// The hcloud DNS API exposes string ids (distinct from the Cloud API's numeric
// ids). We model only what 5.2's observe/upsert + 5.4's endpoint need.
type DnsZone = { id: string; name: string };
type DnsRecord = {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHetznerHttpFake(): HetznerHttpFake {
  // --- per-instance state (closure; no global/static) ---------------------
  const store = new Map<Plural, Map<number, Resource>>();
  const counters = new Map<Plural, number>();
  // hcloud DNS state — independent string-id counters, isolated from Cloud.
  const dnsZones = new Map<string, DnsZone>();
  const dnsRecords = new Map<string, DnsRecord>();
  let dnsZoneSeq = 0;
  let dnsRecordSeq = 0;
  let rateLimit: { remaining: number; retryAfter: number } | null = null;
  let authFault = false;
  let nextFault: { status: number; code: string; message: string } | null = null;
  // v2 sub-fakes (additive: Cloud + DNS paths above are untouched).
  const firewallStore = createFirewallStore();
  const primaryIpStore = createPrimaryIpStore();
  const certificateStore = createCertificateStore();
  const loadBalancerStore = createLoadBalancerStore();

  function fresh(): void {
    store.clear();
    counters.clear();
    for (const p of Object.keys(COLLECTIONS) as Plural[]) {
      store.set(p, new Map());
      counters.set(p, 0);
    }
    dnsZones.clear();
    dnsRecords.clear();
    dnsZoneSeq = 0;
    dnsRecordSeq = 0;
    rateLimit = null;
    authFault = false;
    nextFault = null;
    firewallStore.reset();
    primaryIpStore.reset();
    certificateStore.reset();
    loadBalancerStore.reset();
  }
  fresh();

  function json(body: unknown, status: number): Response {
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  function error(status: number, code: string, message: string): Response {
    return json({ error: { code, message } }, status);
  }

  // --- list with Hetzner cursor pagination -------------------------------
  function list(plural: Plural, url: URL): Response {
    const all = [...store.get(plural)!.values()].sort((a, b) => a.id - b.id);
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(all.length / perPage));
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const nextPage = page < lastPage ? page + 1 : null;
    return json(
      {
        [plural]: slice,
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: nextPage,
            last_page: lastPage,
            total_entries: all.length,
          },
        },
      },
      200,
    );
  }

  // --- hcloud DNS list with the SAME meta.pagination.next_page shape -----
  // so a future HetznerDNSProvider drives it via HttpClient.getAllPages.
  function dnsList<T>(rows: T[], key: "zones" | "records", url: URL): Response {
    const perPage = clampInt(url.searchParams.get("per_page"), 25);
    const page = clampInt(url.searchParams.get("page"), 1);
    const lastPage = Math.max(1, Math.ceil(rows.length / perPage));
    const start = (page - 1) * perPage;
    const slice = rows.slice(start, start + perPage);
    return json(
      {
        [key]: slice,
        meta: {
          pagination: {
            page,
            per_page: perPage,
            previous_page: page > 1 ? page - 1 : null,
            next_page: page < lastPage ? page + 1 : null,
            last_page: lastPage,
            total_entries: rows.length,
          },
        },
      },
      200,
    );
  }

  // --- hcloud DNS sub-handler (separate API; routed by /zones, /records) --
  function dnsHandler(
    collection: "zones" | "records",
    url: URL,
    method: string,
    init?: RequestInit,
  ): Response {
    const segments = url.pathname.split("/").filter(Boolean);
    const tail = segments[segments.length - 1] ?? "";
    const hasId = tail !== collection;
    const id = hasId ? tail : null;

    if (collection === "zones") {
      if (!hasId) {
        if (method === "GET") {
          const name = url.searchParams.get("name");
          let rows = [...dnsZones.values()].sort((a, b) =>
            a.id.localeCompare(b.id, undefined, { numeric: true }),
          );
          if (name !== null) rows = rows.filter((z) => z.name === name);
          return dnsList(rows, "zones", url);
        }
        if (method === "POST") {
          let payload: Record<string, unknown>;
          try {
            payload = init?.body ? JSON.parse(String(init.body)) : {};
          } catch {
            return error(400, "invalid_input", "malformed JSON body");
          }
          if (typeof payload.name !== "string" || payload.name.length === 0) {
            return error(400, "invalid_input", "missing required field: name");
          }
          const zid = String((dnsZoneSeq += 1));
          const zone: DnsZone = { id: zid, name: payload.name };
          dnsZones.set(zid, zone);
          return json({ zone }, 201);
        }
        return error(405, "method_not_allowed", `${method} ${url.pathname}`);
      }
      if (method === "GET") {
        const found = dnsZones.get(id!);
        return found
          ? json({ zone: found }, 200)
          : error(404, "not_found", `zone ${id} not found`);
      }
      return error(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // collection === "records"
    if (!hasId) {
      if (method === "GET") {
        const zoneId = url.searchParams.get("zone_id");
        const name = url.searchParams.get("name");
        const type = url.searchParams.get("type");
        let rows = [...dnsRecords.values()].sort((a, b) =>
          a.id.localeCompare(b.id, undefined, { numeric: true }),
        );
        if (zoneId !== null) rows = rows.filter((r) => r.zone_id === zoneId);
        if (name !== null) rows = rows.filter((r) => r.name === name);
        if (type !== null) rows = rows.filter((r) => r.type === type);
        return dnsList(rows, "records", url);
      }
      if (method === "POST") {
        let payload: Record<string, unknown>;
        try {
          payload = init?.body ? JSON.parse(String(init.body)) : {};
        } catch {
          return error(400, "invalid_input", "malformed JSON body");
        }
        if (
          typeof payload.zone_id !== "string" ||
          typeof payload.name !== "string" ||
          typeof payload.type !== "string" ||
          payload.zone_id.length === 0 ||
          payload.type.length === 0
        ) {
          return error(
            400,
            "invalid_input",
            "missing required field: zone_id, name, type",
          );
        }
        const rid = String((dnsRecordSeq += 1));
        const record: DnsRecord = {
          id: rid,
          zone_id: payload.zone_id,
          type: payload.type,
          name: payload.name,
          value: typeof payload.value === "string" ? payload.value : "",
          ttl: typeof payload.ttl === "number" ? payload.ttl : 0,
        };
        dnsRecords.set(rid, record);
        return json({ record }, 201);
      }
      return error(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // item-level record: GET / PUT (update) / DELETE
    if (method === "GET") {
      const found = dnsRecords.get(id!);
      return found
        ? json({ record: found }, 200)
        : error(404, "not_found", `record ${id} not found`);
    }
    if (method === "PUT") {
      const existing = dnsRecords.get(id!);
      if (!existing) {
        return error(404, "not_found", `record ${id} not found`);
      }
      let payload: Record<string, unknown>;
      try {
        payload = init?.body ? JSON.parse(String(init.body)) : {};
      } catch {
        return error(400, "invalid_input", "malformed JSON body");
      }
      const updated: DnsRecord = {
        ...existing,
        zone_id:
          typeof payload.zone_id === "string" ? payload.zone_id : existing.zone_id,
        type: typeof payload.type === "string" ? payload.type : existing.type,
        name: typeof payload.name === "string" ? payload.name : existing.name,
        value: typeof payload.value === "string" ? payload.value : existing.value,
        ttl: typeof payload.ttl === "number" ? payload.ttl : existing.ttl,
      };
      dnsRecords.set(id!, updated);
      return json({ record: updated }, 200);
    }
    if (method === "DELETE") {
      return dnsRecords.delete(id!)
        ? json(null, 204)
        : error(404, "not_found", `record ${id} not found`);
    }
    return error(405, "method_not_allowed", `${method} ${url.pathname}`);
  }

  // --- the fetch-shaped handler ------------------------------------------
  async function handler(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    // Faults are checked BEFORE routing so any path can exercise them.
    if (authFault) {
      return error(401, "unauthorized", "fake auth fault");
    }
    if (nextFault) {
      const f = nextFault;
      nextFault = null;
      return error(f.status, f.code, f.message);
    }
    if (rateLimit && rateLimit.remaining > 0) {
      rateLimit.remaining -= 1;
      const retryAfter = rateLimit.retryAfter;
      if (rateLimit.remaining === 0) rateLimit = null;
      return new Response(
        JSON.stringify({ error: { code: "rate_limit_exceeded", message: "fake rate limit" } }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(retryAfter),
          },
        },
      );
    }

    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url,
    );
    const method = (init?.method ?? "GET").toUpperCase();

    // hcloud DNS is a SEPARATE API — dispatch by trailing /zones|/records
    // segment BEFORE the Cloud-API routing (additive; Cloud paths untouched).
    {
      const segs = url.pathname.split("/").filter(Boolean);
      const last = segs[segs.length - 1] ?? "";
      const prev = segs[segs.length - 2] ?? "";
      if (last === "zones" || last === "records") {
        return dnsHandler(last, url, method, init);
      }
      if (prev === "zones" || prev === "records") {
        return dnsHandler(prev as "zones" | "records", url, method, init);
      }
    }

    // v2 /firewalls sub-fake (Task 1.2). Dispatched by presence of the
    // `firewalls` segment anywhere in the path, BEFORE the v1 Cloud-API
    // routing (additive; servers/networks/volumes untouched).
    {
      const segs = url.pathname.split("/").filter(Boolean);
      if (segs.includes("firewalls")) {
        const res = firewallStore.handle(url, method, init);
        if (res) return res;
      }
      if (segs.includes("primary_ips")) {
        const res = primaryIpStore.handle(url, method, init);
        if (res) return res;
      }
      if (segs.includes("certificates")) {
        const res = certificateStore.handle(url, method, init);
        if (res) return res;
      }
      if (segs.includes("load_balancers")) {
        const res = loadBalancerStore.handle(url, method, init);
        if (res) return res;
      }
    }

    // path: /v1/servers  or  /v1/servers/<id>
    // Fase 2 assumption: only flat collection/item paths (/v1/<resource>[/<id>]);
    // nested paths (e.g. /v1/servers/<id>/actions) are out of scope.
    const segments = url.pathname.split("/").filter(Boolean);
    const plural = segments[segments.length - 2] as Plural | undefined;
    const tailIsId = /^\d+$/.test(segments[segments.length - 1] ?? "");
    const collection = (tailIsId ? plural : segments[segments.length - 1]) as
      | Plural
      | undefined;

    if (!collection || !(collection in COLLECTIONS)) {
      return error(404, "not_found", `unknown route ${url.pathname}`);
    }
    const bucket = store.get(collection)!;
    const singular = COLLECTIONS[collection];

    if (!tailIsId) {
      // collection-level: GET list, POST create
      if (method === "GET") return list(collection, url);
      if (method === "POST") {
        let payload: Record<string, unknown>;
        try {
          payload = init?.body ? JSON.parse(String(init.body)) : {};
        } catch {
          return error(400, "invalid_input", "malformed JSON body");
        }
        if (typeof payload.name !== "string" || payload.name.length === 0) {
          return error(400, "invalid_input", "missing required field: name");
        }
        const id = (counters.get(collection)! + 1);
        counters.set(collection, id);
        const resource: Resource = { ...payload, id, name: payload.name };
        bucket.set(id, resource);
        return json({ [singular]: resource }, 201);
      }
      return error(405, "method_not_allowed", `${method} ${url.pathname}`);
    }

    // item-level: GET one, DELETE one
    const id = Number(segments[segments.length - 1]);
    if (method === "GET") {
      const found = bucket.get(id);
      return found
        ? json({ [singular]: found }, 200)
        : error(404, "not_found", `${singular} ${id} not found`);
    }
    if (method === "DELETE") {
      return bucket.delete(id)
        ? json(null, 204)
        : error(404, "not_found", `${singular} ${id} not found`);
    }
    return error(405, "method_not_allowed", `${method} ${url.pathname}`);
  }

  return {
    fetch: handler,
    reset: fresh,
    setRateLimitFault({ times, retryAfter }) {
      rateLimit = times > 0 ? { remaining: times, retryAfter } : null;
    },
    setAuthFault(on) {
      authFault = on;
    },
    seed(collection, resource) {
      const id = counters.get(collection)! + 1;
      counters.set(collection, id);
      store.get(collection)!.set(id, { ...resource, id, name: resource.name });
      return id;
    },
    setNextRequestFault(opts) {
      nextFault = { ...opts };
    },
    setManagedIssuanceLatency(n) {
      certificateStore.setManagedIssuanceLatency(n);
    },
    setNextManagedIssuanceLatency(n) {
      certificateStore.setNextManagedIssuanceLatency(n);
    },
    setNextManagedIssuanceFailure(on) {
      certificateStore.setNextManagedIssuanceFailure(on);
    },
    setNextManagedRequiresDnsChallenge(on) {
      certificateStore.setNextManagedRequiresDnsChallenge(on);
    },
    firewalls: {
      injectExtraRule(id, rule) {
        return firewallStore.injectExtraRule(id, rule);
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

/** Parse a positive integer query param, falling back to `fallback`. */
function clampInt(raw: string | null, fallback: number): number {
  const n = raw === null ? NaN : Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
