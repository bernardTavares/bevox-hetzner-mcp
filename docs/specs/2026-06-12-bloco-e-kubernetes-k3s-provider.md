# bevox-hetzner-mcp v2 — Bloco E: Kubernetes/k3s provider (kubectl-over-SSH)

- **Data:** 2026-06-12
- **Status:** Aceita (2026-06-12) — decisões D1–D7 confirmadas no brainstorm; open questions Q-a..Q-d resolvidas no review do operador (ver §8).
- **Autor:** Bernard + Claude Code
- **Tipo:** Spec-filha (implementável) — adiciona um novo bloco (E) de v2; 100% pelo caminho v2 (os 12 tools v1 são FROZEN e NÃO são tocados).
- **Spec-mãe (v2 contract):** [2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md](./2026-05-20-bevox-hetzner-mcp-v2-architecture-contract.md)
- **Spec-avô (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)
- **Spec irmãs / referências:**
  - [2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md](./2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md) (molde de bloco-filho de v2: providers + tools + fases internas)
  - [2026-05-26-server-scope-transport-decoupling.md](./2026-05-26-server-scope-transport-decoupling.md) (`MANAGED_MESH`)
  - [2026-05-26-tolerant-meta-scope-and-managed-services.md](./2026-05-26-tolerant-meta-scope-and-managed-services.md) (`MANAGED_SERVICES`; framing "Bloco E (k3s)")
- **Investigação que fundamenta esta spec:** [docs/investigations/2026-06-04-kubernetes-integration-feasibility.md](../investigations/2026-06-04-kubernetes-integration-feasibility.md) — conclui que k8s de primeira classe = peças novas e independentes sobre a camada de Provider já extensível, e recomenda o **Caminho B1 (kubectl-over-SSH)** por espelhar 1:1 o padrão Docker já provado. Esta spec é o "próximo passo correto" que aquela investigação aponta (§7.2: "o próximo passo correto é escrever uma spec do 'Bloco E' em `docs/specs/`, não codar").

## 0. Status, escopo e relação com as outras specs

Esta spec-filha adiciona um **bloco novo (E)** ao contrato v2 — gerenciamento Kubernetes/k3s de primeira classe — pelo caminho v2 exclusivamente. A investigação `2026-06-04` mapeou dois eixos independentes (workload e host); esta spec cobre AMBOS (decisão **D5**, escopo amplo) em **dois componentes de fronteira limpa** dentro de **uma** spec, com um **plano TDD de duas fases** (decisão **D6**).

> **Nota de relação com a spec-mãe.** O contrato v2 (`2026-05-20`) enumera quatro blocos (A–D) em §3 e diz (§5) que "nenhum item [fora de escopo] entra em spec-filha sem revisão deste contrato". Kubernetes NÃO está entre os blocos A–D nem entre os não-objetivos explícitos de §5 (que listam service mesh sidecar Envoy/Istio, multi-cloud, etc., mas não k8s-como-backend). Esta spec **acrescenta** o Bloco E honrando §1 (princípios invioláveis), §2 (interfaces — usa `Provider<T>` sem mudança, §2.1) e o caminho v2-aditivo; não contradiz nenhum schema de §3. O Bloco E é um **novo backend** atrás do mesmo port `Provider`, exatamente o ponto de extensão que a investigação confirmou.

