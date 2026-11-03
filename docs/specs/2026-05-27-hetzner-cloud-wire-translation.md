# bevox-hetzner-mcp — HetznerCloud declarative→wire body translation

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (investigação live do bug #5a + brainstorm com Claude)
- **Tipo:** Spec-filha (aditiva, corretiva) — fecha gap herdado da v1
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN — v1 §"HetznerCloud provider"; comment inline em `core/src/providers/hetzner-cloud.ts:259-266` admite o gap explicitamente)
- **Spec irmã (imediata):** [2026-05-27-reconcile-envelope-failure-surface.md](./2026-05-27-reconcile-envelope-failure-surface.md) (PR-A, merged `61b2ca9`) — fixou o silent no-op; expôs o root cause real (esta spec).

## 0. Escopo e relação com as outras specs

Esta spec é **PR-B** de uma sequência iniciada por PR-A
(`reconcile-envelope-failure-surface`). PR-A garantiu que o envelope
não mente quando `applyPlan` falha — virou condição necessária para
PR-B ser observável em produção.

O escopo é **estritamente o `HetznerCloudProvider`**:
`core/src/providers/hetzner-cloud.ts` — função `toApiBody()` (linhas
269-279) e o orquestrador `apply()` (linhas 207-251). A spec corrige a
tradução declarative→wire para três kinds (`network`, `server`,
`volume`) e introduz um fixture de teste capaz de capturar bodies HTTP
sem ir live.

Não toca:

- v1/v2 invariantes (idempotência, fail-safe, secrets-at-apply,
  StateEvent actor) — todos preservados (§5).
- Schemas Zod públicos (`ManifestNetworkSchema`,
  `ManifestServerSchema`, `ManifestVolumeSchema`,
  `NetworkSchema`/`ServerSchema`/`VolumeSchema`). Schema enrichment
  (subnet objects, multi-network) é fora de escopo.
- API pública (MCP tools, REST envelopes, wire contract).
- Outros providers (`DockerProvider`, `WireGuardProvider`,
  `HetznerDNSProvider`, `BackupProvider`).
- v2 providers (Firewall, LoadBalancer, Certificate, PrimaryIP,
  Ingress) — já têm wire correto.
- `update` ops (apply path só `create` por enquanto — cf. comentário
  inline em `apply.ts`).

## 1. Contexto

### 1.1 Sintoma observado (live, pós PR-A)

`apply_manifest` com manifest `{networks:[{name:"bug5-diag",
ip_range:"10.50.0.0/16", subnets:["10.50.1.0/24"]}], dry_run:false}`:

- Pre PR-A: envelope `{"status":"applied"}` (mentira — `state_events`
  registrava error).
- Pós PR-A: envelope `{"status":"error", "error":{"code":"transient",
  "message":"POST /v1/networks failed with HTTP 400 …",
  "entity":"network:bug5-diag"}}` (verdade).

Hetzner Cloud retornou `400 {"code":"json_error","message":"A valid
JSON document is required."}` para o POST do reconciler. A
terminologia da mensagem é confusa (o JSON é tecnicamente válido) —
significa **schema mismatch**: a API rejeita o body porque a forma
declarativa do manifest não bate com o schema da API.

### 1.2 Causa-raiz

`toApiBody()` (`core/src/providers/hetzner-cloud.ts:269-279`) hoje
apenas STRIPa campos de bookkeeping (`hcloud_id`, `network_id`,
`status`) e forwarda o resto **como está**:

```ts
function toApiBody(
  _kind: Kind,
  desired: Record<string, unknown>,
): Record<string, unknown> {
  const { hcloud_id, network_id, status, ...body } = desired;
  void hcloud_id; void network_id; void status;
  return body;
}
```

Isso só passou no in-process fake porque o fake valida `name` e ignora
todo o resto. O comentário inline em `:259-266` ja admite o gap, em
literais:

