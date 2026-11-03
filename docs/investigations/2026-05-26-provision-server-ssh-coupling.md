# Investigação: `provision_server` acopla SSH mesmo quando deveria ser HTTP-puro

- **Data:** 2026-05-26
- **Reporter:** sessão paralela do `bevox-meta-api`
- **Investigador:** Claude Code (no repo `bevox-hetzner-mcp`)
- **Status:** Phase 1 (root cause) **completa**. Nenhum fix implementado. Aguarda decisão do owner.

## TL;DR

A hipótese 1 (**bug**) **E** a hipótese 2 (**design quirk**) propostas pela sessão `bevox-meta-api` são **ambas verdadeiras**, em três camadas independentes:

1. **`doProvisionServer` ignora `input.dry_run`** — o tool sempre escreve desired-state e dispara reconcile, independente do flag. Inconsistente com `doDeployService` que tem branch dedicado pra dry_run.
2. **O caminho de dry_run que existe (em `doDeployService`) chama `provider.observe(scope)` ao vivo** — não usa o observed-store cacheado. Logo, mesmo se a Bug 1 fosse corrigida, dry_run para o scope `server` ainda dispararia SSH.
3. **`composite-provider.observe(scope="server")` é UNION fan-out para `[HetznerCloud, WireGuard]` por design** — qualquer call de observe no scope `server` chama WireGuard.observe, que faz SSH no `SSH_HOST`. Não há diferenciação por "intenção do call site" (cloud-only vs serviço-com-mesh).

A spec `2026-05-25-go-live-cloudflare-tunnel.md §6` é **otimista demais** ao dizer que placeholders Hetzner/SSH/restic só falham "no ciclo de reconcile, isoladas por circuit breaker". A verdade é: **qualquer tool que toca `server` ou `service` scope (~13 das 19 tools)** chama observe ao vivo e falha em SSH antes do circuit breaker poder isolar nada. O CB protege as próximas tentativas, não a primeira.

## Reprodução: o que realmente acontece

Caso reportado: `provision_server({name, type, location, network, ssh_keys, labels, dry_run: true})` → HTTP 503 com `error.entity: "ssh:placeholder-fase-a"`.

Trace verificado lendo o código:

```
POST /api/servers (rest.ts:444)
  → tool dispatch "provision_server" (tools.ts:823)
    → doProvisionServer(input, scope="server", actor) (tools.ts:405-432)
      ⚠ NÃO lê input.dry_run em momento algum
      → mergeDesired(scope, ...)          (escreve desired-state)
      → reconcileToEnvelope(scope, actor, () => true, {op:"create", entity:"server:..."})
        → (eventualmente) reconcile() (reconciler/reconcile.ts:294-...)
          → provider.observe("server") (reconcile.ts:341)
            → compositeProvider.observe("server") (composite-provider.ts:137-146)
              → targetsFor("server") = routes.server = [HetznerCloud, WireGuard]
              → for each: await p.observe("server")
                → HetznerCloud.observe("server") = HTTP GET (ok)
                → WireGuard.observe("server") (wireguard.ts:304-319)
                  → managedPeers(scope) (wireguard.ts:312)
                    → controller.listPeers() (ctl.listPeers)
                      → ssh-exec spawn ssh root@SSH_HOST 'wg show ...'
                        → exit 255 "Could not resolve hostname placeholder-fase-a"
                        → ssh-exec.ts:378 emite ReconcileError("transient",
                            "ssh: connection to placeholder-fase-a failed (exit 255)",
                            { entity: "ssh:placeholder-fase-a" })
                          ← bate exato com o entity/message do bug report
```

Bate exatamente.

## Evidência por camada

### Camada 1 — `doProvisionServer` não honra `dry_run`

`core/src/agent/tools.ts:405-432`:

```ts
async function doProvisionServer(
  input: Record<string, unknown>,
  scope: string,
  actor: string,
): Promise<WriteEnvelope> {
  const serverName = str(input.name);
  await mergeDesired(scope, (d) => ({
    ...d,
    networks: d.networks ?? [],
    servers: [
      ...(d.servers ?? []),
      { name: serverName, type: str(input.type), ... },
    ],
  }));
  return reconcileToEnvelope(scope, actor, () => true, {
    op: "create",
    entity: entityKey("server", serverName),
  });
}
```

**`input.dry_run` nunca é lido.** O tool sempre escreve desired-state e dispara `reconcileToEnvelope`.

Comparativo com `doDeployService` (linhas 434-488):

