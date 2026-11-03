# bevox-hetzner-mcp — Manifest schema gaps (`services[]` additive fields)

- **Data:** 2026-05-28
- **Status:** Aceita (2026-05-28) · **Revisão 2026-05-28b** — Phase 1 implementada e verde; §1.5/§3 (Phase 2.0/2.1) corrigidas após a implementação revelar que o design original contradizia a arquitetura (ver §8 "Revisão 2026-05-28b").
- **Autor:** Bernard (brainstorm desta sessão Claude Code)
- **Tipo:** Spec-filha v2 (additive ao `ManifestServiceSchema`). NÃO altera v1 FROZEN nem o catálogo de tools.
- **Spec-mãe (v2 contract FROZEN):** [2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md). Esta spec realiza additives no shape do manifesto; ALL_TOOLS (12) e V2_TOOLS permanecem inalterados.
- **Motivação concreta:** [docs/manifest-schema-cheatsheet.md](../manifest-schema-cheatsheet.md) §"Gaps conhecidos" — 4 lacunas do manifesto declarativo expostas durante o go-live do bevox-harness: (1) sem `command`, (2) sem ordenação/espera entre services, (3) `env_from` declarado-mas-morto, (4) sem `restart` policy.
- **Invariantes v1/v2 preservadas:** ALL_TOOLS (12) FROZEN byte-identical; V2_TOOLS inalterado; fail-safe nunca fail-deleting (CONTRIBUTING §"Ground rules" #3); idempotência por design (#2) — campo omitido ⇒ body do container byte-idêntico ao atual; StateEvent actor mandatory (#5); secrets-resolution scope inalterado (#4).

## 0. Escopo

Quatro mudanças **aditivas** no `ManifestServiceSchema` (`core/src/domain/desired-state.ts`) e na sua propagação pelo `DockerProvider`, mais uma remoção de campo morto:

| # | Gap (cheatsheet) | Mudança | Phase |
|---|---|---|---|
| 1 | `command`/`cmd` ausente | **+ `services[].command: string[]`** → `Cmd` do Engine | 1 |
| 4 | `restart` policy ausente | **+ `services[].restart`** (enum) → `HostConfig.RestartPolicy` | 1 |
| 3 | `env_from` morto | **− `services[].env_from`** (removido do schema/fixtures/doc) | 1 |
| 2 | `depends_on` + healthcheck-wait | **+ `services[].depends_on`** — ordenação DAG (Phase 1); espera healthy (Phase 2.0); healthcheck declarativo (Phase 2.1) | 1 / 2.0 / 2.1 |

**Princípio transversal (idempotência):** todo campo novo é **opcional**. Campo omitido ⇒ o body que o provider monta é byte-idêntico ao atual ⇒ `isConverged()` não flapa em containers já existentes ⇒ nenhum re-create forçado no primeiro apply pós-upgrade. A comparação de convergência só observa um campo novo **quando ele é declarado**.

**Out-of-scope (§9):** `services[].entrypoint`; `restart` default não-vazio; depends_on cross-kind (já coberto pelo DAG existente network→server→volume→container); wait-for-healthy por sleep heurístico; backoff exponencial no reconciler; healthcheck declarativo na Phase 1 (fica 2.1); rotação/multi-host.

## 1. Design

### 1.1 Superfície de schema (`ManifestServiceSchema`)

Estado atual (`desired-state.ts:73-83`):

```ts
const ManifestServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  replicas: z.number().int().positive(),
  env_from: z.string().optional(),      // ← REMOVER (morto)
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
});
```

Estado-alvo:

```ts
const RestartPolicySchema = z.enum(["no", "on-failure", "always", "unless-stopped"]);

// Duration string: "<N>s" | "<N>m" (ex.: "120s", "2m"). Parseada para ms.
const DurationSchema = z.string().regex(/^\d+[sm]$/);

const DependsOnEntrySchema = z.union([
  z.string().min(1),                                    // forma curta: "postgres"
  z.object({
    name: z.string().min(1),
    wait_healthy_timeout: DurationSchema.optional(),    // default 120s (Phase 2.0)
  }),
]);

const ManifestServiceSchema = z.object({
  name: z.string().min(1),
  image: z.string().min(1),
  replicas: z.number().int().positive(),
  command: z.array(z.string()).optional(),              // ← NOVO (gap #1)
  restart: RestartPolicySchema.optional(),              // ← NOVO (gap #4)
  depends_on: z.array(DependsOnEntrySchema).optional(), // ← NOVO (gap #2)
  // healthcheck: HealthcheckSchema.optional(),         // ← Phase 2.1 (additive futuro)
  env: z.record(z.string()).optional(),
  ports: z.array(z.string()).optional(),
  volumes: z.array(z.string()).optional(),
  server_selector: z.record(z.unknown()).optional(),
});
```

Notas:

- O item schema **continua non-strict** (forward-compat — `desired-state.ts:27-31`). Por isso a remoção de `env_from` é graciosa: manifests legados que ainda o tragam têm o campo silenciosamente strippado, sem erro. Comportamento de runtime é idêntico (o campo já era ignorado).
- `depends_on` aceita forma curta (`"postgres"`) ou objeto (`{ name, wait_healthy_timeout }`). A normalização para `{ name, wait_healthy_timeout_ms }` acontece num helper puro.
- `wait_healthy_timeout` só tem efeito na Phase 2.0; na Phase 1 é parseado e validado, mas ignorado (ordenação não espera).

### 1.2 Propagação no `DockerProvider` (`createContainerBody`)

`docker.ts:createContainerBody` ganha duas injeções condicionais (só quando o campo é declarado):

```ts
// command → Cmd (gap #1)
if (svc.command !== undefined) body.Cmd = [...svc.command];

// restart → HostConfig.RestartPolicy (gap #4)
if (svc.restart !== undefined) {
  body.HostConfig = { ...(body.HostConfig ?? {}), RestartPolicy: { Name: svc.restart } };
}
```

`depends_on` **não** entra no body nem em `isConverged` — é hint de ordenação/espera, não shape de container. Na Phase 1 fica fora de `entities.ServiceSchema` (stripado antes do provider). Na Phase 2.0 passa a existir em `entities.ServiceSchema` para que `apply()` o enxergue e espere o health das deps — mas `createContainerBody`/`isConverged` seguem ignorando-o (ver §1.5).

### 1.3 Idempotência — `isConverged()` / `verify()`

`docker.ts` compara, no inspect do container, **apenas os campos que o create setou** (princípio documentado em `docker.ts:355+`). Estende-se a comparação:

| Campo desejado | Inspect comparado | Regra |
|---|---|---|
| `command` declarado | `Config.Cmd` | igualdade de array; difere ⇒ drift/re-create |
| `command` omitido | — | **não compara** (não flapa) |
| `restart` declarado | `HostConfig.RestartPolicy.Name` | igualdade de string; difere ⇒ drift |
| `restart` omitido | — | **não compara** (default do Engine permanece, sem flap) |

Isto garante a invariante transversal: **container existente sem os campos novos converge byte-idêntico**.

### 1.4 Ordenação DAG (Phase 1) — `topoSortServices`

Helper **puro** (sem I/O), chamado pelo `DockerProvider` antes de iterar os services no apply:

```ts
// core/src/providers/docker-depends-on.ts (novo arquivo, <600 linhas)
export function topoSortServices(services: ManifestService[]): ManifestService[]
```

- Ordena por DAG `depends_on`: cada dep aparece **antes** do dependente.
- **Ciclo** (`a→b→a`) ⇒ `ReconcileError("precondition")` citando o ciclo, **antes de qualquer mutação** (fail-safe).
- **Ref a service inexistente** ⇒ `ReconcileError("precondition")` citando o nome ausente.
- Empate (sem dependência entre dois) preserva ordem de declaração no manifesto (estável/determinístico).
- DAG cross-kind existente (network→server→volume→container, `plan.test.ts`) **inalterado** — esta é ordenação intra-kind `service`.

`depends_on` é desired-state ordering, não propriedade observável do container ⇒ **não entra em `isConverged`** e não gera drift por si só.

### 1.5 Wait-for-healthy (Phase 2.0) — **revisado 2026-05-28b**

> **Por que revisado.** O design original dizia "`apply()` emite StateEvent com
> actor do `ApplyContext`". A implementação da Phase 1 revelou que isso
> contradiz a arquitetura: (a) `ApplyContext` (`store/secrets.ts`) é só um brand
> token de secret — **não carrega actor**; (b) o contrato `Provider` é
> `apply() → ApplyResult { entity, op, changed }` — **providers não emitem
> StateEvents**; só o passo Record do reconciler escreve via `appendEvent`
> (`reconcile.ts:478`), com o `actor` da chamada `reconcile({ actor })`;
> (c) `depends_on` é **stripado antes do provider** (Phase 1 decidiu mantê-lo
> fora de `entities.ServiceSchema`), então `apply()` não enxerga as deps. O
> mecanismo abaixo corrige os três pontos com mudanças **aditivas**.

**Quem espera, onde.** O `DockerProvider.apply(dependente)` é o gate: antes de
criar os containers do dependente, ele espera o health das suas deps. Para isso
`apply()` precisa enxergar `depends_on` — portanto:

- **`entities.ServiceSchema` ganha `depends_on`** (Phase 2.0) para sobreviver ao
  `ServiceSchema.safeParse(action.desired)` (`docker.ts:204`). `createContainerBody`
  e `isConverged` **continuam ignorando** `depends_on` (não é shape de
  container). Atualiza-se o comentário "intentionally NOT here" da Phase 1.

**Fonte do health.** `State.Health.Status` do Engine (container inspect). O
provider já localiza as réplicas de um service por label (`replicasOf`/`listManaged`).

**Seam de espera (puro, injetável).** `waitForHealthy(depName, timeoutMs, { call, now, sleep })`
em `docker.ts` (ou módulo co-locado se passar do soft-limit ~600 linhas).
Inspeciona as réplicas da dep; retorna um dos outcomes:

- `{ outcome: "healthy" }` — todas as réplicas `State.Health.Status === "healthy"`.
- `{ outcome: "wait_skipped", reason: "no_healthcheck", dep }` — `State.Health`
  ausente na dep (imagem sem HEALTHCHECK).
- `{ outcome: "timeout", dep, status, waited_ms }` — budget esgotado no clock injetado.

`now`/`sleep` injetados ⇒ testes nunca esperam wall-clock; fake dirige as
transições de health deterministicamente.

**Timeout.** `wait_healthy_timeout` por-dep, **default 120s** (postgres cold-init
em volume novo pode levar 30-45s).

**Emissão de StateEvent (corrigida).** O provider **não** emite eventos.
`ApplyResult` ganha um campo aditivo opcional:

```ts
// provider.ts (aditivo, backward-compat)
interface ApplyResult {
  readonly entity: string;
  readonly op: PlanOp;
  readonly changed: boolean;
  readonly events?: ReadonlyArray<{ op: string; after?: Record<string, unknown> }>;
}
```

O passo Record do reconciler, **com o `actor`+`scope` do ciclo**, persiste cada
`events[]` via `appendEvent` (estendido para repassar `after` — o
`StateEventSchema` já tem o campo). Assim o actor mandatory (ground rule #5) vem
da fonte canônica, não de um `ApplyContext` que não o tem.

**Comportamento por outcome:**

- **`healthy`** → cria/inicia o dependente normalmente.
- **`wait_skipped` (degraded-skip)** → o provider emite (via `ApplyResult.events`)
  `{ op: "service.wait_skipped", after: { reason: "no_healthcheck", dep } }` e
  **prossegue** criando o dependente (degrada para ordering-only da Phase 1).
  Não se pune o apply por imagem upstream sem HEALTHCHECK (`postgres:16-alpine`/
  `redis:7-alpine` não trazem). Também log `warn` (Pino).
- **`timeout` (abort fail-safe)** → o provider **NÃO cria** os containers do
  dependente, retorna `changed:false` e emite
  `{ op: "service.dep_health_timeout", after: { dep, status, waited_ms } }`.
  **Nada é criado nem deletado** (fail-safe, ground rule #3); o reconciler
  converge no ciclo seguinte (cadência ~60s, **sem backoff**). Abortar via
  retorno (não `throw`) mantém o evento no canal único `events[]` e evita
  colidir com o op genérico (`create`) do caminho de falha do reconciler.

`service.wait_skipped` (warn, esperado) e `service.dep_health_timeout` (requer
ação) são `op`s distintos para agregação em painel sem parse de mensagem livre.

> **Nota sobre o op do timeout.** A revisão troca `apply.precondition_failed`
> (do design original) por `service.dep_health_timeout`. Motivo: o abort é por
> **retorno** (não exceção), então não passa pelo caminho `report.failed`
> (que grava `result:"error"` com o `op` do PlanAction). Um `op` dedicado é
> mais limpo e agregável. `StateEventSchema.op` é `z.string()` (enum aberto) —
> nenhum dos dois exige migração de Postgres.

### 1.6 Healthcheck declarativo (Phase 2.1 — additive, sem breaking)

Resolve o atrito do "imagem sem HEALTHCHECK": em vez de exigir rebuild da imagem, o operador declara healthcheck no manifesto.

```ts
const HealthcheckSchema = z.object({
  test: z.array(z.string()).min(1),       // ex.: ["CMD", "pg_isready", "-U", "bevox"]
  interval: DurationSchema.optional(),
  timeout: DurationSchema.optional(),
  retries: z.number().int().positive().optional(),
  start_period: DurationSchema.optional(),
});
// + services[].healthcheck: HealthcheckSchema.optional()
```

- Injetado em `ContainerCreate.Healthcheck` (compose-style, mapeamento 1:1).
- **Precedência:** se a imagem TEM HEALTHCHECK **e** o manifesto declara `healthcheck:`, o manifesto vence (sobrescreve via Engine — padrão compose).
- Quem já tem HEALTHCHECK na imagem e não declara `healthcheck:` continua igual.
- Entra em `isConverged` só quando declarado (mesma regra transversal de §1.3).

## 2. Faseamento (→ plano)

| Phase | Conteúdo | Critério de ship |
|---|---|---|
| **Phase 1** | `command` + `restart` + remoção de `env_from` + `depends_on` **ordering-only** | Desbloqueia o go-live; mergeable cedo |
| **Phase 2.0** | wait-for-healthy via HEALTHCHECK da imagem (State.Health.Status, timeout 120s, degraded-skip, abort fail-safe) | Espera real entre deps |
| **Phase 2.1** | `services[].healthcheck` declarativo | Remove atrito de imagens upstream sem HEALTHCHECK |

Cada phase é additive e independentemente mergeable; Phase 2.x não bloqueia Phase 1.

## 3. StateEvents (novos `op`) — **revisado 2026-05-28b**

`StateEventSchema.op` é `z.string()` (enum aberto) — nenhuma migração de coluna. Novos valores:

| `op` | Quando | `after` payload |
|---|---|---|
| `service.wait_skipped` | dep sem HEALTHCHECK na Phase 2.0 | `{ reason: "no_healthcheck", dep }` |
| `service.dep_health_timeout` | timeout de health da dep (abort fail-safe) | `{ dep, status, waited_ms }` |

**Canal de emissão (corrigido).** O provider **não** emite StateEvents nem tem
acesso ao actor. Ele surfa os outcomes via `ApplyResult.events?[]` (campo
aditivo opcional, §1.5); o passo Record do reconciler persiste cada um via
`appendEvent`, carregando o **`actor` + `scope` do ciclo** (`reconcile({ actor })`)
e o `after` (o `StateEventSchema` já tem `after`; o helper `record()` em
`reconcile.ts` é estendido para repassá-lo). Assim o actor mandatory
(ground rule #5) vem da fonte canônica — **não** do `ApplyContext`, que é só um
brand token de secret e não carrega actor. Nenhum valor de secret aparece em
payload (apenas nomes de service e status de health).

## 4. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| Schema unit | `core/src/domain/desired-state.test.ts` (EXTEND) | `command` array; `restart` enum (rejeita valor fora do enum); `depends_on` forma curta + objeto; duration regex; **`env_from` removido** (não mais asserido como preservado); ciclo e dangling-dep rejeitados como precondition |
| `topoSortServices` | `core/src/providers/docker-depends-on.test.ts` (NEW) | ordem correta; estabilidade em empate; ciclo → precondition; dangling-dep → precondition |
| `createContainerBody` | `core/src/providers/docker.test.ts` (EXTEND) | `Cmd` presente sse `command` declarado; `RestartPolicy.Name` presente sse `restart` declarado; ambos omitidos ⇒ body byte-idêntico ao atual |
| `isConverged`/`verify` | `core/src/providers/docker.test.ts` (EXTEND) | omitido ⇒ no-flap em container existente; declarado e divergente ⇒ drift |
| Property idempotency | `core/src/reconciler/idempotency*.property.test.ts` (EXTEND) | manifestos com os campos novos: apply N× converge; ciclo 2..N = no-op (zero mutating actions) |
| `ApplyResult.events` + Record | `core/src/providers/provider.test.ts` (se houver) + `core/src/reconciler/reconcile*.test.ts` (EXTEND) | `ApplyResult.events[]` é repassado pelo Record do reconciler com `actor`+`scope`+`after`; conformanceHarness inalterado (campo opcional) |
| wait-for-healthy (2.0) | `core/src/providers/docker-wait-healthy.test.ts` (NEW) | healthy antes do timeout ⇒ prossegue; timeout ⇒ abort (retorno `changed:false`) + `ApplyResult.events` com `service.dep_health_timeout` + **nada criado nem deletado**; sem HEALTHCHECK ⇒ `service.wait_skipped` + prossegue; `entities.ServiceSchema` com `depends_on` mas body/isConverged ignoram. Contra `docker-http` fake |
| healthcheck (2.1) | `docker.test.ts` (EXTEND) | `ContainerCreate.Healthcheck` mapeado; manifesto sobrescreve imagem |
| Secret sentinel | `core/src/reconciler/secret-apply.test.ts` | UNCHANGED — nenhum campo novo toca o path de secret |
| Live `@live` | `core/test/live/*.live.test.ts` | opcional pré-release; excluído do `npm test` |

Fakes: `docker-http.ts` (estende com `State.Health` no inspect para os testes de wait); `ssh-exec.ts` reutilizado.

## 5. Acceptance criteria

- [ ] `npm --prefix core run typecheck` limpo.
- [ ] `npm --prefix core test` — suíte cheia verde (1 `@live` skipped).
- [ ] ALL_TOOLS (12) e V2_TOOLS inalterados (esta spec não mexe no catálogo).
- [ ] `manifest-ok.yaml` e `desired-state.test.ts` não referenciam mais `env_from`.
- [ ] `docs/manifest-schema-cheatsheet.md` atualizado: gaps #1/#3/#4 marcados resolvidos (Phase 1), #2 com status por phase; tabelas de `services[]` ganham `command`/`restart`/`depends_on`.
- [ ] Property test de idempotência cobre os campos novos.
- [ ] Nenhuma sentinela `S3CR3T-*` fora dos arquivos allowlisted.
- [ ] `CHANGELOG.md` entrada minor sob `[Unreleased]`.

## 6. Decisões registradas (sumário)

| Decisão | Escolha | Razão |
|---|---|---|
| `command` scope | só `command`, sem `entrypoint` | YAGNI; imagens já definem entrypoint correto |
| `restart` default | omitido (sem RestartPolicy) | preserva convergência byte-idêntica; sem re-create forçado |
| `env_from` | **remover** (não implementar) | campo morto; pattern correto é `env: { K: "secret:<ref>" }` per-key; remoção graciosa via non-strict |
| `depends_on` Phase 1 | ordenação DAG pura | determinístico, não toca idempotência, zero polling |
| wait-for-healthy fonte | `State.Health.Status` do Engine | fonte canônica; não inventa protocolo |
| timeout default | 120s, override por-dep | postgres cold-init em volume novo |
| imagem sem HEALTHCHECK | degraded-skip + StateEvent | não pune apply por imagem upstream; degrada pra ordering-only |
| timeout estourado | abort fail-safe (retorno, não throw) + StateEvent; converge next cycle | ground rule #3; sem backoff |
| **(rev b)** emissão de StateEvent do wait | via `ApplyResult.events[]` → Record do reconciler | provider não emite eventos nem tem actor; canal aditivo opcional |
| **(rev b)** actor do evento | do ciclo `reconcile({ actor })` | `ApplyContext` é brand de secret, não carrega actor |
| **(rev b)** `depends_on` no provider | em `entities.ServiceSchema` na Phase 2.0; body/isConverged ignoram | `apply()` precisa enxergar deps para esperar |
| **(rev b)** op do timeout | `service.dep_health_timeout` (não `apply.precondition_failed`) | abort por retorno não passa pelo caminho `report.failed` |
| healthcheck declarativo | Phase 2.1 additive | maioria das imagens upstream não tem HEALTHCHECK; rebuild é atrito |

## 7. Non-goals (YAGNI)

`services[].entrypoint`; `restart` default não-vazio; wait baseado em sleep heurístico; backoff exponencial no reconciler; depends_on cross-kind; healthcheck na Phase 1; multi-host scheduling (Bloco B); rotação de secrets.

## 8. Revisão 2026-05-28b — correção arquitetural da Phase 2.0/2.1

**Contexto.** A Phase 1 foi implementada TDD e está verde (full suite 1138
passed). Ao preparar a Phase 2.0, a implementação revelou que o design original
de §1.5/§3 contradizia a arquitetura real do core. Esta revisão corrige a spec
**antes** de qualquer código de Phase 2.0 (nenhuma linha de 2.0 foi escrita).

**Contradições encontradas (verificadas no código):**

1. **`ApplyContext` não carrega actor.** É `{ [APPLY_BRAND]: true }`
   (`store/secrets.ts:119`) — só a capability de resolução de secret. O design
   original dizia "actor do `ApplyContext`"; impossível.
2. **Providers não emitem StateEvents.** Contrato `Provider.apply() → ApplyResult
   { entity, op, changed }` (`provider.ts:107`). StateEvents são escritos só pelo
   Record do reconciler (`appendEvent`, `reconcile.ts:478`) com o `actor` do
   ciclo. O design original dizia "`apply()` emite StateEvent".
3. **`depends_on` é stripado antes do provider.** Decisão da Phase 1 (fora de
   `entities.ServiceSchema`); mas `apply()` precisa enxergá-lo para esperar as
   deps.
4. **Eventos de apply-item não têm `after` hoje.** O `record()` em `reconcile.ts`
   passa só `{ actor, scope, op, entity, result }` — sem `after`.

**Correções (todas aditivas, sem quebrar v1/v2 FROZEN):**

- `ApplyResult` ganha `events?: ReadonlyArray<{ op; after? }>` (opcional →
  conformanceHarness inalterado).
- Record do reconciler repassa cada `events[]` via `appendEvent` com
  `actor`+`scope`+`after` (helper `record()` estendido para `after`).
- `entities.ServiceSchema` ganha `depends_on` na Phase 2.0; `createContainerBody`
  e `isConverged` seguem ignorando-o.
- Timeout aborta por **retorno** (`changed:false` + evento `service.dep_health_timeout`),
  não por `throw` — fail-safe (nada criado/deletado), evento no canal único.
- Op do timeout: `service.dep_health_timeout` (substitui `apply.precondition_failed`).

**Próximo passo:** re-planejar Phase 2.0/2.1 (`/new-plan` ou atualização do plano
existente) a partir desta §1.5/§3 revisadas. As tasks 2.0.1–2.1.3 do plano atual
(`docs/superpowers/plans/2026-05-28-manifest-schema-gaps.md`) precisam ser
reescritas para o canal `ApplyResult.events` + `entities.ServiceSchema.depends_on`.
