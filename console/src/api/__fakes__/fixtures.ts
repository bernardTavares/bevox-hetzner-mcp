/**
 * console/src/api/__fakes__/fixtures.ts
 *
 * In-memory state mirroring the prototype mockups.
 * All objects are validated against the contract Zod schemas at module load.
 */

import {
  ServerSchema,
  NetworkSchema,
  VolumeSchema,
  ServiceSchema,
  DnsRecordSchema,
  BackupPolicySchema,
  BackupEntrySchema,
  StateEventSchema,
  SecretSchema,
  type Server,
  type Network,
  type Volume,
  type Service,
  type DnsRecord,
  type BackupPolicy,
  type BackupEntry,
  type StateEvent,
  type Secret,
} from "../contract";

// ---------------------------------------------------------------------------
// Servers — from overview.html
// ---------------------------------------------------------------------------

/** Canonical name for the drift server fixture used as a fail-safe sentinel. */
export const DRIFT_SERVER_NAME = "bevox-x-9";

export const servers: Server[] = [
  ServerSchema.parse({
    name: "bevox-app-1",
    type: "cx32",
    location: "nbg1",
    image: "ubuntu-24.04",
    ssh_keys: ["bevox-ops"],
    labels: { app: "harness", network: "bevox-priv" },
    network: "bevox-priv",
    status: "healthy",
  }),
  ServerSchema.parse({
    name: "bevox-app-2",
    type: "cx32",
    location: "nbg1",
    image: "ubuntu-24.04",
    ssh_keys: ["bevox-ops"],
    labels: { app: "harness", network: "bevox-priv" },
    network: "bevox-priv",
    status: "healthy",
  }),
  ServerSchema.parse({
    name: "bevox-db-1",
    type: "cx42",
    location: "nbg1",
    image: "ubuntu-24.04",
    ssh_keys: ["bevox-ops"],
    labels: { app: "db", network: "bevox-priv" },
    network: "bevox-priv",
    status: "degraded",
  }),
  ServerSchema.parse({
    name: "bevox-x-9",
    type: "cx22",
    location: "fsn1",
    image: "ubuntu-24.04",
    ssh_keys: [],
    labels: {},
    network: "unknown",
    status: "drift",
  }),
];

// ---------------------------------------------------------------------------
// Networks — from network.html
// ---------------------------------------------------------------------------

export const networks: Network[] = [
  NetworkSchema.parse({
    name: "bevox-priv",
    ip_range: "10.0.0.0/16",
    subnets: ["10.0.1.0/24"],
  }),
];

// ---------------------------------------------------------------------------
// Volumes — from backups.html + plan-apply.html
// ---------------------------------------------------------------------------

export const volumes: Volume[] = [
  VolumeSchema.parse({
    name: "pg-data",
    size: "50Gi",
    server: "bevox-db-1",
    fs: "ext4",
    status: "healthy",
  }),
  VolumeSchema.parse({
    name: "pg-data-2",
    size: "50Gi",
    fs: "ext4",
    status: "pending",
  }),
  VolumeSchema.parse({
    name: "app-data",
    size: "20Gi",
    server: "bevox-app-1",
    fs: "ext4",
    status: "healthy",
  }),
];

// ---------------------------------------------------------------------------
// Services — from overview.html
// ---------------------------------------------------------------------------

export const services: Service[] = [
  ServiceSchema.parse({
    name: "bevox-harness",
    image: "registry/bevox-harness:v12",
    replicas: 2,
    env: { NODE_ENV: "production" },
    ports: ["3000:3000"],
    server_selector: { app: "harness" },
    status: "healthy",
  }),
  ServiceSchema.parse({
    name: "bevox-backend",
    image: "registry/bevox-backend:v8",
    replicas: 1,
    env: { NODE_ENV: "production" },
    ports: ["8080:8080"],
    server_selector: { app: "harness" },
    status: "degraded",
  }),
];

// ---------------------------------------------------------------------------
// DNS Records — from dns.html
// ---------------------------------------------------------------------------

export const dnsRecords: DnsRecord[] = [
  DnsRecordSchema.parse({
    zone: "example.net",
    name: "app",
    type: "A",
    value: "1.2.3.4",
    ttl: 300,
  }),
  DnsRecordSchema.parse({
    zone: "example.net",
    name: "api",
    type: "CNAME",
    value: "app.example.net",
    ttl: 300,
  }),
  DnsRecordSchema.parse({
    zone: "example.net",
    name: "@",
    type: "A",
    value: "1.2.3.4",
    ttl: 3600,
  }),
  DnsRecordSchema.parse({
    zone: "example.net",
    name: "www",
    type: "CNAME",
    value: "app.example.net",
    ttl: 300,
  }),
];