| Dentro do escopo | Fora do escopo (YAGNI — ver §8) |
|---|---|
| Componente 1 — `KubernetesProvider` (eixo workload): tool v2 `kubectl_apply`, `KubeManifestSchema` (envelope-only), apply/observe/verify/destroy via `kubectl`-over-SSH | Edge Cloudflare / `cloudflared` no host (3ª peça da investigação §4 — eixo separado e caro; o edge do MCP segue Hetzner-native) |
| Componente 2 — `ensure_k3s` (eixo host): tool v2 `ensure_k3s`, `EnsureK3sSchema` (tipado, restrito), observe/apply/verify do k3s instalado | Mecanismo genérico de "rodar comando arbitrário no host" — `ensure_k3s` é capability TIPADA e restrita; o provider OWNS a receita de install (D7) |
| Transporte `kube()` espelhando o Docker-over-SSH 1:1 (chave temp 0600, argv-only, sem shell) | Multi-cluster / multi-host targeting — assume a config de SSH host atual (uma) |
| Idempotência por design + property tests para ambos os kinds | Helm; k3s uninstall (uninstall = fail-deleting, proibido — D3/D7); k3s upgrade in-place (Q-a → drift; gated upgrade = spec futura); WireGuard mesh crypto real |
| Approval Gate always-sensitive em ambos os tools | Tocar qualquer um dos 12 tools v1 (FROZEN; `contract-conformance.test.ts:822-823` trava `ALL_TOOLS.length === 12`) |
| Cabeamento data-driven: `KIND_TABLE`, `V2_PLAN_ORDER`, `byKind`, `kube()` transport, registro MCP+REST, `v2Tools` em `server.ts` | B2 (cliente do kube-apiserver via kubeconfig/TLS) — adotamos B1 (kubectl-over-SSH); B2 fica para uma revisão futura se o atrito de SSH pesar |

## 1. Contexto

O projeto-irmão `bevox-meta-api` roda em produção em **k3s** num host Hetzner. Hoje o `bevox-hetzner-mcp` **não enxerga nada dentro do k3s** — só entrega a VM (Caminho A da investigação: provisiona via Hetzner Cloud, `user_data` instala k3s no boot, `MANAGED_MESH=off`/`MANAGED_SERVICES=off` desligam Docker/WireGuard do roteamento). O Caminho A funciona hoje sem código novo, mas é fire-and-forget: zero observe, zero reconcile, zero idempotência do que vive DENTRO do cluster.

A investigação `2026-06-04` confirmou que a camada de Provider é **agnóstica de backend** (`core/src/providers/provider.ts` — o port `observe/apply/verify/destroy?`) e que adicionar um kind é uma **mutação de mapa data-driven** em três pontos que precisam concordar, sem tocar `reconcile.ts` nem `apply.ts` (comentário explícito em `v2-wrap.ts:157-159`: "No dispatch switch lives in apply.ts/reconcile.ts"). O exemplar mais limpo de "kind v2 inteiro adicionado" é o Bloco A (firewall/load-balancer/etc.).

Esta spec realiza o **Caminho B1 (kubectl-over-SSH)** (decisão **D1**): o `KubernetesProvider` roda `kubectl` no host k3s via o `ssh-exec.ts` que já existe — o mesmo transporte SSH argv-only (chave temp 0600 deletada em `finally`, `spawn("ssh", argv, {shell:false})`, sem shell) que move o Docker-over-SSH hoje. Menor footprint de dependência nova; nenhuma lib `ssh2`, nenhum SDK k8s npm.

## 2. Design — Componente 1: `KubernetesProvider` (eixo workload)

### 2.1 Superfície híbrida: envelope tipado + corpo opaco (D2)

`KubeManifestSchema` (Zod, em `core/src/domain/entities-v2.ts`) valida **só o ENVELOPE** — a identidade usada para observe / dedup / idempotência — e carrega o corpo YAML **opaco**, repassado intocado para `kubectl apply -f -`:

| Campo | Tipo | Obs |
|---|---|---|
| `host` | string (ref nomeada) | **referência nomeada** a um SSH host config resolvido server-side (Q-c resolvida) — a chave/credencial NUNCA vai no manifesto. Liga o apply a um host/cluster explícito; funciona idêntico com `MANAGED_SERVICES` on/off, e é forward-compatible com multi-host (targeting fica fora de escopo, §9) |
| `apiVersion` | string | identidade k8s (ex.: `apps/v1`) |
| `kind` | string | qualquer kind k8s; aceito opaco (ex.: `Deployment`, `Service`, `Ingress`, `ConfigMap`) |
| `metadata.name` | string | identidade no namespace |
| `namespace` | string | namespace alvo; **deve pré-existir** (Q-d resolvida) — namespace ausente = precondition error, NUNCA criado em silêncio (quem quer o ns declara um manifesto `Namespace` explícito no desired) |
| `body` | string (YAML opaco) | o documento k8s completo; **não validado campo-a-campo**; passa por stdin ao `kubectl apply -f -` |

