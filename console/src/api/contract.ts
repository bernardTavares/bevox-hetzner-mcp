/**
 * console/src/api/contract.ts
 *
 * Single source of truth for every type the Console exchanges with the
 * bevox-hetzner-mcp REST API.  The core (Fase 4) MUST implement this contract;
 * the Console consumes ONLY this API.
 *
 * Generated with Zod so runtime validation and static types stay in sync.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared enums
// ---------------------------------------------------------------------------

export const StatusEnum = z.enum([
  "pending",
  "applying",
  "healthy",
  "degraded",
  "drift",
  "error",
]);
export type Status = z.infer<typeof StatusEnum>;

// ---------------------------------------------------------------------------
// Canonical entities
// ---------------------------------------------------------------------------

export const ServerSchema = z.object({
  name: z.string(),
  type: z.string(),
  location: z.string(),
  image: z.string(),
  ssh_keys: z.array(z.string()),
  labels: z.record(z.string()),
  network: z.string(),
  status: StatusEnum,
});
export type Server = z.infer<typeof ServerSchema>;

export const NetworkSchema = z.object({
  name: z.string(),
  ip_range: z.string(),
  subnets: z.array(z.string()),
});
export type Network = z.infer<typeof NetworkSchema>;

export const VolumeSchema = z.object({
  name: z.string(),
  size: z.string(),
  server: z.string().optional(),
  fs: z.string(),
  status: StatusEnum.optional(),
});
export type Volume = z.infer<typeof VolumeSchema>;

export const ServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  replicas: z.number(),
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
  status: StatusEnum.optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const DnsRecordSchema = z.object({
  zone: z.string(),
  name: z.string(),
  type: z.string().min(1),
  value: z.string(),
  ttl: z.number(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

export const BackupPolicySchema = z.object({
  target: z.string(),
  schedule: z.string(),
  retention: z.string(),
  repo: z.string(),
});
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;

/** A single restic snapshot entry */
export const SnapshotEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  size: z.string(),
});
export type SnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

/**
 * Enriched backup entry returned by GET /api/backups.
 * Extends BackupPolicy with last_run metadata and the snapshots list.
 * No secret values — only operational metadata.
 */
export const BackupEntrySchema = BackupPolicySchema.extend({
  last_run: z.string().optional(),
  snapshots: z.array(SnapshotEntrySchema),
});
export type BackupEntry = z.infer<typeof BackupEntrySchema>;

export const StateEventSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  op: z.string(),
  entity: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  result: z.string(),
});
export type StateEvent = z.infer<typeof StateEventSchema>;

// ---------------------------------------------------------------------------
// Write envelope + helpers
// ---------------------------------------------------------------------------

/**
 * All op values that may appear in a PlanItem returned by any endpoint.
 * Audited against __fakes__/handlers.ts — every op string the fake emits is
 * represented here.  Extra values (add, remove, noop) are included as a
 * forward-compatible superset so real-server responses never fail parsing.
 *
 * Handlers-audited ops: create, update, drift, scale, destroy, upsert,
 *   snapshot, restore.
 * Superset additions: add, remove, noop.
 */
export const PlanOpEnum = z.enum([
  "create",
  "add",
  "update",
  "scale",
  "drift",
  "remove",
  "destroy",
  "noop",
  "upsert",
  "snapshot",
  "restore",
]);
export type PlanOp = z.infer<typeof PlanOpEnum>;

export const PlanItemSchema = z.object({
  op: PlanOpEnum,
  entity: z.string(),
  change: z.string(),
  impact: z.string(),
});
export type PlanItem = z.infer<typeof PlanItemSchema>;

export const ErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  entity: z.string(),
});
export type ApiError = z.infer<typeof ErrorSchema>;

export const WriteEnvelopeStatusEnum = z.enum(["planned", "pending_approval", "applied", "error"]);
export type WriteEnvelopeStatus = z.infer<typeof WriteEnvelopeStatusEnum>;

export const WriteEnvelopeSchema = z.object({
  status: WriteEnvelopeStatusEnum,
  plan: z.array(PlanItemSchema).optional(),
  approval_id: z.string().optional(),
  error: ErrorSchema.optional(),
});
export type WriteEnvelope = z.infer<typeof WriteEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Approval (GET /api/approvals response items)
// ---------------------------------------------------------------------------

export const ApprovalSchema = z.object({
  id: z.string(),
  action: z.string(),
  entity: z.string(),
  actor: z.string(),
  requested_at: z.string(),
  ttl_remaining: z.string(),
  impact: z.string(),
  status: z.enum(["pending", "approved", "rejected"]),
});
export type Approval = z.infer<typeof ApprovalSchema>;

// ---------------------------------------------------------------------------
// HealthReport (GET /api/health response)
// ---------------------------------------------------------------------------

const CircuitBreakerSchema = z.object({
  name: z.string(),
  state: z.string(),
  failures: z.number().optional(),
  max_failures: z.number().optional(),
  last_failure: z.string().optional(),
});

const DegradedItemSchema = z.object({
  entity: z.string(),
  detail: z.string(),
});

const BlockedItemSchema = z.object({
  entity: z.string(),
  reason: z.string(),
});

const DriftItemSchema = z.object({
  entity: z.string(),
  detail: z.string(),
});

const ReconcilerStatusSchema = z.object({
  state: z.string(),
  last_cycle: z.string(),
  last_result: z.string(),
  next_cycle_in: z.string(),
  total_cycles: z.number(),
});

export const HealthReportSchema = z.object({
  circuit_breakers: z.array(CircuitBreakerSchema),
  degraded: z.array(DegradedItemSchema),
  blocked: z.array(BlockedItemSchema),
  drift: z.array(DriftItemSchema),
  reconciler: ReconcilerStatusSchema,
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

// ---------------------------------------------------------------------------
// Secret (GET /api/secrets response items)
//
// SECURITY INVARIANT: this schema MUST NOT include any field that holds
// a secret value. Only the reference name, key count, and which services
// use the secret are exposed. The actual secret values are resolved by the
// reconciler at apply time and are NEVER transmitted to the Console.
// ---------------------------------------------------------------------------

export const SecretSchema = z
  .object({
    /** Reference name, e.g. "bevox-harness" */
    name: z.string(),
    /** Number of keys in this secret bundle */
    keys: z.number().int().nonnegative(),
    /** List of service names that reference this secret */
    used_by: z.array(z.string()),
    // NOTE: There is intentionally NO `value`, `values`, `data`, or similar field.
  })
  .strict();
  // .strict() ensures any unexpected key (e.g. `value` injected by a Fase 4 backend)
  // is REJECTED with a ZodError rather than silently stripped.
export type Secret = z.infer<typeof SecretSchema>;

// ---------------------------------------------------------------------------
// State (GET /api/state response)
// ---------------------------------------------------------------------------

export const StateSchema = z.object({
  servers: z.array(ServerSchema),
  networks: z.array(NetworkSchema),
  volumes: z.array(VolumeSchema),
  services: z.array(ServiceSchema),
  dns: z.array(DnsRecordSchema),
  backups: z.array(BackupPolicySchema),
});
export type State = z.infer<typeof StateSchema>;
