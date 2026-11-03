/**
 * core/src/providers/hetzner-dns.ts
 *
 * Task 5.2 — HetznerDNSProvider: the concrete `Provider` (provider.ts) for
 * hcloud DNS records. It is the ONLY translation seam between a declarative
 * `DnsRecord` (entities.ts) and the hcloud DNS REST surface; it drives every
 * request through HttpClient (http-client.ts), which already owns
 * retry/backoff/Retry-After and the SINGLE error taxonomy (errors.ts) — this
 * module never re-implements any of that.
 *
 * THE DNS MODEL (hcloud DNS is a SEPARATE API from the Cloud API; string ids):
 *
 *   desired `DnsRecord` { zone, name, type, value, ttl, hcloud_dns_id? }
 *     ─ zone  → resolved to a `zone_id` via GET /zones?name=<zone>
 *               (a missing zone is a PRECONDITION, raised BEFORE any write —
 *                this provider never creates a zone; YAGNI / fail-safe).
 *     ─ the record's NATURAL COMPOSITE KEY is (zone_id, name, type), looked
 *       up via GET /records?zone_id=&name=&type= (paginated via getAllPages).
 *     ─ hcloud_dns_id ↔ the fake/API `record.id`. It is IDENTITY, not a drift
 *       field: it is server-assigned and is NEVER compared in isConverged
 *       (comparing it would flap convergence and break the Fase-2 idempotency
 *       property). Only the STABLE desired-derived fields (zone, name, type,
 *       value, ttl) define convergence.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; §"non-objetivos"; YAGNI):
 *
 *   - IDEMPOTENCY IS THE CENTRAL INVARIANT. apply() is a NON-DESTRUCTIVE
 *     UPSERT that OBSERVES BEFORE IT WRITES: resolve the zone, look the record
 *     up by its natural composite key, then
 *       absent              → POST /records           (create)
 *       present & differs   → PUT  /records/<id>      (update in place)
 *       present & equal     → NO-OP, changed:false, ZERO writes
 *     A converged apply() repeated N times stays changed:false with zero
 *     writes. conformanceHarness(makeProvider, action, "dns") is the oracle
 *     and the test wires it in directly.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. There is NO delete code path here. An
 *     unmanaged record present in the zone but not desired is the reconciler's
 *     drift concern (Task 2.9), NEVER auto-removed. A destructive `op`
 *     (remove/destroy) is a deliberate NO-OP returning changed:false
 *     (consistent with hetzner-cloud.ts / wireguard.ts). No destructive
 *     rollback on partial failure. The PUT path targets an EXISTING id (the
 *     fake returns 404 with no resurrection if it vanished — never a recreate).
 *
 *   - NO APPROVAL LOGIC. `set_dns` is a none-policy tool (Task 4.4); the
 *     catalog/gate layer owns policy. This provider has ZERO approval/gate
 *     logic — it only observes / applies / verifies.
 *
 *   - PRECONDITION BEFORE WRITE. A missing zone, an unknown scope/kind, or
 *     malformed desired (fails the entities.ts DnsRecordSchema) is a
 *     ReconcileError("precondition"), never a crash, raised BEFORE any write.
 *
 *   - NO SECRET LEAKAGE. The API token is held only to build the
 *     Authorization header and is NEVER logged or interpolated into an error
 *     message (HttpClient already guarantees this for HTTP errors).
 *
 *   - MINIMAL SURFACE. One factory `createHetznerDnsProvider(opts)` returning
 *     `Provider`. Scope is DNS records only over the fake seam — no zone
 *     create/delete, no record delete, no extra endpoints (YAGNI).
 *
 * Exported API:
 *   createHetznerDnsProvider(opts: HetznerDnsOptions): Provider
 *   interface HetznerDnsOptions
 */

import { DnsRecordSchema, type DnsRecord } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";
import { HttpClient } from "./http-client.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Options — the test injects an HttpClient bound to the fake's fetch.
// ---------------------------------------------------------------------------