> WIRE-SHAPE WARNING: the produced body is FAKE-SHAPED, NOT
> Hetzner-wire-shaped. A real Hetzner server create needs
> `server_type`/`image`/`location` and `networks: number[]` — not the
> declarative `type`/`network: string` carried here. […] Real
> declarative→wire field mapping is a hard prerequisite of the first
> `@live` run / any real-endpoint use (YAGNI: add it then, not before).

Esta spec ativa o "add it then".

### 1.3 Discrepâncias por kind

**Network:** manifest envia `subnets: ["10.251.1.0/24"]` (array de
strings — `ManifestNetworkSchema.subnets: z.array(z.string())`).
Hetzner API espera `subnets: [{ip_range, type, network_zone}]` (array
de objetos).

**Server:** manifest envia `type`/`image`/`location`/`network`
(referência por nome, string). Hetzner API espera
`server_type`/`image`/`location`/`networks: number[]` (IDs, não
nomes). A função `apply()` precisa fazer um lookup nome→id ANTES de
chamar `toApiBody`.

**Volume:** manifest envia `size: "10G"` (string), `fs` (filesystem),
`server` (nome). Hetzner API espera `size: 10` (number, GB), `format`
(renomeado), `server: <id>` (lookup nome→id) OU `location` (quando
standalone, sem server).

## 2. Goals

- `toApiBody("network", desired)` produz body Hetzner-shaped (com
  `subnets` como array de objetos `{ip_range, type, network_zone}`).
- `toApiBody("server", desired, refs)` produz body Hetzner-shaped (com
  `server_type` renomeado e `networks: number[]` resolvido via lookup
  nome→id).
- `toApiBody("volume", desired, refs)` produz body Hetzner-shaped (com
  `size: number`, `format` renomeado, `server: number` opcional).
- O lookup nome→id em `apply()` falha com `precondition` **antes** do
  POST — fail-safe preservado.
- Novo fixture `createCaptureHetznerHttpFake()` em
  `core/test/fakes/hetzner-http-capture.ts` captura `{url, method,
  body}` de cada call, permitindo asserts de wire shape sem ir live.
- `apply_manifest` live com `HCLOUD_TOKEN` real cria networks/servers
  reais na conta Hetzner; re-call idempotente retorna `changed:false`.
- Suíte existente continua verde (897/898). Property tests intactos.

## 3. Non-goals (YAGNI)

- **Schema enrichment do manifesto.** Manifest aceitar `subnets:
  [{ip_range, type, network_zone}]` objects diretamente ou
  `networks: string[]` (multi-network) em server é v2 spec. Hoje:
  manifest é simples-string, wire é object — a tradução fecha o gap.
- **DNS / backup providers.** `HetznerDNSProvider` e `BackupProvider`
  são providers separados, com translation paths próprios.
- **v2 providers (Firewall, LoadBalancer, Certificate, PrimaryIP,
  Ingress).** Já têm wire correto desde v2 Bloco A. Fora desta spec.
- **`update` ops.** Apply path em `core/src/providers/hetzner-cloud.ts`
  só implementa `create`; `update`/`remove`/`destroy` são no-ops
  intencionais (`:213-215`). Esta spec **não** muda isso.
- **Server image lookup.** Hetzner API aceita `image` por nome
  (`"ubuntu-24.04"`) ou id; pass-through. Sem lookup adicional.
- **Multi-zone network.** v1: `subnet.network_zone = "eu-central"`
  default para todos os locations que o ecossistema Bevox usa (nbg1,
  fsn1, hel1). Multi-region é v2 spec.
- **Multi-network server.** Manifest tem `network: string` (uma só).
  Wire `networks: [id]` é array de um elemento. Multi-network exige
  schema enrichment — fora de escopo.
- **Pure schema migration.** Sem `ALTER TABLE`; manifest schema
  inalterado; observed state inalterado.
