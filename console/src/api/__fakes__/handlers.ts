/**
 * console/src/api/__fakes__/handlers.ts
 *
 * MSW v2 handlers implementing every endpoint in CONTRACT.md.
 * Faithful to the write envelope semantics: dry_run, pending_approval,
 * fail-safe drift, and structured error envelope.
 */

import { http, HttpResponse } from "msw";
import {
  servers as fixtureServers,
  networks,
  volumes as fixtureVolumes,
  services as fixtureServices,
  dnsRecords as fixtureDnsRecords,
  backupPolicies,
  backupEntries,
  stateEvents as fixtureEvents,
  approvals as fixtureApprovals,
  secrets as fixtureSecrets,
  DRIFT_SERVER_NAME,
  type Approval,
} from "./fixtures";
import type { WriteEnvelope, PlanItem } from "../contract";

// ---------------------------------------------------------------------------
// Mutable in-memory state (cloned from fixtures so tests can reset)
// ---------------------------------------------------------------------------

let servers = [...fixtureServers];
let volumes = [...fixtureVolumes];
let services = [...fixtureServices];
let dnsRecords = [...fixtureDnsRecords];
let events = [...fixtureEvents];
let approvals: Approval[] = fixtureApprovals.map((a) => ({ ...a }));
let approvalCounter = 100;

export function resetState() {
  servers = [...fixtureServers];
  volumes = [...fixtureVolumes];
  services = [...fixtureServices];
  dnsRecords = [...fixtureDnsRecords];
  events = [...fixtureEvents];
  approvals = fixtureApprovals.map((a) => ({ ...a }));
  approvalCounter = 100;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function isDryRun(body: Record<string, unknown>): boolean {
  // default for destructive ops is dry_run:true per spec
  return body.dry_run !== false;
}

function newApprovalId(): string {
  return `apr_${(++approvalCounter).toString(16)}`;
}

// ---------------------------------------------------------------------------
// GET /api/state
// ---------------------------------------------------------------------------

const getState = http.get("*/api/state", () => {
  return HttpResponse.json({
    servers,
    networks,
    volumes,
    services,
    dns: dnsRecords,
    backups: backupPolicies,
  });
});

// ---------------------------------------------------------------------------
// GET /api/diff?source=working|git
// ---------------------------------------------------------------------------

const getDiff = http.get("*/api/diff", () => {
  const plan: PlanItem[] = [
    {
      op: "update",
      entity: "service:bevox-backend",
      change: "image v7 → v8",
      impact: "rolling restart, 2 replicas",
    },
    {
      op: "create",
      entity: "volume:pg-data-2",
      change: "criar 50Gi",
      impact: "attach: server:bevox-db-1",
    },
    {
      op: "drift",
      entity: "server:bevox-x-9",
      change: "DRIFT — não está no manifesto",
      impact: "não destruído (fail-safe)",
    },
  ];
  return HttpResponse.json(plan);
});

// ---------------------------------------------------------------------------
// GET /api/events?actor=&entity=&result=
// ---------------------------------------------------------------------------

const getEvents = http.get("*/api/events", ({ request }) => {
  const url = new URL(request.url);
  const actor = url.searchParams.get("actor") ?? "";
  const entity = url.searchParams.get("entity") ?? "";
  const result = url.searchParams.get("result") ?? "";

  let filtered = events;
  // Exact-match only; real API (Fase 4) may implement substring/case-insensitive matching.
  if (actor) filtered = filtered.filter((e) => e.actor === actor);
  if (entity) filtered = filtered.filter((e) => e.entity === entity);
  if (result) filtered = filtered.filter((e) => e.result === result);

  return HttpResponse.json(filtered);
});

// ---------------------------------------------------------------------------
// GET /api/health
// ---------------------------------------------------------------------------

const getHealth = http.get("*/api/health", () => {
  return HttpResponse.json({
    circuit_breakers: [
      { name: "HetznerCloud", state: "closed" },
      { name: "Docker", state: "closed" },
      {
        name: "DNS",
        state: "open",
        failures: 3,
        max_failures: 5,
        last_failure: "2026-05-17T13:55:00Z",
      },
    ],
    degraded: [
      {
        entity: "service:bevox-backend",
        detail: "1/2 réplicas up · replica.2 restarting",
      },
      {
        entity: "server:bevox-db-1",
        detail: "1/2 health checks passing · disk 89%",
      },
    ],
    blocked: [
      {
        entity: "volume:pg-data-2",
        reason: "dep server:bevox-x-9 em drift — bloqueado até resolução",
      },
    ],
    drift: [
      {
        entity: "server:bevox-x-9",
        detail: "existe na Hetzner mas não está no manifesto (drift). Reportado, não destruído (fail-safe).",
      },
    ],
    reconciler: {
      state: "idle",
      last_cycle: "2026-05-17T14:02:00Z",
      last_result: "ok",
      next_cycle_in: "~5m",
      total_cycles: 1247,
    },
  });
});

// ---------------------------------------------------------------------------
// GET /api/approvals
// ---------------------------------------------------------------------------

const getApprovals = http.get("*/api/approvals", () => {
  return HttpResponse.json(approvals.filter((a) => a.status === "pending"));
});

// ---------------------------------------------------------------------------
// GET /api/secrets
//
// Returns only reference metadata: name, key count, and which services use each
// secret. No secret values are ever returned — values are resolved by the
// reconciler at apply time and are never transmitted to the Console.
// ---------------------------------------------------------------------------

const getSecrets = http.get("*/api/secrets", () => {
  return HttpResponse.json(fixtureSecrets);
});

// ---------------------------------------------------------------------------
// GET /api/backups — enriched backup entries (policy + last_run + snapshots)
// ---------------------------------------------------------------------------

const getBackups = http.get("*/api/backups", () => {
  return HttpResponse.json(backupEntries);
});

// ---------------------------------------------------------------------------
// POST /api/servers — provision_server
// ---------------------------------------------------------------------------

const postServers = http.post("*/api/servers", async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>;

  if (body.name === "__force_error__") {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "invalid_input",
        message: "forced error for testing",
        retryable: false,
        entity: `server:__force_error__`,
      },
    };
    return HttpResponse.json(envelope, { status: 422 });
  }

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "create",
          entity: `server:${body.name ?? "new-server"}`,
          change: `type=${body.type ?? "cx32"} location=${body.location ?? "nbg1"}`,
          impact: "nova instância Hetzner",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // dry_run:false → pending_approval (destructive / costly)
  const approvalId = newApprovalId();
  approvals.push({
    id: approvalId,
    action: "provision",
    entity: `server:${body.name ?? "new-server"}`,
    actor: (body.actor as string) ?? "console",
    requested_at: new Date().toISOString(),
    ttl_remaining: "24h",
    impact: "cria novo servidor Hetzner",
    status: "pending",
  });
  const envelope: WriteEnvelope = {
    status: "pending_approval",
    approval_id: approvalId,
  };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/services — deploy_service
