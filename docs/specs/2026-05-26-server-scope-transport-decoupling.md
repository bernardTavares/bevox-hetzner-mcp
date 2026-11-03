# bevox-hetzner-mcp — Server-scope transport decoupling

- **Data:** 2026-05-26
- **Status:** Aceita (2026-05-26)
- **Autor:** Bernard (investigação + decisão pelo owner)
- **Tipo:** Spec-filha (implementável) — aditiva
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)
- **Spec irmã (v2):** [2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
- **Origem factual:** [docs/investigations/2026-05-26-provision-server-ssh-coupling.md](../investigations/2026-05-26-provision-server-ssh-coupling.md)

## 0. Status, escopo e relação com as outras specs

Esta spec-filha é **aditiva**. Não redefine entidades v1 nem v2; não altera o
schema de manifestos; não altera a borda pública v2. Resolve uma classe de bug
estrutural na **camada de transporte** da Agent Interface: hoje qualquer
`dry_run` em ~10 tools v1 (e provavelmente todos os write tools v2) executa
`provider.observe()` ao vivo, e o `routes.server` está cabeado em
`[hetznerCloud, wireguard]`, acoplando inevitavelmente provisionamento de
servidor à existência de um endpoint SSH alcançável.

A spec-mãe v1 (`2026-05-17`) e a spec irmã v2 (`2026-05-20`) estão **frozen**.
Esta spec **supersede semanticamente** o trecho da v1 §"Agent Interface"
("`dry_run: true` retorna **plan/diff** sem aplicar"): a partir desta spec,
"sem aplicar" passa a significar literalmente "sem side-effect observável",
incluindo nenhuma chamada de rede. Nada na v1/v2 é editado in-place.

Dentro do escopo:

- Mudança A — tool layer honra `input.dry_run` em todas as tools mutadoras.
- Mudança B — `dry_run` lê do `observed-store` cacheado, nunca via
  `provider.observe()` ao vivo.
- Mudança E — knob de configuração `MANAGED_MESH` (default `on`) que
  desacopla o `routes.server` da WireGuard.

Fora do escopo (não-objetivos, ver §8):

- Mecanismo declarativo `requires_transports[]` por provider (Option D da
  investigação — over-engineered para v1).
- `routes.service` configurável (Docker continua via SSH — ortogonal).
- Modificação do tool surface v2 (v2 herda da infra compartilhada
  `reconcileToEnvelope`).
- Edição in-place das specs frozen v1 ou v2.
- Rollback automático destrutivo.

Invariantes preservadas (CONTRIBUTING §"Ground rules"):

| # | Invariante | Como esta spec preserva |
|---|---|---|
| 1 | Specs come first | Esta spec precede qualquer mudança em `core/src/`. Nenhuma linha de código aterrou. |
| 2 | Idempotência por design | A, B e E são idempotentes: re-rodar A é no-op se o tool já retorna `planned`; B lê snapshot estável; E lê knob estável. |
| 3 | Fail-safe, never fail-deleting | Mudança E **não remove** peers WireGuard ao virar `off`; drift é reportado. Nenhum erro de A/B/E deleta recurso. |
| 4 | Secrets at apply only | Mudança B **remove** uma superfície de potencial leak (dry_run não invoca mais observe → não há SSH spawn → não há temp keyfile materializado). Net negative leak risk. |
| 5 | StateEvent actor | Inalterado. Esta spec toca camada Agent Interface, não o writer de `StateEvent`. |

## 1. Contexto

A investigação `docs/investigations/2026-05-26-provision-server-ssh-coupling.md`
confirma três bugs sobrepostos numa única classe:

1. **Bug 1 — v1 tool layer ignora `dry_run`.** Em `core/src/agent/tools.ts`,
   apenas `doDeployService` (linha 434) lê `input.dry_run`. Os demais
   handlers v1 (`doProvisionServer:405`, `doScaleService:490`, `doSetDns:509`,
   `doApplyManifest:538`, `doGatedOp:559` que cobre destroy/snapshot/restore
   via parâmetro `op`) chamam `mergeDesired` + `reconcileToEnvelope` ou
   `gate.evaluate` independentemente do flag. **v2 write tools (`agent/v2/*.ts`)
   JÁ honram `dry_run`** (cada um tem `const dryRun = input.dry_run === true`
   + branch dedicado — verificado no double-check).
2. **Bug 2 — dry_run executa observe ao vivo.** Mesmo no único caminho
   correto (`doDeployService` lines 456–472), o branch dry_run chama
   `provider.observe(scope)` que, no `routes.server` atual, inclui
   `WireGuardProvider.observe()` (lines 300–340 de `wireguard.ts`) que faz
   SSH para enumerar `managedPeers`. Resultado: dry_run faz SSH real,
   spawna `ssh-exec` com keyfile temporário, e falha em deploys que não
   tenham SSH configurado (mesma rede que o bug original).
3. **Bug 3 — `routes.server` hardcoded.** `core/src/entrypoint-wiring.ts`
   linhas 193–204 amarra `server: [hetznerCloud, wireguard]`. Não há forma
   de bootar o reconciler sem a WireGuard. Em deploys que usam k3s/CNI
   (mesh gerenciado fora) ou que não querem WG ainda, a única saída é hack.

Owner aprovou o pacote **A + B + E**. Esta spec define o contrato exato
dessas três mudanças.

## 2. Goals

1. `dry_run` de qualquer tool mutadora é estruturalmente side-effect-free:
   zero chamadas de rede (HTTP Hetzner, SSH, Docker Engine, restic).
2. Deploys que rodam k3s/CNI ou que ainda não têm WireGuard configurada
   podem bootar o daemon e operar `provision_server` apenas com
   `HCLOUD_TOKEN` válido — `SSH_*` opcional.
3. Default backwards-compatible: deploys atuais (`MANAGED_MESH=on`
   implícito) preservam 100% do comportamento; suíte de testes existente
   continua verde sem modificação.

## 3. Non-goals (YAGNI)

- `requires_transports[]` ou qualquer DSL declarativa de transporte por
  provider (Option D da investigação). Custo de design > benefício hoje.
- `routes.service` configurável: Docker segue via SSH, fora do escopo.
- Modificação do schema/contract v2 (Bloco A) — wire-contracts e schemas
  Zod inalterados. **A implementação dos handlers v2 É tocada** (ver
  §4.2.b): o `await deps.provider.observe()` em cada v2 write tool sai
  do branch dry_run, permanecendo apenas no caminho de apply real.
- Rollback automático destrutivo (proibido por invariante #3).
- Limpeza automática de peers WireGuard ao virar `MANAGED_MESH=off`:
  drift reportado, nunca corrigido em silêncio.
- Renomeação ou refatoração de `routes` v1 — só adicionamos um knob de
  composição na fase de wiring.

## 4. Design

### 4.1 Mudança A — tool layer honra `input.dry_run`

**Regra.** Toda tool em `core/src/agent/tools.ts` (e em `core/src/agent/v2/*`
que segue o mesmo padrão de funil) que muta desired-state via
`reconcileToEnvelope` MUST, quando `input.dry_run === true`:

1. NÃO chamar `mergeDesired`.
2. NÃO chamar `reconcileToEnvelope`.
3. Calcular um desired hipotético (current + delta) e retornar
   `planned(plan(desired, observed))`.

O padrão canônico já existe em `doDeployService` (`tools.ts:456-472`):
preserva exatamente essa forma, modificado pela Mudança B (§4.2).

Lista exaustiva (validada no double-check contra `core/src/agent/`):

| Tool | Handler | Padrão atual | O que A faz |
|---|---|---|---|
| `provision_server` | `tools.ts:405` `doProvisionServer` | ignora `dry_run`; chama `reconcileToEnvelope` | adicionar branch dry_run |
| `deploy_service` | `tools.ts:434` `doDeployService` | **já honra `dry_run`** (origem do padrão) | nenhuma — alvo da Mudança B (§4.2.a) |
| `scale_service` | `tools.ts:490` `doScaleService` | ignora `dry_run` | adicionar branch dry_run |
| `set_dns` | `tools.ts:509` `doSetDns` | ignora `dry_run` | adicionar branch dry_run |
| `apply_manifest` | `tools.ts:538` `doApplyManifest` | ignora `dry_run` | adicionar branch dry_run |
| `destroy` / `snapshot` / `restore` | `tools.ts:559` `doGatedOp(op, ...)` (handler único para os 3) | ignora `dry_run`; sempre invoca `gate.evaluate` (persiste approval) | adicionar branch dry_run que retorna `planned([syntheticItem])` SEM `gate.evaluate` — ver §4.2.c |
| `set_firewall` / `set_load_balancer` / `set_certificate` / `set_primary_ip` / `set_ingress` / `expose_service` | `agent/v2/<tool>.ts` | **já honram `dry_run`** (Mudança A done) | nenhuma — gap está em Mudança B (§4.2.b) |

Tools de leitura (`get_state`, `diff`, `events`, `health`,
`resolve_selector`) são imutáveis e ficam fora do escopo de A.

**Erros estruturados inalterados.** Forma de saída em dry_run é a forma
v1: `{ status: "planned", plan: [...], next: "call again with dry_run:false to apply" }`.

### 4.2 Mudança B — dry_run sem chamadas de rede ao vivo

Três caminhos no código, três tratamentos distintos. Cada um remove a fonte de side-effect do branch dry_run sem alterar o caminho de apply real.

#### 4.2.a — v1 mutating tools (composite provider, via `reconcileToEnvelope`-style)

**Antes** (`tools.ts:470`, dentro do branch dry_run de `doDeployService`):

```ts
const slice = await provider.observe(scope);   // ← LIVE: SSH/HTTP/Docker
const observed = observedAdapter(slice);
return planned(plan(desired, observed));
```

**Depois** (aplicado em todos os handlers v1 mutadores via Mudança A):

```ts
const observed = await getState(pool, scope);  // ← cached snapshot via observed-store
return planned(plan(desired, observed));
```

`getState(pool, scope)` já existe em `core/src/store/observed-store.ts:47`
(serve `get_state`/`diff` hoje). Substituição de origem do `observed`,
sem código novo. Daemon fresco sem reconcile ainda → `State` vazio →
plan() = "create everything in desired".

#### 4.2.b — v2 write tools (per-entity providers)

v2 usa interface diferente: `deps.provider.observe(desired)` retornando
`ObservedX | null`. Não há observed-store equivalente para entidades v2.
A fix correta é **mover o observe para depois do dry_run check**.

**Antes** (`agent/v2/set-ingress.ts:169-194`, padrão repetido nos 5 demais):

```ts
let observed: ObservedIngress | null;
try {
  observed = await deps.provider.observe(desired);   // ← LIVE HTTP Hetzner
} catch (err) { return toErrorEnvelope(err); }
let prior: Ingress | null = await deps.workingStore.get(desired.name);
let plan: IngressPlan = await deps.provider.plan(desired, observed);
if (dryRun) {
  return buildV2WriteEnvelope({ status: "planned", plan: { ops: [...plan.ops] } });
}
```

**Depois** (observe gated por `!dryRun`; plan() chamado com `null` em dry_run):

```ts
let observed: ObservedIngress | null = null;
if (!dryRun) {
  try {
    observed = await deps.provider.observe(desired);
  } catch (err) { return toErrorEnvelope(err); }
}
let plan: IngressPlan = await deps.provider.plan(desired, observed);
if (dryRun) {
  return buildV2WriteEnvelope({ status: "planned", plan: { ops: [...plan.ops] } });
}
// workingStore.get pode ficar fora do dry_run também — é DB-local, não rede
```

Os 6 tools v2 (`set-firewall`, `set-load-balancer`, `set-certificate`,
`set-primary-ip`, `set-ingress`, `expose-service`) recebem o mesmo
refactor. `provider.plan(desired, null)` retorna o plan completo de
criação — semanticamente equivalente ao caminho v1 com observed vazio.

> **Trade-off declarado.** O plan v2 em dry_run perde a capacidade de
> detectar idempotência (não saberá que `desired` já está convergido).
> Aceito como semântica de preview; agente que precisa do estado atual
> chama o tool de leitura correspondente.

#### 4.2.c — `doGatedOp` (destroy / snapshot / restore)

`doGatedOp` (`tools.ts:559`) **não chama observe** (network-safe), MAS
invoca `gate.evaluate` que persiste uma approval pendente quando o op é
sensível — side-effect na DB que dry_run não pode ter.

**Alvo:** branch dry_run **antes** do gate, retornando `planned([item])`
com o synthetic PlanItem que `doGatedOp` já constrói:

```ts
async function doGatedOp(op, entity, scope, actor, sensitive, dryRun) {
  const item: PlanItem = { op, entity, change: `${op} ${entity}`, impact: ... };
  if (dryRun) {
    return planned([item]);   // synthetic PlanItem; SEM gate.evaluate, SEM DB write
  }
  // ...código atual continua igual a partir daqui...
}
```

A assinatura de `doGatedOp` cresce em um parâmetro (`dryRun: boolean`)
ou o caller é refatorado para passar o flag — implementação escolhe a
forma menor.

**Semântica explicitada (supersede v1 §"Agent Interface"):**

- `dry_run` reflete a **última observed-state reconciliada**, não a
  absolute-current.
- Em daemon fresco (sem nenhum ciclo de reconcile ainda completado), o
  observed-store está vazio: `getState` retorna `State` vazio; `plan()`
  responde "create everything in desired". Esta é a semântica aceita de
  preview; agente que precisa de visão absolute-current chama
  `get_state` (leitura) ou aguarda o próximo ciclo de drift detection.
- `dry_run` torna-se **estruturalmente** side-effect-free: nenhuma rota
  de código nesse branch invoca `provider.observe()`, portanto:
  - Nenhum SSH spawn (alinha com invariante #4 — sem materialização de
    secret no temp keyfile).
  - Nenhum HTTP Hetzner.
  - Nenhum risco de timeout/falha de rede afetar resultado de plan.

**Alinhamento com v1.** O texto literal da v1 §"Agent Interface" diz
"`dry_run: true` retorna plan/diff sem aplicar". A intenção de "sem
aplicar" sempre foi side-effect-free; a implementação atual viola
essa intenção. Esta spec não revisa a v1 — formaliza o que a v1 já
exigia em linguagem natural.

### 4.3 Mudança E — knob `MANAGED_MESH` (default `on`)

**Novo campo em `ConfigSchema`** (`core/src/config.ts`):

```ts
MANAGED_MESH: z
  .preprocess((v) => v === undefined || v === "" ? undefined : v,
              z.enum(["on", "off"]).optional())
  .transform((v) => v ?? "on")
```

Mirrors o padrão de `SSH_HOST_KEY_POLICY` já em config.ts: enum estreito,
default seguro, não-secreto, parseável de env var vazia.

**Wiring** (`core/src/entrypoint-wiring.ts:193-204`):

```ts
const providers: BootDeps["providers"] = {
  network: hetznerCloud,
  server: config.MANAGED_MESH === "on"
    ? [hetznerCloud, wireguard]
    : [hetznerCloud],
  volume: hetznerCloud,
  service: docker,        // unchanged — Docker via SSH é ortogonal ao mesh
  dns: hetznerDns,
  backup,
};
```

Notas:

- O `WireGuardProvider` continua sendo **instanciado** (para spec audit,
  testes, future-proofing) — apenas não entra no `routes.server` quando
  `MANAGED_MESH=off`.
- `routes.service` não é tocado. Docker continua usando o transport SSH
  que ele já usa hoje.

**Drift behavior em flip `on → off`.** Operador que decide desativar o
managed mesh num deploy onde já existem peers WireGuard observados:

- No primeiro ciclo de reconcile após o flip, o `routes.server` deixa de
  incluir WireGuard, então `observe()` para o scope server não enumera
  peers WG. O snapshot novo no observed-store fica sem peers.
- O `StateEvent` writer registra a transição como **drift** (peers que
  estavam no observed anterior somem do novo observe), nunca como
  destrutiva.
- O reconciler **NÃO** invoca `wg-quick` / `wg set` para deletar peers
  na máquina. Limpeza, se desejada, é manual via SSH + `wg` (operação
  out-of-band).
- Recomendação operacional: bootar com `MANAGED_MESH=off` num deploy
  fresco, NUNCA flipar em deploy ativo com peers gerenciados.

**Boot-time warning.** Quando o config carrega `MANAGED_MESH=off`, o
daemon emite um log estruturado (Pino, nível `warn`) no boot — mesmo
padrão do warning existente "desired-state in-process". Valor explícito,
zero secret, ajuda operador a confirmar a postura escolhida.

### 4.4 Interação entre as três mudanças

A, B e E são **ortogonais por construção**:

- A é uma mudança em cada handler v1 mutador (+ `doGatedOp`); v2 já
  honra Mudança A. B tem 3 sub-padrões (§4.2.a/b/c) conforme o caminho
  de código. E é uma mudança em config + wiring.
- A correção isolada de A (sem B) já melhora: tools v1 nunca mais
  executam apply acidental em dry_run. Mas o branch dry_run continuaria
  chamando observe ao vivo e poderia falhar com SSH/HTTP ausente.
- A correção isolada de B (sem A) corrige `doDeployService` e os 6 v2
  tools. Mas demais v1 permanecem ignorando dry_run.
- E sem A/B é insuficiente: mesmo desativando WireGuard do
  `routes.server`, dry_run continuaria invocando `HetznerCloudProvider.observe()`
  ao vivo (HTTP), que ainda pode falhar (rate limit, indisponibilidade).
  E sem B torna o produto **menos** side-effect-free, não mais.

O pacote A+B+E (cobrindo v1 + v2 + `doGatedOp`) é a unidade mínima
coerente. Implementação pode commitar em ordem (E → A → B ou A → B → E),
cada commit verde isoladamente, mas o critério de aceite §9 exige os três.

## 5. Invariants (esta spec preserva)

| # | Invariante (origem) | Preservação concreta |
|---|---|---|
| I1 | Specs come first (CONTRIBUTING §Ground rules #1) | Nenhum código aterrou antes desta spec. |
| I2 | Idempotência (CONTRIBUTING §Ground rules #2) | A: re-aplicar é no-op (mesmo branch dry_run). B: getState é puro. E: knob lido uma vez no boot. |
| I3 | Fail-safe, never fail-deleting (CONTRIBUTING §Ground rules #3) | E reporta drift em peers WG órfãos; nunca deleta. A/B não tocam apply path. |
| I4 | Secrets at apply only (CONTRIBUTING §Ground rules #4) | B remove uma superfície de leak (no-SSH-em-dry_run elimina materialização de chave temp). |
| I5 | StateEvent actor (CONTRIBUTING §Ground rules #5) | Inalterado. Esta spec é Agent Interface, não writer. |

## 6. Test strategy

| Camada | Como testar | Cobre |
|---|---|---|
| Tool unit (`agent/tools.test.ts`, `agent/v2/*.test.ts`) | Fake provider que **lança** se `.observe()` for invocado em dry_run | Garante que A+B eliminam side-effect em dry_run; regressão contra futuro tool handler que esquecer o branch |
| Tool integração | Fake providers in-memory; chamadas `tool(dry_run:true)` → `{ status: "planned", plan: [...] }` sem nenhum stub de observe ativado | Forma de saída v1 preservada |
| Config unit (`config.test.ts`) | `ConfigSchema.parse({})` → `MANAGED_MESH: "on"`; `{MANAGED_MESH: "off"}` → `"off"`; `{MANAGED_MESH: ""}` → `"on"`; valor inválido → ZodError | Default + validação de E |
| Wiring unit (`entrypoint-wiring.test.ts`) | `MANAGED_MESH=on` → `routes.server.length === 2`; `MANAGED_MESH=off` → `routes.server.length === 1` e `wireguard not in routes.server` | E mecanicamente correto |
| Reconciler property (existente, herdado v1) | Re-rodar apply N vezes converge | Idempotência preservada |
| Boot-time | Daemon com `MANAGED_MESH=off` boota com `HCLOUD_TOKEN` real e `SSH_HOST=placeholder-*`; `provision_server` (apply real, fake HTTP Hetzner) funciona | Critério de aceite §9 #1 |
| `@live` opcional | (Não requer mudança nesta spec) | — |

Todos os testes seguem a convenção v1: fakes em `core/test/fakes/`;
nenhuma chamada externa real no projeto `unit` do vitest; `@live` fica
sob demanda.

## 7. Migration / rollout

**Backwards-compatible por construção.**

- Default `MANAGED_MESH=on` ⇒ deploys atuais não percebem mudança.
- Suíte de testes existente não exige modificação (qualquer teste que
  configura `MANAGED_MESH` está livre para fazê-lo, mas nenhum precisa).
- Sem migration Postgres — esta spec não toca schema.
- Sem mudança de wire/contrato v1 ou v2 — tools mantêm input/output
  schemas; só o branch interno dry_run muda.

**Novos deploys que querem opt-out** (típico: caminho A do
`bevox-meta-api`, k3s gerencia mesh via CNI):

1. Setar `MANAGED_MESH=off` em `core/.env` antes do primeiro boot.
2. `SSH_*` vars passam a ser opcionais para o scope server; permanecem
   exigidas se o operador declarar `Service` (Docker continua via SSH).
3. `provision_server` (apply real) funciona apenas com `HCLOUD_TOKEN`.

**Reversibilidade.** Voltar de `off` para `on` em deploy sem peers
existentes é instantâneo: próximo ciclo de reconcile reincorpora a
WireGuard ao `routes.server` e enumera peers (zero) sem efeito. Voltar
em deploy onde peers foram criados out-of-band: ver §4.3 (peers ficam
visíveis no próximo observe, sem drift desde que estejam no desired).

## 8. Open questions

| # | Questão | Recomendação preliminar | Decisor |
|---|---|---|---|
| Q1 | `MANAGED_MESH=off` + `Service` declarado: hard precondition error ou aceitar? | **Resolved: aceitar.** Docker via SSH é independente da WireGuard mesh. Rejeitar **somente** se o `Service` exigir peer WG explícito (não existe hoje em v1). | resolvido (owner aprovou 2026-05-26) |
| Q2 | Boot-time warning ao carregar `MANAGED_MESH=off`? | **Resolved: sim.** Log estruturado nível `warn`, valor explícito (nunca secret), espelha o warning "desired-state in-process" existente. | resolvido (owner aprovou 2026-05-26) |
| Q3 | v2 write tools: estado atual | **Resolvida no double-check.** 6 tools v2 (`set-firewall`, `set-load-balancer`, `set-certificate`, `set-primary-ip`, `set-ingress`, `expose-service`) já honram `dry_run` (Mudança A done). Gap é exclusivamente Mudança B — mover `provider.observe` para depois do dry_run check. Tratado em §4.2.b. | resolvido |
| Q4 | Sinal/aviso quando operador flipa `on → off` em deploy com peers observados? | Reconciler **deveria** emitir `StateEvent kind: "drift"` para cada peer órfão na primeira observação após o flip. Implementação valida que isso já cai natural do drift detector existente; se não, adiciona-se um caso. | implementação (com revisão de owner) |

## 9. Critérios de aceite

A implementação está pronta quando todos os itens abaixo são verdade:

1. `provision_server` em modo dry_run **e** apply funciona com
   `SSH_HOST=placeholder-*` desde que `MANAGED_MESH=off` e `HCLOUD_TOKEN`
   seja válido.
2. Todos os dry_run paths de tools mutadoras retornam envelope `planned`
   **sem nenhuma chamada de rede ao vivo**. Validado por um fake provider
   que lança `Error("observe must not be called in dry_run")` se
   `.observe()` for invocado dentro desse branch.
3. `MANAGED_MESH=on` (default) preserva 100% do comportamento atual.
   Suíte completa (`npm --prefix core test`) continua verde sem alteração
   nos testes existentes.
4. `MANAGED_MESH=off` com `Service` declarado: comportamento documentado
   conforme decisão de Q1 (aceitar com Docker SSH funcionando, ou
   rejeitar com precondition error claro).
5. Trecho da v1 §"Agent Interface" sobre dry_run é considerado
   **superseded semanticamente** por §0/§4.2 desta spec. v1 **não é
   editada**.
6. `docs/2026-05-25-go-live-cloudflare-tunnel.md` §9 atualizado para
   indicar que `SSH_*` é requerido **somente** quando `MANAGED_MESH=on`
   ou quando ao menos um `Service` é declarado.
7. Os 6 v2 write tools (`set-firewall`, `set-load-balancer`,
   `set-certificate`, `set-primary-ip`, `set-ingress`, `expose-service`)
   recebem Mudança B (§4.2.b — `provider.observe()` gated por
   `!dryRun`). Validado por fake provider v2 que lança em `observe()` se
   chamado em dry_run.

## 10. Documentação tocada (escopo da implementação)

Lista exaustiva dos arquivos de documentação que devem ser atualizados
como parte da implementação desta spec. Não é tarefa do `spec-writer`;
fica registrada aqui para o `plan-writer` materializar como tasks.

- `docs/2026-05-25-go-live-cloudflare-tunnel.md` — §9 (variáveis SSH
  passam a condicionais).
- `core/.env.example` — adicionar `MANAGED_MESH` com comentário breve.
- `deploy/README.md` — uma linha mencionando o knob no perfil k3s.
- (Opcional, se a implementação descobrir gaps reais em v2) audit-log
  da Q3 em `docs/investigations/2026-05-26-provision-server-ssh-coupling.md`.

## 11. Relação com plano e próximos passos

Esta spec **não** define ordem interna de fases nem tasks TDD —
responsabilidade do `plan-writer`. Sugestões de fronteira para o
plano (não vinculantes):

- A é maior em superfície (4 handlers v1 mutadores + `doGatedOp`; v2 já
  feita). Pode ser quebrada em sub-tasks por handler, cada uma
  vermelho-verde-commit independente.
- B tem 3 sub-padrões (§4.2.a v1 via getState, §4.2.b v2 via
  observe-after-dryrun-check, §4.2.c `doGatedOp` via skip-gate). Cada
  sub-padrão é testável isoladamente com fake provider que lança se
  `observe()` for chamado em dry_run.
- E é independente; pode aterrar primeiro (config + wiring + teste),
  mantendo o default `on` que não muda nada operacionalmente.
- Após A+B+E verdes (v1 + v2 + doGatedOp), atualizar documentação (§10).

Hand-off: owner revisa esta spec → flipa `Status: Aceita` → invoca
`plan-writer` para o plano de implementação.