- **Logger seam em providers.** Fora de escopo (registrado como
  follow-up em outras specs).

## 4. Design

### 4.1 Mudança 1 — Network wire body

`toApiBody("network", desired)` produz:

```jsonc
{
  "name": "<desired.name>",
  "ip_range": "<desired.ip_range>",
  "subnets": [
    {
      "ip_range": "<each desired.subnets[i]>",
      "type": "cloud",
      "network_zone": "eu-central"
    }
  ]
}
```

**Defaults v1 (opinionated):**

- `subnet.type = "cloud"` — cobre 99% dos cases. A alternativa
  `"server"` é para route-based legacy (fora de escopo).
- `subnet.network_zone = "eu-central"` — locations Hetzner usados pelo
  ecossistema Bevox (nbg1, fsn1, hel1) são todos `eu-central`.

Se manifest declarar `subnets` vazio ou undefined: enviar `subnets:
[]` (Hetzner aceita network sem subnet — usuário cria depois). Sem
crash, sem precondition.

**Trade-off considerado:**

- ✅ Cobre o caso real (Bevox runs eu-central). Sem branch novo no
  manifest schema (mantém retro-compat).
- ⚠ Deploys multi-region futuros precisarão de schema enrichment (v2).
  Aceitável — YAGNI.

### 4.2 Mudança 2 — Server wire body

`toApiBody("server", desired, refs)` produz (refs =
`{networkIds: number[]}`):

```jsonc
{
  "name": "<desired.name>",
  "server_type": "<desired.type>",      // RENAMED type → server_type
  "image": "<desired.image>",
  "location": "<desired.location>",
  "networks": [<refs.networkIds>],      // LOOKUP nome→id ANTES de POST
  "ssh_keys": [<desired.ssh_keys>],     // Hetzner aceita names OR ids — pass-through
  "labels": {<desired.labels>}
}
```

**Lookup pattern:** `apply()` resolve `networkIds` chamando
`findByName("networks", desired.network)` **antes** do POST. Reusa o
helper `findByName` existente (`:135-142`). Falha de lookup →
`ReconcileError("precondition", …, {entity})` — mesma classificação
de `assertPreconditions()` existente (`:165-184`), só que agora o
lookup retorna o `id` em vez de só `boolean`.

**Refactor sugerido (não vinculante — plan-writer decide):**
extender `assertPreconditions()` para retornar `{networkIds: number[]}`
quando `kind === "server"`, e passar esse refs ao `toApiBody`. Mantém
o invariante "precondition before write".

**Single-network simplificação v1:** manifest tem `network: string`
(uma só, já cabe na invariante). Wire `networks: [id]` é array de um
elemento.

**Trade-off:**

- ✅ Lookup falha → precondition antes do POST. Fail-safe preservado
  (nada criado em falha).
- ✅ Reusa `findByName` (já idempotente, já testado).
- ⚠ Lookup é um GET adicional por apply de server. Cost-benefit:
  network lookups são raros (poucas redes) e Hetzner cacheia.
  Aceitável.

### 4.3 Mudança 3 — Volume wire body

`toApiBody("volume", desired, refs)` produz (refs = `{serverId?:
number}`):

```jsonc
{
  "name": "<desired.name>",
  "size": <number_from_desired.size>,    // "10G" → 10 (parse)
  "format": "<desired.fs>",              // RENAMED fs → format
  "server": <refs.serverId>,             // LOOKUP nome→id, OMITIDO se ausente
  "location": "<desired.location>"       // PRESENTE quando server ausente (standalone)
}
```

**Size parsing:** schema atual é `z.string()` (e.g. `"10G"`). Hetzner
API quer GB number (e.g. `10`). v1 parse:

- `/^(\d+)\s*G$/i` → integer
- `/^(\d+)$/` → integer (assume GB)
- Outros formatos → `precondition` (e.g. `"500M"` rejected).

Fora de escopo: schema enrichment para aceitar `size: number`
diretamente. v2.

