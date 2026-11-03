# bevox-hetzner-mcp — Contexto do Projeto

## O que é

Control plane **agent-native** sobre a Hetzner. Substitui o que se faria na AWS
para hospedar o ecossistema Bevox (bevox-backend, bevox-web, bevox-mobile,
bevox-harness, bevox-console) e o runtime Company OS (OpenClaw/Vox, runners).

Diferencial: os próprios agentes OpenClaw/Vox provisionam e operam a infra via
**tools/MCP de primeira classe** — não há UI humana obrigatória. Uso interno
(sem multi-tenant, billing ou UX para terceiros). Hetzner apenas.

Spec canônica: `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md`.

## Arquitetura

Estado desejado declarativo + reconciler idempotente que converge o real via
primitivas provadas. Seis camadas, uma responsabilidade cada:

```
Agent (OpenClaw/Vox) ─→ Agent Interface (MCP + REST)
                          → Approval Gate (ações sensíveis)
                          → State Store (desejado: git YAML / observado: Postgres)
                          → Reconciler (Observe→Plan→Gate→Apply→Record)
                          → Providers (HetznerCloud, HetznerDNS, Docker,
                                       WireGuard, Backup/restic)
                          → Observability (events, health, get_state)
```

Princípios não-negociáveis: idempotência por design; **fail-safe, nunca
fail-deleting** (nenhuma falha remove recurso não solicitado); sem rollback
automático destrutivo; drift reportado, nunca corrigido em silêncio; todo
`StateEvent` registra o agente ator.

## Stack (definitiva — em produção)

- **Runtime**: Node.js 20+, TypeScript 5.x (ESM/NodeNext, strict)
- **MCP**: `@modelcontextprotocol/sdk`
- **DB**: PostgreSQL 16 (estado observado, advisory locks, StateEvents)
- **Hetzner**: cliente HTTP próprio sobre `fetch` nativo (sem SDK npm)
- **Containers**: Docker Engine API via SSH (chave 0600 em temp file, deletada em `finally`)
- **Rede**: WireGuard mesh; **Backup**: restic
- **Managed mesh toggle**: `MANAGED_MESH=on` (padrão) mantém `routes.server = [HetznerCloud, WireGuard]` (comportamento v1); `MANAGED_MESH=off` desacopla `routes.server` da malha WireGuard para deploys k3s/CNI externos (ver [`2026-05-26-server-scope-transport-decoupling.md`](./docs/specs/2026-05-26-server-scope-transport-decoupling.md))
- **Managed services toggle**: `MANAGED_SERVICES=on` (padrão) mantém `routes.service = Docker` (comportamento v1); `MANAGED_SERVICES=off` desacopla `routes.service` e exclui o escopo `service` do periodic reconcile, para deploys onde o orquestrador de containers vive fora do MCP (k3s/CNI). Combine com `MANAGED_MESH=off` para a postura "pure Hetzner Cloud HTTP" (zero SSH). Ver [`2026-05-26-tolerant-meta-scope-and-managed-services.md`](./docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md)
- **Strict manifest approval toggle**: `STRICT_MANIFEST_APPROVAL=off` (padrão) mantém `apply_manifest` com `defaultIsSensitive` — só destroy/remove/restore gate (v1 FROZEN); `STRICT_MANIFEST_APPROVAL=on` faz `apply_manifest` consultar `TOOL_POLICY` per-entity-kind, então `create server:*` herda `provision_server` "always" → server creates via manifest requerem approval. Opt-in pra postura "defense in depth". Ver [`2026-05-27-strict-manifest-approval-knob.md`](./docs/specs/2026-05-27-strict-manifest-approval-knob.md)
- **Validação**: Zod · **Logging**: Pino · **Testes**: Vitest + fakes HTTP
- **Deploy de referência**: systemd + Postgres em Docker + Cloudflare Tunnel + Access (ver `deploy/README.md`)

## Fases internas (todas concluídas)

v1 (spec `2026-05-17`) — shipped:

1. State Store + modelo de dados + parser de manifesto ✅
2. `HetznerCloudProvider` + reconciler (servers, redes, volumes) ✅
3. `DockerProvider` + `WireGuardProvider` (services em rede privada) ✅
4. Agent Interface (MCP + REST) + Approval Gate ✅
5. `HetznerDNSProvider` + `BackupProvider` (restic) ✅
6. Drift detection periódico + circuit breaker + endurecimento ✅

v2 contract (spec `2026-05-20`) — Bloco A (borda pública) shipped:
`Firewall`, `LoadBalancer`, `Certificate`, `PrimaryIP`, `Ingress` (composto) +
7 tools v2 (`set_firewall`, `set_load_balancer`, `set_certificate`,
`set_primary_ip`, `set_ingress`, `expose_service`, `resolve_selector`).

Blocos B/C/D (HA/DR, PolicyEngine + capability tokens, observability/cost)
ficam para ciclos futuros — fora do escopo atual.

## Como trabalhar neste projeto

- v1 + v2 Bloco A estão em produção. Evolução incremental: **toda nova
  feature comportamental em `core/src/` segue o fluxo
  `brainstorm → spec → plan → implementação`** (skills superpowers). Specs
  em `docs/specs/`, planos em `docs/superpowers/plans/`. Não codar sem
  plano aprovado.
- v1 spec (`2026-05-17`) e v2 contract (`2026-05-20`) são FROZEN —
  mudanças invariantes exigem nova revisão de spec, não edit in-place.
- Mudanças mínimas e focadas (ver agente `engineering-minimal-change-engineer`).
- Toda operação destrutiva passa por Approval Gate, nunca atalho.
- Testes nunca tocam Hetzner/Docker real (providers mockáveis; `@live` manual
  pré-release).
- Deploy/runbook: `deploy/README.md`. Mudanças puramente operacionais (units
  systemd, config do `cloudflared`, runbook) não exigem spec — só mudança
  comportamental em `core/src/`.

## Agentes disponíveis (`.claude/agents/`)

Conjunto curado para este projeto:

- **Arquitetura/núcleo**: `engineering-software-architect`,
  `engineering-backend-architect`, `specialized-mcp-builder`
- **Infra/operação**: `engineering-devops-automator`,
  `support-infrastructure-maintainer`, `engineering-sre`,
  `engineering-incident-response-commander`
- **Dados**: `engineering-database-optimizer`
- **Segurança/identidade**: `engineering-security-engineer`,
  `agentic-identity-trust` (credenciais escopadas por capability dos agentes)
- **Qualidade**: `engineering-code-reviewer`,
  `engineering-minimal-change-engineer`, `testing-api-tester`,
  `testing-test-results-analyzer`, `testing-performance-benchmarker`
- **Docs**: `engineering-technical-writer`
- **IA**: `engineering-ai-engineer`

## Consumo atual em produção (orientação)

O daemon serve hoje o **cluster MVP do piloto Bevox** (bevox-backend +
bevox-harness — manifesto canônico em `bevox-PRD-consolidation/infra/`):

- **Onde o daemon roda:** local na máquina do operador (port 8787) — NÃO está em VM dedicada. Process supervision via systemd unit local.
- **State cache pode ficar stale** vs a realidade Hetzner+Docker se o daemon for reiniciado fora de sequência. Em estado vazio (`get_state` retorna listas zeradas), `apply_manifest` planeja recriar tudo do zero — incluindo provisionar server novo, ou seja, blast radius enorme. **Detectar antes de chamar:** se `get_state` retorna `{networks:[], servers:[], services:[]}` enquanto há cluster real ativo, fazer state backfill (TODO no roadmap do core) antes de qualquer `apply_manifest`.
- **Mudanças pontuais em prod hoje** (image swap, env update, postgres recreate) são feitas via SSH direto + `docker stop/rm/run`, contornando o daemon. Manifest YAML no hub é o desired-state of record; daemon é, na prática, observador degradado.
- **Topologia detalhada do cluster que o daemon serve:** `$BEVOX_KNOWLEDGE_PATH/20_architecture/_shared/runtime-topology.md`.

## Não-objetivos (YAGNI)

Multi-tenant, billing, UI web rica, autoscaling preditivo, multi-cloud,
rotação de secrets v1, rollback automático destrutivo.
