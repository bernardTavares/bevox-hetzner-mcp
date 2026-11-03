/**
 * core/src/providers/hetzner-cloud.ts
 *
 * Task 2.4 — HetznerCloudProvider: the concrete `Provider` (provider.ts) for
 * Hetzner Cloud servers/networks/volumes. It is the ONLY translation seam
 * between declarative desired entities (entities.ts) and the Hetzner Cloud
 * REST surface; it drives every request through HttpClient (http-client.ts),
 * which already owns retry/backoff/Retry-After and the SINGLE error taxonomy
 * (errors.ts) — this module never re-implements any of that.
 *
 * Design principles (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; YAGNI):
 *
 *   - IDEMPOTENCY IS THE CENTRAL INVARIANT (Fase 2 exit criterion). apply()
 *     OBSERVES BEFORE IT CREATES: it lists the collection and looks the
 *     desired resource up by its natural identifier (`name`). If a resource
 *     with that name already exists it performs NO write and returns
 *     `changed:false`. Hence a converged apply() is a no-op on every repeat —
 *     conformanceHarness(makeProvider, action, scope) is the oracle and the
 *     test wires it in directly.
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. This task only observes / creates /
 *     verifies. No delete, orphan-prune or drift-correction logic lives here
 *     (Tasks 2.5/2.6/2.9 own plan/apply/drift). A destructive `op`
 *     (remove/destroy/…) is a deliberate NO-OP here ("handled in a later
 *     task") — it NEVER deletes a resource.
 *
 *   - PRECONDITION BEFORE WRITE. A server that references a network is
 *     rejected with ReconcileError("precondition") BEFORE any create attempt
 *     if that network does not yet exist. Malformed desired (fails the
 *     entities.ts Zod schema) is likewise a "precondition", never a crash.
 *
 *   - NO SECRET LEAKAGE. The API token is held only to build the
 *     Authorization header and is NEVER logged or interpolated into an error
 *     message (HttpClient already guarantees this for HTTP errors).
 *
 *   - MINIMAL SURFACE. One factory, `createHetznerCloudProvider(opts)`,
 *     returning `Provider`. Scope is servers/networks/volumes only — the
 *     fake's surface; no DNS/backup/firewall (YAGNI).
 *
 * Exported API:
 *   createHetznerCloudProvider(opts: HetznerCloudOptions): Provider
 *   interface HetznerCloudOptions
 */

import { z } from "zod";
import {
  NetworkSchema,
  ServerSchema,
  VolumeSchema,
} from "../domain/entities.js";
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

export interface HetznerCloudOptions {
  /** Hetzner API token. Used ONLY for the Authorization header; never logged. */
  readonly token: string;
  /** API root, e.g. "https://api.hetzner.cloud/v1". No trailing slash. */
  readonly baseUrl?: string;
  /**
   * Pre-built HttpClient (test seam — wire the Hetzner HTTP fake's fetch in
   * here). When omitted, one is built from `token` over the global fetch.
   */
  readonly http?: HttpClient;
}

// ---------------------------------------------------------------------------
// Scope ⇄ Hetzner collection mapping (the only three Fase 2 needs).
// `scope` is the `<kind>` prefix of the "<kind>:<name>" entity key
// (provider.ts / observed-store.ts convention).
// ---------------------------------------------------------------------------

const KINDS = {
  server: { collection: "servers", schema: ServerSchema },
  network: { collection: "networks", schema: NetworkSchema },
  volume: { collection: "volumes", schema: VolumeSchema },
} as const;

type Kind = keyof typeof KINDS;

/** A list row from the Hetzner Cloud API. `id`/`name` are load-bearing
 *  (findByName); the rest are the rich fields observe() maps (task 3). */
type WireRow = { id: number; name: string } & Record<string, unknown>;

/**
 * Lenient wire schema for the fields `observe()` maps — EVERYTHING optional so
 * a partial / surprising real response degrades to the minimal payload rather
 * than throwing. No `as` on the wire: the row is parsed, then mapped to the
 * entities.ts shape. Spec 2026-06-02-observed-state-adapter §1.1 (task 3).
 */
const WireRowSchema = z.object({
  server_type: z.object({ name: z.string() }).partial().optional(),
  datacenter: z
    .object({ location: z.object({ name: z.string() }).partial().optional() })
    .partial()
    .optional(),
  image: z.object({ name: z.string() }).partial().nullable().optional(),
  labels: z.record(z.string()).optional(),
  ip_range: z.string().optional(),
  subnets: z.array(z.object({ ip_range: z.string() }).partial()).optional(),
  size: z.number().optional(),
  format: z.string().nullable().optional(),
});

