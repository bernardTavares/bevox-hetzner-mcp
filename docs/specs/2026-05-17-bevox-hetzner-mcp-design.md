# bevox-hetzner-mcp — Design

- **Data:** 2026-05-17
- **Status:** Em revisão
- **Autor:** Bernard (brainstorm com Claude)
- **Tipo:** Design / spec único

## Contexto

O ecossistema Bevox (bevox-backend, bevox-web, bevox-mobile, bevox-harness,
bevox-console) e o runtime de agentes Company OS (OpenClaw/Vox, runners) hoje
seriam hospedados em AWS. O objetivo é rodar tudo na **Hetzner** com software
próprio, **uso interno** (sem multi-tenant, billing ou UX para terceiros).

A justificativa para construir em vez de usar um PaaS self-hosted pronto
(Coolify, Dokku, Kamal, Nomad) é **controle agent-native**: os próprios agentes
OpenClaw/Vox devem provisionar e operar a infra via tools/API de primeira
classe — algo que PaaS de UI humana não expõe programaticamente do jeito
necessário.

Abordagem escolhida: **control plane fino sobre primitivas provadas**. Não se
reinventa orquestração; reinventa-se a *interface para agentes*. O destino é
"infra completa agent-native" (servidores + containers + rede + volumes + DNS +
backup) entregue como **spec único**, porém estruturado em módulos/fases
internas para construção incremental.

## Não-objetivos (YAGNI)

Multi-tenant, billing, autoscaling preditivo, multi-cloud. Hetzner apenas.

> **Revisão 2026-05-17:** "UI web rica" deixa de ser não-objetivo. Decidido
> adicionar um **Console Operacional** para uso interno humano (operação +
> observabilidade) como casca sobre o mesmo núcleo MCP/REST — sem lógica
> paralela. Continua sem UX para terceiros / multi-tenant.

## Arquitetura

Princípio central: o software mantém um **estado desejado declarativo** e um
**reconciler** que o aplica na Hetzner via primitivas maduras. Toda operação é
exposta como tool/MCP para os agentes; humanos operam e observam via **Console
Operacional**, que não tem lógica própria — só consome a mesma Agent Interface
(REST), com as mesmas validações, gating e auditoria. Ações sensíveis seguem o
Approval Gate independentemente da origem (agente ou console).

Camadas (uma responsabilidade cada):

1. **State Store** — fonte de verdade do estado desejado (manifestos YAML
   versionados em git) + observado (Postgres). O reconciler sempre relê o real.
2. **Providers** — adaptadores finos: `HetznerCloudProvider`
   (servidores/volumes/redes/firewall), `HetznerDNSProvider`, `DockerProvider`
   (Docker Engine API via SSH), `WireGuardProvider`, `BackupProvider` (restic).
3. **Reconciler** — loop de convergência idempotente desejado × observado.
4. **Agent Interface** — servidor MCP + API REST com tools de primeira classe.
5. **Approval Gate** — operações destrutivas/custosas exigem aprovação
   (integra Approval Center do Company OS).
6. **Observability** — eventos, logs e estado consultáveis pelos agentes.
7. **Console Operacional** — frontend interno (12 telas: fleet, detalhe de
   entidade, plan/apply, approvals, events, manifest/working state,
   provision wizard, secrets, backups, network/WireGuard, DNS, health) que
   consome só a Agent Interface REST. Toda escrita passa por `dry_run` e
   Approval Gate como qualquer agente; secrets nunca exibem valor. Stack a
   ratificar no plano.

Fluxo: agente chama tool → valida + grava estado desejado → (se sensível)
Approval Gate → Reconciler aplica via Providers → estado observado atualizado →
evento de volta ao agente.

## Modelo de dados e estado declarativo

Estado desejado em **manifestos YAML versionados (git)**; estado observado em
**Postgres**. O reconciler nunca confia em cache — sempre relê Hetzner/Docker.

Entidades canônicas:

| Entidade | Campos-chave | Notas |
|---|---|---|
| `Server` | name, type, location, image, ssh_keys, labels, network_id | 1:1 com servidor Hetzner Cloud |
| `Network` | name, ip_range, subnets | Rede privada + WireGuard mesh |
| `Volume` | name, size, server (attach), fs | Volume Hetzner persistente |
| `Service` | name, image, replicas, env, ports, volumes, server_selector | Containers Docker; selector decide onde roda |
| `DnsRecord` | zone, name, type, value, ttl | hcloud DNS |
| `BackupPolicy` | target, schedule, retention, repo | restic |
| `StateEvent` | ts, actor (agent id), op, entity, before, after, result | Trilha append-only |

