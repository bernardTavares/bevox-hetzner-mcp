# Investigação: viabilidade de integração Kubernetes no bevox-hetzner-mcp

**Data:** 2026-06-04
**Tipo:** investigação read-only (nenhum arquivo de código modificado)
**Motivação:** o projeto-irmão `bevox-meta-api` roda em produção em **k3s** num host
Hetzner exposto por **cloudflared no próprio host**. Avaliar se o
`bevox-hetzner-mcp` poderia provisionar/gerenciar esse tipo de setup, e o que
faltaria.

---

## TL;DR

O `bevox-hetzner-mcp` **não tem integração Kubernetes hoje**. Apesar de tools com
nomes que evocam o léxico cloud-native (`apply_manifest`, `set_ingress`,
`set_load_balancer`, `expose_service`), **nada no código fala k8s** — `grep` por
`kubectl|kubernetes|k8s|helm|kubeconfig` em `core/src` retorna **zero** matches.

O que existe:

- **Integração Docker** confirmada: SSH → `curl --unix-socket /var/run/docker.sock`
  (Docker Engine API; não docker-compose, não TCP, não SDK npm).
- Uma **camada de Provider extensível e data-driven** — adicionar um backend novo é
  caminho já trilhado (exemplar mais recente: firewall v2).
- O time **já antecipou k3s** como "Bloco E" / "caminho A do bevox-meta-api", mas
  como algo que roda **fora** do control plane (knobs `MANAGED_MESH=off` /
  `MANAGED_SERVICES=off` existem exatamente pra isso).

Conclusão: a arquitetura foi desenhada para receber um backend novo. Uma integração
k8s de primeira classe são **3 peças novas e independentes**. O caminho de menor
esforço (provisionar a VM + instalar k3s via cloud-init) **já funciona hoje sem
tocar uma linha de código**.

---

## 1. Como funciona a integração Docker (o molde a espelhar)

Fluxo de `deploy_service`, ponta a ponta:

```
Tool MCP/REST ("deploy_service")
  → core/src/agent/tools.ts (executeTool → doDeployService) — autz + audit + dispatch
  → reconciler (core/src/reconciler/reconcile.ts): Observe → Plan → Gate → Apply → Record
       (tudo dentro de withScopeLock, advisory lock por scope)
  → core/src/reconciler/composite-provider.ts: roteia kind "service" → DockerProvider
  → core/src/providers/docker.ts: apply() cria N containers nomeados <svc>-<i>
  → core/src/providers/docker-transport.ts (seam) → core/src/providers/ssh-transports.ts
  → SSH: curl --unix-socket /var/run/docker.sock -X POST .../containers/create  (body via stdin)
  → core/src/providers/ssh-exec.ts: spawn("ssh", argv, {shell:false}), chave temp 0600
  → HOST remoto: sshd → curl → Docker Engine
```

Características que importam para o contraste com k8s:

| Peça | Docker hoje |
|---|---|
| **Transporte** | SSH `argv-only` (sem shell), `curl` na docker.sock. Não usa WireGuard, não usa TCP, não usa SDK npm. (`core/src/providers/ssh-transports.ts:135`, `ssh-exec.ts`) |
| **Réplicas** | Materializadas como N containers individuais `<svc>-<i>`. Não há Swarm/serviço replicado nativo — o reconciler cria os que faltam (`docker.ts:423`, `:813`). |
| **Scale-down** | **Não remove** containers (fail-safe — órfão vira *drift*, nunca delete automático). (`core/src/reconciler/drift.ts`) |
| **Secrets** | `secret:<ref>` resolvido **só no apply**, atrás de token unforgeable (`createApplyContext()` em `reconcile.ts:446`), injetado direto no `Env` do container. Nunca em plan/log/observe. Resolver real = SOPS+age (`core/src/store/secrets.ts`). |
| **Health** | `observe()` faz `GET /containers/json` + inspect; wait-for-healthy faz poll de `State.Health.Status` (`core/src/providers/docker-wait-healthy.ts`). |

---

## 2. O ponto de extensão (por que isso é factível)

O loop do reconciler é **agnóstico de backend**. Todo backend implementa um único
contrato — `core/src/providers/provider.ts:166`:

```ts
interface Provider {
  readonly name: string;
  observe(scope: string): Promise<ObservedSlice>;   // read-only
  apply(action: PlanAction): Promise<ApplyResult>;    // idempotente; no-op ⇒ changed:false
  verify(action: PlanAction): Promise<boolean>;       // read-only; reality == desired
  destroy?(action: PlanAction): Promise<ApplyResult>; // opcional, gated
}
```

Adicionar um kind/provider novo é uma **mutação de mapa data-driven** em três pontos
que precisam concordar:

1. `KIND_TABLE` em `core/src/reconciler/observed-adapter.ts:33` (kind → schema + coleção).
2. Ordenação do plano: `KIND_RANK` (`plan.ts:77`, v1) ou `V2_PLAN_ORDER` (`plan.ts:463`, v2).
3. Roteamento ao backend: `CompositeRoutes` (`composite-provider.ts:68`) ou `byKind`
   em `createCompositeProvider` (`v2-wrap.ts:161`).