A chave de identidade segue a convenção `<kind>:<name>` do projeto (`observed-store.ts`), composta como `kube:<host>/<namespace>/<kind>/<name>` para dedup estável (o `host` explícito de Q-c entra na chave, deixando a identidade não-ambígua mesmo num cenário futuro de múltiplos hosts). **Decisão D2:** o schema NÃO tenta modelar PodSpec, probes, volumes, etc. — aceita **qualquer kind k8s**, o que mantém o blast radius da spec pequeno e delega ao apiserver a validação semântica do corpo. O corpo opaco é o que viabiliza o canal de secrets (§2.4): o token `secret:<ref>` pode aparecer no body e é substituído só em `apply()`.

### 2.2 Transporte — espelha o Docker-over-SSH 1:1

O `KubeTransport` (seam injetável, análogo a `DockerTransport` em `core/src/providers/docker-transport.ts:56`) roda `kubectl` no host via `core/src/providers/ssh-exec.ts` (verificado: argv-only, `shell:false`, chave 0600 em temp file deletada em `finally` em TODO caminho de saída, `StrictHostKeyChecking` nunca "no", segredos nunca em argv/log). O `kubeconfig` default do k3s vive em `/etc/rancher/k3s/k3s.yaml` no host. O provider em `core/src/providers/v2/kube-apply.ts` segue dois moldes (investigação §5):
- **estrutural** — `core/src/providers/v2/hetzner-load-balancer.ts` (forma de um provider v2: `observe/apply/verify`, slice enriquecido, `StateEvent`);
- **driver** — `core/src/providers/docker.ts` + `docker-transport.ts` (como executar um comando externo sobre SSH e mapear stdout→resultado).

O manifesto (já com secrets resolvidos, §2.4) vai por **stdin** ao `kubectl apply -f -` — nunca como argv token, nunca interpolado em shell.

### 2.3 `apply()` / `observe()` / `verify()` / `destroy()` — idempotência e fail-safe

