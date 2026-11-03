# bevox-hetzner-mcp — `apply_manifest` meta-scope no compositeProvider

- **Data:** 2026-05-26
- **Status:** Aceita (2026-05-26)
- **Autor:** Bernard (bug-report do `bevox-meta-api` + investigação owner)
- **Tipo:** Spec-filha (cirúrgica) — aditiva
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)
- **Spec irmã (precedente):** [2026-05-26-server-scope-transport-decoupling.md](./2026-05-26-server-scope-transport-decoupling.md)

## 0. Escopo e relação com as outras specs

Spec **aditiva, cirúrgica**: ~5 linhas de mudança comportamental em
`core/src/reconciler/composite-provider.ts` + 1 teste de unidade + 1
teste de integração REST. Não toca v1 nem v2 invariantes; não altera
schema, API pública, ou wire contract.

Resolve um bug residual descoberto pelo `bevox-meta-api` após o merge da
spec de transport decoupling: `apply_manifest` via REST (caminho de apply
real, não dry_run) retorna `HTTP 400 precondition` com mensagem
`compositeProvider: unsupported scope/kind "manifest"`.

## 1. Contexto

`rest.ts:469` declara a rota:

```ts
{ method: "POST", pattern: "/api/apply", tool: "apply_manifest", scope: "manifest" }
```

E `rest.ts:1071-1074` dispatcha passando o scope literal `"manifest"` pro
`executeTool`. O handler `doApplyManifest` em `tools.ts:594-615`:

```ts
if (dryRun) {
  const observed = await getObservedState(pool, scope);   // ✅ scope="manifest" → empty State
  return planned(plan(manifest, observed));               // ✅ funciona
}
await writeDesired(scope, manifest);                       // ⚠ silo "manifest"
return reconcileToEnvelope(scope, actor, defaultIsSensitive); // ❌ reconcile chama observe("manifest")
```

`reconcileToEnvelope` chama `reconcile()` que em `reconcile.ts:388/792`
faz `provider.observe(scope="manifest")`. Composite atinge
`targetsFor("manifest")` (composite-provider.ts:96-131) que cai no
default `throw ReconcileError("precondition", "compositeProvider:
unsupported scope/kind ...")`.

**Cobertura de testes hoje:** `tools.test.ts:900-916` testa
`apply_manifest` chamando `executeTool` direto com
`ctx(fullCred(), "network")` — passa um scope válido por engano.
**Nenhum teste cobre o caminho REST → executeTool com scope="manifest"**.
Por isso o bug escapou.