```ts
async function doDeployService(...) {
  const dryRun = input.dry_run === true;     // ← lê
  const svc = {...};
  if (dryRun) {                              // ← branch dedicado
    const current = await loadDesired(scope);
    const desired = DesiredStateSchema.parse({...});
    const slice = await provider.observe(scope);   // ← live observe, ver Camada 2
    const observed = observedAdapter(slice);
    return planned(plan(desired, observed));       // ← retorna plan sem mergeDesired/reconcile
  }
  await mergeDesired(scope, ...);
  return reconcileToEnvelope(scope, actor, defaultIsSensitive, {...});
}
```

**11 das 19 tools** (lookup por `grep -nE "const dryRun" agent/tools.ts` retorna **só** o match da `doDeployService`) seguem o padrão de `doProvisionServer`: ignoram `dry_run` no tool layer. Provavelmente uma assunção implícita de que "reconcileToEnvelope honra dry_run". Não é o caso — a função simplesmente dispara um reconcile.

> **Confirmar com owner:** essa diferença entre `doDeployService` e `doProvisionServer` é **intencional** (alguma razão de design para apenas `service` honrar dry_run no tool layer)? Não vejo no spec v1 nem nos comentários.

### Camada 2 — dry_run path em `doDeployService` chama observe ao vivo

`core/src/agent/tools.ts:470`:

```ts
const slice = await provider.observe(scope);   // ← `provider` é o COMPOSITE
```

O `provider` injetado é o resultado de `compositeProvider({network, server: [hcloud, wg], volume, service, dns?, backup?})` (`entrypoint-wiring.ts:193-204`).

Para scope=`service`, `composite.observe` chama `Docker.observe` → SSH a `SSH_HOST` rodando `docker ...`. Pra scope=`server`, chama `HetznerCloud.observe` (HTTP, ok) **e** `WireGuard.observe` → SSH.

Logo, **mesmo se Camada 1 fosse corrigida** (`doProvisionServer` lendo `dry_run` e usando o mesmo pattern de `doDeployService`), o dry_run ainda dispararia SSH no scope `server`. Camada 1 e Camada 2 são bugs ortogonais.

> Note que o comentário em `tools.ts:457-461` diz:
>
> > "dry_run → planned: plan() ONLY against the current desired+observed. NO desired-state write, NO reconcile, NO secret resolution"
>
> O comentário descreve "NO reconcile" mas a chamada **literal de `provider.observe`** atravessa todos backends do scope. O comentário está tecnicamente correto ("não reconcile = não plan+apply+record"), mas o efeito colateral de SSH no observe não é mencionado.

### Camada 3 — `composite.observe` é union fan-out por design

`core/src/reconciler/composite-provider.ts:137-146`:

```ts
async observe(scope: string): Promise<ObservedSlice> {
  // Union the slices of every backend owning this scope (deduped). A
  // backend that does not model the scope simply returns no entities.
  const seen = new Set<string>();
  for (const p of targetsFor(scope)) {
    const slice = await p.observe(scope);
    for (const e of slice.entities) seen.add(e);
  }
  return { scope, entities: [...seen] };
}
```

`routes.server = [HetznerCloud, WireGuard]` (fan-out de "host + mesh peer" — explícito em `entrypoint-wiring.ts:193-204` e documentado em `composite-provider.ts:21-37`).

A union semantics é **intencional**: a abstração "qual é o estado observado da entidade `server:X`" é a junção de "o que o Hetzner Cloud diz sobre o server" + "o que o WireGuard diz sobre o peer derivado deste server". Pra um uso "MCP gerencia VM + serviços Docker + mesh", a union é correta.

Pra uso "MCP só provisiona VM, k3s/containerd cuidam de containers" (caminho A do `bevox-meta-api`), o segundo backend é **inadequado** e o union força um requisito SSH que não existe na intenção do operador.

## Resposta direta às hipóteses do reporter

| Hipótese | Veredito | Onde |
|---|---|---|
| **1 — bug**: dry_run aciona algo que não devia (pre-flight global) | ✅ verdadeira | duas formas: (a) tool não lê dry_run; (b) dry_run path em doDeployService chama observe live |
| **2 — design quirk não documentado**: reconciler valida conectividade global antes de aceitar tool | ✅ verdadeira | `composite.observe` é union por design; SSH-backed backends são chamados em todo observe do scope que os contém — não há "transport-aware skip" |

A 1 é um defeito (oversight); a 2 é uma escolha arquitetural que não escala pra todos os use cases.

## Por que `journalctl` mostrou ciclos limpos antes do call

