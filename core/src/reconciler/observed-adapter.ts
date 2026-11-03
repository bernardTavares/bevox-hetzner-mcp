/**
 * core/src/reconciler/observed-adapter.ts
 *
 * The PURE observed-state adapter: turn a provider `ObservedSlice` (entity key
 * + raw payload) into a typed, Zod-validated `State`. This is the seam the
 * reconciler's Observe step feeds into `putObservedState`, so `get_state` /
 * `diff` reflect reality (spec 2026-06-02-observed-state-adapter §1.2).
 *
 * - Per entity: derive the kind from the key prefix, `safeParse` the payload
 *   against that kind's `entities.ts` schema, and push the validated object
 *   into the matching `State` collection.
 * - DEGRADE-SAFE (Q3 / L4): a payload that fails validation — or whose key has
 *   an unknown kind — is SKIPPED, never thrown. One malformed resource can
 *   never drop the reconcile cycle; the result always satisfies StateSchema.
 * - PURE & TOTAL: same slice ⇒ deeply-equal `State`; no I/O; no `ApplyContext`
 *   ⇒ structurally unable to resolve a secret (the payload is surfaced as-is,
 *   carrying refs not values — the producers enforce that boundary).
 * - NO `as` on the payload: validation is Zod-only (the payload is `unknown`).
 */

import {
  ServerSchema,
  NetworkSchema,
  VolumeSchema,
  ServiceSchema,
  DnsRecordSchema,
  BackupPolicySchema,
  type State,
} from "../domain/entities.js";
import type { ObservedSlice } from "../providers/provider.js";

/** kind → its entities.ts schema + the State collection it lands in. */
const KIND_TABLE = {
  server: { schema: ServerSchema, collection: "servers" },
  network: { schema: NetworkSchema, collection: "networks" },
  volume: { schema: VolumeSchema, collection: "volumes" },
  service: { schema: ServiceSchema, collection: "services" },
  dns: { schema: DnsRecordSchema, collection: "dns" },
  backup: { schema: BackupPolicySchema, collection: "backups" },
} as const;

/**
 * Build a typed `State` from an observed slice. Pure, total, degrade-safe.
 */
export function observedAdapter(slice: ObservedSlice): State {
  const state: State = {
    servers: [],
    networks: [],
    volumes: [],
    services: [],
    dns: [],
    backups: [],
  };
  for (const entity of slice.entities) {
    const idx = entity.key.indexOf(":");
    const kind = idx >= 0 ? entity.key.slice(0, idx) : entity.key;
    const entry = (KIND_TABLE as Record<string, (typeof KIND_TABLE)[keyof typeof KIND_TABLE] | undefined>)[kind];
    if (entry === undefined) continue; // unknown kind ⇒ skip (degrade-safe)
    const parsed = entry.schema.safeParse(entity.payload);
    if (!parsed.success) continue; // invalid payload ⇒ skip (degrade-safe)
    // Each collection is homogeneous to its schema; push the validated object.
    switch (entry.collection) {
      case "servers":
        state.servers.push(parsed.data as State["servers"][number]);
        break;
      case "networks":
        state.networks.push(parsed.data as State["networks"][number]);
        break;
      case "volumes":
        state.volumes.push(parsed.data as State["volumes"][number]);
        break;
      case "services":
        state.services.push(parsed.data as State["services"][number]);
        break;
      case "dns":
        state.dns.push(parsed.data as State["dns"][number]);
        break;
      case "backups":
        state.backups.push(parsed.data as State["backups"][number]);
        break;
    }
  }
  return state;
}