**Server lookup:** se `desired.server` presente (volume attached),
resolve `serverId` via `findByName("servers", desired.server)`.
Ausente → standalone volume; envia `location` em vez de `server`.

**Lower priority:** o caminho A do `bevox-meta-api` (k3s) não usa
volumes hoje. Esta mudança pode ficar para spec separada se o plan
ficar grande — mas a translation rule já está congelada aqui.

### 4.4 Mudança 4 — Fixture HTTP de captura

Novo arquivo `core/test/fakes/hetzner-http-capture.ts`:

```ts
export interface CaptureRequest {
  readonly url: string;
  readonly method: string;
  readonly body: unknown; // parsed JSON (or undefined for GET)
}

export interface CaptureHetznerHttpFake {
  readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  readonly requests: ReadonlyArray<CaptureRequest>;
  reset(): void;
}

export function createCaptureHetznerHttpFake(opts?: {
  /** Pre-seeded GET responses for findByName lookups. */
  readonly collections?: Record<string, ReadonlyArray<{ id: number; name: string }>>;
}): CaptureHetznerHttpFake;
```

**Comportamento:**

- POST `/v1/<collection>`: parse body como JSON, registra em
  `requests`, retorna `201 {<collection_singular>: {id: N, name:
  body.name}}`. Auto-increment id.
- GET `/v1/<collection>`: retorna o seed (`opts.collections`),
  paginated trivialmente (`{<collection>: [...], meta: {pagination:
  {next_page: null}}}`).
- Outros métodos / paths: throw "unhandled in capture fake".
- Tests podem inject erros via opção `errorOnNextPost?: {status:
  number, body: unknown}`.

**Por que separado de `hetzner-http.ts` (fake existente)?** O fake
existente é stateful (mantém uma store em memória, valida shape
relaxada). Esta fixture é puramente para **wire-shape assertion** —
mantém histórico de bodies, não simula estado. Separação de
responsabilidade.

### 4.5 Mudança 5 — `toApiBody` signature

De:

```ts
function toApiBody(
  _kind: Kind,
  desired: Record<string, unknown>,
): Record<string, unknown>
```

Para:

```ts
interface ApiBodyRefs {
  readonly networkIds?: ReadonlyArray<number>;
  readonly serverId?: number;
}

function toApiBody(
  kind: Kind,
  desired: Record<string, unknown>,
  refs?: ApiBodyRefs,
): Record<string, unknown>
```

Implementação per-kind (switch ou map). Plan-writer decide a
granularidade — sugestão: 3 helper functions privadas (`networkBody`,
`serverBody`, `volumeBody`) chamadas do switch.

### 4.6 Orquestração em `apply()`

Pseudocódigo (não vinculante):