/**
 * Map a Hetzner wire row to an entities.ts-shaped payload for `kind`. Fields
 * the observe wire does not carry (ssh_keys; the private-network NAME) default
 * so the payload satisfies the entities.ts schema and the adapter (task 5)
 * includes it; `status` is OMITTED so the schema default ("pending") /
 * optionality applies, matching the manifest's own default (noop alignment).
 * Drift on the un-carried fields surfaces honestly (spec §0 — reported, never
 * corrected); perfect fidelity is Part 2.
 */
function wireToPayload(kind: Kind, row: WireRow): Record<string, unknown> {
  const w = WireRowSchema.safeParse(row);
  const f = w.success ? w.data : {};
  if (kind === "server") {
    return {
      name: row.name,
      type: f.server_type?.name ?? "",
      location: f.datacenter?.location?.name ?? "",
      image: f.image?.name ?? "",
      ssh_keys: [],
      labels: f.labels ?? {},
      network: "",
      hcloud_id: row.id,
    };
  }
  if (kind === "network") {
    return {
      name: row.name,
      ip_range: f.ip_range ?? "",
      subnets: (f.subnets ?? []).map((s) => s.ip_range ?? "").filter((r) => r.length > 0),
      hcloud_id: row.id,
    };
  }
  // volume
  return {
    name: row.name,
    size: f.size !== undefined ? `${f.size}Gi` : "",
    fs: f.format ?? "",
    hcloud_id: row.id,
  };
}