A spec §6 diz que placeholders são OK porque "o boot só checa não-vazio". Verdade pra boot. Mas o periodic reconcile cycle **chama `provider.observe(scope)` por scope a cada `RECONCILE_INTERVAL_MS`** (`reconcile.ts:341`). Para scope `server`, isso seria SSH ao vivo a cada ciclo.

Hipóteses do porquê não vimos `failed: 1` nos logs:
- O reconciler **deve** estar levando esses erros por TransientError + circuit breaker. Olhando `circuit-breaker.ts` e o agregado de health no daemon atual: todos os breakers estavam `closed` com `failures: 0` em sessão anterior. Isso só faz sentido se nenhum observe SSH falhou — o que sugere que a sessão anterior tinha `SSH_HOST` já real (caso da nossa máquina hoje: `<SERVER_IP>`).
- Logs anteriores mostraram principalmente "reconcile cycle withheld (scope contention)" — esses ciclos foram pulados por advisory lock, então nunca chegaram em observe.

**Conclusão**: o bug reportado por `bevox-meta-api` é reproduzível **especificamente quando `SSH_HOST=placeholder-*`**. Na nossa máquina hoje, `SSH_HOST=<SERVER_IP>` (VM bevox-control real), então `WireGuard.observe` consegue resolver o hostname e fazer SSH — pode até falhar por outro motivo (chave / `wg` não rodando), mas não com "Could not resolve hostname".

> Sub-pergunta para o owner: o daemon do `bevox-meta-api` está rodando uma **instância diferente** desta máquina, com `.env` próprio onde SSH_HOST ainda é placeholder? Ou é a mesma instância e o report descreve um estado de antes do Phase B?

## Espaço de fixes — comparação técnica

### A) Fazer `doProvisionServer` honrar `dry_run` (igual `doDeployService`)
- **Resolve**: aciona a mesma branch que outras tools tem.
- **Não resolve**: a branch ainda faz `provider.observe(scope)` ao vivo → SSH no scope server.
- **Esforço**: ~10 linhas + 1 teste por tool inconsistente. Multiplica por ~11 tools.
- **Veredito**: necessário mas insuficiente sozinho.

### B) dry_run usa observed cacheado (observed-store) em vez de live observe
- **Resolve**: dry_run deixa de fazer qualquer SSH/HTTP por definição.
- **Trade-off**: dry_run reflete o último snapshot persistido, não o agora-mesmo. Tradicional pra "preview" semantics; defensável.
- **Risco**: fresh daemon sem reconcile cycle ainda rodado → não há observed snapshot → dry_run precisa de fallback (snapshot vazio? erro?).
- **Esforço**: substituir `provider.observe` por `getState(pool, scope)` no dry_run path. Atualizar spec pra documentar a semântica "preview against last reconcile".
- **Veredito**: alinha com a redação do spec (`dry_run plans only`); resolve Camada 2.

### C) Lazy observe por provider (plan-aware)
- **Resolve**: só consulta backends cuja decisão depende deles.
- **Trade-off**: composite deixa de ser uma facade transparente; precisa entender o plan.
- **Esforço**: refactor grande do composite + plan; quebra invariantes de "composite é union forwarder".
- **Veredito**: caro; não recomendo a menos que C/D virem requisito.

### D) Provider declara `requires_transports: ("hcloud_http" | "ssh_docker" | "ssh_wg" | "restic_s3")[]`, reconciler skipa providers com transport não-configurado/inacessível
- **Resolve**: HTTP-only tools nunca tocam SSH se SSH não está configurado.
- **Trade-off**: novo conceito no Provider port; precisa atravessar o pipeline `observe → plan → apply` cuidadosamente pra não violar "fail-safe, never silent no-op". Drift estranho: provider "ausente" não vê suas entidades → reconciler poderia interpretar como "delete".
- **Esforço**: substancial; requer spec revision (novo invariante).
- **Veredito**: limpa, mas grande mudança arquitetural. Útil pra v2/v3.

### E) `routes.server` configurável (operador escolhe `[HetznerCloud]` puro ou `[HetznerCloud, WireGuard]`)
- **Resolve**: caminho A (k3s) ficaria com `routes.server = [HetznerCloud]`; caminho clássico (Docker MCP-managed) com `[HetznerCloud, WireGuard]`.
- **Trade-off**: a escolha vira config; permite cenários onde mesh é "fora-do-MCP". Coerente com spec do Bloco E (k3s) já proposta.
- **Esforço**: medium. `entrypoint-wiring.ts:193-204` deixa de hardcodar; nova chave no `ConfigSchema` (`MANAGED_MESH=on|off`); spec adicional.
- **Veredito**: o **mais alinhado** com a intenção do caminho A. Não toca a abstração composite. Cumpre o critério de aceite proposto.

