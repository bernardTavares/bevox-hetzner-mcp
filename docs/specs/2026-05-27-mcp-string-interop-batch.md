# bevox-hetzner-mcp — MCP client string-interop batch (bugs #11 + #12)

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (bug-report #11 + #12 do `bevox-meta-api` Claude Code MCP consumer)
- **Tipo:** Spec-filha (cirúrgica, defensiva) — interop fix; mesma classe do bug #7
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN)
- **Spec irmã:** [2026-05-27-asrecord-accept-json-string.md](./2026-05-27-asrecord-accept-json-string.md) (bug #7 — string parse para `apply_manifest`).

## 0. Escopo

Cirúrgico: dois fixes defensivos relacionados, ambos por MCP clients (Claude Code et al.) serializarem nested args como JSON strings:

1. **Bug #11:** v2 `set_*` tools parseiam nested object com `Schema.parse(input.X)` direto. Quando MCP envia `firewall: "{...}"` (string), Zod rejeita `expected object, received string`.
2. **Bug #12:** `dry_run` é checado com strict `=== true` (11 call sites). MCP pode serializar como `"true"` (string) → strict ≠ → `dry_run` vira `false` → apply path roda quando deveria ser planned.

Mesma família do bug #7 (`asRecord` para `apply_manifest`). Esta spec generaliza para os outros call sites.

## 1. Design

### 1.1 `asBool` helper (novo, exported em `tools.ts`)

```ts
export function asBool(input: unknown): boolean {
  if (typeof input === "boolean") return input;
  if (typeof input === "string") return input === "true" || input === "1";
  if (typeof input === "number") return input === 1;
  return false;
}
```

Conservador: só `true` boolean, `"true"`/`"1"` string, `1` number → `true`. Ausente OR ambíguo → `false`. Preserva semantic atual: default é "apply" (não dry_run); coerção SOMENTE pra ativar dry_run.

### 1.2 Replace `=== true` per call site

11 sites em:
- `core/src/agent/tools.ts:462, 505, 560, 596, 651` (5 v1 — deploy_service, scale_service, set_dns, provision_server, doGatedOp).
- `core/src/agent/v2/set-firewall.ts:194, set-certificate.ts:172, set-primary-ip.ts:180, set-load-balancer.ts:171, set-ingress.ts:159, expose-service.ts:362` (6 v2).

Padrão:
```ts
- const dryRun = input.dry_run === true;
+ const dryRun = asBool(input.dry_run);
```

### 1.3 Wrap v2 nested Zod parses com `asRecord`

5 sites em `core/src/agent/v2/`:
- `set-firewall.ts:183` — `input.firewall`
- `set-certificate.ts:161` — `input.certificate`
- `set-primary-ip.ts:169` — `input.primary_ip`
- `set-load-balancer.ts:160` — `input.load_balancer`
- `set-ingress.ts:148` — `input.ingress`

Padrão:
```ts
- desired = FirewallSchema.parse(input.firewall);
+ desired = FirewallSchema.parse(asRecord(input.firewall));
```

`asRecord` (já exported pós-PR #17) JSON-parses se string, retorna `{}` se array/null. Zod então valida shape. MCP clients que enviam JSON-string passam; clients que enviam object passam unchanged.

**Nota expose_service:** não wrappa — input é flat (service/hostname/tls são scalar strings via `input.service` etc.). Só a coerção de dry_run aplica.

## 2. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | `asBool` + `asRecord` são puros; coerções são idempotentes. Property tests intactos. |
| 3 | Fail-safe | `asBool(ambiguous) = false` → default é apply (não dry_run); operador opera-in explicitly. `asRecord(malformed) = {}` → Zod rejeita com mensagem clara. |
| 4 | Secrets at apply only | Coerções são síncronas, puras; nenhum canal de secret. |
| 5 | StateEvent actor | Inalterado. |

## 3. Critérios de aceite

1. **`asBool` unit tests:** `true`→`true`; `"true"`→`true`; `"1"`→`true`; `1`→`true`; `false`→`false`; `"false"`→`false`; `undefined`→`false`; `null`→`false`; `"yes"`→`false` (conservador).
2. **dry_run string coerção (integration):** `apply_manifest({manifest:{...},dry_run:"true"})` retorna `{status:"planned",plan:[...]}`. Antes: `{status:"applied"}` (silent no-op se desired vazio, ou applied real se manifest tem creates).
3. **v2 JSON-string nested input:** `set_firewall({firewall:"<JSON string>",dry_run:true})` chega ao `FirewallSchema.parse` com o object parsed; sem error "expected object, received string".
4. **Backward-compat:** todos os existing tests passam — boolean `true` e object `{...}` continuam funcionando.
5. **Suite green:** 973/975 → manter + novos tests (~+6: 4 asBool + 2 integration).

## 4. Fora de escopo

- **Bug #9** (apply_manifest approval semantics) — design call sobre policy v1; precisa spec própria.
- **Bug #13** (snapshot semantics) — separate spec.
- **Bug #14** (destroy/restore verification) — smoke test follow-up.
- **Wiring v2 set_* restantes (LB/cert/ingress/primary-ip/expose-service routes em entrypoint)** — preventive PR à parte.
- Não tocar `WriteEnvelope` shape.
- Não introduzir Zod preprocess (deixar pattern explícito via helpers).

## 5. Migração

- **Backwards-compat full.** Boolean inputs continuam. Object inputs continuam. String inputs (que falhavam antes) agora passam.
- Sem schema migration.

## 6. Arquivos

- `core/src/agent/tools.ts` — novo `asBool` + 5 dry_run replaces.
- `core/src/agent/v2/{set-firewall,set-certificate,set-primary-ip,set-load-balancer,set-ingress,expose-service}.ts` — 6 dry_run replaces + 5 nested object wraps.
- `core/src/agent/tools.test.ts` — `asBool` unit tests + 1 integration sentinel.
- `core/src/agent/v2/set-firewall.test.ts` — 1 integration sentinel (string-input).