Manifesto exemplo (conceitual):

```yaml
servers:
  - name: bevox-app-1
    type: cx32
    location: nbg1
    network: bevox-priv
services:
  - name: bevox-harness
    image: registry/bevox-harness:tag
    replicas: 2
    server_selector: { label: app }
    env_from: secret:bevox-harness
backups:
  - target: volume:pg-data
    schedule: "0 3 * * *"
    retention: 14d
```

Decisões:

- **Secrets** não ficam no manifesto — referência (`secret:nome`) resolvida de
  um store (v1: arquivo cifrado com age/sops; futuro: Vault).
- **State drift**: recursos fora do manifesto são reportados como `drift`,
  nunca destruídos automaticamente.
- **Identidade do ator**: todo `StateEvent` registra qual agente fez a mudança.

## Agent Interface (MCP + REST)

Duas formas equivalentes sobre o mesmo núcleo: **servidor MCP** (consumo
primário pelos agentes) e **REST** (scripts, CI, debug). Mesma lógica,
validação e auditoria.

Princípios:

- Toda tool é **declarativa e idempotente**: o agente descreve estado desejado,
  não passos imperativos.
- `dry_run: true` retorna **plan/diff** sem aplicar (default para operações
  destrutivas).
- Operações sensíveis retornam `pending_approval` com `approval_id`.
- Erros **estruturados** (`code`, `message`, `retryable`, `entity`).

Catálogo de tools:

| Tool | Tipo | Approval | Descrição |
|---|---|---|---|
| `get_state` | leitura | não | Estado observado + desejado |
| `diff` | leitura | não | Plano desejado × observado, sem aplicar |
| `events` | leitura | não | Trilha de auditoria filtrável |
| `health` | leitura | não | Saúde de servers/services |
| `provision_server` | escrita | sim (custo) | Cria/ajusta servidor + rede privada |
| `deploy_service` | escrita | dry_run→não / apply→condicional | Cria/atualiza containers |
| `scale_service` | escrita | condicional | Ajusta réplicas |
| `set_dns` | escrita | não | Upsert de registro DNS |
| `snapshot` | escrita | não | Backup sob demanda |
| `restore` | escrita | sim (destrutivo) | Restaura backup |
| `destroy` | escrita | sim (destrutivo) | Remove server/service/volume |
| `apply_manifest` | escrita | condicional | Reconcilia manifesto inteiro |

Contrato exemplo (`deploy_service`):

```json
// input
{ "name": "bevox-harness", "image": "registry/bevox-harness:v12",
  "replicas": 2, "dry_run": true }
// output (dry_run)
{ "status": "planned",
  "plan": [ {"op":"update","entity":"service:bevox-harness",
             "change":"image v11→v12","impact":"rolling restart, 2 replicas"} ],
  "next": "call again with dry_run:false to apply" }
```

Fluxo agent-native: `agente → diff/apply_manifest(dry_run)` → recebe plan →
decide → `apply(dry_run:false)` → se sensível: `pending_approval` → humano
aprova no Approval Center → reconciler aplica → `events` reflete resultado com
ator = id do agente.

Autenticação: cada agente tem credencial própria com **escopo por capability**
(ex.: Vox pode `destroy`, runners só `deploy_service`). O escopo entra no
`StateEvent`.

## Reconciler e tratamento de erros

Loop de convergência idempotente. Calcula a diferença desejado × observado e
aplica o mínimo de ações.

Ciclo:

1. **Observe** — relê o real (Hetzner + Docker API), nunca confia em cache.
2. **Plan** — lista ordenada de ações respeitando dependências (DAG
   topológico: rede → server → volume → container).
3. **Gate** — ações sensíveis aguardam approval; o resto segue.
4. **Apply** — ação por ação, idempotente, cada uma com `verify()`.
5. **Record** — `StateEvent` por ação (before/after/result/ator).

Gatilhos: sob demanda (tool call), periódico (drift detection ~5 min), webhook
(futuro). **Lock** (advisory lock no Postgres) garante um reconciler ativo por
escopo, evitando corridas entre agentes concorrentes.