```ts
async apply(action: PlanAction): Promise<ApplyResult> {
  const kind = kindOf(action.entity);
  if (action.op === "remove" || action.op === "destroy") {
    return { entity: action.entity, op: action.op, changed: false };
  }
  const { collection, schema } = KINDS[kind];
  const desired = parseDesired(schema, action) as Record<string, unknown> & { name: string };

  // 1. Idempotency: observe-before-create (unchanged).
  const existing = await findByName(collection, desired.name);
  if (existing) return { entity: action.entity, op: action.op, changed: false };

  // 2. Precondition + ref resolution (extended).
  const refs = await resolveRefs(kind, desired, action.entity);
  //    ^ throws ReconcileError("precondition") if referenced network/server missing.

  // 3. Wire body (NEW: per-kind translation).
  const body = toApiBody(kind, desired, refs);

  // 4. POST (unchanged).
  const res = await http.request(`${baseUrl}/${collection}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.json().catch(() => undefined);
  return { entity: action.entity, op: action.op, changed: true };
}
```

`resolveRefs()` substitui `assertPreconditions()` — retorna `refs` ou
throwa `precondition`. Mantém invariante "precondition before write".

## 5. Invariantes preservados

| # | Invariante (de CONTRIBUTING.md §"Ground rules") | Como esta spec preserva |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | `findByName` lookups e `observe-before-create` inalterados. Re-apply é no-op (`changed:false`). Property tests em `core/src/reconciler/idempotency*.property.test.ts` intactos. |
| 3 | Fail-safe, never fail-deleting | Lookup falha → `precondition` **antes** do POST. Nada criado em falha. Wire-shape errors viram `transient` (HTTP 400 do Hetzner) e propagam via PR-A envelope; nada é deletado/rollback. |
| 4 | Secrets at apply only | Translation pura (no-secret-resolution). `HCLOUD_TOKEN` é resolvido pelo `HttpClient.defaultHeaders` em construção; toApiBody não vê secrets. Sem canal novo de leak. Sentinels-test em `core/src/reconciler/secret-apply.test.ts` cobre. |
| 5 | StateEvent actor | Inalterado. `apply()` continua sem tocar StateEvent diretamente — quem grava é `applyPlan` via `ApplyContext` (`reconciler/apply.ts`). |

## 6. Test strategy

| Camada | Teste | O que cobre |
|---|---|---|
| Unit (`core/src/providers/hetzner-cloud.test.ts`) | Wire shape — network: dado `desired = {name:"bevox-priv", ip_range:"10.50.0.0/16", subnets:["10.50.1.0/24"]}`, asserts captured request body matches `{name, ip_range, subnets:[{ip_range:"10.50.1.0/24", type:"cloud", network_zone:"eu-central"}]}`. | §4.1 |
| Unit (`hetzner-cloud.test.ts`) | Wire shape — server: dado `desired = {name:"app-1", type:"cx32", image:"ubuntu-24.04", location:"nbg1", network:"bevox-priv", ssh_keys:["mykey"], labels:{role:"app"}}` + seed networks `[{id:42, name:"bevox-priv"}]`, asserts captured body matches `{name, server_type:"cx32", image, location, networks:[42], ssh_keys:["mykey"], labels:{role:"app"}}`. | §4.2 |
| Unit (`hetzner-cloud.test.ts`) | Server lookup failure: `desired.network = "missing-net"`, seed vazio → `apply()` throws `ReconcileError("precondition", ..., {entity:"server:app-1"})`. **Nenhum POST emitido** (assert `requests.filter(r => r.method === "POST").length === 0`). | §4.2 fail-safe |
| Unit (`hetzner-cloud.test.ts`) | Wire shape — volume attached: `desired = {name:"data-1", size:"10G", fs:"xfs", server:"app-1"}` + seed servers `[{id:7, name:"app-1"}]`, asserts body `{name, size:10, format:"xfs", server:7}`. Standalone: `desired.server` undefined + `location:"nbg1"` → body `{name, size:10, format:"xfs", location:"nbg1"}`. | §4.3 |
| Unit (`hetzner-cloud.test.ts`) | Volume size parse: `"10G"` → 10, `"100"` → 100, `"500M"` → throws `precondition`. | §4.3 size parsing |
| Unit (`hetzner-cloud.test.ts`) | Network sem subnets: `desired.subnets = []` (ou undefined) → body `{name, ip_range, subnets:[]}`. | §4.1 empty subnets |
| Unit (`hetzner-cloud.test.ts`) | Idempotência: re-apply após primeira criação retorna `changed:false`, **zero POSTs adicionais** capturados. | Property invariant 2 |
| Fixture (`core/test/fakes/hetzner-http-capture.test.ts`) | Smoke do próprio fake: POST registra request, GET retorna seed, métodos não-suportados throw. | §4.4 |
| Unit (existing) | `core/src/providers/hetzner-cloud.test.ts` existing test suite (idempotência conformance, `verify`, `observe`, etc.) continua verde sem modificação. | Regressão |
| Property (existentes) | `core/src/reconciler/idempotency*.property.test.ts` inalteradas. Sem enfraquecimento. | Garantia central |
| Live (`@live`, opcional manual) | `core/test/live/hetzner-cloud-wire.live.test.ts`: com `HETZNER_LIVE_TOKEN`, apply minimal network (gratuito) → verifica criação real; segunda call idempotente. Cleanup manual ou via tear-down opcional. | §9 critério 1 |

Fakes-only para CI (CONTRIBUTING §"Tests never touch real infra").
`@live` apenas pré-release, manual, sandbox. Suite `unit` glob exclui
`*.live.test.ts` (`core/vitest.config.ts`).

## 7. Migração / rollout

- **Backwards-compatible** para todos os testes existentes que usam o
  fake stateful (`hetzner-http.ts`) — esse fake valida `name` only e
  continua aceitando os novos bodies (que mantêm `name`).
- **Behavior change em produção:** após esta PR + `HCLOUD_TOKEN` real,
  `apply_manifest` com manifest válido cria recursos reais na conta
  Hetzner. Pre-fix retornava `error` honesto (PR-A); pós-fix retorna
  `applied` quando consegue criar.
- **Sem schema migration.** Manifest schema, observed state e wire
  contract (envelope) inalterados.
- **Sem nova config-knob.** Mudança incondicional — comportamento
  atual produz HTTP 400 em qualquer caminho real; não há modo legado
  a preservar.
- **Reversibilidade.** Trivial: revert do commit restaura `toApiBody`
  cego. Mas o revert é desencorajado — restaura o bug.
- **Ordem de deploy.** Após merge, rebuild + `sudo systemctl restart
  bevox-daemon.service`. O consumer `bevox-meta-api` observa
  `apply_manifest` retornar `applied` com `state_events` mostrando
  `result=ok` (em vez de `result=error` com HTTP 400).
- **Sandbox cost:** network creation na Hetzner é gratuito; server
  creation cobra (~€4/mês por cx22). Owner decide quando flipar
  auto-mode para apply live.

## 8. Open questions

- **Default `network_zone` para deploys non-eu-central futuros.** Spec
  assume eu-central (Bevox runs nbg1/fsn1/hel1). Se futuramente um
  deploy precisar `us-east` ou `ap-southeast`, schema enrichment é
  necessário (manifest declara network_zone). **Stakeholder:** owner;
  decisão técnica não-invariante.
- **Refactor `assertPreconditions` → `resolveRefs`.** Pseudocódigo em
  §4.6 sugere unificar precondition-check + ref-resolution. Plan-writer
  decide se vale a pena ou se mantém dois helpers separados.
  **Stakeholder:** plan-writer + owner.
- **Volume parsing tolerance.** Hetzner Cloud API aceita `size` apenas
  como number (GB). Esta spec rejeita `"500M"` como `precondition`.
  Alternativa: round-up para 1 GB. **Stakeholder:** owner. Decisão
  default: reject strict (fail-loud).
- **`hetzner-http.ts` (fake stateful existente) precisa de
  retrofit?** Tests existentes desse fake continuam verdes porque
  validam `name` only. Mas a precisão da simulação melhora se o fake
  também aceitar bodies wire-shaped. Follow-up opcional; não-bloqueante
  para esta spec.

## 9. Critérios de aceite

1. **Network end-to-end (fake capture):** `apply_manifest` com
   manifest `{networks:[{name, ip_range, subnets:["x/y"]}]}` →
   captured POST body matches `{name, ip_range, subnets:[{ip_range,
   type:"cloud", network_zone:"eu-central"}]}`.

2. **Server end-to-end (fake capture):** apply_manifest com network +
   server → primeiro POST cria network (id N); segundo POST cria
   server com `server_type` renomeado, `networks:[N]` resolvido, e
   `ssh_keys`/`labels` pass-through.

3. **Server lookup failure (fail-safe):** server referencia network
   inexistente → `ReconcileError("precondition", ..., {entity})`
   antes do POST do server. Network POST não emitido (sem network no
   manifest) ou network POST emitido (network presente mas server
   pediu outra) — em ambos os casos, **zero server POST**.

4. **Volume wire shape (lower priority):** attached e standalone
   ambos testados. Size parsing rejeita `"500M"` com `precondition`.

5. **Fake fixture (`createCaptureHetznerHttpFake`):** smoke test do
   próprio fixture passa. Asserts wire shape contra capture funciona
   para os 3 kinds.

6. **Backwards-compat (`hetzner-http.ts` fake stateful):** todos os
   testes existentes que usam `createHetznerHttpFake()` continuam
   verdes sem modificação.

7. **Suite completa:** `npm --prefix core test` permanece verde
   (897/898; o 1 skipped é `@live`). Property tests intactos.
   Idempotência conformance harness passa.

8. **PR-A integration:** envelope `error` surface (PR-A) continua
   honrando `FailedItem.errorClass`:
   - Lookup failure (esta spec) → `precondition` (não-retriable).
   - Hetzner 5xx (transient HTTP) → `transient` (retriable).
   - Hetzner 4xx wire (caso latente, hoje extinto pós-fix) →
     `precondition` ou `conflict` (HttpClient classifica).

9. **Live smoke (opcional manual):** com `HCLOUD_TOKEN` real, a
   sequência minimal network → server → idempotent re-apply funciona
   end-to-end. Cleanup manual.

10. **Comentário inline removido / atualizado.** O bloco "WIRE-SHAPE
    WARNING" (`:259-266`) é substituído por referência a esta spec
    (`docs/specs/2026-05-27-hetzner-cloud-wire-translation.md`) e
    documenta o contrato per-kind ativo.

## 10. Arquivos antecipados

(Lista informativa para o plan-writer — não vincula o plano.)

- `core/src/providers/hetzner-cloud.ts` — `toApiBody` per-kind
  (§4.1/4.2/4.3) + `apply()` orchestration (lookup → translate →
  POST, §4.6). Cerca de 60-100 linhas de mudança.
- `core/test/fakes/hetzner-http-capture.ts` — **NOVO** (§4.4). Cerca
  de 80-120 linhas.
- `core/test/fakes/hetzner-http-capture.test.ts` — **NOVO** (§6,
  fixture smoke). Cerca de 30-50 linhas.
- `core/src/providers/hetzner-cloud.test.ts` — novo `describe` block
  para wire shape (§6). Cerca de 150-200 linhas.
- `core/test/live/hetzner-cloud-wire.live.test.ts` — **NOVO** opcional
  (§9 critério 9). Cerca de 50-80 linhas.

## 11. Relação com o plano e demais specs

- Esta spec **define o contrato**. Não vincula a ordem das fases do
  plano nem a granularidade dos commits TDD — isso é responsabilidade
  do `plan-writer`.
- Ordem sugerida (não-vinculante): F1 capture fixture + network wire
  shape (~3 tasks TDD), F2 server wire shape + network lookup
  (~3 tasks), F3 volume wire shape + size parsing (~2 tasks), F4
  comment cleanup + opcional `@live` test (~1 task). ~9 commits.
- **PR-A** (`reconcile-envelope-failure-surface`) é prerequisito
  merged: sem ele, o envelope continua mentindo "applied" mesmo após
  esta spec materializar. PR-A já merged em `61b2ca9`.
- **Future v2 specs** (schema enrichment para multi-subnet,
  multi-network, multi-zone): construirão **sobre** este contrato,
  não contra ele. Esta spec é o piso da tradução; v2 só adiciona
  branches no schema do manifesto.
- Após aceita, próximo passo: `plan-writer` produz
  `docs/superpowers/plans/2026-05-27-hetzner-cloud-wire-translation.md`.
