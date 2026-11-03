# bevox-hetzner-mcp — wire v2 `set_firewall` through `buildBootDeps`

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (bug-report #10 do `bevox-meta-api`)
- **Tipo:** Spec-filha (cabling, operational) — sem mudança de provider/contrato
- **Spec-mãe (v2 Bloco A):** [2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md](./2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md) (FROZEN — define `set_firewall` contract + provider).
- **Spec irmã:** [2026-05-27-hetzner-cloud-wire-translation.md](./2026-05-27-hetzner-cloud-wire-translation.md) (PR-B; v1 server/network/volume creation pipeline).

## 0. Escopo

Cabling apenas. `HetznerFirewallProvider`, `setFirewall` tool, `WorkingFirewallStore` já existem (v2 Bloco A F1). REST route `POST /api/v2/firewalls` + MCP tool já existem mas só registram quando `deps.setFirewall` está populado. Esta spec wira o dep.

Mudança aderente a v2 Bloco A — NÃO altera contrato ou comportamento dos providers.

## 1. Contexto

Verificado live:

```
POST /api/v2/firewalls → HTTP 404 {"code":"fatal","message":"no such endpoint"}
```

Routes condicionais em `rest.ts:766-794` e `mcp.ts:613-643` ficam dormant quando `deps.setFirewall === undefined`. Bug #10 da sessão `bevox-meta-api`: caminho A precisa de firewall pra `meta-api-prod-1` (ID 133406347, criada pelo apply_manifest pós PR-B).

`entrypoint-wiring.ts:138-249` não constrói os deps. v2 Bloco A foi shipped mas operacionalmente nunca wired no daemon.

## 2. Design

### 2.1 `BootDeps` ganha `setFirewall?`

`core/src/server.ts:BootDeps`:
```ts
import type { SetFirewallDeps } from "./agent/v2/set-firewall.js";
// ...
export interface BootDeps {
  // ... existing
  readonly setFirewall?: SetFirewallDeps;
}
```

### 2.2 `server.ts` forwarda pra rest + mcp

Tanto `createRestServer({...})` quanto `createMcpServer({...})` já aceitam `setFirewall` opcional (rest.ts:207, mcp.ts:135). `server.ts` apenas threadia:

```ts
const rest = createRestServer({ catalog, credentials, approvalGate, secrets, health,
  ...(deps.setFirewall ? { setFirewall: deps.setFirewall } : {}) });
const mcp = createMcpServer({ catalog, credentials,
  ...(deps.setFirewall ? { setFirewall: deps.setFirewall } : {}) });
```

### 2.3 `entrypoint-wiring.ts` constrói o dep

Novos imports + construction usando o token HCLOUD já no scope:

```ts
import { createHetznerV2HttpClient } from "./providers/v2/hetzner-cloud-v2-http.js";
import { createHetznerFirewallProvider } from "./providers/v2/hetzner-firewall.js";
import { createInMemoryWorkingFirewallStore } from "./agent/v2/set-firewall.js";
import { getState as getObservedState } from "./store/observed-store.js";
import type { Server } from "./domain/entities.js";
import type { SetFirewallDeps } from "./agent/v2/set-firewall.js";

// Inside buildBootDeps (after existing providers + before return):
const hetznerV2Http = createHetznerV2HttpClient({
  token: config.HCLOUD_TOKEN,
  baseUrl: "https://api.hetzner.cloud/v1",
});
const serversProvider = async (): Promise<readonly Server[]> => {
  const state = await getObservedState(pool, "server");
  return state.servers;
};
const firewallProvider = createHetznerFirewallProvider({
  http: hetznerV2Http,
  serversProvider,
});
const firewallStore = createInMemoryWorkingFirewallStore();
// approvalGate is constructed inside server.ts (not entrypoint-wiring) — so
// setFirewall deps assembly happens at the seam where the gate exists.
```

**Nota:** `approvalGate` é instanciado em `server.ts:417` (não no `entrypoint-wiring`). Logo, o assembly final dos `SetFirewallDeps` precisa acontecer ali. Plan-writer decide se passa "peças soltas" via BootDeps (provider+store+serversProvider) e server.ts monta os deps, ou se entrypoint-wiring expõe uma factory closure que server.ts chama com o gate. Recomendação: passar peças soltas — server.ts já é o canonical gate owner.

### 2.4 `.env` ganha cap `set_firewall`

`core/.env` — adicionar `"set_firewall"` ao array `capabilities` do agente `claude-code:bevox-meta-api`. Operacional, fora do TS.

## 3. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o cabling code. |
| 2 | Idempotência | Sem mudança de provider; cabling apenas. Existing property tests intactos. |
| 3 | Fail-safe | set_firewall tool já tem deny-before-write (assertV2Capability); cabling herda. |
| 4 | Secrets at apply only | HCLOUD_TOKEN flows via http defaults (same as v1); sem novo canal. |
| 5 | StateEvent actor | Inalterado. |
| 6 | v2 Bloco A FROZEN contract | Contract não toca; só wiring operacional. |

## 4. Critérios de aceite

1. **Route registered:** após buildBootDeps, `deps.setFirewall` é populated (assembly em server.ts ou direto). `POST /api/v2/firewalls` retorna não-404.
2. **Token authz works:** agente `claude-code:bevox-meta-api` com `set_firewall` cap aceito; assertV2Capability não rejeita.
3. **Smoke test live:** `set_firewall` com firewall declarando rules SSH+HTTP+HTTPS aplica em Hetzner real (HCLOUD_TOKEN); idempotent re-call → no-change.
4. **Suite intact:** 972/974 verde → manter (+ qualquer test novo deste PR).
5. **Other v2 tools:** NÃO wired neste PR; deixar `setLoadBalancer`/`setCertificate`/`setPrimaryIp`/`setIngress`/`exposeService` como follow-up. Cabling pattern documented serve de template.

## 5. Fora de escopo

- v2 Bloco A outros tools (LB/Cert/PrimaryIP/Ingress/ExposeService) — follow-up batch per consumer demand.
- Mudanças no provider/contract.
- Live test automated (`@live` skeleton opcional).
- Update do `console/contract.ts` (v2 lives in `contract-v2.ts`; já existe — não tocar).

## 6. Arquivos

- `core/src/server.ts` — BootDeps.setFirewall + forward.
- `core/src/entrypoint-wiring.ts` — construct dep pieces.
- `core/.env` — add cap (operational, outside TS).
- Tests: a sanity test em `core/src/server.test.ts` (ou similar) que confirma BootDeps.setFirewall is forwarded.