Modelo de erros:

| Classe | Exemplo | Comportamento |
|---|---|---|
| `transient` | timeout, rate-limit | Retry backoff exponencial + jitter, máx N; respeita `Retry-After` |
| `precondition` | dependência ausente | Aborta a ação, marca dependência, continua ações independentes |
| `conflict` | drift | Não sobrescreve; emite `drift`, exige tool explícita |
| `fatal` | credencial inválida, quota | Para o ciclo, evento crítico, notifica |
| `partial` | 2 de 3 réplicas | Estado `degraded`; converge faltantes no próximo ciclo |

Princípios de falha:

- **Idempotência por design**: recuperação = rodar o reconciler de novo.
- **Sem rollback automático destrutivo**: apply parcial deixa estado
  consistente e reportável; desfazer só via tool explícita com approval.
- **Fail-safe, não fail-deleting**: nenhuma falha remove recurso não
  solicitado. Drift/órfãos são reportados, nunca destruídos sozinhos.
- **Visibilidade total**: cada entidade em
  `pending | applying | healthy | degraded | drift | error`.
- **Timeouts e circuit breaker**: por provider; após falhas consecutivas, abre
  circuito e marca dependentes como `blocked`.

Consistência: o State Store é a verdade do *desejado*; o *observado* é sempre
releitura real. Divergência = drift explícito, nunca correção silenciosa.

## Estratégia de testes

Reconciler e providers nunca tocam a Hetzner real em testes. Toda chamada
externa passa por interface de provider mockável.

| Camada | Como testar | Cobre |
|---|---|---|
| Providers | Fake server HTTP da API Hetzner/Docker + suíte `@live` opcional (sandbox, manual) | Tradução manifesto→API, paginação, rate-limit, mapeamento de erros |
| Reconciler | Unidade com providers fake in-memory | DAG de dependências, idempotência, classificação de erros, drift |
| Agent Interface | Integração: tool MCP/REST → plan, approval gating, StateEvent com ator | Contrato das tools, dry_run, escopo de credencial, erros estruturados |
| End-to-end | Cenário com fakes: stack Bevox completo converge para healthy; injeção de falhas | Fluxo agent-native completo |
| Idempotência (property) | Aplicar manifesto N vezes converge e 2º+ ciclo = no-op | Garantia central |

Não se testa a API da Hetzner nem o Docker Engine em si — apenas a tradução e
a lógica de convergência. CI roda unitário + integração com fakes a cada
commit; `@live` sob demanda antes de releases.

## Clarificações (refinamentos da revisão de spec)

- **Write-path do estado desejado**: `apply_manifest` e demais tools de escrita
  **não** commitam no git diretamente. Escrevem num *working desired state* no
  Postgres; o manifesto git permanece a fonte humana/canônica. Reconciliação
  usa o working state; divergência working × git é reportada como `drift` de
  manifesto (mesma política fail-safe). Promoção working→git é ação explícita
  com approval (Fase 1 define o modelo; Fase 4 expõe a tool).
- **Lifecycle de approval**: `pending_approval` cria um registro com TTL
  (default 24h). O reconciler **não** bloqueia o ciclo esperando — a ação fica
  `blocked` e é reavaliada a cada ciclo. Resolução por webhook do Approval
  Center (preferido) com fallback de polling. Approval expirada → ação
  `cancelled`, evento emitido; rejeitada → idem com motivo. (Fase 4.)
- **Resolução de secrets**: feita **no apply, lado reconciler/DockerProvider**
  (nunca no plan/dry_run, que mostra só a referência). Injetados como env vars
  no container; rotação fora de escopo v1 (recriar serviço aplica novo valor).
  (Fase 3.)
- **Enforcement de escopo por capability**: autorização é checada na **Agent
  Interface** (antes de gravar estado desejado), não no reconciler. O escopo
  efetivo é registrado no `StateEvent` para auditoria. (Fase 4.)

## Fases internas de construção (spec único, build incremental)

1. State Store + modelo de dados + manifesto parser
2. `HetznerCloudProvider` + reconciler (servers, redes, volumes)
3. `DockerProvider` + `WireGuardProvider` (services em rede privada)
4. Agent Interface (MCP + REST) + Approval Gate
5. `HetznerDNSProvider` + `BackupProvider` (restic)
6. Drift detection periódico + circuit breaker + endurecimento
