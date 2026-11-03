# bevox-hetzner-mcp — `apply_manifest` desired-state silo fan-out

- **Data:** 2026-05-26
- **Status:** Aceita (2026-05-26)
- **Autor:** Bernard (bug-report do `bevox-meta-api` caminho A + investigação owner com Claude)
- **Tipo:** Spec-filha (cirúrgica) — aditiva, corretiva
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)
- **Spec irmãs:**
  - [2026-05-26-server-scope-transport-decoupling.md](./2026-05-26-server-scope-transport-decoupling.md) (PR #11 — `MANAGED_MESH`)
  - [2026-05-26-apply-manifest-meta-scope.md](./2026-05-26-apply-manifest-meta-scope.md) (PR #12 — composite meta-scope; introduziu o silo)
  - [2026-05-26-tolerant-meta-scope-and-managed-services.md](./2026-05-26-tolerant-meta-scope-and-managed-services.md) (PR #13 — tolerant + `MANAGED_SERVICES`)

## 0. Escopo e relação com as outras specs

Spec **aditiva, cirúrgica, corretiva**: muda a forma como
`doApplyManifest` (`core/src/agent/tools.ts:594-615`) escreve o estado
desejado, e ajusta o reconcile do scope sintético `"manifest"` para que
o observed-state caia em rows per-scope no Postgres. Não toca v1/v2
invariantes; não altera schemas, API pública, wire contract, nem o
shape de retorno do tool `apply_manifest`.

A spec **promove** o item #1 da lista "Fora de escopo (latent issues)"
do PR #12 (`docs/specs/2026-05-26-apply-manifest-meta-scope.md` §5) de
*latent* para *atual e blocking*: ele agora bloqueia o caminho A do
`bevox-meta-api` (apply via REST não declara `service`; `Network` só é
declarável via `apply_manifest`, mas `provision_server` subsequente não
enxerga a `Network` declarada).

O follow-up "caveat 2" das release notes do PR #13 já antecipava esta
spec.

## 1. Contexto

### 1.1 O silo do `desiredByScope` Map

`entrypoint-wiring.ts:213-226` provê o seam `loadDesired` /
`writeDesired` como um `Map<string, DesiredState>` in-process keyed por
scope:

```ts
const desiredByScope = new Map<string, DesiredState>();
const loadDesired = async (scope: string): Promise<DesiredState> =>
  desiredByScope.get(scope) ?? {};
const writeDesired = async (
  scope: string,
  desired: DesiredState,
): Promise<void> => {
  desiredByScope.set(scope, desired);
};
```

Cada *tool* per-kind (`provision_server` → `"server"`, `deploy_service`
→ `"service"`, etc.) lê e escreve em sua própria chave. O `Map` não
unifica entre chaves: `loadDesired("network")` não vê o que
`writeDesired("manifest", ...)` colocou em `"manifest"`.

### 1.2 O que `doApplyManifest` faz hoje

`core/src/agent/tools.ts:594-615` (apply path):

```ts
async function doApplyManifest(input, scope /* = "manifest" */, actor) {
  const dryRun = input.dry_run === true;
  const manifest = DesiredStateSchema.parse(asRecord(input.manifest));

  if (dryRun) {
    const observed = await getObservedState(pool, scope);
    return planned(plan(manifest, observed));
  }

  await writeDesired(scope, manifest);                            // ⚠ silo
  return reconcileToEnvelope(scope, actor, defaultIsSensitive);   // ⚠ silo
}
```

- `writeDesired("manifest", manifest)` deposita o manifest inteiro
  numa entrada `"manifest"` do `desiredByScope` Map.
- `reconcileToEnvelope("manifest", ...)` dispara `reconcile({scope:"manifest"})`,
  que via composite meta-scope (PR #12) observa per-kind, e via
  `composite.apply` aplica per-entity. O apply em si funciona.
- O **observed-state** porém é escrito em `putObservedState(pool, "manifest", observed)`
  (`reconcile.ts:794` no path do drift sweep; análogo no apply path),
  com `scope="manifest"` — uma única row Postgres keyed por `"manifest"`
  contendo a união de todas as entidades. Spec PR #12 §5 já reconhece
  isto como "wasteful mas inofensivo" — esta spec demonstra que é, na
  verdade, *blocking*.

### 1.3 Os consumidores per-scope (que sofrem com o silo)

Após `apply_manifest({networks:[A], servers:[B]})` rodar:

| Caller | Chamada | Resultado |
|---|---|---|
| `doProvisionServer` (`tools.ts:405-432`) | `loadDesired("server")` | `{}` (não vê `B`) |
| `doDeployService` | `loadDesired("service")` | `{}` |
| Periodic drift sweep (`reconcile.ts:790-820`) | itera scopes nativos `["network","server","volume",("service")]`; chama `loadDesired(scope)` por scope | nunca lê `"manifest"`; cada scope nativo vê desired vazio |
| `get_state` REST (`scope="server"`) | `getObservedState(pool, "server")` | row vazia (observed foi para `"manifest"`) |
| `diff(source="working")` per-scope | `loadDesired(scope)` per-scope | retorna `[]` |

**Consequência operacional:**

1. `bevox-meta-api` caminho A declara `Network` via `apply_manifest`
   (única forma — não há `set_network` standalone, decisão do owner que
   esta spec preserva).
2. `bevox-meta-api` então chama `provision_server({name, network})`.
3. `doProvisionServer` faz `loadDesired("server")`; o `Map` retorna
   `{}`. `mergeDesired` produz um desired sem a `Network` declarada.
4. O reconcile do scope `"server"` opera sobre um desired sem
   `Network` → erro `precondition: network not declared` (ou drift, ou
   apply parcial).
5. Caminho A do `bevox-meta-api` fica sem rota possível.

O periodic reconcile, similarmente, **não converge nada do que
`apply_manifest` declarou** — porque ele itera scopes nativos e nunca
visita `"manifest"`.

### 1.4 Anomalia secundária reportada

O consumer também reportou ter recebido `{"status":"applied"}` quando
chamou `apply_manifest({dry_run: true, ...})`, ao invés do esperado
`{"status":"planned"}`. O código atual (`tools.ts:599-610`) está
correto: `if (dryRun) return planned(plan(...))` antes de qualquer
`writeDesired` ou `reconcile`. Não reproduzimos sem credenciais; pode
ser misquote, transformação na camada bridge do consumer, ou bug
correlato que sumiu com fixes anteriores. Esta spec inclui um teste de
regressão que ancora o shape; se o bug existir em algum caminho não
óbvio, o teste o expõe.

## 2. Goals

- Eliminar o silo `"manifest"` no desired-store em runtime: após
  `apply_manifest` (apply path), `loadDesired(<kind>)` per-scope retorna
  o slice correspondente do manifest.
- Garantir que `get_state` e o periodic reconcile per-scope vejam o
  resultado de um `apply_manifest`.
- Manter a API pública e o wire shape do tool `apply_manifest`
  inalterados (backwards-compat dos consumidores, inclusive
  `bevox-meta-api`).
- Manter dry_run `apply_manifest` exatamente como está (PR #12 fix
  preservado; não é o caminho com bug).
- Ancorar a regressão `dry_run:true → status:"planned"` com teste
  explícito.

## 3. Non-goals (YAGNI)

- **Não** introduzir tool `set_network` standalone. Regra do owner:
  Network só se declara via `apply_manifest`, para forçar declaração
  coesa do bloco de rede. Preservada.
- **Não** mudar a API pública nem o wire shape do tool
  `apply_manifest`. Consumers não precisam alterar nada.
- **Não** introduzir queries cross-scope do desired-store
  (`loadDesired` per-scope continua o único contrato; `provision_server`
  lê seu próprio scope; o manifest descreve servers que **devem** estar
  na entrada `"server"` após o fan-out).
- **Não** persistir desired-state em disco/DB. `desiredByScope` segue
  como `Map` in-process (CLAUDE.md: "durable git/manifest persistence
  is the manifest-repo's concern"). Sem migration de dados — o `Map`
  reseta a cada boot, não há row Postgres a converter.
- **Não** introduzir nova config-knob. O fan-out é incondicional —
  remove um bug, não adiciona modo opt-in.
- **Não** mudar `observed_state` *schema* — apenas o **scope** com que
  rows são gravadas (de `"manifest"` para per-kind).
- **Não** mudar a semântica de Approval Gate. Sensitive policies das
  ops continuam aplicadas pelo composite no caminho de apply
  (entity-routed); o gate avalia o plan agregado como hoje.
- **Não** propagar fan-out para `dry_run`. Esse caminho não escreve
  desired (`writeDesired` ausente em `if (dryRun)`); sem silo a corrigir.

## 4. Design

### 4.1 Fan-out write-time em `doApplyManifest` (apply path)

`doApplyManifest`, ao invés de `writeDesired("manifest", manifest)`,
decompõe o manifest e escreve **uma entrada per-scope** para cada
*slice* não-vazia presente em `DesiredStateSchema`:

| Slice do manifest | Scope alvo | Forma escrita |
|---|---|---|
| `servers`   | `"server"`   | `{ servers: manifest.servers }`     |
| `networks`  | `"network"`  | `{ networks: manifest.networks }`   |
| `volumes`   | `"volume"`   | `{ volumes: manifest.volumes }`     |
| `services`  | `"service"`  | `{ services: manifest.services }`   |
| `dns`       | `"dns"`      | `{ dns: manifest.dns }`             |
| `backups`   | `"backup"`   | `{ backups: manifest.backups }`     |

(A tabela enumera **todas** as slices declaradas em
`core/src/domain/desired-state.ts` § `DesiredStateSchema`. Slices
ausentes no manifest não disparam write — o `Map` permanece sem entrada
para aquele scope.)

**Pseudocódigo (não vinculante — implementação pertence ao plano):**

```ts
if (manifest.networks) await writeDesired("network", { networks: manifest.networks });
if (manifest.servers)  await writeDesired("server",  { servers: manifest.servers });
if (manifest.volumes)  await writeDesired("volume",  { volumes: manifest.volumes });
if (manifest.services) await writeDesired("service", { services: manifest.services });
if (manifest.dns)      await writeDesired("dns",     { dns: manifest.dns });
if (manifest.backups)  await writeDesired("backup",  { backups: manifest.backups });
```

**Semântica de replace vs merge.** `apply_manifest` documenta-se como
"full-manifest replace" (`tools.ts:600-602` comentário). O fan-out
preserva essa semântica per-scope: cada `writeDesired(scope, slice)`
substitui integralmente a entrada daquele scope no `Map` (mesmo
contrato do `writeDesired` atual). Apply de um manifest com
`servers:[A,B]` seguido de apply com `servers:[A]` deixa a entrada
`"server"` com apenas `A` — coerente com o contrato pré-existente.

**Slices ausentes.** Um manifest que não declara `services` **não**
limpa a entrada `"service"` existente — o fan-out condicional preserva
o que cada slice individual deixou. Justificativa: `apply_manifest` é
declarativo *sobre o que declara*; ausência de `services:` no manifest
significa "não tenho opinião sobre services" e não "remova todos os
services". Isto é coerente com o comportamento atual (no silo, o
manifest inteiro substituía a entrada `"manifest"` — não havia
interação com `"service"`). Se o operador quiser limpar uma slice,
declara `services: []` explicitamente, e o fan-out escreve
`{services: []}` no scope `"service"` — convergência idempotente para
zero entidades.

### 4.2 Reconciliação subsequente — Opção A3 (recomendada)

Três opções foram avaliadas; descartadas duas, recomendada A3.

**A1 — manter `reconcileToEnvelope("manifest", ...)` inalterado.**
Composite meta-scope (PR #12) continua resolvendo observe/apply.
- ✅ Diff mínimo no caminho de apply.
- ❌ `observed_state` continua sendo escrito em row keyed por
  `"manifest"`. `get_state(scope="server")` segue vendo `{}`.
- ❌ Periodic reconcile segue ignorando `"manifest"`. Drift do que
  `apply_manifest` declarou continua não detectado per-scope.
- **Veredicto: NÃO RESOLVE.** Apenas conserta o desired-store; o
  observed-store mantém o silo.

**A2 — substituir por N `reconcileToEnvelope(kind, ...)` per-scope.**
`doApplyManifest` itera as slices declaradas e chama o reconcile uma
vez por scope.
- ✅ Observed e desired ambos per-scope, naturalmente.
- ✅ `get_state` per-scope vê o resultado imediatamente.
- ❌ O Approval Gate avalia per-scope; um manifest multi-kind pode
  abrir múltiplos pending approvals simultaneamente, exigindo
  agregação no wire envelope. Mudança de comportamento observável.
- ❌ Ordem entre scopes (network antes de server, server antes de
  service) passa a importar; failure parcial entre scopes complica a
  resposta. Aproxima o tool de uma orquestração — mais código, mais
  superfície de falha.
- ❌ Os testes existentes de `apply_manifest` que assumem **um único**
  envelope agregado quebram.
- **Veredicto: muito disruptivo para o objetivo cirúrgico.**

**A3 — manter `reconcileToEnvelope("manifest", ...)`, mas o reconcile
do scope `"manifest"` escreve observed per-kind. (RECOMENDADA.)**
- O composite meta-scope (PR #12) já observa per-kind internamente
  (`composite-provider.ts:67-89` no path `if (scope === "manifest")`).
  Cada slice observada carrega seu *kind* nativo (`server:foo`,
  `network:bar`).
- O reconcile, ao invés de chamar `putObservedState(pool, "manifest", observed)`,
  **particiona** o `ObservedSlice` retornado pelo composite por kind, e
  chama `putObservedState(pool, <kind>, slice_<kind>)` para cada kind
  presente. A row Postgres keyed por `"manifest"` deixa de ser
  escrita; rows per-kind ficam coerentes com `get_state` per-scope.
- O composite.apply continua entity-routed (já é hoje — `tools.ts`
  e `composite-provider.ts:148-158` não mudam).
- O Approval Gate continua avaliando o plan agregado em **uma**
  chamada — wire envelope inalterado. **Backwards-compat dos testes
  existentes preservado.**
- **Veredicto: escopo de mudança contido em (`tools.ts` apply branch,
  `reconcile.ts` particionador), gate inalterado, wire inalterado.**

A spec adota **A3**. O plano detalhará onde particionar (provavelmente
no path `reconcile()` quando `scope === "manifest"`, antes da chamada
a `putObservedState`); a decisão fina entre particionar dentro de
`reconcile.ts` ou dentro de `composite.observe("manifest")` é
delegação ao plano — não vincula a spec.

### 4.3 Caminho dry_run — inalterado

`apply_manifest({dry_run:true})` continua exatamente como
`tools.ts:605-610`: lê `getObservedState(pool, "manifest")` e roda
`plan(manifest, observed)`. **Não** dispara `writeDesired`, **não**
dispara `reconcile`, **não** dispara fan-out.

Justificativa para não migrar dry_run agora:

1. Dry_run não tem o bug — não há escrita no desired-store, nada
   silado.
2. `getObservedState(pool, "manifest")` retorna `{}` se nunca houve
   apply prévio com o scope `"manifest"` — degradação graciosa
   pré-existente.
3. Quando A3 entra em produção, o reconcile do scope `"manifest"`
   **pára de gravar** rows com `scope="manifest"` no `observed_state`.
   Rows residuais (de runs pré-fix) ficam órfãs; serão purgadas
   naturalmente quando o operador limpar ou ignoradas (nenhum caller
   per-scope as lê). Sem migration de schema; sem cleanup obrigatório.
4. Migrar dry_run para fan-out implicaria query agregada per-kind
   (`getObservedState` por kind, união) — não-trivial e fora do
   escopo cirúrgico. Pode ser follow-up se observado degradação.

### 4.4 Forma do envelope de resposta

Inalterada. `reconcileToEnvelope("manifest", actor, defaultIsSensitive)`
continua retornando um único `WriteEnvelope`:

- `applied` se nenhum item foi withheld pelo gate;
- `pending_approval` (com um único `approval_id`) se ≥1 item foi
  withheld — a lógica de pinning de `requested.entity` em
  `reconcileToEnvelope` (`tools.ts:344-385`) já trata o caso "no single
  requested entity" pegando o primeiro pending. Esse comportamento
  permanece; `bevox-meta-api` deve seguir pollar approvals por id como
  já faz.

### 4.5 Cross-scope read union + write strip-to-own (revisão 2026-05-26-b)

**Gap identificado durante implementação (Task 3.1 capstone):** após o
fan-out (§4.1), `loadDesired("server")` retorna apenas `{servers:[...]}`
sem `networks`. `plan(desired, observed)` valida cross-references
(server.network → network entity) e lança `precondition: server
references network not declared` quando a network está em outro silo.
O resultado é que **`provision_server`, periodic reconcile de
scope=server, e `diff(scope=server)`** continuam falhando após fan-out
puro — i.e. caminho A do `bevox-meta-api` ainda bloqueado.

A spec inicial assumiu que fan-out + observed-partition bastariam.
Não bastam. Esta revisão fecha o gap **dentro do mesmo ciclo** (cross-
scope ortogonal só na superfície — na prática o seam
`loadDesired`/`writeDesired` é o ponto natural de mudança).

**Tabela de slice ↔ scope ↔ upstream deps (parsed do schema):**

| Scope    | Own slice    | Upstream deps             |
|----------|--------------|---------------------------|
| `backup` | `backups`    | —                         |
| `dns`    | `dns`        | —                         |
| `network`| `networks`   | —                         |
| `server` | `servers`    | `network`                 |
| `service`| `services`   | `server`, `network`       |
| `volume` | `volumes`    | `server`                  |

Os deps refletem campos do schema (`Server.network: string`,
`Volume.server: string`, `Service.server_selector` resolve a server,
que por sua vez resolve a network).

**`loadDesired(scope)` (entrypoint-wiring.ts):**

- `scope === "manifest"`: união de **todos** os silos per-scope (síntese
  do manifest completo). Equivalente ao silo `"manifest"` pré-fan-out.
- `scope` em `{server, service, volume}`: união **own slice + upstream
  slices** (read-time merge — read-only context pra plan() validar
  cross-refs).
- `scope` em `{network, dns, backup}`: apenas own slice (sem deps).

**`writeDesired(scope, state)` (entrypoint-wiring.ts):**

- Strip-to-own-slice: persiste apenas `state[ownSlice(scope)]` no Map
  desse scope. Slices que não pertencem ao scope são descartadas no
  write — preserva o invariante "cada silo só carrega seu próprio kind".
- Idempotência: `writeDesired("server", {servers:[X], networks:[N]})`
  duas vezes resulta no mesmo silo `{servers:[X]}` (networks são
  persistidas no silo `"network"` em outra chamada — não duplicadas no
  silo `"server"`).
- Para `scope === "manifest"` (caminho não-mais-usado pós-fan-out):
  defensivamente persistir como-está (não-load-bearing — só
  back-compat se algum caller futuro voltar a chamar).

**Pseudocódigo (não vinculante — implementação no plano):**

```ts
const OWN_SLICE: Readonly<Record<string, keyof DesiredState>> = {
  backup: "backups", dns: "dns", network: "networks",
  server: "servers", service: "services", volume: "volumes",
};
const UPSTREAM_DEPS: Readonly<Record<string, readonly string[]>> = {
  server: ["network"], service: ["server", "network"], volume: ["server"],
};

const loadDesired = async (scope: string): Promise<DesiredState> => {
  if (scope === "manifest") {
    return Object.assign({}, ...Array.from(desiredByScope.values()));
  }
  const own = desiredByScope.get(scope) ?? {};
  const deps = UPSTREAM_DEPS[scope] ?? [];
  if (deps.length === 0) return own;
  const merged: DesiredState = { ...own };
  for (const dep of deps) {
    Object.assign(merged, desiredByScope.get(dep) ?? {});
  }
  return merged;
};

const writeDesired = async (
  scope: string, desired: DesiredState,
): Promise<void> => {
  const ownKey = OWN_SLICE[scope];
  if (ownKey === undefined) {
    desiredByScope.set(scope, desired); // defensive: unknown scope
    return;
  }
  const stripped: DesiredState =
    desired[ownKey] !== undefined
      ? ({ [ownKey]: desired[ownKey] } as DesiredState)
      : {};
  desiredByScope.set(scope, stripped);
};
```

**Trade-offs:**
- ✅ Cross-scope refs em `plan()` resolvem (caminho A unbocks).
- ✅ Per-scope silos permanecem cleanly partitioned (strip-on-write).
- ✅ Idempotente: writes não acumulam slices.
- ⚠ Read amplification: `loadDesired("service")` agora lê 3 silos (vs 1).
  Custo: O(1) extra `Map.get` por dep. Desprezível.
- ⚠ Assumption: o conjunto de `UPSTREAM_DEPS` é estável (mirror do
  schema). Mudança de schema pode exigir update aqui. Documentar.

**Por que NÃO está em §4.2 (reconcile partition)?** A read-union é
seam-level (entrypoint-wiring), não reconciler-level. Mantém reconcile
provider-agnostic per CONTRIBUTING. A partition do observed (§4.2)
acontece dentro do reconcile porque é write-side; a union do desired
acontece no seam porque é read-side. Simetria intencional.

## 5. Invariantes preservados

| # | Invariante | Como esta spec preserva |
|---|---|---|
| 1 | Specs first | Esta spec precede o código; nada de `core/src/` muda antes de plan aprovado. |
| 2 | Idempotência | Fan-out write é overwrite per-scope com a mesma slice ⇒ mesmo `Map`. Property tests existentes inalterados; o plano estende coverage onde necessário sem enfraquecer asserções. |
| 3 | Fail-safe, never fail-deleting | Fan-out só **adiciona** entradas no `Map`; **zero** `delete`/`destroy`. Slices ausentes no manifest **não** apagam scopes não declarados (cf. §4.1 "Slices ausentes"). Operador removendo entidades dentro de uma slice declarada gera drift via per-scope diff (canal reportável, nunca auto-deletado). |
| 4 | Secrets at apply only | Fan-out é puro `DesiredState` (referências `secret:<ref>` permanecem strings). Nenhum `resolveSecret` no caminho. |
| 5 | StateEvent actor | Inalterado. `reconcileToEnvelope` continua propagando `actor` para o reconcile, que continua escrevendo `StateEvent` com actor não-anônimo. |

## 6. Test strategy

| Camada | Teste | O que cobre |
|---|---|---|
| Unit (`core/src/agent/tools.test.ts`) | `apply_manifest` apply path com manifest multi-kind ⇒ `loadDesired("network")`, `loadDesired("server")`, etc. retornam slices corretas; `loadDesired("manifest")` retorna `{}` (silo eliminado). | §4.1 fan-out write. |
| Unit (`tools.test.ts`) | `apply_manifest` apply path com manifest mono-kind (só `servers`) ⇒ apenas `loadDesired("server")` populado; outros scopes ficam intocados. | §4.1 slices ausentes. |
| Unit (`tools.test.ts`) | `apply_manifest({dry_run:true})` retorna envelope com `status:"planned"` (não `"applied"`). | Regressão §1.4. |
| Unit (`tools.test.ts`) | `apply_manifest` apply path seguido de `provision_server` com referência à network do manifest ⇒ `provision_server` lê network do `loadDesired("server")` (ou via mergeDesired correto). | Cenário do `bevox-meta-api` caminho A. |
| Unit (`core/src/reconciler/reconcile.test.ts`) | reconcile do scope `"manifest"` ⇒ `putObservedState` é chamado per-kind (`"server"`, `"network"`, …); **não** com scope `"manifest"`. | §4.2 A3 particionamento. |
| Integration (`core/src/agent/rest.test.ts`) | `POST /api/apply` com manifest multi-kind, depois `GET /api/state?scope=server` ⇒ vê os servers. | Vincula REST contract ao fan-out per-scope. |
| Property (existentes) | Idempotency property tests sob `core/src/reconciler/idempotency*.property.test.ts`. | **Sem alteração / sem enfraquecimento.** Se a partição per-kind no reconcile exigir extensão das properties, o plano declara. |
| Live (`@live`) | Não obrigatório — mudança não envolve novo provider nem nova HTTP wire. Live tests pré-release existentes continuam suficientes. | n/a |

Fakes-only (CONTRIBUTING §"Tests never touch real infra"): toda a
suite acima usa `core/test/fakes/`. Sem chamadas a Hetzner/Docker
real.

## 7. Migração / rollout

- **Backwards-compatible no wire.** Tool `apply_manifest` API pública
  inalterada; clients (`bevox-meta-api`, qualquer agente OpenClaw/Vox)
  não precisam alterar nada.
- **Sem migration de dados.** `desiredByScope` é `Map` in-process —
  reset a cada boot do daemon. Não há row Postgres do desired-store a
  converter.
- **`observed_state` rows com `scope="manifest"` residuais.** Após o
  fix, o reconcile pára de escrevê-las. Rows pré-existentes ficam
  órfãs; nenhum caller per-scope as lê. Sem operação obrigatória; um
  `DELETE FROM observed_state WHERE scope='manifest'` opcional é
  cosmético.
- **Sem nova config-knob.** Diferente de PR #11 (`MANAGED_MESH`) e PR
  #13 (`MANAGED_SERVICES`), este fix é incondicional — não há modo
  legado a preservar via flag (o comportamento atual é o bug).
- **Reversibilidade.** Trivial: revert do commit restaura o silo. Não
  há schema, persistência ou contrato de wire que prenda.
- **Ordem de deploy.** Após merge, rebuild + `sudo systemctl restart
  bevox-daemon.service` é suficiente. O `bevox-meta-api` retoma o
  caminho A em seguida.

## 8. Open questions

- **Ponto de particionamento (A3).** A spec recomenda particionar em
  `reconcile.ts` quando `scope === "manifest"` (antes da chamada a
  `putObservedState`). O plano pode escolher empurrar para dentro de
  `composite.observe("manifest")` — devolvendo já o slice rotulado por
  kind. **Stakeholder:** plan-writer + owner; decisão técnica não
  invariante.
- **Comportamento de "slice ausente apaga slice persistida".** §4.1
  fixa a semântica: ausência ⇒ não toca. Se em algum momento o
  consumer quiser semântica "manifest é a verdade total" (ausência ⇒
  remove), exige nova spec. **Stakeholder:** owner; decisão de
  produto, não de implementação. Não-bloqueante para esta entrega.
- **Approval Gate identity para apply_manifest pending.** Mantém o
  comportamento atual (`requested.entity` ausente ⇒ pega o primeiro
  pending — `tools.ts:363-370`). Se o consumer reclamar de ambiguidade
  com manifests grandes, follow-up. **Stakeholder:** owner +
  consumidor `bevox-meta-api`.

## 9. Critérios de aceite

1. Após `POST /api/apply { manifest: {networks:[N], servers:[S]}, dry_run: false }`:
   - `loadDesired("network")` retorna `{ networks: [N] }`.
   - `loadDesired("server")` retorna `{ servers: [S] }`.
   - `loadDesired("manifest")` retorna `{}` (silo eliminado).
   - `getObservedState(pool, "server")` reflete o(s) server(s) após o
     reconcile aplicar (ou row vazia consistente em fake mode).
   - `getObservedState(pool, "manifest")` **não** é escrito pelo
     reconcile dessa chamada.
2. `apply_manifest({dry_run:true, manifest:{...}})` retorna
   `{status:"planned", plan:[...]}` — nunca `{status:"applied"}`.
3. `provision_server` chamado **após** `apply_manifest` declarando a
   `Network` correspondente enxerga a Network no desired do scope
   `"server"` (via `mergeDesired` per-scope), e o plan/apply
   subsequente não falha com `precondition: network not declared`.
4. Periodic reconcile (próximo tick após o apply) consome `loadDesired`
   per-scope corretamente — drift sweep observa as entidades
   declaradas, sem precisar visitar `"manifest"`.
5. `npm --prefix core test` permanece 100% verde. Property tests
   existentes não enfraquecidos. Nenhum teste removido sem
   justificativa registrada.
6. Comentário inline em `doApplyManifest` cita esta spec por path e
   explica o fan-out per-scope.

## 10. Arquivos antecipados

(Lista informativa para o plan-writer — não vincula o plano.)

- `core/src/agent/tools.ts` — `doApplyManifest` apply branch (§4.1).
- `core/src/reconciler/reconcile.ts` — particionamento de observed
  per-kind quando `scope === "manifest"` (§4.2 A3). Decisão fina entre
  reconcile.ts e composite-provider.ts fica para o plano.
- `core/src/reconciler/composite-provider.ts` — possivelmente, se o
  particionamento for empurrado para dentro do `observe("manifest")`.
- `core/src/agent/tools.test.ts` — testes §6.
- `core/src/agent/rest.test.ts` — integration test §6.
- `core/src/reconciler/reconcile.test.ts` — particionamento §6.

## 11. Relação com o plano e demais specs

- Esta spec **define o contrato**. Não vincula a ordem das fases do
  plano nem a granularidade dos commits TDD — isso é responsabilidade
  do `plan-writer`.
- Esta spec **não revisa** o PR #12 (`apply-manifest-meta-scope`); o
  meta-scope `"manifest"` segue válido como artefato interno do
  composite. A spec **resolve** o item #1 da §5 "Fora de escopo
  (latent)" daquela spec.
- PR #11 (`server-scope-transport-decoupling`) e PR #13
  (`tolerant-meta-scope-and-managed-services`) são contexto — esta
  spec não toca `MANAGED_MESH` nem `MANAGED_SERVICES`. O caminho A do
  `bevox-meta-api` (k3s, HTTP-only) é o consumidor que destrava com
  esta entrega; ele já roda com `MANAGED_MESH=off` +
  `MANAGED_SERVICES=off` (PRs #11/#13) e ainda assim hoje fica preso
  no silo aqui descrito.
- Após aceita, próximo passo: `plan-writer` produz
  `docs/superpowers/plans/2026-05-26-apply-manifest-silo-fanout.md`.
  Estimativa preliminar (não vinculante): F1 fan-out write (2 tasks
  TDD), F2 particionamento observed per-kind (2 tasks), F3 regression
  dry_run + REST integration (2 tasks). ~6 commits.