export interface HetznerDnsOptions {
  /** hcloud DNS API token. Used ONLY for the Authorization header; never logged. */
  readonly token: string;
  /** API root, e.g. "https://dns.hetzner.com/api/v1". No trailing slash. */
  readonly baseUrl?: string;
  /**
   * Pre-built HttpClient (test seam — wire the Hetzner HTTP fake's fetch in
   * here). When omitted, one is built from `token` over the global fetch.
   */
  readonly http?: HttpClient;
}

// ---------------------------------------------------------------------------
// Scope — this provider serves exactly the "dns" kind (the "<kind>:<name>"
// entity-key convention from provider.ts / observed-store.ts).
// ---------------------------------------------------------------------------

const SCOPE = "dns";
const DEFAULT_BASE_URL = "https://dns.hetzner.com/api/v1";

/** The hcloud DNS API record shape (string ids — distinct from Cloud API). */
interface ApiRecord {
  id: string;
  zone_id: string;
  type: string;
  name: string;
  value: string;
  ttl: number;
}

interface ApiZone {
  id: string;
  name: string;
}

/**
 * Whether an existing API record matches the desired record on the STABLE
 * desired-derived fields ONLY (name, type, value, ttl — zone is pinned by the
 * resolved zone_id). The server-assigned `id`/`hcloud_dns_id` is IDENTITY,
 * never compared: comparing it would flap convergence and break idempotency.
 */
