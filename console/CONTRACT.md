# Console REST Contract

**Fronteira de integração — o core (Fase 4) DEVE implementar este contrato.
O Console consome SÓ esta API REST.**

Todas as entidades e envelopes estão definidos como schemas Zod em
`src/api/contract.ts`, que é a fonte canônica de tipos. Este documento é a
descrição legível; `contract.ts` é a verdade executável.

---

## Tool → REST Endpoint Table

| Agent Tool        | REST Endpoint                                         | Method |
|-------------------|-------------------------------------------------------|--------|
| `get_state`       | `/api/state`                                          | GET    |
| `diff`            | `/api/diff?source=working\|git`                       | GET    |
| `events`          | `/api/events?actor=&entity=&result=`                  | GET    |
| `health`          | `/api/health`                                         | GET    |
| `provision_server`| `/api/servers`                                        | POST   |
| `deploy_service`  | `/api/services`                                       | POST   |
| `scale_service`   | `/api/services/:name/scale`                           | POST   |
| `set_dns`         | `/api/dns`                                            | POST   |
| `snapshot`        | `/api/backups/:target/snapshot`                       | POST   |
| `restore`         | `/api/backups/:target/restore`                        | POST   |
| `destroy`         | `/api/destroy`                                        | POST   |
| `apply_manifest`  | `/api/apply`                                          | POST   |
| *(approvals)*     | `/api/approvals`                                      | GET    |
| *(approvals)*     | `/api/approvals/:id/approve`                          | POST   |
| *(approvals)*     | `/api/approvals/:id/reject`                           | POST   |

---

## Status Enum (shared)

Used by entities that expose a lifecycle status:

```
"pending" | "applying" | "healthy" | "degraded" | "drift" | "error"
```

---

## Canonical Entities

All entities are validated by the Zod schemas in `src/api/contract.ts`.

| Entity        | Key Fields |
|---------------|------------|
| `Server`      | `name`, `type`, `location`, `image`, `ssh_keys[]`, `labels{}`, `network`, `status` (required) |
| `Network`     | `name`, `ip_range`, `subnets[]` |
| `Volume`      | `name`, `size` (e.g. `"50Gi"`), `server?`, `fs`, `status?` |
| `Service`     | `name`, `image`, `replicas`, `env?{}`, `ports?[]`, `volumes?[]`, `server_selector?{}`, `status?` |
| `DnsRecord`   | `zone`, `name`, `type` (A/CNAME/…), `value`, `ttl` |
| `BackupPolicy`| `target` (e.g. `"volume:pg-data"`), `schedule` (cron), `retention` (e.g. `"14d"`), `repo` |
| `StateEvent`  | `ts` (ISO), `actor` (agent id), `op`, `entity`, `before?`, `after?`, `result` |

---

## Write Envelope

Every mutating endpoint (`POST /api/*`) returns a `WriteEnvelope`:

```ts
{
  status: "planned" | "pending_approval" | "applied" | "error";
  plan?:        PlanItem[];   // present when status === "planned"
  approval_id?: string;       // present when status === "pending_approval"
  error?:       ApiError;     // present when status === "error"
}

PlanItem: { op: PlanOp; entity: string; change: string; impact: string }
// PlanOp (enum): "create" | "add" | "update" | "scale" | "drift" | "remove" | "destroy" | "noop" | "upsert" | "snapshot" | "restore"
ApiError: { code: string; message: string; retryable: boolean; entity: string }
```

Lifecycle:

1. Client sends a write request (optionally with `dry_run: true`).
2. Core returns `{ status: "planned", plan: [...] }` for dry-run or when
   approval is not yet needed.
3. If the action requires approval, core returns
   `{ status: "pending_approval", approval_id: "apr_<id>" }`.
4. Console polls `GET /api/approvals` or waits for a human to approve via
   `POST /api/approvals/:id/approve`.
5. Core applies and returns `{ status: "applied" }`.
6. On error, core returns `{ status: "error", error: { code, message, retryable, entity } }`.

---

## Example: `deploy_service` with `dry_run: true`

```json
// POST /api/services — input
{
  "name": "bevox-harness",
  "image": "registry/bevox-harness:v12",
  "replicas": 2,
  "dry_run": true
}

// output (dry_run — status "planned", no mutation)
{
  "status": "planned",
  "plan": [
    {
      "op": "update",
      "entity": "service:bevox-harness",
      "change": "image v11→v12",
      "impact": "rolling restart, 2 replicas"
    }
  ],
  "next": "call again with dry_run:false to apply"
}
```

> **Note:** the `next` field above is advisory/informational only and is NOT part of `WriteEnvelopeSchema` — Zod strips unknown keys by default; clients must not depend on it being validated.

---

## Error Response Example

```json
{
  "status": "error",
  "error": {
    "code": "conflict",
    "message": "drift detected: server bevox-app-1 has unexpected state",
    "retryable": false,
    "entity": "server:bevox-app-1"
  }
}
```

---

## Design Constraints

- The Console never talks to Hetzner or Docker directly.
- The Console never bypasses the Approval Gate.
- All reads are idempotent (`GET`). All writes go through the envelope.
- Drift is reported by `GET /api/diff`; the Console never silently corrects it.
- `StateEvent.actor` always identifies the originating agent.
