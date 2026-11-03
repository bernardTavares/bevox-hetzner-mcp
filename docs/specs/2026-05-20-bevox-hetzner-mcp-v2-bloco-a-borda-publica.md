# bevox-hetzner-mcp v2 — Bloco A: Borda Pública

- **Data:** 2026-05-20
- **Status:** Em revisão
- **Autor:** Bernard (brainstorm com Claude)
- **Tipo:** Spec-filha (implementável)
- **Spec-mãe:** [2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
- **Spec-avô (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)

## 0. Status, escopo e relação com as outras specs

Esta spec-filha implementa as cinco entidades do **Bloco A** definidas em
§3 da spec-mãe: `Firewall`, `LoadBalancer`, `Certificate`, `PrimaryIP`,
`Ingress`. Não redefine schemas — apenas implementa.

Dentro do escopo:
- 5 providers Hetzner novos + 1 provider composto (`IngressProvider`).
- 6 tools MCP novas + extensões de leitura.
- Migração aditiva do schema Postgres (estado observado).
- Estratégia de testes com fake HTTP da API Hetzner.
- 6 fases internas implementáveis.

Fora do escopo (referências a outras specs-filhas):
- `region` / `datacenter` em `Server` (Bloco B).
- PolicyEngine real (Bloco C — invariantes da spec-mãe ficam aqui como
  TODOs marcados, ver §9).
- `cost_estimate` populado (Bloco D — campo sempre `{ monthly_delta_eur:
  0, breakdown: [] }` nas tools deste bloco; só shape).
- WAF, rate-limit L7, sticky sessions (não-objetivos v2, §5 spec-mãe).

## 1. Pré-requisitos sobre v1

Antes de iniciar a Fase 1, este bloco adiciona o **mínimo de extensões da
spec-mãe** necessário para que ele e os blocos futuros se encaixem. São
aditivas e não tocam comportamento v1:

| Extensão (origem spec-mãe) | Conteúdo neste bloco | Bloco que ativa |
|---|---|---|
| `StateEvent.capability_token_id` (§2.4) | Coluna `nullable` no schema; reconciler grava `null` em todos eventos deste bloco | Bloco C |
| `StateEvent.policy_eval_result` (§2.4) | Coluna `nullable jsonb`; reconciler grava `null` | Bloco C |
| `plan.cost_estimate` (§2.3) | Sempre `{ monthly_delta_eur: 0, breakdown: [] }` | Bloco D |
| `plan.policy_violations` (§2.3) | Sempre `[]` | Bloco C |
| `resolve_selector(selector)` (§2.2) | Implementada já como tool MCP **e** helper interno do reconciler (mesma função, exposta nos dois lados) | (consumida por todos) |

Migração Postgres: arquivo único de migration, aditiva. Sem `ALTER`
destrutivo, sem reescrita de eventos v1.

## 2. Stack adicional

**Zero novas dependências npm.** Hetzner não publica SDK oficial Node.js;
a opção "SDK oficial" considerada no brainstorm não existe no registry. v1
já dirige `HetznerCloudProvider` diretamente pela REST via o
`HttpClient` interno (`core/src/providers/http-client.ts`, com retry/
backoff/`Retry-After`/taxonomia de erros) — Bloco A estende esse mesmo
padrão. Decisão também coerente com a postura "no npm dep" do projeto
(ver commit `aa7fa0d feat(core): real SSH-exec transports (no npm dep)`).

Adapter v2 (`core/src/providers/v2/hetzner-cloud-v2-http.ts`) é uma fina
camada sobre `HttpClient` v1 que injeta `baseUrl` + `Authorization` e
expõe helpers tipados por recurso (Firewall/LB/Cert/PrimaryIP). Reusa
Zod (parsing das respostas), Pino (logs), Vitest (testes), Postgres
(estado observado) — todas já em v1.

## 3. Providers novos — contratos internos

Todos implementam `Provider<T>` v1 (`observe`, `plan`, `apply`, `verify`).
Cada provider é um arquivo isolado em `core/src/providers/v2/`.

### 3.1 `HetznerFirewallProvider`

Mapeamento entidade ↔ Hetzner Cloud REST (`/v1/firewalls/*`):

| Spec-mãe | Hetzner REST | Notas |
|---|---|---|
| `Firewall.name` | `firewall.name` | identidade |
| `Firewall.rules[]` | `firewall.rules[]` | allow-list, conjunto |
| `Firewall.applied_to` | `firewall.applied_to[]` (Server refs) | resolve via `resolve_selector` no apply |

Erros tratados:
- `rate_limit` → backoff (handler comum v1).
- `rule_conflict` (Hetzner valida): `code: "firewall.invalid_rules"`,
  `retryable: false`.
- `not_found` no apply: `precondition_failed` (provider abortado, evento
  registrado).

Drift: regra adicionada fora-de-banda na Hetzner = reportada em
`StateEvent` com `kind: "drift"`. Reconciler **re-aplica** as regras
desejadas (princípio v1 "regras desejadas convergem"), mas **nunca remove
regras extras** sem aprovação — fail-safe §1.6 spec-mãe.

### 3.2 `HetznerPrimaryIPProvider`

Mapeamento ↔ Hetzner Cloud REST (`/v1/primary_ips/*`). Atribuição via `assignee_selector`
resolve para 0 ou 1 server (invariante §3 spec-mãe — >1 é erro de
PolicyEngine; aqui validamos inline e retornamos `precondition_failed`).

Risco: PrimaryIP **é cobrado mesmo desatribuído**. Tool `set_primary_ip`
classificada como sensível (Approval Gate sempre — independente de criar
ou modificar).

### 3.3 `HetznerCertificateProvider`

Dois caminhos:

**`type: managed`** — Hetzner Certificates managed.
- **Hetzner cuida do ACME internamente** (DNS-01 nativo). O único
  pré-requisito é que a zona dos `domains` esteja gerenciada por
  `HetznerDNSProvider` v1 — o provider **não** publica `_acme-challenge`
  manualmente. F3 confirma essa premissa contra a API real antes do
  apply; se Hetzner exigir publicação manual, o provider passa a
  orquestrar via DNSProvider v1 (fallback documentado no plano).
- Provider: cria recurso Cert e **faz polling** do estado da Hetzner.
  Cert fica `pending` até emitido; reconciler **não bloqueia** o ciclo
  (mesmo padrão de approval lifecycle v1 §236 — ação fica `blocked`,
  reavaliada a cada ciclo de reconcile).
- TTL ≤ 30min; ao expirar, cert vira `error`, evento emitido, ação
  `cancelled`; agente decide retentar.

**`type: uploaded`** — PEM + chave de secret store v1.
- Resolução de `private_key_secret_ref` no apply (mesmo padrão de v1, spec
  v1 §227-243).
- Validação: parser PEM mínima antes de enviar (chain + key match).

Drift: cert revogado/expirado na Hetzner = reportado, **não** re-emitido
automaticamente (re-emissão de managed = ação explícita; uploaded exige
nova chave).

### 3.4 `HetznerLoadBalancerProvider`

Mapeamento ↔ Hetzner Cloud REST (`/v1/load_balancers/*`). Algoritmo,
health check e targets mapeiam 1:1.

Particularidade: **trocar `location` de um LB existente é destrutivo**
(Hetzner recria). Tool `set_load_balancer` detecta no `plan`, retorna
`pending_approval` com diff que destaca "LOCATION CHANGE — LB will be
recreated, public IP will change".

Targets resolvem via `service_selector` → lista de Servers que rodam o
Service. Drift em targets (servidor adicionado/removido fora-de-banda) é
reportado e reconciler re-converge.

**`set_load_balancer` não toca Firewall.** Hetzner Cloud não aceita
Firewall atrelado ao LB; aplicação de regras de borda nos Servers backend
é responsabilidade do `IngressProvider` (§3.5) via `firewall_ref` da
entidade `Ingress`. Esta fase entrega o LB cru, sem política de rede.

### 3.5 `IngressProvider` (composto)

Não fala com Hetzner direto. Orquestra:

```
Ingress (desejado)
  └─ resolve tls.certificate_ref       → HetznerCertificateProvider
  └─ resolve load_balancer_ref         → HetznerLoadBalancerProvider
  └─ resolve firewall_ref (opcional)   → HetznerFirewallProvider
                                          (aplica-se aos Servers backend
                                          do LB, ver spec-mãe §3 Bloco A)
  └─ resolve routes[*].backend         → Service v1 → Server v1
  └─ publica DnsRecord do hostname     → HetznerDNSProvider v1
```

Estado observado: `Ingress.reconcile_status` agrega o pior status dos
componentes (`healthy` só se todos `healthy`).

Ordem de apply (DAG topológico do reconciler v1, §estendido):
1. Certificate (apenas se `type: managed`; `uploaded` é instantâneo e
   pode ir em paralelo com 2)
2. LoadBalancer
3. Firewall (se `firewall_ref`; aplica-se aos Servers backend)
4. DnsRecord apontando para LB
5. Ingress fica `healthy`

Falha parcial: cada componente fica no seu estado, Ingress vira
`degraded`. Reconciler retenta no próximo ciclo (idempotência v1).

## 4. Tools MCP novas

Estendem o catálogo da spec v1 (§Agent Interface). Mesma forma:
declarativas, idempotentes, com `dry_run`, erros estruturados.

| Fase | Tool | Approval | Notas |
|---|---|---|---|
| F1 | `set_firewall` | condicional (destrutivo se remoção de regra cobrindo Server ativo) | input: spec Firewall; output: plan/applied |
| F2 | `set_primary_ip` | **sim** (custo) | PrimaryIP cobrado mesmo desatribuído |
| F3 | `set_certificate` | `managed`: não · `uploaded`: sim (toca secret) | resolve secret só no apply (v1) |
| F4 | `set_load_balancer` | **sim** (custo + possível recreação) | `location` change destaca no plan |
| F5 | `set_ingress` | condicional (toca DNS implicitamente) | composto |
| F6 | `expose_service` | **um único Approval bundle** cobrindo Cert+LB+Ingress (não N approvals separados) | conveniência: `{ service, hostname, tls: "managed" \| cert_ref }` cria Cert+LB+Ingress no working desired state |

Leituras gratuitas via tools v1 (`get_state`, `diff`, `events`) e a nova
`resolve_selector` adicionada em §1.

`expose_service` semântica: **escreve no working desired state**
(Postgres, spec v1 §227-234), não no manifesto git. Promoção working→git
permanece ação explícita v1.

## 5. Estado observado — schema Postgres

Migration aditiva. Tabelas novas:

```sql
CREATE TABLE firewalls (
  id          uuid PRIMARY KEY,
  name        text UNIQUE NOT NULL,
  observed    jsonb NOT NULL,           -- snapshot do recurso na Hetzner
  status      text NOT NULL,            -- pending|applying|healthy|degraded|drift|error
  updated_at  timestamptz NOT NULL
);
-- idem para load_balancers, certificates, primary_ips, ingresses
```

`state_events` ganha colunas via mesma migration (§1):

```sql
ALTER TABLE state_events
  ADD COLUMN capability_token_id text,
  ADD COLUMN policy_eval_result jsonb;
```

Sem mudanças em tabelas v1 de Servers/Services/Volumes/DnsRecords/BackupPolicies/StateEvents existentes (só ALTER aditivo).

## 6. Estratégia de testes

Convenção herdada de v1 (§Estratégia de testes, linha 217): **fake HTTP
da API Hetzner**, não mock no nível do client. Garante que a tradução
entidade → REST está fiel à API consumida.

| Camada | Fake/setup | Cobre |
|---|---|---|
| Cada provider Hetzner | Fake HTTP server (msw ou equivalente) com fixtures por endpoint | Tradução entidade→REST, paginação, rate-limit, mapeamento de erros |
| `IngressProvider` | Providers v1 + novos como fakes in-memory | Ordem DAG (Cert→LB→FW→DNS), falha parcial, agregação de status |
| Cada tool | Integração tool MCP/REST → reconciler com providers fake | `dry_run`, approval gating, capability scope (mock), erros estruturados |
| Capstone F6 | Cenário E2E: manifesto bevox-web exposto via Ingress; fakes | Composição de tudo; `expose_service` produz mesmo resultado que `set_*` individuais |
| Idempotência (property) | Aplicar manifesto N vezes; 2º+ ciclo = no-op | Garantia central v1 |
| `@live` opcional manual | 1 cenário ACME real em sandbox Hetzner antes de release | Confiança em managed cert real |

CI: unitário + integração com fakes a cada commit; `@live` sob demanda.

## 7. Fases internas

Mesma granularidade de v1 (Fases 1–6). Cada fase é PR mergivel.

### F1 — `HetznerFirewallProvider` + `set_firewall`

Entregáveis:
- Migration aditiva (§5, inclui colunas novas em `state_events` para C/D).
- `resolve_selector` tool de leitura.
- Provider + fake HTTP de `/firewalls/*`.
- Tool `set_firewall` com `dry_run`, classificação de Approval Gate.
- Testes: provider unit, tool integração, idempotência.

**Critério de pronto:** agente cria/atualiza/remove firewall via tool;
drift detectado; fail-safe verificado (remoção fora-de-banda não destrói
nada).

### F2 — `HetznerPrimaryIPProvider` + `set_primary_ip`

Entregáveis:
- Provider + fake HTTP.
- Tool `set_primary_ip`, Approval Gate sempre.
- Validação inline: `assignee_selector` casa ≤1 server.
- Testes.

### F3 — `HetznerCertificateProvider` + `set_certificate`

Entregáveis (mais densa):
- Provider + fake HTTP cobrindo ambos `managed` e `uploaded`.
- Fluxo ACME DNS-01: integração com `HetznerDNSProvider` v1 (publica
  `_acme-challenge` durante apply, remove ao final).
- Resolução de `private_key_secret_ref` no apply (uploaded).
- Polling de `pending` com TTL.
- Tool `set_certificate` com classificação Approval por `type`.
- Testes incluindo timeout de managed, falha de parser PEM.

### F4 — `HetznerLoadBalancerProvider` + `set_load_balancer`

Entregáveis:
- Provider + fake HTTP.
- Detecção de `location` change → diff destaca recreação.
- Resolução de `targets: service_selector`.
- Tool `set_load_balancer` Approval sempre.
- Testes incluindo drift em targets, change de algoritmo.

### F5 — `IngressProvider` + `set_ingress`

Entregáveis:
- Provider composto orquestrando F1, F3, F4 + DNS v1.
- DAG de apply (Cert → LB → FW → DNS → Ingress healthy).
- Agregação de status.
- Tool `set_ingress`.
- Testes integração com falha parcial em cada componente.

**Depende de:** F1, F3, F4 prontos.

### F6 — `expose_service` + capstone E2E

Entregáveis:
- Tool `expose_service` (wrapper que monta Cert+LB+Ingress no working
  desired state).
- Capstone E2E: manifesto com `bevox-web` exposto; fakes garantem
  convergência. Fixture do manifesto definida nesta fase (v1 não traz
  sample dedicado a Ingress; deriva do exemplo conceitual da spec v1).
- Cenário `@live` opcional: ACME real em sandbox.
- Documentação de operação no Console Operacional v1 (apenas leitura das
  novas entidades; UI de escrita fica para iteração futura).

**Depende de:** F5 pronta.

**Paralelização:** F1, F2, F3, F4 são independentes em PR; podem
acontecer em paralelo desde que F1 (que carrega a migration §1) seja a
primeira a mergiar. F5 espera F1+F3+F4. F6 espera F5.

## 8. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Endpoint Hetzner muda formato | Centralizado no adapter v2; cada provider toca um único método tipado; ajuste pontual + Zod parser cobre |
| ACME DNS-01 lento (Hetzner emite cert em minutos) | Polling com TTL 30min, evento `pending` exposto, agente decide retentar |
| Trocar `location` de LB destrói IP público | Tool destaca no plan + Approval Gate obrigatório; Ingress com `firewall_ref` re-aplica regras automaticamente após recreação |
| Drift em FW silencioso (regra adicionada fora-banda) | Reportado em `StateEvent kind: "drift"`; reconciler converge regras desejadas mas não remove extras |
| `expose_service` esconde complexidade demais | `dry_run` mostra o plan completo (Cert+LB+Ingress+DNS) antes do apply; logs explicitam composição |
| Cert managed expirando sem renovação automática | Hetzner renova managed; provider verifica `expires_at` em cada `observe()` e emite `drift` se < 14d sem renovação visível |
| Approval Gate para `set_primary_ip` cria fricção em testes E2E | Capability token de teste com scope amplo; cenários documentam Approval bypass por modo `e2e` |

## 9. Não-objetivos desta spec-filha

Itens listados aqui ficam como TODOs comentados no código, referenciando
a spec-mãe e a spec-filha futura. Não implementar:

- **PolicyEngine real (Bloco C).** Invariantes da spec-mãe §3 Bloco A
  (ex.: "todo Server tem firewall", "TLS hostname ⊆ cert domains") ficam
  como `// TODO(bloco-c): validate via PolicyEngine` em cada provider,
  com validação inline mínima por enquanto.
- **`cost_estimate` populado (Bloco D).** Sempre `{ monthly_delta_eur: 0,
  breakdown: [] }`; Bloco D substitui implementação.
- **PlacementGroup, FloatingIP, Image (Bloco B).**
- **`region` / `datacenter` em `Server` (Bloco B).**
- **WAF, rate-limit L7, sticky sessions, mTLS** (não-objetivos v2 §5).
- **Console Operacional UI de escrita** para novas entidades. Apenas
  leitura no Console; escrita via tool MCP por agentes.
- **Renovação automática de cert uploaded.** Manual via re-`set_certificate`.

## 10. Como esta spec-filha se relaciona com a spec-mãe

- Cada provider tem comentário no topo citando §3 Bloco A da spec-mãe.
- Cada invariante deferida para PolicyEngine tem comentário citando a
  regra exata.
- Mudança em §3 Bloco A da spec-mãe → revisão coordenada desta spec.
- Esta spec **não pode** acrescentar entidades novas no Bloco A sem
  revisar a spec-mãe primeiro.
