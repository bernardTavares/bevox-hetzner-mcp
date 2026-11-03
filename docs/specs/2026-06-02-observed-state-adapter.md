# bevox-hetzner-mcp — Observed-state adapter (get_state/diff reflect reality)

- **Data:** 2026-06-02
- **Status:** Aceita (2026-06-02) — §7 confirmado pelo operador: Q1 objeto único `{ key, payload }`; Q2 módulo em `core/src/reconciler/observed-adapter.ts`; Q3 degrade-safe = PULAR a entidade inválida (nunca throw); Q4 dedup do union = primeiro-vence; Q5 divergência de volume só REPORTADA como drift em Part 1 (SoT decidida na Part 2); Q6 stub-fallback de `server.ts` permanece test-only.
- **Autor:** Bernard (design audit do deploy real, 2026-06-01) + Claude Code
- **Tipo:** Bug-fix (visibilidade do observed-state — `get_state`/`diff` estruturalmente vazios) + aditivo (enriquece o contrato de `observe()`). **NÃO altera invariantes FROZEN v1 (`2026-05-17`) / v2 (`2026-05-20`); visa NÃO mudar o contrato de wire do console** (`contract.ts`/`contract-v2.ts`).
- **Motivação concreta:** Num cluster 100% live (1× cpx22, 9 containers, tunnel up, `api.example.com` → 200), `GET /api/state` retorna tudo vazio (`{"servers":[],"networks":[],…}`) e `GET /api/diff` propõe `create` para CADA entidade — mesmo com `GET /api/health` mostrando o reconciler rodando (292 ciclos, "2 applied, 0 failed"). **Causa-raiz (verificada no source):** o `observedAdapter` de produção é um STUB NÃO-IMPLEMENTADO. `core/src/server.ts:420-429` cai num `State` constante-vazio quando `deps.observedAdapter` é `undefined`, e `core/src/entrypoint-wiring.ts` (`buildBootDeps`) NUNCA o seta. O passo Observe do reconciler DE FATO roda um probe de realidade todo ciclo — `HetznerCloudProvider.observe()` → `listAll(collection)` lista TODOS os servers/networks/volumes (`core/src/providers/hetzner-cloud.ts:189-196`); `DockerProvider.observe()` → `listManaged()` com `all=true` lista TODOS os containers `bevox.managed` (`core/src/providers/docker.ts:750-759`) — mas o `ObservedSlice` carrega SÓ os NOMES das entidades (`{ scope, entities: readonly string[] }`, `core/src/providers/provider.ts:131-134`), e o stub descarta até esses. Logo `reconcile.ts:388-411` persiste `putObservedState(scope, EMPTY)` todo ciclo ⇒ `get_state` é estruturalmente sempre `[]`. `reconcile.ts:189-196` documenta o gap: "the concrete provider→State adapter is a later task; the seam is injectable". O diff "create-tudo" é alarmante mas INERTE: `plan(desired, observed=EMPTY)` ⇒ "create"; o `apply` do provider faz observe-before-create (`findByName`) ⇒ o recurso já existe ⇒ noop (`changed:false`) — daí 292 ciclos, 0 failed, zero duplicação.
- **Invariantes preservadas:** fail-safe nunca fail-deleting (#3 — observed mais fiel passa a mostrar drift REAL, mas o caminho de observe/adapter NÃO adiciona nenhuma chamada delete/destroy/remove e não pode dirigir uma); secrets resolvidos só em apply (#4 — o observed persistido carrega só `secret:<ref>`, nunca valor resolvido); idempotência por design (#2 — adapter puro; re-observar realidade inalterada produz `State` byte-idêntico ⇒ ciclo 2 estrito no-op); specs-first (#1 — esta spec, sem novo write-site de `StateEvent`); StateEvent actor (#5 — inalterado, o actor do ciclo não muda).

## 0. Escopo

Esta spec implementa **Part 1 apenas** (travado com o operador): o `observedAdapter` provider→State deferido, para que `get_state`/`diff` reflitam a realidade. O fix é **observe-only, não-destrutivo, idempotente**. Duas peças coordenadas: (1) enriquecer o contrato de `observe()` e (2) implementar o adapter puro e cabeá-lo.

| Dentro do escopo (Part 1) | Fora do escopo (Part 2 — spec futura separada) |
|---|---|
| Enriquecer `ObservedSlice` para carregar o objeto tipado por entidade (`core/src/providers/provider.ts`) | Durabilidade do desired-state (follow-up #70) — `promote_manifest` segue in-process/não-durável |
| Implementar o adapter puro `(slice: ObservedSlice) => State`, validando cada payload via os schemas Zod de `core/src/domain/entities.ts` | Qualquer caminho `import_state`/adopt que SEMEIE desired a partir da realidade ou do YAML do manifesto |
| Migrar os providers que implementam `observe()` (HetznerCloud, Docker, e os providers v2 se observarem) para emitir slices enriquecidos | Migração de source-of-truth de volume (manifesto declara volumes Hetzner; realidade usa Docker named volumes) — Part 1 **não escolhe vencedor** e **não migra nada** |
| Unir slices enriquecidos no `composite-provider` observe (dedup por key) | Limpeza/correção de qualquer drift descoberto (fail-safe: reportado, nunca corrigido) |
| Cabear o adapter REAL em `buildBootDeps` (`entrypoint-wiring.ts`) + threading em `server.ts` (substituindo o stub-fallback em produção) | Mudança no contrato de wire do console (`get_state` mantém shape `Server[]`/`Service[]`/…) |

**Divergência conhecida e esperada (NÃO um bug desta spec).** O manifesto declara volumes Hetzner (`pg-backend-data`…) enquanto a realidade usa Docker named volumes — AMBOS são modelos legítimos; o operador pode querer qualquer um (default lean: Docker named volumes). Part 1 NÃO decide e NÃO migra; quando o observed ficar verdadeiro, essa divergência aparece como **drift** (recurso observado-mas-não-desejado), reportada fielmente (fail-safe: reportada, nunca corrigida — §1.4 / §3). Resolver o modelo de volume é Part 2.

## 1. Design

### 1.1 Peça 1 — enriquecer o contrato `ObservedSlice`

Hoje `observe()` mapeia cada entidade para a string `${kind}:${name}` e descarta o resto (`provider.ts:131-134`). Os providers JÁ têm o objeto em mãos no momento do observe (zero round-trip extra é exigido — ver nota de fidelidade abaixo). A decisão (travada): **carregar o objeto completo através do `ObservedSlice`**, cada entry carregando a key E um payload validável:

```ts
// core/src/providers/provider.ts — shape NOVO (aditivo: a key sobrevive).
export interface ObservedEntity {
  /** A mesma convenção "<kind>:<name>" de observed-store.ts. */
  readonly key: string;
  /** Objeto observado bruto; validado pelo adapter contra entities.ts (Peça 2).
   *  `unknown` de propósito — nunca um `as` em dado wire-ish. */
  readonly payload: unknown;
}
export interface ObservedSlice {
  readonly scope: string;
  readonly entities: ReadonlyArray<ObservedEntity>;
}
```

> **Decisão de shape (a confirmar — §6 Q1).** RECOMENDADO: trocar `entities: readonly string[]` por `entities: ReadonlyArray<{ key; payload }>` (acima). Alternativa: manter `entities: readonly string[]` e adicionar um `payloads: ReadonlyMap<string, unknown>` paralelo (menos invasivo no `conformanceHarness`, que faz `obs.entities.includes(action.entity)` em `provider.ts:245`, mas duplica a key). A recomendação é o objeto único `{ key, payload }`; a migração do harness e dos consumidores é parte do plano.

**Superfície de migração (verificada — `slice.entities` é consumido como `string[]` em ~40 sítios).** Esta é a parte invasiva, toda em teste exceto dois sítios de produção:

- Produção: `composite-provider.ts:186` e `:229` fazem `for (const e of slice.entities) seen.add(e)` — passam a dedupar por `e.key` (§1.3). `provider.ts:245` (`conformanceHarness`) passa a checar `obs.entities.some(e => e.key === action.entity)`.
- Concrete providers que implementam `observe()` e hoje emitem `${kind}:${name}` strings: HetznerCloud (`:193-196`), Docker (`:756-759`), Hetzner DNS, WireGuard, Backup/restic, e os providers v2 (firewall etc., `plan-v2.test.ts:212` evidencia slices v2). Cada um passa a emitir `{ key, payload }` carregando o objeto que já lista.
- Testes: os adapters inline (`contract-conformance.test.ts:213-236`, `rest.test.ts:322`, `mcp.test.ts:208`, `tools.test.ts:183`, `idempotency.property.test.ts:183-220` — que JÁ generaliza o padrão via um `payloadOf` map externo) migram para ler `e.payload`. O `idempotency.property.test.ts:183` (`makeObservedAdapter(payloadOf)`) é o protótipo exato do adapter de produção.

**Nota de fidelidade (`listAll` hoje é magro).** `HetznerCloudProvider.listAll` retorna hoje só `{ id, name }` (`hetzner-cloud.ts:126-133`) — `getAllPages<{ id; name }>`. A Hetzner API JÁ devolve os campos ricos (server type/IP/status, network ip_range/subnets, volume size/server/status) na MESMA resposta; o provider hoje os DESCARTA na desserialização. Enriquecer = parsear os campos que já chegam (via um schema Zod de wire), não fazer chamadas novas. O `createHetznerHttpFake` precisa servir esses campos (disciplina `fakes-author`: um fake magro mascara o real). Docker idem: `listManaged()` (`docker.ts:752`) já tem o container→labels→service em mãos.

### 1.2 Peça 2 — o adapter puro `(slice) => State`

Novo módulo puro (RECOMENDADO `core/src/reconciler/observed-adapter.ts` — fica perto do `reconcile.ts` que o consome; alternativa `core/src/store/observed-adapter.ts`). Assinatura `(slice: ObservedSlice) => State`. Por entidade do slice:

1. Deriva o `kind` do prefixo de `entity.key` (`key.slice(0, key.indexOf(":"))`).
2. Valida `entity.payload` contra o schema Zod de `entities.ts` do kind (`ServerSchema`/`NetworkSchema`/`VolumeSchema`/`ServiceSchema`/`DnsRecordSchema`/`BackupPolicySchema`). **Sem `as`** em dado wire-ish — `safeParse`.
3. Sucesso ⇒ empurra o objeto validado na coleção correspondente do `State`.
4. **Falha de parse ⇒ degrade-safe per-entity: PULA a entidade (não a inclui no `State`), NUNCA lança.** Decisão de comportamento (§3 degrade-safe): um payload malformado/unknown derruba a entidade, não o ciclo. Opcionalmente registra um log estruturado value-free (kind+key, nunca o payload — que poderia carregar `secret:<ref>` ou material sensível). O `State` resultante satisfaz `StateSchema.parse` (todas as coleções contêm só objetos válidos).

O adapter é **puro e total**: mesma slice ⇒ mesmo `State` (determinístico), sem I/O, sem exceptions de fluxo normal. Isso é o que garante a idempotência DB-backed (§3 I2): re-observar realidade inalterada ⇒ `State` byte-idêntico ⇒ `putObservedState` full-replace estável ⇒ ciclo 2 estrito no-op.

### 1.3 `composite-provider` — union enriquecido (dedup por key)

`composite-provider.ts:152-231` une slices de múltiplos backends por scope. Com o shape novo, o `seen: Set<string>` vira um `Map<string, ObservedEntity>` keyed por `entity.key` (dedup por key, último-vence ou primeiro-vence — escolha de implementação documentada; recomendado primeiro-vence por estabilidade). O union do meta-scope "manifest" (`:173-222`) e o union per-scope (`:224-231`) recebem o mesmo tratamento. A tolerância a falha por-backend (`:184-214`, warn value-free) é preservada byte-idêntica.

### 1.4 `reconcile.ts` — caminho de persistência (inalterado, agora não-vazio)

Nenhuma linha nova de write-site de `StateEvent`. `reconcile.ts:388-389` (`const slice = await provider.observe(scope); const observed = observedAdapter(slice);`) passa a receber um adapter REAL ⇒ `observed` deixa de ser vazio ⇒ `putObservedState` (`:404-411`) persiste a realidade. Consequência direta e desejada: a detecção de shrinkage/drift (`:350-416`, `detectObservedShrinkage`) e o `plan(desired, observed)` passam a operar sobre observed verdadeiro. **Fail-safe absoluto preservado:** o caminho de drift (`reconcile.ts:360-374`) "NEVER deletes the underlying resource"; `apply(op:"destroy")` segue no-op (`provider.ts:159-168` — destroy real só via Approval Gate + desired-state explícito); a divergência de modelo de volume (§0) aparece como `result:"drift"`, reportada, nunca corrigida.

### 1.5 Wiring — `buildBootDeps` + `server.ts`

- `core/src/entrypoint-wiring.ts` (`buildBootDeps`): cabeia o adapter real em `BootDeps.observedAdapter`. Este era exatamente o campo que `buildBootDeps` NUNCA setava — a regressão de origem do bug (mesma classe da regressão de wiring do "Bug 10").
- `core/src/server.ts:420-429`: o fallback constante-vazio permanece como **default test-only** (não-quebra de testes-em-isolamento que não passam adapter), mas em produção `deps.observedAdapter` agora está sempre presente via `buildBootDeps`. A linha `deps.observedAdapter ?? (() => EMPTY)` fica; o que muda é que produção nunca mais cai no `??`.

## 2. Files in scope (impl checklist)

- `core/src/providers/provider.ts` — shape novo de `ObservedSlice`/`ObservedEntity`; `conformanceHarness` (`:245`) checa por `e.key`.
- `core/src/providers/hetzner-cloud.ts` — `observe()` (`:189-196`) emite `{ key, payload }`; `listAll` (`:126-133`) parseia os campos ricos que a API já devolve (schema Zod de wire); fidelidade no `createHetznerHttpFake`.
- `core/src/providers/docker.ts` — `observe()` (`:750-759`) emite payload Service (container→labels→service); binding de secret segue `secret:<ref>`/label `bevox.secret.<k>` (§3 L1), NUNCA valor resolvido.
- Providers v2 que implementam `observe()` (firewall/load-balancer/etc.) e Hetzner DNS / WireGuard / Backup-restic — migram para `{ key, payload }`.
- `core/src/reconciler/composite-provider.ts` — union enriquecido, dedup por `key` (`:186`, `:229`).
- **Novo:** `core/src/reconciler/observed-adapter.ts` (ou `core/src/store/observed-adapter.ts`) — o adapter puro + colocated `*.test.ts`.
- `core/src/entrypoint-wiring.ts` — cabeia o adapter em `buildBootDeps`/`BootDeps`.
- `core/src/server.ts` — produção usa o adapter real; stub-fallback (`:420-429`) fica test-only.
- Testes: adapters inline em `contract-conformance.test.ts`/`rest.test.ts`/`mcp.test.ts`/`tools.test.ts` migram para `e.payload`; `core/src/reconciler/idempotency.property.test.ts`; um sentinel de secrets.
- `CHANGELOG.md` — `[Unreleased]`.

Arquivos **EXPLICITAMENTE NÃO TOCADOS:** `core/src/reconciler/secret-apply.test.ts` (golden — byte-idêntico); `core/src/store/secrets.ts` (`SecretResolver`/`ApplyContext` FROZEN); nenhum write-site novo de `StateEvent` em `core/src/reconciler/` / `core/src/store/`.

## 3. Invariantes — leak / fail-safe prevention explícita

| # | Invariante | Garantido por |
|---|---|---|
| L1 | Observed `State` persistido no Postgres carrega só `secret:<ref>`, NUNCA valor resolvido (`.claude/rules/secrets-resolution.md` "observed-state storage … references only") | O Docker observe→Service mapeia env-binding de secret como o ref/label `bevox.secret.<k>` (o canal 3.2), nunca resolve; o adapter é puro e sem token de apply ⇒ estruturalmente incapaz de resolver |
| L2 | A persistência observed não ganha caminho delete/destroy/remove e não pode dirigir um terminate | Adapter é pura `(slice) => State`; observe é read-only; observed mais fiel só muda o que `plan`/drift VÊ; `apply(op:"destroy")` segue no-op (`provider.ts:159-168`); drift é `result:"drift"` (`reconcile.ts:360-374`), nunca delete |
| L3 | `secret-apply.test.ts` golden permanece byte-idêntico | Esta spec não toca o env-injection/apply path; só o observe/adapter |
| L4 | Snapshot persistido satisfaz `StateSchema.parse` (degrade-safe) | Adapter valida cada payload por Zod e PULA o inválido (§1.2 passo 4); um payload malformado nunca derruba o ciclo (espelha o degrade-safe read em `reconcile.ts:366-387`) |
| I2 | Idempotência | Adapter puro + `putObservedState` full-replace ⇒ re-observar realidade inalterada = `State` byte-idêntico ⇒ ciclo 2 estrito no-op |
| C1 | Contrato console FROZEN | `get_state` retorna o shape `Server[]`/`Service[]`/etc. do `contract.ts`/`contract-v2.ts`; o adapter produz objetos válidos por `entities.ts` (que espelha o contrato field-for-field, `entities.ts:5-9`); `ObservedSlice` é interno (`provider.ts`), não o contrato console ⇒ seguro mudar. **Flag pro contract-oracle review; objetivo: ZERO novo wire field.** |

## 4. Testes (TDD, fakes-only)

`DATABASE_URL_TEST=postgres://core:core@localhost:5546/bevox_core_test` para os DB-backed. Baseline de typecheck pré-existente: 2 erros conhecidos em `contract-v2-conformance.test.ts` + `idempotency-load-balancer.property.test.ts` (esta spec não os introduz nem os resolve).

| Layer | Arquivo | Cobertura |
|---|---|---|
| HetznerCloud observe enriquecido | `hetzner-cloud.test.ts` + `createHetznerHttpFake` | `observe()` retorna slice com payload completo de server/network/volume (o fake serve os campos ricos); o adapter constrói `State.servers/networks/volumes` |
| Docker observe enriquecido | `docker.test.ts` + `createDockerHttpFake` | `observe()` retorna payload Service; o adapter constrói `State.services`; env secret-bound fica ref/label, NUNCA valor resolvido |
| Adapter unit (happy + degrade) | `observed-adapter.test.ts` (novo) | slice enriquecido → `State` Zod-validado; payload malformado/unknown degrade-safe (pulado, ciclo sobrevive) — NÃO um throw que derruba o ciclo |
| Composite union | `composite-provider.test.ts` | union de observe une slices enriquecidos entre backends (dedup por `key`) |
| Wiring regression guard | `entrypoint-wiring*.test.ts` | `buildBootDeps` cabeia o adapter REAL — o stub-fallback era o bug; assert que um probe com fakes live flui pra um `State` NÃO-vazio (espelha a estrutura do teste de regressão de wiring do "Bug 10") |
| Reconcile integração (DB-backed, pg-harness :5546) | `reconcile.test.ts` (extend) | observe persiste snapshot observed NÃO-VAZIO; `get_state` o retorna; com desired casando o observed, `diff` é vazio/noop |
| Secret hygiene sentinel | sentinel novo + `docker.test.ts` | snapshot observed persistido + resposta de `get_state` contêm ZERO valor de secret resolvido |
| Idempotency property | `idempotency.property.test.ts` (extend) | realidade observed NÃO-VAZIA converge; ciclo 2 estrito no-op; snapshot byte-estável |
| Secret golden | `secret-apply.test.ts` | **byte-idêntico** (nada toca o apply/env path) |

## 5. Acceptance criteria

- [ ] `npm --prefix core run typecheck` sem NOVOS erros além do baseline conhecido (2); `npm --prefix core test` verde.
- [ ] `ObservedSlice` carrega `{ key, payload }` (ou `entities` + `payloads` paralelo — decisão Q1); todos os providers que observam e o `conformanceHarness` migrados; nenhum consumidor de `slice.entities`-as-strings quebrado.
- [ ] Adapter puro `(slice) => State` valida cada payload por Zod (`entities.ts`); payload inválido é PULADO (degrade-safe); o `State` resultante satisfaz `StateSchema.parse`.
- [ ] `composite-provider` une slices enriquecidos com dedup por `key`; tolerância a falha por-backend preservada.
- [ ] `buildBootDeps` cabeia o adapter REAL; produção nunca mais cai no fallback vazio; teste de regressão prova `State` NÃO-vazio.
- [ ] Reconcile DB-backed: snapshot observed NÃO-vazio persistido; `get_state` o retorna; `diff` vazio quando desired == observed.
- [ ] Secret hygiene: nenhum valor resolvido no snapshot persistido nem na resposta `get_state`; `secret-apply.test.ts` byte-idêntico.
- [ ] Idempotency property cobre observed não-vazio (ciclo 2 no-op, snapshot byte-estável).
- [ ] Fail-safe confirmado: nenhuma chamada delete/destroy/remove adicionada; observed mais fiel não pode dirigir um terminate (drift reportado, nunca corrigido).
- [ ] Contract-oracle review: zero novo wire field no `get_state`; shape `Server[]`/`Service[]`/etc. conforme `contract.ts`/`contract-v2.ts`.
- [ ] `CHANGELOG.md` `[Unreleased]`.

## 6. Riscos

| Risco | Mitigação |
|---|---|
| **Drift real passa a aparecer (alto — Q3 do audit):** observed verdadeiro faz `diff` mostrar recursos observados-mas-não-desejados (a divergência de modelo de volume, §0) | Fail-safe: drift é `result:"drift"` (`reconcile.ts:360-374`), reportado nunca corrigido; o adapter/observe path não adiciona delete; documentado como divergência ESPERADA, resolução é Part 2 |
| **Superfície de migração ampla (médio):** ~40 sítios consomem `slice.entities` como `string[]` | Quase todos em teste; 3 sítios de produção (`composite-provider.ts:186/:229`, `provider.ts:245`); migração mecânica, cada provider verde isoladamente; o `idempotency.property.test.ts:183` já é o protótipo do shape |
| **Leak de secret no snapshot persistido (alto):** observed agora não-vazio ⇒ superfície nova de leak | Docker observe→Service mantém `secret:<ref>`/label, nunca resolve (sem token de apply no observe); sentinel test no snapshot + `get_state` |
| **Payload malformado derruba o ciclo (médio):** um container/recurso com shape inesperado | Degrade-safe per-entity: `safeParse` + pula (§1.2 passo 4); o `State` resultante sempre valida; ciclo sobrevive; espelha o degrade-safe read existente |
| **`listAll` magro mascara o real (médio):** se o fake não servir os campos ricos, o teste passa mas produção quebra | Fidelidade no `createHetznerHttpFake`/`createDockerHttpFake` PRIMEIRO (disciplina `fakes-author`); schema Zod de wire nos campos parseados |
| **Quebra de contrato console (alto se acontecer):** observed não-vazio que não case o oracle | Adapter produz objetos válidos por `entities.ts` (espelha o contrato); flag explícito pro contract-oracle review; objetivo zero novo wire field |

## 7. Decisões a confirmar no review

1. **Shape do `ObservedSlice`:** RECOMENDADO `entities: ReadonlyArray<{ key; payload }>` (objeto único). Alternativa: `entities: string[]` + `payloads: Map` paralelo (menos invasivo no harness, duplica key). OK pro objeto único?
2. **Local do módulo adapter:** `core/src/reconciler/observed-adapter.ts` (perto do consumidor) vs `core/src/store/observed-adapter.ts`. Proposto: `reconciler/`. OK?
3. **Degrade-safe per-entity = PULAR (não throw, não "best-effort repair"):** payload inválido sai do `State`, ciclo sobrevive. OK? (Alternativa rejeitada: incluir parcial — quebraria `StateSchema.parse`.)
4. **Dedup do union por `key` = primeiro-vence** (estabilidade do snapshot) vs último-vence. OK pro primeiro-vence?
5. **Divergência de modelo de volume (§0) fica como drift reportado em Part 1**, sem migração nem escolha de vencedor. Confirma que Part 1 só REPORTA e Part 2 (spec separada) decide?
6. **Stub-fallback em `server.ts:420-429` permanece como default test-only** (produção sempre cabeada via `buildBootDeps`) vs remover o fallback de vez. Proposto: manter como test-only. OK?

## 8. Relação com Part 2 e próximos passos

Esta spec **não** define ordem de fases nem tasks TDD — responsabilidade do `plan-writer`. Part 1 entrega observed verdadeiro; Part 2 (spec futura separada) trata: durabilidade do desired-state (#70), caminho `import_state`/adopt, e a decisão de source-of-truth de volume (Hetzner vs Docker named volumes). Part 1 deliberadamente NÃO toca nenhum desses — só torna a realidade visível para que Part 2 tenha base factual.

Hand-off: operador revisa esta spec → flipa `Status: Aceita` → invoca `plan-writer` para o plano de implementação.