// ---------------------------------------------------------------------------

const postServices = http.post("*/api/services", async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>;

  if (body.name === "__force_error__") {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "conflict",
        message: "forced error for testing",
        retryable: false,
        entity: `service:__force_error__`,
      },
    };
    return HttpResponse.json(envelope, { status: 422 });
  }

  if (isDryRun(body)) {
    const existing = services.find((s) => s.name === body.name);
    const change = existing
      ? `image ${existing.image.split(":")[1] ?? "?"}→${(body.image as string)?.split(":")[1] ?? "?"}`
      : "deploy new service";
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: existing ? "update" : "create",
          entity: `service:${body.name ?? "new-service"}`,
          change,
          impact: `rolling restart, ${body.replicas ?? 1} replicas`,
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // non-destructive upsert: applied directly
  const idx = services.findIndex((s) => s.name === body.name);
  if (idx >= 0) {
    services[idx] = { ...services[idx], ...(body as Record<string, unknown>) } as typeof services[0];
  }
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/services/:name/scale — scale_service
// ---------------------------------------------------------------------------

const postScaleService = http.post("*/api/services/:name/scale", async ({ params, request }) => {
  const body = (await request.json()) as Record<string, unknown>;
  const name = params.name as string;

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "scale",
          entity: `service:${name}`,
          change: `replicas → ${body.replicas ?? "?"}`,
          impact: "rolling scale",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  const idx = services.findIndex((s) => s.name === name);
  if (idx >= 0 && body.replicas !== undefined) {
    services[idx] = { ...services[idx], replicas: body.replicas as number };
  }
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/dns — set_dns (non-destructive upsert, no approval needed)
// ---------------------------------------------------------------------------

const postDns = http.post("*/api/dns", async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>;

  if (body.name === "__force_error__") {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "provider_error",
        message: "DNS circuit breaker open",
        retryable: true,
        entity: `dns:${body.zone ?? "?"}/${body.name}`,
      },
    };
    return HttpResponse.json(envelope, { status: 503 });
  }

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "upsert",
          entity: `dns:${body.zone ?? "?"}/${body.name ?? "?"}`,
          change: `${body.type ?? "A"} → ${body.value ?? "?"}`,
          impact: "DNS upsert, sem approval",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // dry_run:false → applied directly (set_dns is non-destructive)
  const record = {
    zone: body.zone as string,
    name: body.name as string,
    type: body.type as string,
    value: body.value as string,
    ttl: (body.ttl as number) ?? 300,
  };
  const idx = dnsRecords.findIndex((r) => r.zone === record.zone && r.name === record.name);
  if (idx >= 0) {
    dnsRecords[idx] = record;
  } else {
    dnsRecords.push(record);
  }
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/backups/:target/snapshot — snapshot (non-destructive)
// ---------------------------------------------------------------------------

const postSnapshot = http.post("*/api/backups/:target/snapshot", async ({ params, request }) => {
  const body = (await request.json()) as Record<string, unknown>;
  const target = params.target as string;

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "snapshot",
          entity: `volume:${target}`,
          change: "snapshot imediato",
          impact: "cria novo snapshot restic",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // non-destructive: applied
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/backups/:target/restore — restore (destructive → pending_approval)
// ---------------------------------------------------------------------------

const postRestore = http.post("*/api/backups/:target/restore", async ({ params, request }) => {
  const body = (await request.json()) as Record<string, unknown>;
  const target = params.target as string;

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "restore",
          entity: `volume:${target}`,
          change: `restore ← ${body.snapshot ?? "latest"}`,
          impact: "sobrescreve estado atual do volume — potencial perda de dados",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // destructive → pending_approval
  const approvalId = newApprovalId();
  approvals.push({
    id: approvalId,
    action: "restore",
    entity: `volume:${target}`,
    actor: (body.actor as string) ?? "console",
    requested_at: new Date().toISOString(),
    ttl_remaining: "24h",
    impact: `restore sobrescreve volume:${target} com snapshot ${body.snapshot ?? "latest"}`,
    status: "pending",
  });
  const envelope: WriteEnvelope = {
    status: "pending_approval",
    approval_id: approvalId,
  };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/destroy — destroy (destructive → pending_approval; drift: fail-safe)
// ---------------------------------------------------------------------------

const postDestroy = http.post("*/api/destroy", async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>;
  const entity = body.entity as string | undefined;

  // Structured error trigger for Task 5 client tests and Task 8 screen tests.
  // Matches both the raw "__force_error__" (client test) and "<kind>:__force_error__" (screen test).
  const isForceError =
    entity === "__force_error__" ||
    (typeof entity === "string" && entity.endsWith(":__force_error__"));
  if (isForceError) {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "conflict",
        message: "drift detected: cannot destroy drift resource",
        retryable: false,
        entity: entity ?? "__force_error__",
      },
    };
    return HttpResponse.json(envelope, { status: 422 });
  }

  // fail-safe: drift resource is NEVER destroyed
  const isDriftResource = entity === `server:${DRIFT_SERVER_NAME}`;

  if (isDryRun(body)) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: isDriftResource ? "drift" : "destroy",
          entity: entity ?? "unknown",
          change: isDriftResource
            ? "DRIFT — não está no manifesto · não destruído (fail-safe)"
            : "destroy entity",
          impact: isDriftResource ? "fail-safe: reportado, não destruído" : "remoção permanente",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // fail-safe: drift resource destroy with dry_run:false still returns pending (not applied)
  // and does NOT mutate state
  if (isDriftResource) {
    const envelope: WriteEnvelope = {
      status: "planned",
      plan: [
        {
          op: "drift",
          entity: `server:${DRIFT_SERVER_NAME}`,
          change: "DRIFT — não destruído (fail-safe)",
          impact: "fail-safe: reportado, não destruído",
        },
      ],
    };
    return HttpResponse.json(envelope);
  }

  // Non-drift destructive → pending_approval
  const approvalId = newApprovalId();
  approvals.push({
    id: approvalId,
    action: "destroy",
    entity: entity ?? "unknown",
    actor: (body.actor as string) ?? "console",
    requested_at: new Date().toISOString(),
    ttl_remaining: "24h",
    impact: `destroy ${entity ?? "unknown"} — permanente`,
    status: "pending",
  });
  const envelope: WriteEnvelope = {
    status: "pending_approval",
    approval_id: approvalId,
  };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/apply — apply_manifest
// ---------------------------------------------------------------------------

const postApply = http.post("*/api/apply", async ({ request }) => {
  const body = (await request.json()) as Record<string, unknown>;

  // fail-safe: if manifest targets drift resource, do NOT destroy it
  if (isDryRun(body)) {
    const plan: PlanItem[] = [
      {
        op: "update",
        entity: "service:bevox-backend",
        change: "image v7 → v8",
        impact: "rolling restart, 2 replicas",
      },
      {
        op: "create",
        entity: "volume:pg-data-2",
        change: "criar 50Gi",
        impact: "attach: server:bevox-db-1",
      },
      {
        op: "drift",
        entity: "server:bevox-x-9",
        change: "DRIFT — não destruído (fail-safe)",
        impact: "fail-safe: reportado, não destruído",
      },
    ];
    const envelope: WriteEnvelope = { status: "planned", plan };
    return HttpResponse.json(envelope);
  }

  // dry_run:false → pending_approval (apply is always gated)
  const approvalId = newApprovalId();
  approvals.push({
    id: approvalId,
    action: "apply_manifest",
    entity: "manifest:working",
    actor: (body.actor as string) ?? "console",
    requested_at: new Date().toISOString(),
    ttl_remaining: "24h",
    impact: "apply manifest — múltiplas mudanças",
    status: "pending",
  });
  const envelope: WriteEnvelope = {
    status: "pending_approval",
    approval_id: approvalId,
  };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/approvals/:id/approve
// ---------------------------------------------------------------------------

const postApprove = http.post("*/api/approvals/:id/approve", ({ params }) => {
  const id = params.id as string;
  const approval = approvals.find((a) => a.id === id);
  if (!approval) {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "not_found",
        message: `approval ${id} not found`,
        retryable: false,
        entity: `approval:${id}`,
      },
    };
    return HttpResponse.json(envelope, { status: 404 });
  }
  approval.status = "approved";
  events.push({
    ts: new Date().toISOString(),
    actor: "console",
    op: "approve",
    entity: approval.entity,
    result: "ok",
  });
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// POST /api/approvals/:id/reject
// ---------------------------------------------------------------------------

const postReject = http.post("*/api/approvals/:id/reject", ({ params }) => {
  const id = params.id as string;
  const approval = approvals.find((a) => a.id === id);
  if (!approval) {
    const envelope: WriteEnvelope = {
      status: "error",
      error: {
        code: "not_found",
        message: `approval ${id} not found`,
        retryable: false,
        entity: `approval:${id}`,
      },
    };
    return HttpResponse.json(envelope, { status: 404 });
  }
  approval.status = "rejected";
  events.push({
    ts: new Date().toISOString(),
    actor: "console",
    op: "reject",
    entity: approval.entity,
    result: "ok",
  });
  const envelope: WriteEnvelope = { status: "applied" };
  return HttpResponse.json(envelope);
});

// ---------------------------------------------------------------------------
// Exported handlers array
// ---------------------------------------------------------------------------

export const handlers = [
  getState,
  getDiff,
  getEvents,
  getHealth,
  getApprovals,
  getSecrets,
  getBackups,
  postServers,
  postServices,
  postScaleService,
  postDns,
  postSnapshot,
  postRestore,
  postDestroy,
  postApply,
  postApprove,
  postReject,
];