**Não se toca** `reconcile.ts` nem `apply.ts` — são data-driven por kind (comentário
explícito em `v2-wrap.ts:155-159`). O exemplar mais recente e limpo de "kind v2
inteiro adicionado" é o **firewall v2** (`core/src/providers/v2/hetzner-firewall.ts` +
`core/src/agent/v2/set-firewall.ts` + pieces em `entrypoint-wiring.ts:402`).

Os transportes externos são um seam injetável — `interface EntrypointTransports`
(`entrypoint-wiring.ts:124`) tem hoje `docker()`, `wireguard()`, `restic()`. Um
`kube()` entraria do mesmo jeito.

---

## 3. As tools de nome enganoso — veredito

| Tool | Veredito | Evidência |
|---|---|---|
| `apply_manifest` | **NÃO é kubectl.** Aplica o manifesto declarativo do PRÓPRIO sistema (6 kinds Hetzner/Docker). | `tools.ts:679` `DesiredStateSchema.parse(...)`; schema em `core/src/domain/desired-state.ts:163` = `{servers, networks, volumes, services, dns, backups}`. |
| `set_ingress` | **Hetzner, não ingress k8s.** Composite Certificate+LoadBalancer+Firewall+Hetzner DNS. | `core/src/providers/v2/ingress.ts:1-94` ("DNS POINTS AT THE LB"). |
| `set_load_balancer` | **Hetzner Cloud Load Balancer (billed), não LB k8s.** | `core/src/providers/v2/hetzner-load-balancer.ts:1-85`. |
| `expose_service` | **Hetzner.** Açúcar que sintetiza Cert+LB+Ingress sob 1 approval. | `core/src/agent/v2/expose-service.ts:175-223`. |

O vocabulário é emprestado do mundo cloud-native, mas a implementação inteira é
**Hetzner Cloud API + Docker-over-SSH + restic + WireGuard**.

---

## 4. As três peças que faltam para gerenciar o setup do bevox-meta-api (k3s + cloudflared)

Achados-chave da investigação:

- **Não existe mecanismo genérico de "rodar comando arbitrário no host".** Só três
  transports fixos (docker `curl`, `wg`, `restic`) sobre SSH. O único `exec` é
  `createDockerExecOverSsh` (`core/src/providers/docker-exec-adapter.ts`) e mesmo esse
  fala Engine API `/containers/{id}/exec` (comando *dentro* de container, não no host).
- **`provision_server` só repassa cloud-init.** `serverBody()` em
  `core/src/providers/hetzner-cloud.ts:425` só inclui `user_data` se declarado no
  manifesto; não há fase pós-boot de "instalar software".
- **O edge do MCP é Hetzner-native, não cloudflared.** O `IngressProvider` orquestra
  Hetzner Certificate (ACME) + Hetzner LB + Firewall + Hetzner DNS. O cloudflared em
  `deploy/` só expõe o próprio daemon (`mcp.example.com → 127.0.0.1:8787`),
  configurado à mão pelo operador — não é recurso gerenciado.
- **WireGuard hoje é stand-in sem crypto real** (`core/src/providers/wireguard.ts:180`,
  `publicKey = "wgpub:<nome>"`). Seam pronto, malha não-funcional.

Logo, reproduzir o setup do meta-api ponta a ponta exige:

| # | Peça | Esforço | Existe hoje? |
|---|---|---|---|
| 1 | **Instalar k3s no host** | Baixo–médio | Parcial — via cloud-init `user_data` (passthrough literal) já roda no boot, mas fire-and-forget (sem observe/verify/retry). Idempotente exigiria um `HostCommandProvider` novo. |
| 2 | **Aplicar manifestos k8s** (Deployment/Service/Ingress) | Alto | **Não** — eixo inteiramente novo. `apply_manifest` aplica o manifesto *do próprio bevox*, não YAML k8s. |
| 3 | **Edge cloudflared** (tunnel/Access/DNS) | Alto | **Não** — o edge é Hetzner LB+ACME, concorrente conceitual do cloudflared. Precisaria de um provider Cloudflare. |

---

## 5. Os dois caminhos estratégicos

### Caminho A — "k3s fora do MCP" (já suportado, esforço quase zero)

O MCP provisiona a VM Hetzner; o `user_data` do manifesto roda
`curl -sfL https://get.k3s.io | sh` no boot; `MANAGED_MESH=off` +
`MANAGED_SERVICES=off` (`core/src/config.ts:208-227`, `deploy/README.md:117-140`)
desligam Docker/WireGuard do roteamento. **É literalmente o "caminho A do
bevox-meta-api" já documentado** em
`docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md` e
`docs/investigations/2026-05-26-provision-server-ssh-coupling.md` (que chama isso de
"Bloco E (k3s)"). Funciona hoje.

**Limite:** o MCP não enxerga nem reconcilia nada *dentro* do k3s — só entrega a VM.

### Caminho B — integração k8s de primeira classe (o "Bloco E")

Um `KubernetesProvider` implementando o port `Provider`, com duas sub-opções de
transporte:

- **B1 — kubectl-over-SSH:** espelha o Docker exatamente. Novo `KubeTransport` análogo
  ao `DockerTransport`, rodando `kubectl` no host k3s via o `ssh-exec.ts` que já existe.
  Menor footprint de dependência nova.
- **B2 — cliente do kube-apiserver:** usa o `http-client.ts` existente contra o
  apiserver via kubeconfig/TLS. Mais idiomático (server-side-apply), mais lida com
  kubeconfig.

Receita concreta (caminho v2 — **não tocar os 12 tools v1 frozen**; há teste de
conformance que trava isso em `core/src/agent/contract-conformance.test.ts`):

1. `"kubectl_apply"` em `V2_TOOLS` (`core/src/agent/capability.ts:82`).
2. `KubeManifestSchema` (Zod) em `core/src/domain/entities-v2.ts`.
3. Provider em `core/src/providers/v2/kube-apply.ts` (molde: `hetzner-load-balancer.ts`
   para a estrutura; `docker.ts` + `docker-transport.ts` para o driver que executa
   comando externo).
4. Tool em `core/src/agent/v2/kubectl-apply.ts` (padrão das 8 tools v2 existentes).
5. Transport factory `kube(config)` em `EntrypointTransports`
   (`entrypoint-wiring.ts:124`) + pieces estáticas em `buildBootDeps`.
6. Registro MCP (`core/src/agent/mcp.ts`) + REST (`core/src/agent/rest.ts`); ligar
   `v2Tools` em `core/src/server.ts` (hoje `server.ts` nem passa `v2Tools`).
7. Approval-gate herdado automaticamente — construir o gate com `isSensitive: () => true`
   para approval-always (como `run_migrations`/`set_load_balancer` fazem).

**Tensão de design a resolver:** o invariante fail-safe do bevox (nunca deletar o que o
operador não pediu) colide com o scale-down nativo do ReplicaSet do k8s. Quem "remove
pods" passa a ser o controller do k8s, não o MCP — precisa ser conciliado
explicitamente na spec.

---

## 6. Contraste Docker-atual × Kubernetes-equivalente

| Peça | Docker atual | Equivalente k8s/k3s | O que muda |
|---|---|---|---|
| Deploy | N containers `<svc>-<i>` via Engine API | `Deployment` (apps/v1); kubelet cria Pods | provider entrega 1 objeto declarativo; controller materializa |
| Scaling | reconciler cria os que faltam; não remove | `spec.replicas`/`kubectl scale`; ReplicaSet adiciona **e remove** | scale-down destrutivo nativo × fail-safe |
| Secrets | inline no `Env`, ref em label | `Secret` (v1) + `envFrom`/`secretKeyRef` | valor vira objeto no apiserver |
| Health | inspect + poll `State.Health` | liveness/readiness/startup probes | probes declaradas no PodSpec |
| Networking | `ExposedPorts`; exposição = Hetzner Cert+LB+Ingress | `Service` + `Ingress` (+cert-manager) | bundle do `expose_service` mapeia ~1:1 |
| Transporte | SSH + curl --unix-socket | kube-apiserver via kubeconfig/HTTPS | sai SSH+curl; `DockerTransport` → `KubeTransport` |

---

## 7. Recomendação

1. **Curto prazo:** usar o **Caminho A** — é o que o próprio repo já prevê e não custa
   código. Provisiona a VM via MCP, instala k3s no cloud-init, deixa o k3s gerenciar
   workloads. Resolve a dor imediata do go-live do meta-api.
2. **Primeira classe:** o **Caminho B1 (kubectl-over-SSH)** é o de menor atrito por
   espelhar 1:1 o padrão Docker já provado. Mas, pelo workflow do repo
   ("substantive changes start with a spec" + dependência/provider externo novo → parar
   e abrir spec), **o próximo passo correto é escrever uma spec do "Bloco E" em
   `docs/specs/`**, não codar.
3. **Edge:** decidir cedo entre aceitar o **edge Hetzner-native** que já existe
   (`expose_service`/`set_ingress`) ou bancar um **provider Cloudflare** novo (peça 3).
   Reproduzir o cloudflared-no-host do meta-api é um eixo separado e caro.

O roadmap atual (`README.md:97-105`) lista HA/DR, PolicyEngine e observabilidade como
próximos blocos — k8s e Cloudflare não estão lá ainda.

---

## Apêndice: menções a k8s/k3s já existentes no repo (roadmap, não código)

- `docs/investigations/2026-05-26-provision-server-ssh-coupling.md:195,212,143,194` —
  "Bloco E (k3s)" proposto; "caminho A do bevox-meta-api".
- Knobs `MANAGED_MESH` / `MANAGED_SERVICES`: `CLAUDE.md:43-44`, `core/src/config.ts:218`,
  `core/.env.example:129,144,154`.
- Specs: `docs/specs/2026-05-26-server-scope-transport-decoupling.md`,
  `docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md`,
  `docs/specs/2026-05-26-apply-manifest-silo-fanout.md:541`.
- `deploy/README.md:117-137` — seção "k3s/CNI external — MANAGED_MESH=off".
- `helm`: nenhuma menção no repo.
