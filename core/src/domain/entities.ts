/**
 * core/src/domain/entities.ts
 *
 * Domain entities for bevox-hetzner-mcp core.
 * Mirrors console/src/api/contract.ts field-for-field so that any core-valid
 * object is also console-valid (the oracle test enforces this invariant).
 * Internal-only optional fields (e.g. network_id) are appended with
 * .optional() to remain structurally compatible with the downstream contract.
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
// Canonical entities — mirroring console contract exactly
// ---------------------------------------------------------------------------

export const ServerSchema = z.object({
  name: z.string(),
  type: z.string(),
  location: z.string(),
  image: z.string(),
  ssh_keys: z.array(z.string()),
  labels: z.record(z.string()),
  network: z.string(),
  // Manifest-shape input may omit `status` (ManifestServerSchema does);
  // default to "pending" so apply-path parseDesired succeeds. Output type
  // stays non-nullable StatusEnum (default fills in) → console contract
  // oracle preserved. Spec docs/specs/2026-05-27-server-schema-status-default.md.
  status: StatusEnum.default("pending"),
  // cloud-init passthrough → Hetzner provision user_data (Bug 3). Present here
  // so it survives ServerSchema.safeParse(action.desired) into serverBody.
  user_data: z.string().optional(),
  // Core-only optional internal fields (do not break console parse)
  network_id: z.number().optional(),
  hcloud_id: z.number().optional(),
});
export type Server = z.infer<typeof ServerSchema>;

export const NetworkSchema = z.object({
  name: z.string(),
  ip_range: z.string(),
  subnets: z.array(z.string()),
  // Core-only optional internal fields
  hcloud_id: z.number().optional(),
});
export type Network = z.infer<typeof NetworkSchema>;

export const VolumeSchema = z.object({
  name: z.string(),
  size: z.string(),
  server: z.string().optional(),
  fs: z.string(),
  status: StatusEnum.optional(),
  // Core-only optional internal fields
  hcloud_id: z.number().optional(),
  mount_path: z.string().optional(),
});
export type Volume = z.infer<typeof VolumeSchema>;

export const ServiceSchema = z.object({
  name: z.string(),
  image: z.string(),
  replicas: z.number(),
  // container argv → Docker Engine Cmd (gap #1).
  command: z.array(z.string()).optional(),
  // restart policy → HostConfig.RestartPolicy (gap #4).
  restart: z.enum(["no", "on-failure", "always", "unless-stopped"]).optional(),
  // intra-service ordering + wait-for-healthy (gap #2). Present here as of
  // Phase 2.0 so apply() can SEE the deps and wait on their health; it is
  // STILL ignored by createContainerBody and isConverged (not container shape).
  depends_on: z
    .array(
      z.union([
        z.string().min(1),
        z.object({
          name: z.string().min(1),
          wait_healthy_timeout: z
            .string()
            .regex(/^\d+[sm]$/)
            .optional(),
        }),
      ]),
    )
    .optional(),
  // declarative healthcheck → ContainerCreate.Healthcheck (gap #2, Phase 2.1).
  // Present here so apply() sees it; maps to the container body.
  healthcheck: z
    .object({
      test: z.array(z.string()).min(1),
      interval: z
        .string()
        .regex(/^\d+[sm]$/)
        .optional(),
      timeout: z
        .string()
        .regex(/^\d+[sm]$/)
        .optional(),
      retries: z.number().int().positive().optional(),
      start_period: z
        .string()
        .regex(/^\d+[sm]$/)
        .optional(),
    })
    .optional(),
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
  status: StatusEnum.optional(),
  // Core-only optional internal fields
  container_ids: z.array(z.string()).optional(),
});
export type Service = z.infer<typeof ServiceSchema>;

export const DnsRecordSchema = z.object({
  zone: z.string(),
  name: z.string(),
  type: z.string().min(1),
  value: z.string(),
  ttl: z.number(),
  // Core-only optional internal fields
  hcloud_dns_id: z.string().optional(),
});
export type DnsRecord = z.infer<typeof DnsRecordSchema>;

// NOTE: operational fields (last_run, snapshots[]) belong to BackupEntrySchema
// — deferred to Fase 5 (Task 5.3), not on the declarative policy.
export const BackupPolicySchema = z.object({
  target: z.string(),
  schedule: z.string(),
  retention: z.string(),
  repo: z.string(),
});
export type BackupPolicy = z.infer<typeof BackupPolicySchema>;

// ---------------------------------------------------------------------------
// StateEvent — append-only audit log entry
// ---------------------------------------------------------------------------

export const StateEventSchema = z.object({
  ts: z.string(),
  actor: z.string(),
  op: z.string(),
  entity: z.string(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
  result: z.string(),
  // core-internal: effective capability scope; not surfaced by the console API
  // (optional so core-valid ⇒ console-valid holds)
  scope: z.string().optional(),
});
export type StateEvent = z.infer<typeof StateEventSchema>;

// ---------------------------------------------------------------------------
// State — six collections matching the console contract
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

// ---------------------------------------------------------------------------
// Plan vocabulary — canonical PlanOpEnum + PlanItemSchema (Task 2.5)
//
// Introduced here per its reservation below. This is the SINGLE Zod source of
// truth for plan op intent in core. It mirrors the FROZEN console contract
// (console/src/api/contract.ts PlanOpEnum) value-for-value so a core-produced
// PlanItem is also console-valid (same core-valid ⇒ console-valid invariant
// the oracle test enforces for entities). The string-literal `PlanOp` union in
// providers/provider.ts is the by-value mirror of this same set — keep the two
// consistent if either changes.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Intentionally NOT defined here — agent-interface layer schemas
// ---------------------------------------------------------------------------
//
// The following schemas are owned by their respective phases and MUST NOT be
// duplicated or ad-hoc imported from production modules into core:
//
//   PlanOpEnum, PlanItemSchema          — DEFINED ABOVE (Fase 2, Task 2.5)
//   WriteEnvelopeSchema, ApprovalSchema — Fase 4 (agent interface + gate)
//   HealthReportSchema                  — Fase 4 (observability endpoint)
//   SecretSchema                        — Fase 4 (secret resolution layer)
//
// Downstream tasks introduce each schema in its owning package at the
// appropriate phase.  If you need one before its phase, raise it in the plan.