// ---------------------------------------------------------------------------
// Backup Policies — from backups.html (used by GET /api/state)
// ---------------------------------------------------------------------------

export const backupPolicies: BackupPolicy[] = [
  BackupPolicySchema.parse({
    target: "volume:pg-data",
    schedule: "0 3 * * *",
    retention: "14d",
    repo: "restic:hetzner-backup",
  }),
];

// ---------------------------------------------------------------------------
// Backup Entries — enriched data for GET /api/backups
// Includes last_run metadata and snapshots list.
// Faithful to prototype/backups.html.
// ---------------------------------------------------------------------------

export const backupEntries: BackupEntry[] = [
  BackupEntrySchema.parse({
    target: "volume:pg-data",
    schedule: "0 3 * * *",
    retention: "14d",
    repo: "restic:hetzner-backup",
    last_run: "2026-05-17 03:00 ok (2.1Gi)",
    snapshots: [
      { id: "snap-0517", timestamp: "2026-05-17 03:00", size: "2.1Gi" },
      { id: "snap-0516", timestamp: "2026-05-16 03:00", size: "2.0Gi" },
      { id: "snap-0515", timestamp: "2026-05-15 03:00", size: "2.0Gi" },
      { id: "snap-0514", timestamp: "2026-05-14 03:00", size: "1.9Gi" },
      { id: "snap-0513", timestamp: "2026-05-13 03:00", size: "1.9Gi" },
    ],
  }),
];

// ---------------------------------------------------------------------------
// State Events — from events.html
// ---------------------------------------------------------------------------

export const stateEvents: StateEvent[] = [
  StateEventSchema.parse({
    ts: "2026-05-17T14:02:00Z",
    actor: "vox",
    op: "update",
    entity: "service:bevox-harness",
    before: { image: "registry/bevox-harness:v11" },
    after: { image: "registry/bevox-harness:v12" },
    result: "ok",
  }),
  StateEventSchema.parse({
    ts: "2026-05-17T13:50:00Z",
    actor: "runner-3",
    op: "deploy",
    entity: "service:bevox-backend",
    before: { replicas: 1 },
    after: { replicas: 2 },
    result: "ok",
  }),
  StateEventSchema.parse({
    ts: "2026-05-17T13:31:00Z",
    actor: "bernard",
    op: "approve",
    entity: "server:bevox-db-old",
    before: null,
    after: { action: "destroy — aprovado" },
    result: "ok",
  }),
  StateEventSchema.parse({
    ts: "2026-05-17T12:10:00Z",
    actor: "system",
    op: "drift",
    entity: "server:bevox-x-9",
    before: null,
    after: null,
    result: "reported",
  }),
];

// ---------------------------------------------------------------------------
// Secrets — from secrets.html
//
// SECURITY INVARIANT: these fixtures contain ONLY name, keys, and used_by.
// There is NO value, values, data, or secret_value field — by design.
// Secret values are resolved by the reconciler at apply time and are never
// transmitted to the Console in any form.
// ---------------------------------------------------------------------------

export const secrets: Secret[] = [
  SecretSchema.parse({
    name: "bevox-harness",
    keys: 5,
    used_by: ["service:bevox-harness"],
  }),
  SecretSchema.parse({
    name: "bevox-backend",
    keys: 8,
    used_by: ["service:bevox-backend"],
  }),
];

// ---------------------------------------------------------------------------
// Approvals — from approvals.html
// ---------------------------------------------------------------------------

export interface Approval {
  id: string;
  action: string;
  entity: string;
  actor: string;
  requested_at: string;
  ttl_remaining: string;
  impact: string;
  status: "pending" | "approved" | "rejected";
}

export const approvals: Approval[] = [
  {
    id: "apr_8f3",
    action: "destroy",
    entity: "server:bevox-db-1",
    actor: "vox",
    requested_at: "2026-05-17T12:00:00Z",
    ttl_remaining: "22h",
    impact: "remove server:bevox-db-1 + detach volume:pg-data · serviços afetados: bevox-backend",
    status: "pending",
  },
  {
    id: "apr_8f4",
    action: "restore",
    entity: "volume:pg-data",
    actor: "bernard",
    requested_at: "2026-05-17T11:00:00Z",
    ttl_remaining: "23h",
    impact: "restore sobrescreve estado atual do volume:pg-data com snapshot de 2026-05-16 03:00 (2.1Gi) · potencial perda de dados",
    status: "pending",
  },
];
