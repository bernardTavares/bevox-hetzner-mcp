# bevox-hetzner-mcp v2 — Architecture Contract

- **Data:** 2026-05-20
- **Status:** Em revisão
- **Autor:** Bernard (brainstorm com Claude)
- **Tipo:** Contrato de arquitetura (spec-mãe de v2)
- **Spec-pai:** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (v1)

## 0. Status e escopo

Este documento é **contrato, não roadmap**. Define invariantes, interfaces
estendidas e schemas concretos das novas entidades de v2. Não fixa ordem nem
prazo de implementação.

**Dentro do escopo:**
- Princípios invioláveis que toda spec-filha de v2 honra.
- Interfaces v1 que ganham extensões para acomodar v2 (`Provider<T>`,
  Approval Gate, StateEvent).
- Schemas concretos das novas entidades, agrupados em quatro **blocos**:
  borda pública, HA/DR, identidade/segurança, observability/custo.
- Dependências entre blocos (grafo, não ordem).

**Fora do escopo:**
- Cronograma e ordem de implementação dos blocos.
- Plano de fases internas de cada spec-filha.
- Decisões internas de cada provider (algoritmos, esquema de tabelas,
  layout de módulos) — pertencem à spec-filha correspondente.

Cada bloco vira uma **spec-filha** dedicada (`docs/specs/<data>-...-v2-bloco-<X>-...md`)
que cita esta como base e não pode contradizê-la. Mudança em §1 ou §2 deste
contrato exige revisão coordenada das specs-filhas afetadas.

## 1. Princípios invioláveis de v2

Estendem (não substituem) os princípios de v1 — idempotência, fail-safe,
sem rollback automático destrutivo, drift reportado nunca corrigido em
silêncio, todo `StateEvent` registra o agente ator.

### 1.1 Padrão de referência: selector, nunca ref direta

Entidades v2 que precisam apontar para entidades v1 (ou outras v2) usam
**seletor** (mesmo padrão de `Service.server_selector` em v1), nunca ref
nominal direta. Exemplos: `Firewall.applied_to: server_selector`,
`LoadBalancer.targets: service_selector`.

Consequências:
- Manifesto v1 permanece byte-a-byte válido.
- Ordem de declaração no manifesto é livre; o reconciler resolve grafo.
- A pergunta "que recursos esta ação afeta?" tem resposta única e
  consultável: "tudo que o selector casa".

### 1.2 Toda entidade v2 tem provider com fake testável

Idêntico à regra de v1. Nenhum provider v2 toca Hetzner/Docker/etc. em
testes; suíte `@live` opcional manual permanece.

### 1.3 Toda mutação destrutiva passa por Approval Gate

Sem exceção, incluindo operações novas de v2 (ex.: revogar
`CapabilityToken`, remover regra de `Firewall` que cubra Server em uso,
re-bind de `PrimaryIP`). Spec-filha decide a classificação concreta; este
contrato só fixa que a lista de operações sensíveis **cresce**, nunca
encolhe.

### 1.4 Toda ação registra agente ator + capability token usado