const DEFAULT_BASE_URL = "https://api.hetzner.cloud/v1";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHetznerCloudProvider(
  opts: HetznerCloudOptions,
): Provider {
  if (!opts.token) {
    // Construction-time misconfiguration is fatal, not a reconcile failure.
    throw new ReconcileError("fatal", "HetznerCloudProvider: token is required");
  }
  const baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const http =
    opts.http ??
    new HttpClient({
      defaultHeaders: { Authorization: `Bearer ${opts.token}` },
    });

  /** Narrow a "<kind>:<name>" entity key to its kind; precondition if alien. */
  function kindOf(scopeOrEntity: string): Kind {
    const kind = scopeOrEntity.split(":", 1)[0] ?? "";
    if (!(kind in KINDS)) {
      throw new ReconcileError(
        "precondition",
        `HetznerCloudProvider: unsupported scope/kind "${kind}" ` +
          `(supported: ${Object.keys(KINDS).join(", ")})`,
        { entity: scopeOrEntity },
      );
    }
    return kind as Kind;
  }

  /**
   * List every resource of `collection`, following Hetzner pagination. The
   * row carries the rich wire fields the API returns (server_type / public_net
   * / datacenter / image / status; ip_range / subnets; size / format /
   * linux_device / status) — `observe()` maps them to entities.ts shape (task
   * 3); `findByName` only needs `id`/`name`.
   */
  async function listAll(
    collection: string,
  ): Promise<Array<WireRow>> {
    return http.getAllPages<WireRow>(`${baseUrl}/${collection}`, collection);
  }

  /** Find an existing resource by its natural identifier (name). */
  async function findByName(
    collection: string,
    name: string,
  ): Promise<{ id: number; name: string } | undefined> {
    const all = await listAll(collection);
    return all.find((r) => r.name === name);
  }

  /** Validate desired against the entities.ts schema → precondition on fail. */
  function parseDesired<T extends z.ZodTypeAny>(
    schema: T,
    action: PlanAction,
  ): z.infer<T> {
    const parsed = schema.safeParse(action.desired);
    if (!parsed.success) {
      throw new ReconcileError(
        "precondition",
        `HetznerCloudProvider: malformed desired for ${action.entity} ` +
          `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        { entity: action.entity },
      );
    }
    return parsed.data;
  }

  /**
   * Resolve dependencies that must EXIST before a create. Only servers carry
   * one in Fase 2: the referenced private network. Missing ⇒ precondition,
   * raised BEFORE any write (fail-safe).
   */
  async function assertPreconditions(
    kind: Kind,
    desired: Record<string, unknown>,
    entity: string,
  ): Promise<void> {
    if (kind !== "server") return;
    const net = desired["network"];
    if (typeof net === "string" && net.length > 0) {
      const found = await findByName("networks", net);
      if (!found) {
        throw new ReconcileError(
          "precondition",
          `HetznerCloudProvider: ${entity} references network "${net}" ` +
            `which does not exist — create the network first`,
          { entity },
        );
      }
    }
  }

  return {
    name: "hetzner-cloud",

    async observe(scope: string): Promise<ObservedSlice> {
      const kind = kindOf(scope);
      const { collection } = KINDS[kind];
      const all = await listAll(collection);
      return {
        scope,
        // Task 3: map each rich wire row → an entities.ts-shaped payload.
        entities: all.map((r) => ({
          key: `${kind}:${r.name}`,
          payload: wireToPayload(kind, r),
        })),
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      const kind = kindOf(action.entity);
      const { collection, schema } = KINDS[kind];
      const desired = parseDesired(schema, action) as { name: string };
      const found = await findByName(collection, desired.name);
      return found !== undefined;
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      const kind = kindOf(action.entity);

      // FAIL-SAFE: destructive intents are NOT handled in Task 2.4. Treat as a
      // no-op (plan/apply/drift own the lifecycle in 2.5/2.6/2.9) — we never
      // delete a resource here.
      if (action.op === "remove" || action.op === "destroy") {
        return { entity: action.entity, op: action.op, changed: false };
      }

      const { collection, schema } = KINDS[kind];
      const desired = parseDesired(schema, action) as Record<string, unknown> & {
        name: string;
      };

      // IDEMPOTENCY: observe-before-create. If the resource already exists by
      // its natural name, this apply() is a NO-OP (no duplicate, changed:false).
      //
      // NB: observe→create is not atomic. Concurrent same-entity applies are
      // serialized by the reconciler's per-scope advisory lock (Task 2.7), not
      // here. Idempotency is lock-protected, not self-protected.
      //
      // ORDERING NB (Task 2.6): this early return is correct for CREATE, but
      // 2.6's update-in-place path must still run assertPreconditions() — as
      // written that short-circuit would bypass it. Don't silently regress the
      // observe→precondition→write ordering when wiring update.
      const existing = await findByName(collection, desired.name);
      if (existing) {
        return { entity: action.entity, op: action.op, changed: false };
      }

      // PRECONDITION before the write (fail-safe: nothing created on failure).
      await assertPreconditions(kind, desired, action.entity);

      // NAME→ID LOOKUPS: resolve referenced resource names to Hetzner numeric ids
      // BEFORE the POST (fail-safe: throws precondition if the dependency is absent).
      const refs: { networkIds?: number[]; serverId?: number } = {};
      if (kind === "server") {
        const netName = desired["network"];
        if (typeof netName === "string" && netName.length > 0) {
          const net = await findByName("networks", netName);
          if (!net) {
            throw new ReconcileError(
              "precondition",
              `HetznerCloudProvider: ${action.entity} references network "${netName}" which does not exist — create the network first`,
              { entity: action.entity },
            );
          }
          refs.networkIds = [net.id];
        }
      }
      if (kind === "volume") {
        const serverName = desired["server"];
        if (typeof serverName === "string" && serverName.length > 0) {
          const srv = await findByName("servers", serverName);
          if (!srv) {
            throw new ReconcileError(
              "precondition",
              `HetznerCloudProvider: ${action.entity} references server "${serverName}" which does not exist — create the server first`,
              { entity: action.entity },
            );
          }
          refs.serverId = srv.id;
        }
      }

      // For volumes, `desired` (Zod-parsed) strips fields not in VolumeSchema (e.g.
      // `location`). Merge back from action.desired so volumeBody can access them.
      const wireDesired: Record<string, unknown> =
        kind === "volume"
          ? { ...(action.desired as Record<string, unknown>), ...desired }
          : desired;

      const res = await http.request(`${baseUrl}/${collection}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(toApiBody(kind, wireDesired, refs, action.entity)),
      });
      // HttpClient already threw a classified ReconcileError for any non-2xx;
      // reaching here means a 2xx — drain the body so the socket is freed.
      await res.json().catch(() => undefined);

      return { entity: action.entity, op: action.op, changed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Internals — desired entity → Hetzner Cloud create body. Per-kind
// translation: network builds subnet objects with eu-central defaults;
// server renames `type → server_type` and consumes resolved `networks:[id]`
// from `refs.networkIds`; volume renames `fs → format`, parses size to
// number, and consumes resolved `server: refs.serverId` when attached.
//
// Contract: docs/specs/2026-05-27-hetzner-cloud-wire-translation.md (Aceita).
// Pre-write name→id lookups happen in apply() and surface missing references
// as ReconcileError("precondition", ..., {entity}) BEFORE any POST.
// The v1 spec-mãe (docs/specs/2026-05-17-bevox-hetzner-mcp-design.md) is
// FROZEN; this file's translation contract evolves through follow-up
// spec-filhas, not in-place edits.
// ---------------------------------------------------------------------------

interface ApiBodyRefs {
  readonly networkIds?: ReadonlyArray<number>;
  readonly serverId?: number;
}

function networkBody(
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const rawSubnets = desired["subnets"];
  const subnets: Array<{ ip_range: string; type: string; network_zone: string }> = [];
  if (Array.isArray(rawSubnets)) {
    for (const s of rawSubnets) {
      // Trust Zod-parsed NetworkSchema.subnets: z.array(z.string()) — entries are strings.
      subnets.push({
        ip_range: s as string,
        type: "cloud",
        network_zone: "eu-central",
      });
    }
  }
  return {
    name: desired["name"],
    ip_range: desired["ip_range"],
    subnets,
  };
}

function serverBody(
  desired: Record<string, unknown>,
  refs: ApiBodyRefs | undefined,
): Record<string, unknown> {
  const { name, type, image, location, ssh_keys, labels, user_data } = desired;
  const networkIds = refs?.networkIds;
  const body: Record<string, unknown> = {
    name,
    server_type: type,
    image,
    location,
    ssh_keys,
    labels,
  };
  if (networkIds !== undefined) {
    body["networks"] = [...networkIds];
  }
  // Bug 3: cloud-init passthrough. Conditional — omitted ⇒ body byte-identical.
  if (typeof user_data === "string" && user_data.length > 0) {
    body["user_data"] = user_data;
  }
  return body;
}

function parseVolumeSize(raw: unknown, entity: string): number {
  if (typeof raw !== "string") {
    throw new ReconcileError(
      "precondition",
      `HetznerCloudProvider: volume ${entity} size is not a string`,
      { entity },
    );
  }
  // Accept "<N>G" or bare "<N>"
  const withG = /^\s*(\d+)\s*G\s*$/i.exec(raw);
  if (withG) {
    return parseInt(withG[1] ?? "0", 10);
  }
  const bare = /^\s*(\d+)\s*$/.exec(raw);
  if (bare) {
    return parseInt(bare[1] ?? "0", 10);
  }
  throw new ReconcileError(
    "precondition",
    `HetznerCloudProvider: volume ${entity} size "${raw}" not parseable as GB (accepted: "<N>G" or "<N>")`,
    { entity },
  );
}

function volumeBody(
  desired: Record<string, unknown>,
  refs: ApiBodyRefs | undefined,
  entity: string,
): Record<string, unknown> {
  const sizeNum = parseVolumeSize(desired["size"], entity);
  const body: Record<string, unknown> = {
    name: desired["name"],
    size: sizeNum,
    format: desired["fs"],
    // Hetzner formats the NEW volume once and mounts it at
    // /mnt/HC_Volume_<id>. Re-attach/re-create never reformats (data-safe).
    // The manifest `mount_path` stays advisory and is deliberately NOT sent.
    automount: true,
  };
  if (typeof desired["server"] === "string" && desired["server"].length > 0) {
    // Attached volume — must have a resolved server id
    if (refs?.serverId === undefined) {
      throw new Error(
        `HetznerCloudProvider: programming error — serverId not resolved for volume ${entity}`,
      );
    }
    body["server"] = refs.serverId;
  } else if (typeof desired["location"] === "string" && desired["location"].length > 0) {
    // Standalone volume with explicit location
    body["location"] = desired["location"];
  }
  // If neither server nor location is specified, emit just name/size/format
  // (Hetzner will return a validation error; the operator must provide location).
  return body;
}

function toApiBody(
  kind: Kind,
  desired: Record<string, unknown>,
  refs?: ApiBodyRefs,
  entity?: string,
): Record<string, unknown> {
  // Strip core-only internal bookkeeping fields that are not API inputs.
  const { hcloud_id, network_id, status, ...stripped } = desired;
  void hcloud_id;
  void network_id;
  void status;

  if (kind === "network") {
    return networkBody(stripped);
  }
  if (kind === "server") {
    return serverBody(stripped, refs);
  }
  if (kind === "volume") {
    return volumeBody(stripped, refs, entity ?? "");
  }
  return stripped;
}