- **`apply()` → `kubectl apply -f -` (NUNCA `--prune`).** **Sinal canônico de change-detection (Q-b resolvida): anotação content-hash `hetzner-mcp/manifest-hash`.** O provider computa o hash do manifesto desejado e o injeta como anotação; em `observe()`/`apply()` compara o hash desejado com o anotado no objeto vivo — igual ⇒ **`changed:false` (no-op estrito)**, diferente/ausente ⇒ aplica e `changed:true`. Determinístico, independente de versão/locale do `kubectl` (mais robusto que parsear `unchanged`/`configured` do stdout, que vira só sinal secundário/sanity). A 2ª passada de um plano já aplicado é assim um no-op estrito por construção, satisfazendo o property test de idempotência (invariante #2). **Restrição dura:** o hash é digest one-way — NUNCA revela o valor de um secret — e `observe()` NUNCA resolve secret; o tratamento fino de um manifesto secret-bearing (hash pré- vs pós-resolução) é detalhe do plano, sempre sob essas duas restrições.
- **`observe()` → `kubectl get <kind> <name> -n <ns> -o json` por identidade.** Read-only; constrói o `ObservedSlice` enriquecido (`{ key, payload }`, shape de `core/src/reconciler/observed-adapter.ts` / spec `2026-06-02`). **NUNCA lê de volta o `data` de um objeto `Secret`** (D4): para o kind `Secret`, `observe()` redige/pula o campo `data` (o observed carrega só a referência/identidade, jamais o valor — `.claude/rules/secrets-resolution.md` "observed-state storage … references only").
- **`verify()` → `kubectl get`** confirma realidade == desejado (read-only).
- **`destroy()` → `kubectl delete`** SOMENTE via Approval Gate, e SOMENTE quando o desired-state remove explicitamente o manifesto. Nunca um caminho de erro, nunca `--prune`, nunca heurística de "limpar órfão".

### 2.4 Secrets — espelha o Docker (D4)

O corpo opaco pode conter tokens `secret:<ref>`. Em `apply()` — e SOMENTE ali, atrás do `ApplyContext` unforgeable (`core/src/store/secrets.ts`) — o provider substitui o ref pelo valor resolvido ANTES de pipar o manifesto ao `kubectl` por stdin. `plan` / `dry_run` / `observe` carregam só o `secret:<ref>`, nunca o valor. Erros lançados de `apply()` são embrulhados para que o valor resolvido nunca apareça em `.message`/`.cause`/stderr (espelha `ssh-exec.ts` SECRET NON-LEAK). O leak-sentinel test existente (`core/src/reconciler/secret-apply.test.ts` golden + a família de sentinelas) é **estendido** para cobrir o caminho `kubectl_apply` (manifesto com sentinela → garante zero ocorrência em plan/log/StateEvent/observed).

### 2.5 Tensão de design: fail-safe × scale-down nativo do k8s (D3)

A investigação (§5.2) sinaliza esta tensão; resolvê-la explicitamente é requisito desta spec.

**O problema.** O invariante #3 do bevox (fail-safe, nunca fail-deleting: "nenhuma falha remove recurso não solicitado"; "drift reportado, nunca corrigido em silêncio") parece colidir com o comportamento nativo do ReplicaSet do k8s, que **adiciona E remove** Pods para convergir a `spec.replicas`.

**Resolução adotada.** A linha de fronteira é **quem remove e por quê**:

- **Scale-down DENTRO de um objeto** (`replicas: 3 → 1` num `Deployment` declarado pelo operador) é o **controller do k8s** cumprindo a spec que o operador DECLAROU. O MCP não removeu nada; o MCP aplicou um desired-state que o operador escreveu. Isso é **permitido**, NÃO é violação de fail-safe — é semanticamente idêntico ao operador pedir `scale_service` em v1.
- O **MCP nunca usa `kubectl apply --prune`** (que removeria objetos ausentes do conjunto aplicado — isso SIM seria fail-deleting silencioso).
- Um manifesto **REMOVIDO do desired-state** vira **DRIFT reportado**, nunca auto-deletado. O objeto k8s órfão permanece; `observe()` o vê; o reconciler reporta `result:"drift"` (mesma mecânica do Docker: container órfão = drift, nunca delete — investigação §1). 
- **Delete real** de um objeto k8s = uma ação `destroy()` **explícita**, disparada quando o desired-state remove o manifesto E aprovada pelo Approval Gate. O provider nunca deleta por iniciativa própria, nunca num caminho de erro.

Resumo: a entidade que remove Pods num scale-down é o controller do k8s honrando `replicas:N` que o operador declarou — NÃO o MCP. O MCP só faz apply-forward (sem `--prune`) e delete gated.

## 3. Design — Componente 2: `ensure_k3s` (eixo host)

### 3.1 Capability TIPADA e restrita (D7) — NÃO exec arbitrário

A investigação (§4) constata que "não existe mecanismo genérico de rodar comando arbitrário no host" — e D7 mantém esse limite. `ensure_k3s` é uma capability **restrita e tipada**; o provider **OWNS a receita de install**. `EnsureK3sSchema` (Zod, em `core/src/domain/entities-v2.ts`):

| Campo | Tipo | Obs |
|---|---|---|
| `host` | string (ref nomeada) | referência nomeada a um SSH host config resolvido server-side (Q-c) — credencial/chave nunca no manifesto |
| `version` | string | versão k3s desejada (channel/tag) |
| `role` | `"server" \| "agent"` | papel do node k3s |
| `...` | (campos adicionais tipados conforme a receita) | NUNCA um campo `command`/`script` de exec livre |

NÃO há campo de comando arbitrário. O input é declarativo; a receita de install é interna ao provider (`core/src/providers/v2/ensure-k3s.ts`).

### 3.2 `observe()` / `apply()` / `verify()` — idempotente por design

- **`observe()`** → `k3s --version` / `systemctl is-active k3s` / `kubectl get nodes` no host → estado atual (instalado? qual versão? node Ready?). Read-only; constrói o slice observado.
- **`apply()`** → roda a receita de install SOMENTE se o k3s estiver **ausente**. Presente = **no-op, `changed:false`**. **Version-divergence (Q-a resolvida): se o k3s observado tem versão != a desejada, `apply()` NÃO faz upgrade automático — reporta DRIFT.** O campo `version` serve para detectar e reportar a divergência, não para disparar reinstalação. Upgrade in-place reinicia o k3s (disruptivo num cluster de produção) e é exatamente o tipo de mutação silenciosa que o fail-safe existe para evitar; portanto fica como ação explícita, Approval-Gated, **diferida a uma spec futura** (§9). A receita de install é idempotente por design (instalar duas vezes converge ao mesmo estado).
- **`verify()`** → node `Ready` (`kubectl get nodes`).

### 3.3 Fail-safe ABSOLUTO: install-only (D7)

`ensure_k3s` é **install-only**. k3s removido do desired-state → **DRIFT reportado**, **NUNCA** roda `k3s-uninstall.sh` — desinstalar seria fail-deleting (invariante #3), proibido sem exceção. Não há caminho de uninstall nesta spec, nem gated. (Se um dia houver demanda de teardown, será outra spec, com Approval Gate e desired-state explícito; fora do escopo aqui — §8.)

## 4. Cabeamento — pontos de extensão data-driven (verificados contra `main`)

Estes são os mesmos três pontos que a investigação §2 mapeou, mais o transporte e o registro de tools. Os caminhos abaixo foram **verificados no `main` atual** (a observed-state-adapter já mergeou, então `observed-adapter.ts` e seu `KIND_TABLE` existem). `reconcile.ts` e `apply.ts` **NÃO mudam** — são data-driven por kind (`v2-wrap.ts:157-159`).

| # | Ponto de extensão | Local verificado | Mutação |
|---|---|---|---|
| 1 | `KIND_TABLE` (kind → schema + coleção) | `core/src/reconciler/observed-adapter.ts:33` (existe; hoje 6 kinds v1) | Novos kinds `kube` / `k3s` → seu schema de envelope + a coleção/canal observado. **Nota:** `observedAdapter` valida cada payload via Zod e PULA o inválido (degrade-safe, spec `2026-06-02` §1.2) — o adapter NÃO ganha caminho destrutivo. |
| 2 | Ordenação do plano | `V2_PLAN_ORDER` em `core/src/reconciler/plan.ts:463` (v2; v1 usa `KIND_RANK:77`) | Inserir `ensure_k3s` **ANTES** de `kubectl_apply` (o host precisa do k3s up antes de aplicar workload). |
| 3 | Roteamento ao backend | `byKind` em `createCompositeProvider` (`core/src/reconciler/v2-wrap.ts:161`); construção data-driven (`:157`) | Map mutation: `kube` / `k3s` → o provider wrapped. v1 entities seguem pelo fallback (zero regressão). |
| 4 | Transporte | `interface EntrypointTransports` (`core/src/entrypoint-wiring.ts:124`, hoje `docker()/wireguard()/restic()`) + peças estáticas em `buildBootDeps` (`:210`) | Novo factory `kube(config): KubeTransport`. Seam injetável: testes passam fake; produção pluga o ssh2-backed sob a MESMA interface. |
| 5 | Registro MCP + REST | `core/src/agent/mcp.ts` (wire por `v2Tools?: ReadonlySet<V2ToolName>`, `:134`) + `core/src/agent/rest.ts` | Registrar `kubectl_apply` e `ensure_k3s`. **Gap a corrigir (verificado):** `core/src/server.ts` NÃO referencia `v2Tools` hoje (grep retorna zero) — `server.ts` precisa passar `v2Tools` para que QUALQUER tool v2 (não só estes) fique acessível em produção. |
| 6 | Vocabulário de capability | `V2_TOOLS` em `core/src/agent/capability.ts:82` (hoje 8 tools v2) | Adicionar `"kubectl_apply"` e `"ensure_k3s"` ao `V2_TOOLS`. `ALL_TOOLS` (os 12 v1) fica byte-idêntico — `contract-conformance.test.ts:822-823` trava `ALL_TOOLS.length === 12`. |
| 7 | Tools | `core/src/agent/v2/kubectl-apply.ts` + `core/src/agent/v2/ensure-k3s.ts` | Padrão das 8 tools v2 existentes (molde: `core/src/agent/v2/run-migrations.ts`). |

## 5. Invariantes — desta spec (preserva / estende)

Cada item mapeia a um ground rule de `CONTRIBUTING.md` §"Ground rules" / `CLAUDE.md` por número.

| # | Invariante (ground rule) | Como esta spec o honra |
|---|---|---|
| #1 | **Specs first.** Mudança comportamental começa como spec. | Esta spec precede qualquer código em `core/src/`. Plano (`/new-plan`) só após aceite. |
| #2 | **Idempotência por design** (property tests obrigatórios). | `kubectl apply` declarativo: 2ª passada → `unchanged` → `changed:false` (no-op estrito). `ensure_k3s` install-only: presente → `changed:false`. Property tests para AMBOS os kinds (apply 2× → no-op estrito), reusando o `conformanceHarness`. Ver Q-b para robustez do sinal de change. |
| #3 | **Fail-safe, nunca fail-deleting; drift reportado, nunca corrigido.** | `apply()` nunca usa `--prune`; nunca delete num caminho de erro. Manifesto removido = drift. Delete real só via `destroy()` gated. `ensure_k3s` install-only: NUNCA `k3s-uninstall.sh`. Scale-down nativo é o controller cumprindo a spec do operador (§2.5), não o MCP. |
| #4 | **Secrets resolvidos só em apply** (nunca em plan/dry_run/log/StateEvent/observed-store). | `secret:<ref>` no body opaco, resolvido só em `apply()` atrás do `ApplyContext`. `observe()` NUNCA lê `Secret.data`. Erros embrulhados (valor nunca em `.message`/stderr). Leak-sentinel estendido para `kubectl_apply`. |
| #5 | **Todo `StateEvent` registra o actor.** | `ApplyContext` carrega o actor (`.claude/rules/state-event-actor.md`); os providers o propagam para o `StateEvent` emitido. Nenhuma mutação anônima. |
| v1-FROZEN | **Os 12 tools v1 são FROZEN; v2 é aditivo.** | Bloco E é 100% v2. `ALL_TOOLS`/`TOOL_POLICY` byte-idênticos; `contract-conformance.test.ts:822-823` (`ALL_TOOLS.length === 12`) intocado. Nada em `core/src/agent/capability.ts` `ALL_TOOLS` muda. |
| cross | **Approval-always** em ambos os tools. | `kubectl_apply` e `ensure_k3s` construídos com `isSensitive: () => true` (molde: `run_migrations.ts`, que usa `makeGate(() => true)` — toda invocação passa pelo Approval Gate real). |

## 6. Estratégia de testes (TDD, fakes-only — zero infra real)

Per `.claude/rules/tdd-required.md` e `.claude/rules/fakes-author`: nenhum teste toca k3s/SSH real; CI roda só contra fakes.

| Layer | Como | O que cobre |
|---|---|---|
| Fake de transporte | Estender `core/test/fakes/ssh-exec-recorder.ts` (existe) para responder `kubectl apply -f -` (com `unchanged`/`configured`/`created` no stdout), `kubectl get … -o json`, `k3s --version`, `systemctl is-active k3s`, `kubectl get nodes` | Mesmo padrão do Docker-over-SSH; grava os argv invocados; zero `ssh`/host/rede real |
| `KubeManifestSchema` unit | Zod parse/safeParse | Envelope válido aceito; body opaco preservado; kind arbitrário aceito |
| `KubernetesProvider` apply/observe/verify | provider + fake transport | `apply` mapeia `unchanged`→`changed:false`, `configured`/`created`→`changed:true`; `observe` por identidade; `observe` de `Secret` redige `data`; `verify` confirma realidade |
| Idempotência (property) | property test reusando `conformanceHarness` | apply 2× → no-op estrito (`changed:false`, zero mutação) para o kind `kube` |
| Secrets / leak-sentinel | estender `secret-apply.test.ts` + sentinela | manifesto com sentinela → zero ocorrência do valor em plan/log/StateEvent/observed; `Secret.data` nunca lido de volta |
| Gated destroy | provider + fake gate | `destroy()` só dispara `kubectl delete` via Approval Gate + desired-state que remove o manifesto |
| `EnsureK3sSchema` unit | Zod | input tipado; nenhum campo de exec arbitrário |
| `ensure_k3s` observe/apply/verify | provider + fake transport | ausente → install (`changed:true`); presente → no-op (`changed:false`); node Ready em `verify` |
| Idempotência (property) host | property test | apply 2× → no-op estrito para o kind `k3s` |
| Fail-safe install-only | provider + fake | k3s removido do desired → drift reportado; NUNCA invoca `k3s-uninstall.sh` (assert nos argv gravados) |
| Wiring | mcp/rest + `server.ts` | `v2Tools` inclui `kubectl_apply`/`ensure_k3s` e ficam acessíveis (corrige o gap de `server.ts` não passar `v2Tools`) |
| v1 FROZEN guard | `contract-conformance.test.ts` | `ALL_TOOLS.length === 12` byte-idêntico (não modificado) |

`@live` (opcional, manual, pré-release) fica em `core/test/live/*.live.test.ts` — fora do `npm test`; exige tokens/host reais do operador. Nenhuma chamada real entra num arquivo do projeto `unit`.

## 7. Critérios de aceite

- [ ] `npm --prefix core run typecheck` sem novos erros além do baseline conhecido; `npm --prefix core test` verde.
- [ ] `V2_TOOLS` inclui `kubectl_apply` e `ensure_k3s`; `ALL_TOOLS` (12 v1) byte-idêntico; `contract-conformance.test.ts` verde sem modificação.
- [ ] `KubeManifestSchema` valida o envelope (inclui `host` como ref nomeada, Q-c) e carrega o body opaco; aceita kind k8s arbitrário. Namespace ausente = precondition error, nunca criado (Q-d).
- [ ] `KubernetesProvider.apply` → `kubectl apply -f -` sem `--prune`; idempotência via anotação content-hash `hetzner-mcp/manifest-hash` (Q-b); 2ª passada = no-op estrito (property test verde para o kind `kube`).
- [ ] `observe()` nunca lê `Secret.data`; o observed persistido carrega só refs; leak-sentinel estendido verde.
- [ ] `destroy()` só via Approval Gate + remoção explícita no desired; nenhum delete em caminho de erro; nenhum `--prune` em lugar nenhum.
- [ ] `EnsureK3sSchema` tipado, sem campo de exec arbitrário; provider install-only.
- [ ] `ensure_k3s` idempotente (property test verde para o kind `k3s`); k3s removido → drift, NUNCA `k3s-uninstall.sh` (assert nos argv do fake); version-divergente → drift, NUNCA upgrade automático (Q-a; assert que nenhuma receita de upgrade roda).
- [ ] Ambos os tools `isSensitive: () => true` (Approval Gate always); `StateEvent` registra o actor via `ApplyContext`.
- [ ] Cabeamento data-driven: `KIND_TABLE`, `V2_PLAN_ORDER` (`ensure_k3s` antes de `kubectl_apply`), `byKind`, `kube()` transport, registro MCP+REST, `v2Tools` ligado em `server.ts` (gap corrigido).
- [ ] Fake `ssh-exec-recorder.ts` estendido responde os comandos `kubectl`/`k3s`; zero infra real em CI.
- [ ] `CHANGELOG.md` `[Unreleased]`.

## 8. Open questions — RESOLVIDAS no review do operador (2026-06-12)

As quatro questões abaixo foram decididas pelo operador no review deste documento; ficam registradas com a resolução adotada (já refletida nas §§2–3, 7, 9). Decisões D1–D7 do brainstorm seguem travadas.

- **Q-a — política de version-divergence do `ensure_k3s` → RESOLVIDA: só reporta drift, sem upgrade automático.** Se o k3s observado tem versão != a desejada, `apply()` NÃO reinstala/upgrade — reporta **drift** (§3.2). O campo `version` detecta e reporta a divergência; não dispara reinstalação. Upgrade in-place reinicia o k3s (disruptivo num cluster de produção) e é exatamente a mutação silenciosa que o fail-safe existe para evitar → fica como ação explícita, Approval-Gated, **diferida a uma spec futura** (§9). _Postura mais robusta+segura: o reconcile nunca derruba um cluster vivo por conta própria._
- **Q-b — sinal de idempotência do `kube-apply` → RESOLVIDA: anotação content-hash `hetzner-mcp/manifest-hash`.** O provider computa o hash do manifesto desejado e o injeta como anotação; change-detection compara o hash desejado com o anotado no objeto vivo (§2.3). Determinístico, independente de versão/locale do `kubectl`. O stdout do `kubectl` vira sinal secundário, nunca fonte de verdade. _Restrição dura: o hash é digest one-way — NUNCA revela valor de secret — e `observe()` NUNCA resolve secret (o tratamento fino de manifesto secret-bearing — hash pré- vs pós-resolução — é detalhe do plano, sob essas restrições)._
- **Q-c — binding de SSH host → RESOLVIDA: campo `host` explícito no manifesto, como referência nomeada.** O `KubeManifestSchema` carrega um `host` que é **referência nomeada** a um SSH host config resolvido server-side (§2.1) — credencial/chave NUNCA no manifesto. Explícito > implícito: funciona idêntico com `MANAGED_SERVICES` on/off, sem ambiguidade de "para qual cluster foi". Multi-host targeting segue fora de escopo (§9), mas o campo é forward-compatible. _Postura mais robusta+segura: nunca aplicar no cluster errado por causa de um default global implícito._
- **Q-d — criação de namespace → RESOLVIDA: exige pré-existência.** Namespace ausente = **precondition error**, nunca criado em silêncio (§2.1). Quem quer o namespace declara um manifesto `Namespace` explícito no desired-state. Blast radius mínimo.

## 9. Fora de escopo (YAGNI explícito)

Estende os não-objetivos de v1 e da spec-mãe v2 (§5). Nenhum item abaixo entra sem nova spec.

- Edge Cloudflare / `cloudflared` no host (3ª peça da investigação §4) — eixo separado e caro; o edge do MCP segue Hetzner-native (`expose_service`/`set_ingress`).
- Mecanismo genérico de exec arbitrário no host (`ensure_k3s` é tipado e restrito; D7).
- Multi-cluster / multi-host targeting — assume a config de SSH host atual.
- Helm.
- k3s uninstall / teardown do host (uninstall = fail-deleting, proibido — D3/D7).
- **Upgrade in-place de k3s** (Q-a): version-divergence → só **drift** nesta spec. O upgrade gated, com receita testada, fica para uma spec futura.
- WireGuard mesh crypto real (segue stub, fora desta spec).
- B2 (cliente do kube-apiserver via kubeconfig/TLS) — adotado B1; B2 fica para revisão futura.

## 10. Relação com o plano e próximos passos

Esta spec **não** define a ordem de tasks TDD nem o layout interno final — isso é responsabilidade do `plan-writer` (`/new-plan` após aceite). A spec fixa apenas o **contrato** (schemas, invariantes, pontos de extensão, tensão fail-safe×scale-down resolvida) e a **estrutura de duas fases**:

- **Fase 1 — Workload:** `KubeManifestSchema` → provider `apply`/`observe`/`verify` → idempotência → secrets/leak → gated destroy → cabeamento (`KIND_TABLE`/`V2_PLAN_ORDER`/`byKind`/`kube()`) → tools MCP+REST → `v2Tools` em `server.ts`.
- **Fase 2 — Host:** `EnsureK3sSchema` → `observe`/`apply`/`verify` → idempotência → fail-safe install-only → cabeamento → tool.

A ordem fina das tasks dentro de cada fase é decisão do plano, não desta spec.

Hand-off: operador revisou este documento e resolveu as Open questions §8; `Status: Aceita` (2026-06-12). Próximo passo: `/new-plan` (`plan-writer`) para o plano de implementação TDD em duas fases.
