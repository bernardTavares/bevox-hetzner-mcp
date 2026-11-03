# Console REST Contract — v2 (additive)

**Fronteira de integração v2 — o core DEVE implementar este contrato.
v2 é puramente ADITIVO sobre v1 (`CONTRACT.md` / `src/api/contract.ts`); os
endpoints `/api/*` v1 permanecem inalterados.**

Schemas em `src/api/contract-v2.ts` (Zod) são a fonte canônica executável;
este documento é a descrição legível. Schemas v1 reaproveitados (status,
ApiError) NÃO são duplicados — `contract-v2.ts` importa-os de
`./contract.ts`.

---

## Tool → REST Endpoint Table (writes)

Todos os endpoints abaixo retornam `WriteEnvelopeV2` (ver §"Write Envelope v2").

| Agent Tool         | REST Endpoint                       | Method | Approval                                 |
|--------------------|-------------------------------------|--------|------------------------------------------|
| `resolve_selector` | `/api/v2/selectors/resolve`         | POST   | no (read-shaped write)                    |
| `set_firewall`     | `/api/v2/firewalls`                 | POST   | conditional (Approval Gate decides)       |
| `set_primary_ip`   | `/api/v2/primary-ips`               | POST   | yes (cost-bearing)                        |
| `set_certificate`  | `/api/v2/certificates`              | POST   | managed: no · uploaded: yes               |
| `set_load_balancer`| `/api/v2/load-balancers`            | POST   | yes (cost-bearing)                        |
| `set_ingress`      | `/api/v2/ingresses`                 | POST   | conditional                                |
| `expose_service`   | `/api/v2/expose`                    | POST   | one bundled approval covering the whole exposure |

## Listing endpoints (reads)

> Endpoint paths and envelope shape are frozen here; per-entity schemas land in F1–F5 as noted in the rightmost column.

| Endpoint                          | Returns                | Entity schema lands in |
|-----------------------------------|------------------------|------------------------|
| `GET /api/v2/firewalls`           | `FirewallSchema[]`     | F1.1                   |
| `GET /api/v2/load-balancers`      | `LoadBalancerSchema[]` | F2.1                   |
| `GET /api/v2/certificates`        | `CertificateSchema[]`  | F3.1                   |
| `GET /api/v2/primary-ips`         | `PrimaryIPSchema[]`    | F4.1                   |
| `GET /api/v2/ingresses`           | `IngressSchema[]`      | F5.1                   |

As entity schemas (`FirewallSchema`, `LoadBalancerSchema`, …) são definidas
por fase nos seus próprios ficheiros — `contract-v2.ts` define apenas o
envelope, não as entidades.

---

## Status Enum (shared with v1)

Reutiliza `WriteEnvelopeStatusEnum` de v1:

```
"planned" | "pending_approval" | "applied" | "error"
```

---

## Write Envelope v2

Cada endpoint mutador `POST /api/v2/*` devolve um `WriteEnvelopeV2`.

> `plan` is an object in v2 (`{ ops, cost_estimate, policy_violations }`); v1 used a bare `PlanItem[]`. This is the intentional decoupling that lets cost/policy travel with the plan rather than as new envelope siblings.


```ts
{
  status:      "planned" | "pending_approval" | "applied" | "error";
  plan?:       PlanV2;       // presente quando status === "planned"
  approval_id?: string;      // presente quando status === "pending_approval"
  error?:      ApiError;     // presente quando status === "error"
}

PlanV2: {
  ops:               unknown[];          // op array — shape per-Bloco (F1..F6)
  cost_estimate:     CostEstimate;       // SEMPRE presente
  policy_violations: PolicyViolation[];  // SEMPRE presente (pode ser [])
}

CostEstimate: {
  monthly_delta_eur: number;             // delta líquido EUR/mês
  breakdown:         CostBreakdownItem[];// por-recurso (pode ser [])
}

// ApiError reutiliza ErrorSchema de v1.
```

### Invariante v2 — `cost_estimate` e `policy_violations` SEMPRE presentes

Toda `PlanV2` carrega as duas estruturas, independentemente do Bloco emissor:

- **Bloco A** (esta fase) sempre emite os neutros:
  `cost_estimate = { monthly_delta_eur: 0, breakdown: [] }` e
  `policy_violations = []`.
- **Bloco C** ativa `policy_violations` com verdicts reais.
- **Bloco D** ativa `cost_estimate` com deltas reais.

Como o *shape* na wire é invariável, consumidores nunca ramificam por
Bloco. A presença é validada pelo schema; a vacuidade NÃO é — `[]` e
`monthly_delta_eur: 0` são respostas válidas e habituais.

---

## Example: `set_primary_ip` (Bloco A — neutral cost/policy)

```json
// POST /api/v2/primary-ips — output (dry_run-equivalent: status "planned")
{
  "status": "planned",
  "plan": {
    "ops": [
      { "op": "create", "entity": "primary_ip:edge-1", "change": "allocate v4", "impact": "billable" }
    ],
    "cost_estimate":     { "monthly_delta_eur": 0, "breakdown": [] },
    "policy_violations": []
  }
}
```

Em Bloco D o mesmo plano passaria a emitir, por exemplo,
`{ "monthly_delta_eur": 4.20, "breakdown": [{ "kind": "primary_ip", "eur": 4.20 }] }`;
o *shape* da resposta não muda.

---

## Lifecycle (idêntico a v1)

1. Cliente envia write (opcional `dry_run: true`).
2. Core devolve `{ status: "planned", plan: { ops, cost_estimate, policy_violations } }`.
3. Se a ação exige aprovação, core devolve `{ status: "pending_approval", approval_id: "apr_<id>" }`.
4. Console aguarda aprovação via `POST /api/approvals/:id/approve` (v1).
5. Core aplica e devolve `{ status: "applied" }`.
6. Em erro, `{ status: "error", error: { code, message, retryable, entity } }`.

---

## Design constraints (herdados de v1)

- Console nunca fala com Hetzner/Docker diretamente.
- Console nunca contorna o Approval Gate (v1 endpoints `/api/approvals/*`
  servem v2 também).
- Drift é reportado (v1 `GET /api/diff`); v2 não introduz auto-correção.
- `StateEvent.actor` identifica sempre o agente originador.