function isConverged(
  have: ApiRecord,
  want: { zone_id: string; name: string; type: string; value: string; ttl: number },
): boolean {
  return (
    have.zone_id === want.zone_id &&
    have.name === want.name &&
    have.type === want.type &&
    have.value === want.value &&
    have.ttl === want.ttl
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHetznerDnsProvider(opts: HetznerDnsOptions): Provider {
  if (!opts.token) {
    // Construction-time misconfiguration is fatal, not a reconcile failure.
    throw new ReconcileError("fatal", "HetznerDNSProvider: token is required");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const http =
    opts.http ??
    new HttpClient({
      defaultHeaders: { Authorization: `Bearer ${opts.token}` },
    });

  /** Narrow a "<kind>:<name>" key / scope to "dns"; else precondition. */
  function assertScope(scopeOrEntity: string): void {
    const kind = scopeOrEntity.split(":", 1)[0] ?? "";
    if (kind !== SCOPE) {
      throw new ReconcileError(
        "precondition",
        `HetznerDNSProvider: unsupported scope/kind "${kind}" ` +
          `(supported: ${SCOPE})`,
        { entity: scopeOrEntity },
      );
    }
  }

  /** Validate desired against DnsRecordSchema → precondition on failure. */
  function parseDesired(action: PlanAction): DnsRecord {
    const parsed = DnsRecordSchema.safeParse(action.desired);
    if (!parsed.success) {
      throw new ReconcileError(
        "precondition",
        `HetznerDNSProvider: malformed DnsRecord desired for ${action.entity} ` +
          `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        { entity: action.entity },
      );
    }
    return parsed.data;
  }

  /**
   * Resolve a zone name → its zone_id. A missing zone is a PRECONDITION
   * (raised BEFORE any write — fail-safe; this provider never creates a zone).
   */
  async function resolveZoneId(zone: string, entity: string): Promise<string> {
    const zones = await http.getAllPages<ApiZone>(
      `${baseUrl}/zones?name=${encodeURIComponent(zone)}`,
      "zones",
    );
    const found = zones.find((z) => z.name === zone);
    if (!found) {
      throw new ReconcileError(
        "precondition",
        `HetznerDNSProvider: ${entity} references zone "${zone}" ` +
          `which does not exist — create the zone first`,
        { entity },
      );
    }
    return found.id;
  }

  /**
   * Find an existing record by its NATURAL COMPOSITE KEY (zone_id+name+type),
   * following pagination. undefined ⇒ absent (a create is required).
   */
  async function findRecord(
    zoneId: string,
    name: string,
    type: string,
  ): Promise<ApiRecord | undefined> {
    const url =
      `${baseUrl}/records?zone_id=${encodeURIComponent(zoneId)}` +
      `&name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const all = await http.getAllPages<ApiRecord>(url, "records");
    return all.find(
      (r) => r.zone_id === zoneId && r.name === name && r.type === type,
    );
  }

  return {
    name: "hetzner-dns",

    async observe(scope: string): Promise<ObservedSlice> {
      assertScope(scope);
      // Walk every zone, then every record per zone (paginated). The entity
      // key is "dns:<name>.<zone>" so it round-trips with desired actions.
      const zones = await http.getAllPages<ApiZone>(
        `${baseUrl}/zones`,
        "zones",
      );
      const entities: Array<{ key: string; payload: unknown }> = [];
      for (const z of zones) {
        const recs = await http.getAllPages<ApiRecord>(
          `${baseUrl}/records?zone_id=${encodeURIComponent(z.id)}`,
          "records",
        );
        for (const r of recs) {
          const name = `${r.name}.${z.name}`;
          entities.push({ key: `${SCOPE}:${name}`, payload: { name } });
        }
      }
      return { scope, entities };
    },

    async verify(action: PlanAction): Promise<boolean> {
      assertScope(action.entity);
      const desired = parseDesired(action);
      // Re-read REAL state: resolve zone, then look the record up by its
      // composite key and compare ONLY the stable desired-derived fields.
      let zoneId: string;
      try {
        zoneId = await resolveZoneId(desired.zone, action.entity);
      } catch (e) {
        if (e instanceof ReconcileError && e.errorClass === "precondition") {
          return false; // no zone ⇒ reality cannot match desired
        }
        throw e;
      }
      const have = await findRecord(zoneId, desired.name, desired.type);
      if (!have) return false;
      return isConverged(have, {
        zone_id: zoneId,
        name: desired.name,
        type: desired.type,
        value: desired.value,
        ttl: desired.ttl,
      });
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      assertScope(action.entity);

      // FAIL-SAFE: destructive intents are NOT handled here. No-op, never
      // delete a record (orphan→drift is the reconciler's job, Task 2.9).
      // There is no DELETE code path in this provider by construction.
      if (action.op === "remove" || action.op === "destroy") {
        return { entity: action.entity, op: action.op, changed: false };
      }

      const desired = parseDesired(action);

      // PRECONDITION before any write: the zone must already exist. Raised
      // BEFORE the lookup/write so a failed precondition writes nothing.
      const zoneId = await resolveZoneId(desired.zone, action.entity);

      const want = {
        zone_id: zoneId,
        name: desired.name,
        type: desired.type,
        value: desired.value,
        ttl: desired.ttl,
      };

      // IDEMPOTENCY: observe-before-write by the natural composite key.
      //
      // NB: lookup→write is not atomic. Concurrent same-entity applies are
      // serialized by the reconciler's per-scope advisory lock (Task 2.7),
      // not here. Idempotency is lock-protected, not self-protected.
      const existing = await findRecord(zoneId, desired.name, desired.type);

      if (existing && isConverged(existing, want)) {
        // Already converged → NO write, NO flap.
        return { entity: action.entity, op: action.op, changed: false };
      }

      if (existing) {
        // UPDATE IN PLACE — PUT the existing id (no delete-then-recreate; the
        // API returns 404 with no resurrection if the id vanished).
        const res = await http.request(
          `${baseUrl}/records/${encodeURIComponent(existing.id)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(want),
          },
        );
        await res.json().catch(() => undefined);
        return { entity: action.entity, op: action.op, changed: true };
      }

      // CREATE — absent by its natural key.
      const res = await http.request(`${baseUrl}/records`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(want),
      });
      await res.json().catch(() => undefined);
      return { entity: action.entity, op: action.op, changed: true };
    },
  };
}