A própria investigação confirmou que esta spec **não precisa** mexer no
fluxo dry_run (já desacoplado da composite após PR #11 / F3). Foco
estrito: apply path real.

## 2. Design — meta-scope "manifest"

`compositeProvider.observe(scope)` ganha um early-branch que, quando
`scope === "manifest"`, faz **union** dos observes nativos de cada
backend, passando a cada um seu PRÓPRIO scope (nunca o literal
"manifest"):

```ts
async observe(scope: string): Promise<ObservedSlice> {
  if (scope === "manifest") {
    // Meta-scope: union of native observes across every backend.
    // Each backend receives its OWN scope (server/network/volume/...),
    // never "manifest" — preserves assertScope contracts in each
    // concrete provider (HetznerCloud/Docker/WireGuard/restic/Dns).
    const seen = new Set<string>();
    const visited = new Set<Provider>();
    const visit = async (kind: string, p: Provider) => {
      if (visited.has(p)) return;          // dedup: hetznerCloud shared by N kinds
      visited.add(p);
      const slice = await p.observe(kind); // native scope, not "manifest"
      for (const e of slice.entities) seen.add(e);
    };
    await visit("network", routes.network);
    for (const p of routes.server) await visit("server", p);
    await visit("volume", routes.volume);
    await visit("service", routes.service);
    if (routes.dns) await visit("dns", routes.dns);
    if (routes.backup) await visit("backup", routes.backup);
    return { scope: "manifest", entities: [...seen] };
  }
  // ... lógica per-scope existente (unchanged) ...
}
```

**Apply** (`composite.apply(action)`) **não muda**: roteia por
`action.entity` (que carrega o kind embedded, ex.: `server:foo`), e
`targetsFor("server:foo")` retorna `routes.server` corretamente. Esta
mecânica já existe (`composite-provider.ts:148-158`) e é independente
do scope passado pro reconcile.

**Por que escolhemos esta opção (E) e não a C sugerida pelo consumer:**
Opção C exigiria que cada provider concreto (Hetzner/Docker/WG/restic/DNS)
aceitasse scope="manifest" em seu próprio `assertScope` — mudança
distribuída em ≥5 arquivos com risco de regressão. Opção E é local,
contida, e mantém o contrato per-scope de cada provider intacto.

## 3. Testes

Dois testes obrigatórios:

### 3.1 Tool unit (regressão sentinel)
Em `core/src/agent/tools.test.ts`: chamada via `executeTool` com
`ctx(cred, "manifest")` e `apply_manifest({manifest:{...multi-kind...},
dry_run: false})`. Provider composite real (com fakes hetzner+wg+docker)
que retorna observed vazia. Assert: envelope é `applied` ou
`pending_approval` (depende da policy), **nunca** `precondition` com
mensagem `unsupported scope/kind`.

### 3.2 REST integration (gap-fill apontado pelo consumer)
Em `core/src/agent/rest.test.ts`: `POST /api/apply` com manifest
multi-kind, headers de auth válidos. Assert: status code 200/202, body
não é `code:"precondition"` com `unsupported scope/kind`. Cobre o
caminho REST → executeTool com scope literal "manifest" extraído da
route metadata.

## 4. Invariantes preservados

| # | Invariante | Como esta spec preserva |
|---|---|---|
| 1 | Specs come first | Esta spec precede a mudança em `core/src/`. |
| 2 | Idempotência | Composite.observe puro; idempotency property tests não tocados. |
| 3 | Fail-safe, never fail-deleting | Composite NÃO ganha código que delete. Meta-scope union só agrega entidades. |
| 4 | Secrets at apply only | Observe não resolve secrets; meta-scope mantém isso. |
| 5 | StateEvent actor | Inalterado. Apply path continua emitindo events com actor existente. |

## 5. Fora de escopo (latent issues)

- **Silo de desired-state entre `apply_manifest` e per-tool calls**:
  `writeDesired("manifest", manifest)` salva o manifest num silo scope
  "manifest"; subsequente `loadDesired("server")` (por `provision_server`)
  não vê. Bug latente que merece spec própria (provavelmente: `loadDesired`
  unifica per-kind quando scope é "manifest", OU `apply_manifest`
  distribui per-kind no write).
- **`putObservedState(pool, "manifest", observed)`**: após o fix, o
  reconcile do scope "manifest" persiste uma row observed-state keyed
  por "manifest" que nenhum per-tool consulta. Wasteful mas inofensivo.
  Optimização possível: pular o persist quando scope==="manifest" no
  reconcile. Não bloqueante.
- **Refactor do `targetsFor`**: a divisão entre `observe` (precisa de
  scope) e `apply` (precisa de entity) ficaria mais clara se composite
  tivesse `targetsForApply` vs `targetsForObserve`. Cosmético.

## 6. Critérios de aceite

1. `POST /api/apply` (REST) com manifest multi-kind retorna `applied`
   ou `pending_approval`, **nunca** `precondition: unsupported scope/kind
   "manifest"`.
2. Os 2 testes da §3 estão verdes.
3. Suíte completa (`npm --prefix core test`) continua verde — nenhum
   teste existente quebra.
4. Doc inline no `composite-provider.ts` cita esta spec e explica o
   case "manifest" como meta-scope (não como kind de backend).
5. `mcp.ts:209` (`apply_manifest: "manifest"`) e `rest.ts:469` (route
   scope literal) ficam coerentes — comportamento agora bate com a
   declaração existente.

## 7. Próximos passos

- Plan: `docs/superpowers/plans/2026-05-26-apply-manifest-meta-scope.md`
- 2-3 commits TDD (red → green → REST integration test → commit).
- Após merge: rebuild + `sudo systemctl restart bevox-daemon.service` +
  avisar `bevox-meta-api` que pode retomar `apply_manifest` real.
