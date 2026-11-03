# bevox-hetzner-mcp — `apply_manifest` approval policy (bug #9 design discussion)

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27) — owner escolheu **Opção C** em §6. Spec implementadora: [2026-05-27-strict-manifest-approval-knob.md](./2026-05-27-strict-manifest-approval-knob.md).
- **Autor:** Bernard (bug-report #9 do `bevox-meta-api` + investigação Claude session)
- **Tipo:** Spec-filha **de discussão** — NÃO autoriza implementação. Quando owner decidir entre as opções, **nova spec implementadora** será escrita com `Status: Aceita`.
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN — define `TOOL_POLICY` map + Approval Gate semantics).
- **Spec irmãs (contexto recente):**
  - [2026-05-26-apply-manifest-silo-fanout.md](./2026-05-26-apply-manifest-silo-fanout.md) (PR #14)
  - [2026-05-27-reconcile-envelope-failure-surface.md](./2026-05-27-reconcile-envelope-failure-surface.md) (PR #15)
  - [2026-05-27-hetzner-cloud-wire-translation.md](./2026-05-27-hetzner-cloud-wire-translation.md) (PR #16)
  - [2026-05-27-set-firewall-synchronous-apply.md](./2026-05-27-set-firewall-synchronous-apply.md) (PR #23)

## 0. Resumo executivo

Consumer `bevox-meta-api` reportou: `apply_manifest` cria server (€4/mês) **sem** disparar approval gate, mesmo que `provision_server` (tool dedicada equivalente) tem policy `"always"` → sempre gateia. Consumer alega bug.

**Esta spec verifica que o comportamento atual É by-design por v1 FROZEN.** Mudar exige decisão owner sobre policy semantics. Três opções (A/B/C) — recomendação na §5.

## 1. Reprodução live (consumer)

```
apply_manifest({
  manifest: {
    networks: [bevox-prod],
    servers: [{...meta-api-prod-1, type:cax11, ...}]
  },
  dry_run: false
})
→ HTTP 200 { "status": "applied" }
list_approvals → []
curl /v1/servers → meta-api-prod-1 ID 133406347 RUNNING, €3.79/mês ativo
```

Comparativo: `provision_server({...same server...}, dry_run:false)` retornaria `{status:"pending_approval", approval_id:"apr_..."}` e nada materializaria até `approve(approval_id)`.

## 2. Análise — comportamento atual é design v1 (FATO)

Verificável no código (FROZEN spec-mãe):

### 2.1 `defaultSensitiveOps` set é mínimo

`core/src/agent/approval-gate.ts:119-128`:
```ts
export const defaultSensitiveOps: ReadonlySet<PlanOp> = new Set<PlanOp>([
  "destroy",
  "remove",
  "restore",
]);
export function defaultIsSensitive(item: PlanItem): boolean {
  return defaultSensitiveOps.has(item.op);
}
```

`create` NÃO está em `defaultSensitiveOps`.

### 2.2 `apply_manifest` policy é "conditional"

`core/src/agent/tools.ts:144`:
```ts
apply_manifest: "conditional",
```

Conditional → usa `defaultIsSensitive`. Per item: `create` → não sensitive → não withhold.

### 2.3 `provision_server` é "always"

`core/src/agent/tools.ts:137`:
```ts
provision_server: "always",
```

Always → função custom retorna sempre `true` → todo item withhold → sempre pending_approval.

### 2.4 Esta divergência é intencional

`apply_manifest` foi desenhada como **bulk declarative** (declara intent inteira; operador revisa o manifesto inteiro antes; gate só pra ops genuinamente destrutivas). `provision_server` foi desenhada como **one-shot imperative** (cada chamada um billable provision; gate pra cada).

V1 spec-mãe `2026-05-17` ratificou ambas policies. Mudança é **revisão de invariante** (CLAUDE.md: "v1 spec ... FROZEN — mudanças invariantes exigem nova revisão de spec").

## 3. A tensão (argumentos de cada lado)

| Argumento consumer (security) | Argumento v1 spec (design) |
|---|---|
| Criar server cobra €4/mês — mutação significativa, deveria gate. | `create` ≠ "destrutivo"; default sensitivity reservado pra destroy/remove/restore. |
| Agent malicioso pode `apply_manifest` 100 servers sem aprovação humana. | Approval per item via `apply_manifest` muda contract; rompe tests/consumers existentes; UX da Vox/console fica overwhelmed por approvals em lote. |
| `provision_server` (`always`) e `apply_manifest` (`conditional`) inconsistentes. | Diferentes tools, diferentes policies — intencional. Bulk declarative vs one-shot imperative. |
| Defense in depth: dois canais (gate per-call + gate per-manifesto). | YAGNI: approval reservado pra "destrutivo" em sentido estrito. Bulk approval é responsibility de quem submete manifest. |
| Capability-token escoping (limitar tools por agent) cobre só parte. | Capability-token JÁ resolve: agente sem `provision_server` cap não pode standalone-create; com `apply_manifest` cap pode bulk; estrutura está consistente. |

Ambos válidos. V1 endossou o lado direito. Owner decide se justifica revisão.

## 4. Três opções

### 4.1 Opção A — Aceitar comportamento atual ("by design / wontfix")

- Documenta em `CLAUDE.md` que `apply_manifest` não gateia creates by design.
- Fecha bug #9 como `wontfix` no consumer trail.
- Security need é endereçado fora do MCP:
  - Vox UI human-in-the-loop antes de invocar `apply_manifest`.
  - Audit log review (`state_events` registra cada apply, `actor` rastreável).
  - Capability-token scoping limita quais agentes podem chamar `apply_manifest`.

**Custo:** zero código. Texto novo em CLAUDE.md / FAQ.
**Risco:** consumer percebe como inconsistência; pressão recorrente a cada vez que novo consumer ler o código.
**Quem deve preferir:** owner que vê valor na separação atomic-vs-bulk e confia capability-token + Vox UI como gates suficientes.

### 4.2 Opção B — Spec revision: per-entity-kind TOOL_POLICY lookup

`apply_manifest` consulta TOOL_POLICY[<tool-equivalente-para-kind>] per plan item:

| op + entity-kind | tool equivalente | policy | sensitive? |
|---|---|---|---|
| `create server:*` | `provision_server` | `always` | sim |
| `destroy server:*` | `destroy` | `always` | sim |
| `create service:*` | `deploy_service` | `conditional` | usa default → não |
| `create network:*` | (não há tool dedicada) | n/a | fallback default → não |
| `update service:*` | `scale_service` | `conditional` | usa default → não |
| `create dns:*` | `set_dns` | `none` | nunca |

**Custo:** ~30 LOC (custom `isSensitive` em `doApplyManifest` antes de `reconcileToEnvelope`), nova spec implementadora, ~5 tests existentes podem precisar update (incluindo `apply-manifest-silo-fanout.bug5.test.ts` que assume `applied`).

**Risco:** mudança de contract pública.
- Consumers existentes que dependem de `applied` direto **quebram**.
- Approval surface ganha N items per manifesto grande → Vox UI dev precisa lidar com batches.
- Tests `["applied","pending_approval"]` permissive ainda passam (covers both); tests strict `"applied"` precisam atualizar.

**Necessidade:** nova spec **implementadora** (`Status: Aceita`), plan, TDD via subagent.

### 4.3 Opção C — Config knob `STRICT_MANIFEST_APPROVAL=on` (default `off`)

Adicionar env var:
```ts
STRICT_MANIFEST_APPROVAL: z.enum(["on", "off"]).default("off")
```

- Default `off` → comportamento atual (`defaultIsSensitive`). Backward-compat full.
- `on` → `apply_manifest` usa logic da Opção B (per-entity-kind lookup).

**Custo:** ~25 LOC config (mirror do `MANAGED_MESH` knob) + ~30 LOC dispatch + ~10 tests. Spec revision **não-breaking**.

**Risco:** menor:
- Opt-in. Consumers default-off zero break.
- Owner habilita via `.env` quando souber que infra (Vox UI) + audit pipeline + UX comportam "muitos pending_approvals" pattern.
- Reversível por flip + restart.

**Padrão já estabelecido:** análogo a `MANAGED_MESH=off` (PR #11) e `MANAGED_SERVICES=off` (PR #13). Owner-knob, default backward-compat.

**Necessidade:** nova spec implementadora + spec curta de v1 invariant clarification ("knob expande policy; default preserva FROZEN").

## 5. Recomendação (esta sessão Claude + consumer reasoning)

**Opção C.**

Razões:

1. **Preserva v1 FROZEN sem revisão de invariante.** Default-off não toca behavior. Adicionar config knob não viola FROZEN — não muda existing invariant, adiciona opt-in.
2. **Atende consumer's need** quando opt-in. Operador alinhado com policy mais estrita liga; outros mantêm v1.
3. **Padrão já estabelecido no projeto.** `MANAGED_MESH`, `MANAGED_SERVICES`, `BUG5_PROBE` durante debug — owner-knob é o vocabulário familiar.
4. **Reversível e auditável.** `.env` flag + boot warn estruturado = audit trail explícito.
5. **Owner mantém última palavra** sobre quando ligar — não muda o equilíbrio de poder agent vs human-in-the-loop. Pode revisitar default em v2 sem quebrar v1.

Owner pode discordar e escolher A ou B. Spec implementadora seguirá a escolha.

## 6. Decisão owner

```
[ ] A — Aceitar atual; fechar bug #9 como wontfix; documentar em CLAUDE.md.
[ ] B — Spec revision; per-entity-kind policy; mudança de contract.
[X] C — Config knob STRICT_MANIFEST_APPROVAL (default off, opt-in). ⭐ Escolhido pelo owner em 2026-05-27.
[ ] Outro:
```

Implementação detalhada na spec-filha: `2026-05-27-strict-manifest-approval-knob.md` (Aceita).

## 7. Como prosseguir após decisão

1. Owner marca opção em §6.
2. Esta spec é re-status'd: `Aceita` + escolha registrada (ou `Rejected → wontfix` se opção A).
3. Se B ou C: nova spec implementadora (`docs/specs/2026-05-27-apply-manifest-approval-{B,C}-impl.md`) + plan + subagent execution.
4. Se A: PR de documentação atualizando `CLAUDE.md` §"Não-objetivos" pra esclarecer intent design.

## 8. Out of scope

- Não muda `set_firewall` / `set_dns` / outros tools (bug #9 é specifically about `apply_manifest`).
- Não introduz approval-batching UX (se 100 servers, 100 pendings; Vox UI / future spec aborda agrupamento).
- Não muda `defaultIsSensitive` global (continua destroy/remove/restore).
- Não toca v2 contract (separate Bloco A scope).
- Não muda capability-token scoping.

## 9. Inputs verificados

- `core/src/agent/approval-gate.ts:119-128` — `defaultSensitiveOps` + `defaultIsSensitive`.
- `core/src/agent/tools.ts:137-148` — TOOL_POLICY (12 v1 tools).
- `core/src/agent/tools.ts:594-625` — `doApplyManifest` apply path.
- `core/src/agent/tools.ts:329-385` — `reconcileToEnvelope` (where `isSensitive` is threaded).
- `docs/specs/2026-05-26-apply-manifest-silo-fanout.md` §4 — apply mechanics (PR #14).
- `docs/specs/2026-05-26-server-scope-transport-decoupling.md` §3 — MANAGED_MESH knob pattern.
- `docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md` §3 — MANAGED_SERVICES knob (newer reference).
- CLAUDE.md "Stack" §Managed mesh toggle / Managed services toggle — knob documentation pattern.
