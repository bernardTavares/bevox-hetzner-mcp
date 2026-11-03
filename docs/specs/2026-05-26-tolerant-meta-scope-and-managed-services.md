# bevox-hetzner-mcp — Tolerant meta-scope + `MANAGED_SERVICES` knob

- **Data:** 2026-05-26
- **Status:** Aceita (2026-05-26)
- **Autor:** Bernard (bug-report do `bevox-meta-api` #3 + investigação owner)
- **Tipo:** Spec-filha (aditiva)
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md)
- **Spec irmãs:**
  - [2026-05-26-server-scope-transport-decoupling.md](./2026-05-26-server-scope-transport-decoupling.md) (PR #11 — MANAGED_MESH)
  - [2026-05-26-apply-manifest-meta-scope.md](./2026-05-26-apply-manifest-meta-scope.md) (PR #12 — composite manifest meta-scope)

## 0. Escopo e relação com as outras specs

Spec aditiva. Resolve um caso de borda exposto pelo PR #12: o meta-scope
`"manifest"` que eu introduzi no composite visita `routes.service`
(Docker) incondicionalmente. Em deploys com `SSH_HOST` placeholder
(caminho A do `bevox-meta-api` — k3s gerencia containers, MCP NÃO toca
Docker), o `Docker.observe("service")` falha em SSH → o
`apply_manifest` apply path inteiro retorna 503 transient — mesmo que o
manifest **não declare nenhum service**.

Combina duas mudanças ortogonais que cobrem cenários diferentes:

- **Mudança B (tolerant):** `composite.observe("manifest")` tolera
  falha per-backend (try/catch silencioso com warn log estruturado).
  Robusto contra connectivity parcial em qualquer cenário.
- **Mudança C (`MANAGED_SERVICES` knob):** novo env var
  `MANAGED_SERVICES=on|off` (default `on`, backwards-compat). Quando
  `off`, `routes.service` fica undefined (mesmo padrão de
  `routes.dns?`/`routes.backup?`); o periodic reconcile filtra o scope
  `"service"` da lista de ticks. Análogo a `MANAGED_MESH=off` do PR #11.

Não toca v1/v2 invariantes; não altera schemas, API pública, ou wire
contract.

## 1. Contexto

PR #12 adicionou meta-scope em `composite-provider.ts`:

```ts
if (scope === "manifest") {
  const visit = async (kind, p) => { /* p.observe(kind), no try */ };
  await visit("network", routes.network);
  for (const p of routes.server) await visit("server", p);
  await visit("volume", routes.volume);
  await visit("service", routes.service);    // ← Docker.observe → SSH SEMPRE
  if (routes.dns) await visit("dns", routes.dns);
  if (routes.backup) await visit("backup", routes.backup);
}
```

Em produção pós-PRs #11/#12 com `MANAGED_MESH=off` (k3s setup):
- `routes.server = [HetznerCloud]` (WireGuard fora — PR #11 fez isso).
- `routes.service = [Docker]` (Docker continua, PR #11 não tocou).
- `Docker` provider invoca `ssh-exec` em todo `observe()`.
- Se `SSH_HOST=placeholder-fase-a`, `ssh exit 255`, `apply_manifest`
  retorna 503 — mesmo com manifest sem `services:`.

O bug-report cita `dry_run: true`, mas o caminho dry_run pós PR #11/F3
usa `getObservedState(pool, scope)` (cached DB, sem composite). O SSH
só dispara via `reconcile.ts:388` que é atravessado pelo apply path
(`reconcileToEnvelope("manifest", ...)`). Investigação assume reporte
misturou trace; bug é real no apply path.

`MANAGED_MESH=off` resolve só wireguard. O caminho A `bevox-meta-api`
precisa também desacoplar Docker — daí o knob novo `MANAGED_SERVICES`.

## 2. Mudança B — tolerant meta-scope (resiliência geral)

**`composite-provider.ts` `observe("manifest")` branch**: cada `visit()`
embrulha a chamada do backend em try/catch silencioso (warn estruturado
+ continue).

```ts
const visit = async (kind: string, p: Provider | undefined) => {
  if (!p || visited.has(p)) return;          // skip undefined (Mudança C)
  visited.add(p);
  try {
    const slice = await p.observe(kind);     // native scope, not "manifest"
    for (const e of slice.entities) seen.add(e);
  } catch (err) {
    // Tolerate per-backend failure: meta-scope union continues with whatever
    // succeeded. Drift detection of failed backend remains the responsibility
    // of the periodic reconcile cycle (canonical drift channel — cf. v1 §5).
    // Cite: docs/specs/2026-05-26-tolerant-meta-scope-and-managed-services.md §2.
    // logger is module-private (entrypoint-wiring injects via createPinoLogger);
    // composite has no logger seam — emit via a sub-logger or accept a logger
    // option in compositeProvider (small interface change).
    // For minimal-diff: console.warn structured JSON. Logger.warn would be cleaner
    // — see §5 follow-up.
  }
};
```

**Decisão pequena**: como o composite não recebe um `logger` hoje, o
warn estruturado em B vai num formato compatível (`stderr` JSON
estruturado via `console.warn` — daemon já não tem agente humano no
caminho HTTP do dry_run/apply). Follow-up #X opcional: estender
`CompositeRoutes` com `logger?: Logger`. Não-bloqueante.

**Trade-off:**
- ✅ Robusto a connectivity parcial (Docker offline, WG offline em flip
  on→off, etc.) — apply_manifest segue para os que respondem.
- ✅ Não muda semântica de drift cross-scope (periodic reconcile
  continua observando tudo).
- ⚠ Drift de backend inacessível fica mascarado em apply_manifest até o
  backend voltar; periodic detecta (porém com circuit breaker isolando).

## 3. Mudança C — `MANAGED_SERVICES` knob (opt-out explícito)

Análogo a `MANAGED_MESH=off` do PR #11. Operador setando
`MANAGED_SERVICES=off` em `core/.env`:

1. **`ConfigSchema`** (`core/src/config.ts`): novo campo
   `MANAGED_SERVICES` com default `"on"`, mesma forma de
   `MANAGED_MESH` (preprocess → enum(["on","off"]) → transform).
2. **`entrypoint-wiring.ts`**: `routes.service` vira condicional.
   ```ts
   const providers: BootDeps["providers"] = {
     network: hetznerCloud,
     server: config.MANAGED_MESH === "on"
       ? [hetznerCloud, wireguard]
       : [hetznerCloud],
     volume: hetznerCloud,
     ...(config.MANAGED_SERVICES === "on" ? { service: docker } : {}),
     dns: hetznerDns,
     backup,
   };
   ```
3. **`CompositeRoutes` interface** (`composite-provider.ts`):
   `service` vira opcional (`readonly service?: Provider`) — mesmo
   padrão de `dns?`/`backup?`.
4. **`targetsFor("service")`**: se `routes.service` undefined, throw
   `"unsupported scope/kind service (no service backend in routes)"` —
   mesmo padrão das outras opcionais que retornam `[]` ou throw.
   Periodic reconcile sabe excluir scope `"service"`.
5. **Effective scopes seam** (`BootDeps.scopes`): computar em
   `entrypoint-wiring.ts` o `scopes` baseado em providers presentes;
   passar pra `BootDeps`. Server.ts pega via `deps.scopes ?? DEFAULT_SCOPES`.
   Quando `MANAGED_SERVICES=off`, scopes = `["network", "server",
   "volume"]` (sem `"service"`).
6. **Boot warn** (`entrypoint-wiring.ts`): emite `warnManagedServicesOff`
   análogo a `warnManagedMeshOff` quando `MANAGED_SERVICES=off`.
7. **`.env.example`**: documenta o knob, exemplo k3s.

## 4. Interação entre B e C

São ortogonais. **B sozinho**: composite continua visitando
routes.service quando definido, mas tolera falha (warn). **C sozinho**:
operador opta out; routes.service nunca chamado. **B + C**: máxima
resiliência — operador explicit opt-out para k3s, e mesmo deploys
"normais" toleram blip transitório em Docker/WG.

Pra o `bevox-meta-api` caminho A: setar `MANAGED_SERVICES=off` (e
manter `MANAGED_MESH=off`) faz o MCP virar puro orquestrador Hetzner
Cloud (HTTP-only) — zero SSH em qualquer caminho. Bug #3 resolvido por
C; bug #3 também resolvido por B sozinho mas com warn no log (menos
limpo).

## 5. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | Composite.observe puro; property tests inalterados. |
| 3 | Fail-safe, never fail-deleting | B/C só toleram observe; ZERO delete path. |
| 4 | Secrets at apply only | Observe não resolve secrets; logs do try/catch são value-free. |
| 5 | StateEvent actor | Inalterado. |

## 6. Fora de escopo (latent)

- **Silo `writeDesired("manifest", ...)` vs per-tool stores**: bug
  herdado da spec #12 §5. Não resolvido aqui.
- **Logger seam no composite-provider**: hoje composite não tem logger
  injetado. Mudança B usa `console.warn` JSON. Refactor pra
  `CompositeRoutes.logger?: Logger` é cosmético — follow-up.

## 7. Critérios de aceite

1. `apply_manifest` (apply path) com manifest contendo só
   networks+servers funciona com `SSH_HOST=placeholder-*`,
   `MANAGED_MESH=off`, e (qualquer um dos dois):
   - `MANAGED_SERVICES=off` (preferencial — pura Mudança C), OU
   - `MANAGED_SERVICES=on` (Mudança B tolera o SSH fail; warn no log).
2. `MANAGED_SERVICES=on` (default) preserva 100% do comportamento de
   hoje: testes existentes verdes sem modificação.
3. `MANAGED_SERVICES=off` com declaração de `Service` no manifest:
   precondition error no plan time (porque `targetsFor("service")`
   throw) — operador sabe que opt-out + Service são incompatíveis.
4. Novos testes:
   - Tolerant: composite com fake docker provider que `throw`s na
     `observe`; meta-scope retorna union dos OUTROS backends; warn
     emitido.
   - Config: ConfigSchema parsing de `MANAGED_SERVICES` (default, on,
     off, "", invalid).
   - Wiring: `MANAGED_SERVICES=off` → `routes.service === undefined` +
     `deps.scopes` exclui `"service"`.
   - Boot warn: structured warn quando `MANAGED_SERVICES=off`.
5. Suite completa verde (`npm --prefix core test`).

## 8. Migração / rollout

- **Backwards-compatible.** `MANAGED_SERVICES=on` default; deploys
  atuais não percebem mudança.
- Deploys novos opt-out (caminho A `bevox-meta-api`): `MANAGED_MESH=off`
  + `MANAGED_SERVICES=off` em `core/.env`.
- Reversibilidade: flipar `on/off` requer restart (config é boot-time,
  igual MANAGED_MESH).

## 9. Próximos passos

- Plan: `docs/superpowers/plans/2026-05-26-tolerant-meta-scope-and-managed-services.md`
- Ordem sugerida: F1 Mudança B (1 task), F2 Mudança C (4 tasks), F3
  docs (1 task). ~6 commits TDD.