### F) Combinação A + B (minimal) + E (estrutural)
- A + B resolve o **report exato** (dry_run side-effect-free).
- E desacopla o `bevox-meta-api` caminho A do SSH no fluxo de apply real.
- **Sem F sem E**: mesmo com dry_run OK, o `apply()` real do `provision_server` (não dry_run) ainda chamará `composite.observe("server")` no reconcile → WireGuard SSH → falha. O caminho A não funciona pleno.

## Recomendação ao owner

1. **Confirmar com o owner** (você) se Camada 1 é oversight (deveria ler dry_run) ou intencional (algum design reason que eu não vi).
2. **Mínimo viável pra resolver o report literalmente**: A + B (dry_run side-effect-free).
3. **Mínimo viável pra desbloquear o caminho A de `bevox-meta-api`**: E (`routes.server` configurável; operador opta por excluir WireGuard quando o mesh é externo). Sem isso, mesmo um dry_run perfeito é inútil — o `apply` real ainda exige SSH.
4. **Updates de spec**:
   - `docs/specs/2026-05-17-bevox-hetzner-mcp-design.md` §"Agent Interface" → documentar a semântica final de `dry_run` (com cache vs live).
   - `docs/specs/2026-05-25-go-live-cloudflare-tunnel.md` §9 → reescrever a frase "as chaves Hetzner/SSH/restic podem ser placeholders" pra refletir a realidade: SSH_* só é dispensável se `routes.server` exclui WireGuard E nenhum `service` (Docker) é declarado.
   - Possivelmente uma **nova spec-filha do Bloco E**: "MCP sem mesh / com runtime de container externo (k3s)" — caminho A do `bevox-meta-api`.

## Não-objetivos confirmados

- Não introduzir `SKIP_SSH_PREFLIGHT=true`. Concordo com o reporter — flag global quebra o modelo declarativo.
- Não mexer no `core/.env` do bevox-hetzner-mcp. A sessão paralela do `bevox-meta-api` cuida.
- Não rodar fixes antes da decisão do owner.

## Critério de aceite proposto pelo reporter — análise

| Critério | Alcançável com | Bloqueado por |
|---|---|---|
| `provision_server` (dry_run e apply) funciona com `SSH_HOST=placeholder-*` se `HCLOUD_TOKEN` é real | E (+A+B opcional pra cleanup) | Camada 3 (composite union) — só E resolve |
| Spec-mãe v2 e/ou v1 design atualizadas (transports por tool) | revisão de spec (nova) | bloqueio é decisão, não código |
| Spec `go-live-cloudflare-tunnel.md §9` atualizada (SSH_* só obrigatório se Service Docker) | revisão de spec | idem |
| Teste de regressão: provider Hetzner Cloud isolado funciona sem SSH transport carregado | já existe parcialmente (`createServer` aceita `providers` injetado nos tests com fakes; nenhum teste atual cobre "SSH transport ausente em produção") | precisa teste novo se aprovarmos E |

## Arquivos lidos durante esta investigação

- `core/src/agent/tools.ts` (linhas 405-488 + grep estrutural)
- `core/src/agent/rest.ts` (grep `dry_run`)
- `core/src/reconciler/composite-provider.ts` (linhas 85-160)
- `core/src/reconciler/reconcile.ts` (linhas 294-360 — vizinhança do observe call)
- `core/src/providers/wireguard.ts` (linhas 300-340)
- `core/src/providers/ssh-exec.ts` (linhas 350-385 — emissor do erro)
- `core/src/entrypoint-wiring.ts` (linhas 137-227 — onde routes.server é construído)

## Próximos passos (aguardando autorização do owner)

- [ ] Owner confirma se Camada 1 (dry_run não-lido em ~11 tools) é oversight.
- [ ] Owner escolhe entre A+B (mínimo do report) vs A+B+E (mínimo do caminho A do bevox-meta-api).
- [ ] Se E: brainstorm/spec breve sobre `routes.server` configurável (skill `superpowers:brainstorming` → `new-spec`).
- [ ] Plano TDD: red test reproduzindo o bug, fix, verde, commit por task.
- [ ] PR pequeno e focado por bug (A, B, E em PRs separados quando viáveis).
- [ ] Update spec `go-live-cloudflare-tunnel.md §9` no mesmo ciclo.