`StateEvent` ganha campo `capability_token_id` (§2.4). Auditoria deixa de
responder apenas "qual agente fez" e passa a responder "com qual escopo
fez". Pré-requisito para que, após uma revogação de token, a trilha
continue **auditável por token-id** (queries como "tudo que foi feito com
token X antes da revogação"); a denegação de novos usos é **forward-only**
e está descrita em §3 (`CapabilityToken`).

### 1.5 PolicyEngine avalia invariantes no `plan`, falha antes de `apply`

Novo subsistema (Bloco C) recebe o `plan` produzido pelo reconciler e
avalia regras declarativas antes do Approval Gate. Violações de severidade
`error` impedem `apply`; `warn` anexam-se ao plan e são exibidas no
Approval Gate. Mantém o princípio v1 de **falha cedo, fora-de-banda do
recurso real**.

### 1.6 Fail-safe estende a v2

Drift detectado em recurso v2 nunca causa remoção de recurso v1 não
solicitada — e vice-versa. Exemplos: remover `Firewall` do manifesto **não**
remove o `Server` que ele cobria; remover `Ingress` **não** remove o
`Service` backend nem o `Certificate`. Cada provider é responsável por
desacoplar seu lifecycle dos vizinhos.

## 2. Interfaces estendidas

### 2.1 `Provider<T>` — assinatura permanece

Nenhuma mudança na interface base. Novos providers (`HetznerFirewallProvider`,
`HetznerLoadBalancerProvider`, etc.) a implementam exatamente como
`HetznerCloudProvider` em v1. Garante reuso da harness de fakes, do
circuit breaker (v1 Fase 6) e do registro de `StateEvent`.

### 2.2 Selector resolution — algoritmo e garantias

Selectors em v2 reusam a sintaxe de `server_selector` v1 (`{ label: X }`,
`{ name: Y }`, conjunções). O resolver é **determinístico** (entrada
manifesto + estado observado → mesma saída) e **reportável**: tool MCP
`resolve_selector(selector)` retorna a lista exata de entidades casadas
no momento, permitindo ao agente verificar impacto antes de qualquer
`plan`.

Garantia operacional: o reconciler chama `resolve_selector` *uma vez por
ciclo* e congela o resultado para a duração do `plan`/`apply` — selector
que muda mid-ciclo (label mexido em paralelo) só afeta o próximo ciclo.

### 2.3 Approval Gate — campos adicionais no `plan`

O `plan` retornado pelas tools de escrita ganha dois campos:

| Campo | Tipo | Origem | Obrigatório quando |
|---|---|---|---|
| `cost_estimate` | `{ monthly_delta_eur, breakdown[] }` | Bloco D (pricing) | sempre presente; `{ monthly_delta_eur: 0, breakdown: [] }` quando o plan não toca recurso cobrado |
| `policy_violations` | `PolicyViolation[]` | Bloco C (PolicyEngine) | sempre presente; array vazio se nenhum |

O Approval Center exibe ambos. Aprovação de plan com `policy_violations`
de severidade `error` é **impossível** (tool retorna `precondition_failed`
antes de criar `approval_id`).

### 2.4 StateEvent — campos adicionais

`StateEvent` ganha:

| Campo | Tipo | Obs |
|---|---|---|
| `capability_token_id` | `string \| null` | `null` para eventos de sistema (drift periódico, reconcile housekeeping) |
| `policy_eval_result` | `{ violations[], evaluated_at } \| null` | preenchido em eventos de `plan`; `null` em eventos puramente de leitura |

Compat: campos opcionais. Eventos v1 lidos por consumidores v2 recebem
`null` em ambos. Migração de schema Postgres é aditiva (sem alter
destrutivo).

## 3. Entidades novas — schemas concretos

Notação: campo seguido de `?` é opcional. `*_selector` reusa a sintaxe de
v1 (§2.2). Invariantes listados são avaliados pela PolicyEngine no `plan`.

### Bloco A — Borda pública

#### Firewall

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | identidade no manifesto |
| `rules` | `FirewallRule[]` | conjunto allow-list (sem ordem; semântica nativa Hetzner Cloud) |
| `applied_to` | `server_selector` | mesmo padrão de Service |

`FirewallRule`:

| Campo | Tipo | Obs |
|---|---|---|
| `direction` | `"in" \| "out"` | |
| `protocol` | `"tcp" \| "udp" \| "icmp" \| ...` | |
| `port` | string (`"443"` \| `"80-90"`) | omitir para icmp |
| `source_ips?` | `CIDR[]` | obrigatório em `direction: in` |
| `destination_ips?` | `CIDR[]` | obrigatório em `direction: out` |

Invariantes:
- Todo `Server` matched por algum `Firewall.applied_to` (sem firewall →
  PolicyEngine `warn`, não `error`).
- Nenhuma regra permite `0.0.0.0/0` em porta SSH sem campo
  `acknowledged_public_ssh: true`.

#### LoadBalancer

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `location` | string (Hetzner location) | |
| `algorithm` | `"round_robin" \| "least_connections"` | |
| `targets` | `service_selector` | |
| `health_check` | `{ protocol, port, path?, interval, timeout, retries }` | |

Invariantes:
- `targets` casa ≥1 `Service` ou PolicyEngine `error`.
- Health check `protocol` ∈ `{http, https, tcp}`.

#### Certificate

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `type` | `"managed" \| "uploaded"` | managed = ACME via Hetzner |
| `domains` | `string[]` | ≥1 |
| `certificate_pem?` | string | obrigatório se `type: uploaded` |
| `private_key_secret_ref?` | string | obrigatório se `type: uploaded`; resolve via secret store |

Invariantes:
- `type: managed` exige zona DNS gerenciada por `HetznerDNSProvider`
  cobrindo `domains[*]` (PolicyEngine cruza com manifesto DNS).
- `type: uploaded` exige `certificate_pem` E `private_key_secret_ref`.

#### PrimaryIP

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `type` | `"ipv4" \| "ipv6"` | |
| `location` | string | |
| `assignee_selector?` | `server_selector` | matched ≤1 server por IP |

Invariantes:
- `assignee_selector` casa **no máximo** 1 server; ≥2 = PolicyEngine
  `error` (PrimaryIP não é balanceador).

#### Ingress

| Campo | Tipo | Obs |
|---|---|---|
| `hostname` | string (FQDN) | |
| `tls` | `{ certificate_ref: string }` | nome de um `Certificate` |
| `routes` | `IngressRoute[]` | ≥1 |
| `firewall_ref?` | string | nome de um `Firewall`; aplica-se aos **Servers backend** alcançados pelo LB (Hetzner Cloud não aceita Firewall direto no LB) |
| `load_balancer_ref` | string | nome de um `LoadBalancer` |

`IngressRoute`:

| Campo | Tipo | Obs |
|---|---|---|
| `path` | string (`"/"` \| `"/api"` \| ...) | first-match por ordem |
| `backend` | `{ service_selector, port }` | |

Invariantes:
- `tls.certificate_ref` resolve para `Certificate` cujo `domains` cobre
  `hostname`.
- `routes[*].backend.service_selector` casa ≥1 Service.

### Bloco B — HA/DR

#### PlacementGroup

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `type` | `"spread"` | só `spread` no v2; outros futuros |
| `members` | `server_selector` | |

Invariantes:
- `Service.replicas > 1` cujo `server_selector` casa servers em
  `PlacementGroup` distintos OU servers de um mesmo group `spread` →
  PolicyEngine `warn` em caso contrário (réplicas no mesmo hipervisor).

#### FloatingIP

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `type` | `"ipv4" \| "ipv6"` | |
| `home_location` | string | |
| `assignee_selector?` | `server_selector` | matched ≤1 server |

Distinção vs `PrimaryIP`: FloatingIP é re-atribuível **a quente** sem
recriar server (failover); PrimaryIP é fixo por server (mas desacoplado
da criação).

#### Image (snapshot)

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `type` | `"snapshot"` | só snapshot no v2 |
| `source` | `server_selector` | matched ≥1 |
| `schedule` | cron string | |
| `retention` | duration (`"30d"`, `"4w"`) | |

Complementa `BackupPolicy` v1 (restic, dados de app); snapshot cobre o
disco inteiro do server, mais rápido para rebuild.

Lifecycle vs `source` removido: snapshots existentes **permanecem** até
expirar pela política de `retention` (fail-safe §1.6 — remover o Server do
manifesto não remove imagens dele). Tool explícita `destroy:image` com
approval para remoção antecipada.

#### Extensão em entidade v1

`Server` ganha campos **opcionais**:

| Campo | Tipo | Obs |
|---|---|---|
| `region?` | string (`"eu-central"`, etc.) | agrupador de locations |
| `datacenter?` | string (`"fsn1-dc14"`) | mais granular que location |

Compat: manifestos v1 omitem ambos; reconciler usa default Hetzner
(location atual). Adição é aditiva no schema Zod.

### Bloco C — Identidade e segurança

#### SSHKey

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `public_key` | string (OpenSSH format) | |
| `ttl?` | duration | sem TTL = nunca expira (PolicyEngine `warn`) |
| `allowed_agents?` | `string[]` | nomes de agentes; omitido = todos |

Invariantes:
- `ttl` ausente → `warn` (encoraja rotação).
- `public_key` deve passar parser OpenSSH (PolicyEngine).

#### CapabilityToken

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `agent` | string | id do agente OpenClaw/Vox |
| `scopes` | `Scope[]` | lista de capabilities (ex.: `deploy_service`, `destroy:server`) |
| `expires_at` | RFC3339 timestamp | obrigatório (sem token eterno) |

Invariantes:
- `expires_at` no futuro.
- `scopes` ⊆ catálogo de capabilities declarado pela Agent Interface.
- Revogação = remover do manifesto; reconciler invalida em ≤1 ciclo;
  `StateEvent` com `capability_token_id` daquele token deixa de ser
  emitido (uso pós-revogação retorna `unauthorized`).

#### Policy

| Campo | Tipo | Obs |
|---|---|---|
| `name` | string (kebab-case, único) | |
| `rule` | predicate (DSL definida na spec-filha do Bloco C) | recebe contexto `{ plan, manifest_desired, observed_state }` e retorna `boolean \| PolicyViolation`; DSL deve aceitar esses três inputs no mínimo |
| `severity` | `"warn" \| "error"` | |
| `applies_to?` | filtro por tipo de entidade | omitido = todas |

Invariantes meta:
- `name` da policy é citado em `policy_violations[*].policy_name` (§2.3).
- Não há policy auto-aplicada implícita; toda regra é declarada.

### Bloco D — Observability e custo

**Sem novas entidades.** Tudo é extensão de interfaces já cobertas em §2:

- `cost_estimate` em todo `plan` (§2.3) — provider de pricing consulta
  catálogo Hetzner.
- Webhook receiver de `Action` Hetzner — substitui polling do reconciler;
  é detalhe interno do reconciler, não entidade declarável.
- Métricas Prometheus de reconcile/drift/MTTR — exposição, não estado
  desejado.
- Tool MCP `explain_state(entity)` — leitura, sem novo schema.

Spec-filha de Bloco D detalha integração com o webhook Hetzner, formato
das métricas e DSL de `explain_state`.

## 4. Dependências entre blocos (grafo, não ordem)

Cada aresta é "precisa que tal extensão exista antes do primeiro provider
que a consome", **não** "tem que ser implementado antes".

```
Bloco A ── independe ──→ (pode partir a qualquer momento)
Bloco B ── depende ──→ Server.region/datacenter (§3 — extensão aditiva,
                       pode ir junto)
Bloco C ── depende ──→ StateEvent.capability_token_id (§2.4)
                       Approval Gate.policy_violations (§2.3)
Bloco D ── depende ──→ Approval Gate.cost_estimate (§2.3)
                       (consumidor das extensões; introduz pricing
                       provider)
```

Implicação prática: a spec-filha do primeiro bloco a ser implementado
**precisa** incluir as extensões de §2 que ela ou os blocos futuros
consomem. Ordem dos blocos fica para cada spec-filha quando enfileirada;
este contrato só garante que as peças se encaixam.

## 5. Fora de escopo de v2 (YAGNI explícito)

Extende os não-objetivos de v1. Nenhum item abaixo entra em spec-filha
sem revisão deste contrato:

- Multi-tenant, billing, UX para terceiros.
- UI humana rica além do Console Operacional já previsto em v1.
- Rollback automático destrutivo.
- Service mesh (WireGuard + Ingress cobrem o caso interno; sidecar
  Envoy/Istio fora).
- Storage Box gerenciada pela Hetzner (restic em volume próprio cobre).
- Rotação automática de secrets (rotação manual auditada via
  `CapabilityToken` + `SSHKey.ttl` basta).
- Multi-cloud.
- Autoscaling preditivo (reativo manual via `scale_service` permanece).
- Provider de LoadBalancer L4-puro separado (LB Hetzner cobre L4 e L7;
  Ingress modela L7 sobre ele).
- Type de PlacementGroup além de `spread` (sem caso de uso interno).
- Failover automático cross-region (DR mensal exercitado manualmente
  cobre).

## 6. Como esta spec se relaciona com as 4 specs-filhas

Cada bloco vira uma spec-filha dedicada:

```
docs/specs/<data>-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md
docs/specs/<data>-bevox-hetzner-mcp-v2-bloco-b-ha-dr.md
docs/specs/<data>-bevox-hetzner-mcp-v2-bloco-c-identidade-seguranca.md
docs/specs/<data>-bevox-hetzner-mcp-v2-bloco-d-observability-custo.md
```

Regras de relacionamento:

- Toda spec-filha cita este contrato no cabeçalho como `Spec-pai`.
- Spec-filha **não pode contradizer** §1 (princípios), §2 (interfaces) ou
  §3 (schemas) deste contrato. Pode **acrescentar** campos opcionais
  desde que cabe no espírito (selector-based, fail-safe, etc.).
- Mudança proposta em §1, §2 ou §3 ativa **revisão coordenada** das
  specs-filhas que tocam o ponto mudado, com nota de impacto neste
  contrato.
- Cada spec-filha define suas próprias fases internas (igual v1, Fases
  1–6) e seu próprio plano de implementação. Este contrato não dita.
- Ordem de implementação entre specs-filhas é decisão **operacional**, não
  arquitetural; tomada quando cada uma for enfileirada para `writing-plans`.
