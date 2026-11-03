# bevox-hetzner-mcp — `reconcileToEnvelope` failure surface + logger threading

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (investigação live do bug #5 + brainstorm com Claude)
- **Tipo:** Spec-filha (cirúrgica, aditiva, corretiva) — bug fix
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN — v1 §"Agent Interface" define `WriteEnvelope`)
- **Spec irmã:** [2026-05-26-apply-manifest-silo-fanout.md](./2026-05-26-apply-manifest-silo-fanout.md) (PR #14 — durante o debug expôs o bug que esta spec resolve)

## 0. Escopo e relação com as outras specs

Spec **aditiva, cirúrgica, corretiva**: muda `reconcileToEnvelope`
(`core/src/agent/tools.ts:329-386`) para que falhas reportadas por
`applyPlan` sejam **propagadas** como `WriteEnvelope { status: "error" }`
ao invés de mascaradas como `{ status: "applied" }`. Adicionalmente,
thread o `logger` injetado em `ToolDeps` até o `reconcile()` factory,
restaurando visibilidade do journal estruturado no caminho on-demand
(tools REST/MCP) — hoje só o periodic reconciler em `server.ts` recebe
logger; o catálogo silencia-o por omissão.

Não toca v1/v2 invariantes; não altera schemas, API pública, wire
contract, nem o shape do `WriteEnvelope` (a alternativa `status:"error"`
já existe — só não estava sendo construída neste código-path).

Esta spec é **PR-A** de uma sequência. **PR-B** (fora de escopo aqui)
endereça a tradução `HetznerCloud` declarative→wire body que produziu o
HTTP 400 que detonou a investigação. Sem o PR-A, o PR-B não tem como
ser observado em produção via envelope.

## 1. Contexto

### 1.1 Sintoma observado

Durante o smoke-test do PR #14 (`apply_manifest` silo fan-out), o
consumer `bevox-meta-api` chamou `POST /api/apply` com
`{networks:[{name:"bug5-diag", ip_range:"10.50.0.0/16"}], dry_run:false}`.
A resposta foi `{"status":"applied"}` — mas nada materializou na conta
Hetzner.

A investigação live, com `RECONCILE_DEBUG=1` + tail no daemon, revelou:

- `state_events` (Postgres): 5 rows `op=create entity=network:bug5-diag
  result=error` (1 audit do apply tool + 4 ticks do periodic, todos
  reincidentes — coerente com idempotência: nenhuma material foi
  modificada, cada ciclo retenta).
- `observed_state`: 0 rows novas. A network nunca existiu na Hetzner.
- Envelope retornado pelo tool: `{"status":"applied"}` — **incoerente**
  com o que `state_events` registrava.

A causa-raiz é o último return de `reconcileToEnvelope`:

```ts
// core/src/agent/tools.ts:329-386 (atual)
if (result.withheld.length > 0) {
  // ... return pendingApproval(...)
}
return applied(); // ← retorna applied INDEPENDENTE de result.failed.length
```

`applyPlan` (`core/src/reconciler/apply.ts:107-113`) reporta o resultado
em quatro buckets disjuntos: `applied`, `failed`, `skipped`, `drift`. O
catálogo só consulta `withheld`; `failed` (e `skipped`) caem no chão e
o envelope final mente "applied" mesmo quando o apply foi 100% failed.

### 1.2 Por que a investigação demorou 7h

`reconcileToEnvelope` constrói `reconcile()` SEM passar `logger` aos
deps:

```ts
// core/src/agent/tools.ts:346-352 (atual)
const run = reconcile({
  pool,
  provider,
  gate,
  observedAdapter,
  loadDesired,
  // ← logger ausente
});
```

`reconcile()` (`core/src/reconciler/reconcile.ts:305`) faz fallback
silencioso: `const logger: Logger = deps.logger ?? noopLogger`. Todos os
`logger.info("reconcile cycle complete", …)` e
`logger.info("reconcile apply item", …)` viram no-ops no caminho
on-demand (apply via tool). Só o periodic em `server.ts:463-472`
(que passa `logger: logger`) chega ao journal — daí o paradoxo do
debug: `journalctl` mostrava ticks periódicos com erro, mas a chamada
do tool aparecia completamente muda.

### 1.3 Evidência empírica (live, 2026-05-27 12:06)

| Sinal | Valor observado | Esperado pelo contrato |
|---|---|---|
| `state_events.result` (5 rows) | `error` | `error` ✓ |
| `observed_state` rows da network | 0 | 0 (apply falhou) ✓ |
| Envelope retornado (`POST /api/apply`) | `{"status":"applied"}` | `{"status":"error", error:{code, message, entity}}` ✗ |
| `journalctl` para `reconcile apply item` (apply path) | silêncio | linha estruturada ✗ |
| `journalctl` para `reconcile apply item` (periodic) | linha presente | linha presente ✓ |

A discrepância entre `state_events` e envelope é exatamente o problema
que esta spec resolve. A discrepância de visibilidade do journal é o
problema correlato que esta spec também resolve (Mudança 2).

## 2. Goals

- `reconcileToEnvelope` retorna `WriteEnvelope { status: "error" }`
  quando `applyPlan` reporta ≥1 `FailedItem` e nenhum item foi withheld
  pelo gate.
- Approval precedence preservada: `withheld.length > 0` continua
  retornando `pending_approval` mesmo se houver `failed > 0` no mesmo
  ciclo (sensitive items aguardam decisão estrutural antes de o
  operador avaliar transients).
- Backwards-compat: `failed === 0 && withheld === 0` continua retornando
  `applied()` byte-idêntico ao hoje.
- O `logger` injetado em `ToolDeps` é threaded até `reconcile({logger})`
  — `reconcile cycle complete` / `reconcile apply item` voltam a
  emitir no caminho on-demand (tool catalog), não só no periodic.
- Suite existente (897/898) continua verde sem modificação. Property
  tests intactos.

## 3. Non-goals (YAGNI)

- **Não** alterar o enum `WriteEnvelope.status` — continua
  `planned | pending_approval | applied | error`. A spec usa a quarta
  variante (já especificada em v1) — não introduz nada novo na wire.
- **Não** modificar `applyPlan` nem o `reconcile()` factory — só o
  consumer em `tools.ts:reconcileToEnvelope`.
- **Não** propagar `skipped` ou `drift` ao envelope. `skipped` indica
  dependent-of-failed (já implícito no `failed`); `drift` é canal
  separado por design (fail-safe — drift reportado, nunca corrigido,
  surfaceado via `get_state` / drift reports, não pelo envelope de
  apply). Esta spec **preserva** essa separação.
- **Não** mudar shape de `state_events.after` — audit trail continua
  registrando `error`/`ok` results como hoje, separado do envelope.
- **Não** introduzir nova config-knob. Mudança é incondicional: hoje é
  bug, amanhã é correto. Nenhum modo legado a preservar.
- **Não** tocar HetznerCloud declarative→wire body translation
  (bug-correlato 5a). PR-B subsequente; fora desta entrega.
- **Não** introduzir logger seam novo no `composite-provider` — esse já
  ficou registrado como follow-up cosmético em PR #13. Esta spec só
  resolve o seam que **já existe** (`ToolDeps.logger` → `reconcile`).

## 4. Design

### 4.1 Mudança 1 — `reconcileToEnvelope` propaga `failed` como `error`

Após o `await run({scope, actor})`, a precedência de mapeamento passa a
ser explícita:

| Bucket reportado | Envelope retornado |
|---|---|
| `withheld.length > 0` | `pending_approval(id)` (sem mudança) |
| `withheld.length === 0 && failed.length > 0` | `error(reconcileError)` (NOVO) |
| `withheld.length === 0 && failed.length === 0` | `applied()` (sem mudança) |

**Approval precede failure** intencionalmente: se um item foi withheld
pelo gate (decisão estrutural — operador precisa aprovar), o operador
deve resolver isso primeiro; falhas transients podem ter sido
consequência de o ciclo ter feito apply parcial pré-withheld, e o
operador avalia o conjunto no Approval Center antes de ver o erro.
Este é o mesmo posture do v1 (gating é sempre prioritário sobre
reporting).

**Pseudocódigo (não vinculante — plano detalha):**

```ts
const result = await run({ scope, actor });

if (result.withheld.length > 0) {
  // ... existing pendingApproval logic, with requested.entity matching ...
}

if (result.failed.length > 0) {
  // Pick the first FailedItem; if the caller pinned an entity, prefer it.
  const picked: FailedItem =
    requested !== undefined
      ? result.failed.find((f) => f.entity === requested.entity)
        ?? result.failed[0]!
      : result.failed[0]!;
  return error(
    new ReconcileError(picked.errorClass, picked.message, {
      entity: picked.entity,
    }),
  );
}

return applied();
```

**Notas de mapeamento:**

- `FailedItem.errorClass` (definido em `core/src/reconciler/apply.ts:80-85`)
  é o `ErrorClass` canônico (`transient | precondition | conflict |
  fatal | partial`) — mapeável 1:1 para o primeiro arg de
  `ReconcileError`.
- `FailedItem.message` herda do `err.message` lançado pelo provider; a
  redação real (no provider/HTTP client) é o mesmo canal do audit
  trail existente (`state_events.after` já grava esses mesmos
  `message`s hoje). Esta spec **não introduz novo canal de leak** —
  reusa o que já está auditado e value-free por construção (cf. §5
  invariante 4).
- `error()` builder (`core/src/agent/envelope.ts:87-91`) converte
  `ReconcileError` → `ApiError` via `toApiError()` que **drop intencional**
  `cause`/`stack` — sem secret leakage.

**Pinning de `requested.entity`:** quando o tool é per-entity
(`provision_server`, `deploy_service`, …) e o caller pinou
`requested.entity`, a spec prefere o `FailedItem` cujo `entity` casa;
fallback é o primeiro. Tools que NÃO pinam (`apply_manifest`, periodic
sweep) caem direto no primeiro — coerente com o pattern já estabelecido
em `pendingApprovals` (`tools.ts:363-370`).

**Por que só o primeiro, não todos?** O `WriteEnvelope.error` é
**singular** (`ApiError`, não `ApiError[]`) — alterar pra plural exige
mudança de schema/oracle/contract.ts (fora deste escopo cirúrgico). O
caller que precisa do detalhe completo lê `state_events` via tool
`events`, que **já carrega** todos os `failed` items 1:1. O envelope
sinaliza "deu erro neste apply"; o detalhe completo vive no audit
trail.

**`applied` parcial fica aplicado.** A spec preserva o fail-safe:
quando `failed > 0` mas `applied > 0` também (apply parcial), o
envelope é `error` (sinaliza ao caller "este apply NÃO convergiu
totalmente") — mas nada do que foi aplicado é destruído ou revertido.
Os items aplicados permanecem em `observed_state`; o próximo
reconcile (on-demand ou periodic) é idempotente e completa o resto.
Recovery = re-call do tool. (Invariante 3, abaixo.)

### 4.2 Mudança 2 — `logger` threading em `reconcileToEnvelope`

`ToolDeps` ganha um campo opcional `logger?: Logger`. Quando presente,
`reconcileToEnvelope` passa-o explicitamente a `reconcile({…, logger})`.

```ts
// ToolDeps (interface), additive
export interface ToolDeps {
  // ... existing fields ...
  /**
   * Optional structured logger threaded to the reconcile() factory in
   * reconcileToEnvelope. When omitted, reconcile falls back to the
   * existing noopLogger — backwards-compat with every existing test
   * (which constructs ToolDeps without `logger`).
   */
  readonly logger?: Logger;
}
```

E o factory:

```ts
// reconcileToEnvelope (pseudocode, additive line)
const run = reconcile({
  pool,
  provider,
  gate,
  observedAdapter,
  loadDesired,
  ...(deps.logger ? { logger: deps.logger } : {}),
});
```

**`server.ts:399-411` wiring** passa o logger injetado (já presente no
escopo de `createServer` — usado pelo periodic em `server.ts:469`):

```ts
const catalog = createToolCatalog({
  pool,
  provider,
  observedAdapter,
  loadDesired,
  writeDesired,
  makeGate: (isSensitive) => createApprovalGate({...}),
  logger, // ← NEW
});
```

**Trade-off considerado:**

- ✅ Restaura visibilidade do journal no caminho on-demand. `reconcile
  cycle complete` / `reconcile apply item` agora aparecem em
  `journalctl` para apply via REST/MCP, não só periodic — o que teria
  cortado as 7h de debug do bug #5 para minutos.
- ✅ Nenhuma mudança de comportamento — só emissão de log.
- ✅ Backwards-compat dos testes: `logger` é opcional em `ToolDeps`;
  testes que constroem `createToolCatalog({…})` sem logger continuam
  silenciosos (mesmo comportamento de hoje — `reconcile` cai no
  `noopLogger`).

### 4.3 Forma do envelope `error`

Inalterada. Reusa builder `error()` (`core/src/agent/envelope.ts:87`):

```jsonc
{
  "status": "error",
  "error": {
    "code": "transient",          // ← FailedItem.errorClass
    "message": "POST /v1/networks failed with HTTP 400",  // ← FailedItem.message
    "retryable": true,            // ← derived from errorClass (cf. ReconcileError.retryable)
    "entity": "network:bug5-diag" // ← FailedItem.entity
  }
}
```

A conformância contract (`console/src/api/contract.ts WriteEnvelopeSchema`)
permanece intacta — `status:"error"` já estava no enum congelado;
nenhum campo novo é introduzido.

## 5. Invariantes preservados

| # | Invariante (de CONTRIBUTING.md §"Ground rules") | Como esta spec preserva |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | Surface de failures **não altera** apply/destroy. Re-call do tool após erro é idempotente (apply.ts garante: items aplicados ficam aplicados, items failed são retentados). Property tests em `core/src/reconciler/idempotency*.property.test.ts` inalterados. |
| 3 | Fail-safe, never fail-deleting | Envelope `error` é **reporte**, não ação. `reconcile.ts` não passa a deletar/rollback; items aplicados em apply parcial permanecem aplicados (apply.ts §"NOTHING was rolled back"). Nenhum delete-path introduzido. |
| 4 | Secrets at apply only | `FailedItem.message` herdado do `err.message` provider; mesmo posture do `state_events.after` existente (que já grava esses messages). HTTP client (`core/src/http/http-client.ts`) já trim sensitive — sem canal novo de leak. Sentinels-test em `core/src/reconciler/secret-apply.test.ts` cobre o caminho. |
| 5 | StateEvent actor | Inalterado. `reconcileToEnvelope` continua passando `actor` ao `reconcile`, que continua escrevendo `StateEvent` com `actor` non-anônimo via `ApplyContext`. |

## 6. Test strategy

| Camada | Teste | O que cobre |
|---|---|---|
| Unit (`core/src/agent/tools.test.ts`) | Novo describe `reconcileToEnvelope failure surfacing`. Fake provider cuja `apply()` `throws` num `ReconcileError("transient", "boom", {entity:"network:x"})`. `apply_manifest` (ou `provision_server`) ⇒ envelope `{status:"error", error:{code:"transient", entity:"network:x", message:"boom"}}`. | §4.1 happy-path failure surfacing. |
| Unit (`tools.test.ts`) | Fake apply onde `FailedItem` é `errorClass:"precondition"`. Envelope traz `code:"precondition"`, `retryable:false`. | Mapping completo de `ErrorClass` → `ApiError.code` (existing `toApiError` lógica). |
| Unit (`tools.test.ts`) | Cenário com `withheld > 0` E `failed > 0` simultâneo. Envelope ⇒ `pending_approval` (approval precede failure). | §4.1 approval precedence. |
| Unit (`tools.test.ts`) | Backwards-compat: cenário existing sem failures ⇒ `applied()` byte-idêntico ao snapshot atual. | Regressão. |
| Unit (`tools.test.ts`) | Pinning: tool per-entity com `requested.entity = "server:foo"`, `failed = [server:foo, server:bar]`. Envelope traz `entity:"server:foo"`. Fallback (sem pinning, ex. `apply_manifest`): primeiro do array. | §4.1 picked entity. |
| Unit (`tools.test.ts` ou seam test) | `createToolCatalog({…, logger: spyLogger})` + apply path ⇒ `spyLogger.info` chamado com `"reconcile cycle complete"` (e per-item). Quando `logger` omitido, `noopLogger` (sem chamadas) — backwards-compat. | §4.2 logger threading. |
| Unit (existing) | Toda a suite existente em `tools.test.ts`, `rest.test.ts`, `mcp.test.ts`, `promote-manifest.test.ts`, etc. continua verde sem modificação. | Regressão geral. |
| Property (existentes) | `idempotency*.property.test.ts`. **Sem alteração / sem enfraquecimento.** | Garantia central. |
| Live (`@live`) | Não obrigatório — mudança não envolve novo provider nem HTTP wire. | n/a |

Fakes-only (CONTRIBUTING §"Tests never touch real infra"): toda a
suite acima usa `core/test/fakes/` + `pg-harness`. Sem chamadas a
Hetzner/Docker real.

## 7. Migração / rollout

- **Backwards-compatible no wire** quando não há failures. Calls que
  retornavam `applied` continuam retornando `applied`.
- **Behavior change** quando há failures: calls que vinham retornando
  `applied` (incorretamente, mascarando o erro) passam a retornar
  `error`. Consumer `bevox-meta-api` é o caso primário esperado — eles
  já consomem `WriteEnvelope.status === "error"` em outros tools (set_*),
  então o consumo client-side já é compatível.
- **Sem schema migration.** `Map` in-process; nenhum row Postgres
  afetado. Audit trail (`state_events`) continua escrevendo `error`
  results como hoje — esta spec só corrige o envelope reportado, não o
  audit.
- **Sem nova config-knob.** Mudança incondicional — o comportamento
  atual é o bug; não há modo legado a preservar via flag.
- **Reversibilidade.** Trivial: revert do commit restaura o
  `applied()` cego. Não há schema, persistência ou contrato de wire que
  prenda. Mas o revert é desencorajado — restaura o bug.
- **Ordem de deploy.** Após merge, rebuild + `sudo systemctl restart
  bevox-daemon.service` é suficiente. O consumer `bevox-meta-api`
  passa a observar `status:"error"` em chamadas onde o provider
  Hetzner rejeita (o que destrava o diagnóstico do PR-B subsequente).

## 8. Open questions

- **Tipo de logger seam em `ToolDeps`.** O `Logger` interface usado em
  `reconcile.ts` é o mesmo importado em `server.ts` (`createPinoLogger`
  factory). Reuso direto. **Stakeholder:** plan-writer + owner;
  decisão técnica não invariante.
- **Comportamento de `skipped` items.** Esta spec **não** propaga
  `skipped` ao envelope (justificativa em §3). Se em algum momento o
  consumer reclamar de granularidade insuficiente — "vejo `error`
  para network:x mas tinha 3 servers `skipped` dependentes" —
  follow-up. **Stakeholder:** owner + `bevox-meta-api`.
  Não-bloqueante.
- **Drift surface.** Idem: `drift` continua canal separado, fora do
  envelope. Não muda nesta spec.

## 9. Critérios de aceite

1. Quando `applyPlan` reporta ≥1 `FailedItem` e `withheld.length === 0`:
   - `reconcileToEnvelope` retorna `WriteEnvelope { status: "error" }`.
   - `envelope.error.code` igual a `FailedItem.errorClass` (uma de
     `transient | precondition | conflict | fatal | partial`).
   - `envelope.error.message` igual a `FailedItem.message`.
   - `envelope.error.entity` igual a `FailedItem.entity`.
   - `envelope.error.retryable` derivado conforme `ReconcileError.retryable`.

2. Quando `failed.length === 0 && withheld.length === 0`:
   - Retorna `applied()` byte-idêntico ao comportamento atual
     (regressão das suítes existentes).

3. Quando `withheld.length > 0` (com ou sem `failed > 0`):
   - Retorna `pending_approval(approval_id)` exatamente como hoje
     (approval-precede-failure).

4. Quando o caller pina `requested.entity`:
   - Prefer `FailedItem` cujo `entity` casa; fallback é o primeiro
     `failed`. Coerente com pattern de `pendingApprovals`.

5. Quando `ToolDeps.logger` é fornecido:
   - `reconcileToEnvelope` passa `logger` ao `reconcile()` factory.
   - `logger.info("reconcile cycle complete", …)` e
     `logger.info("reconcile apply item", …)` emitem no apply path
     via tool (não só periodic).
   - `server.ts:399-411` passa o `logger` já injetado no escopo.

6. Quando `ToolDeps.logger` é omitido:
   - `reconcile()` cai no `noopLogger` (comportamento atual; todos os
     testes existentes que não passam logger continuam verdes).

7. `npm --prefix core test` permanece 100% verde (897/898; o 1 skipped
   é `@live`). Property tests existentes não enfraquecidos. Nenhum
   teste removido sem justificativa registrada.

8. Comentário inline em `reconcileToEnvelope` cita esta spec por path
   (`docs/specs/2026-05-27-reconcile-envelope-failure-surface.md`) e
   explica a precedência `withheld > failed > applied`.

## 10. Arquivos antecipados

(Lista informativa para o plan-writer — não vincula o plano.)

- `core/src/agent/tools.ts` — `reconcileToEnvelope` (§4.1 ~10-15 linhas)
  + `ToolDeps.logger` opcional (§4.2 ~1 campo).
- `core/src/server.ts` — `createToolCatalog({…, logger})` (§4.2 ~1 linha).
- `core/src/agent/tools.test.ts` — novo `describe` block (§6).
- `core/src/agent/promote-manifest.test.ts` / `rest.secrets.test.ts` /
  outros call sites de `createToolCatalog` em test harnesses —
  **não-obrigatório** alterar (logger é opcional; default é noop). O
  plano decide se vale a pena estender algum harness pra ter spy
  logger.

## 11. Relação com o plano e demais specs

- Esta spec **define o contrato**. Não vincula a ordem das fases do
  plano nem a granularidade dos commits TDD — isso é responsabilidade
  do `plan-writer`.
- Spec irmã PR #14 (`apply-manifest-silo-fanout`) é o caminho que
  destravou o bug — mas as duas mudanças são ortogonais. Esta spec
  resolveria o sintoma "envelope mente" mesmo sem PR #14; PR #14 era
  necessário para o consumer chegar a um cenário onde `applyPlan`
  rodava de verdade.
- **PR-B (HetznerCloud declarative→wire body translation)** é spec
  separada, ainda a redigir. Esta spec (PR-A) é prerequisito: sem o
  envelope corrigido, o PR-B não tem como ser observado em produção.
- Após aceita, próximo passo: `plan-writer` produz
  `docs/superpowers/plans/2026-05-27-reconcile-envelope-failure-surface.md`.
  Estimativa preliminar (não vinculante): F1 failure surfacing (3-4
  tasks TDD: failed→error, approval-precedence, pinning, backwards-compat),
  F2 logger threading (1-2 tasks: ToolDeps.logger opcional, server.ts
  wiring). ~4-6 commits.
