# bevox-hetzner-mcp — `set_firewall` synchronous apply (bug #15)

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (bug-report #15 do `bevox-meta-api` Claude Code MCP consumer)
- **Tipo:** Spec-filha (cirúrgica, defensiva) — apply-path correctness
- **Spec-mãe (v2 Bloco A):** [2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md](./2026-05-20-bevox-hetzner-mcp-v2-bloco-a-borda-publica.md) (FROZEN — diz que "Ordem de apply (DAG topológico do reconciler v1, §estendido)" mas v2 scopes nunca foram wired ao reconciler periódico).
- **Spec irmã:** [2026-05-27-wire-v2-set-firewall.md](./2026-05-27-wire-v2-set-firewall.md) (PR #19 — wired route + provider deps; mas tool não invoca apply).

## 0. Escopo

Cirúrgico: 5-linha mudança em `core/src/agent/v2/set-firewall.ts:298` (entre workingStore write e StateEvent emit). Adiciona `await deps.provider.apply(desired, observed)` com try/catch fail-safe (error envelope se Hetzner rejeitar; intent não persiste em workingStore se apply falhar).

Pattern **idêntico ao já existente** em `set-certificate.ts:213-216` (provider.apply inline antes do commit). Não altera v2 contract.

## 1. Contexto

Verificado live por consumer:

```
set_firewall({firewall:{name,applied_to,rules,...}, dry_run:false})
→ {"status":"applied"}
curl https://api.hetzner.cloud/v1/firewalls → count=0   ← nenhum firewall criado
```

`set_firewall.ts:297-321` faz `workingStore.put(desired)` + `appendEvent(...result:"applied")` + retorna `applied` envelope. **Nunca chama `deps.provider.apply()`**. Hetzner API nunca tocada.

v2 Bloco A spec diz que apply real acontece via reconciler v1 estendido pra scopes v2 (firewall/cert/lb/ingress/primary-ip). Mas `composite-provider.ts:107-130` itera só `network|server|volume|service|dns|backup` — não inclui v2 scopes. `entrypoint-wiring.ts` periodic scopes idem. Logo o intent escrito em workingStore **nunca converge**.

Pattern já estabelecido em outros v2 tools: `set-certificate.ts:213` e `set-ingress.ts:266` chamam `provider.apply` inline antes do commit. `set-firewall.ts` é o outlier.

**`set_primary_ip.ts` tem mesmo gap** mas caminho A do `bevox-meta-api` não usa primary IPs (VM default IP basta). Spec à parte se precisar.

**`set_load_balancer.ts`** também não chama apply, mas o comportamento é **documentado** como deferred F5.4. Out of scope.

## 2. Design

`core/src/agent/v2/set-firewall.ts:297-298` ganha apply síncrono ANTES de workingStore.put:

```ts
// (7) Non-destructive + not-dry-run.
// First: converge Hetzner reality via provider.apply (idempotent;
// Hetzner errors surface as `error` envelope BEFORE persisting intent).
// Then: persist intent in workingStore + emit StateEvent. Pattern
// mirrors set_certificate (managed) and set_ingress.
try {
  await deps.provider.apply(desired, observed);
} catch (err) {
  return toErrorEnvelope(err);
}
try {
  await deps.workingStore.put(desired.name, desired);
} catch (err) {
  // ... existing
}
// ... rest unchanged
```

**Ordering rationale:** apply BEFORE store — Hetzner is the source of truth; workingStore is the intent projection. Apply fail → no intent persisted → idempotent re-call → re-attempt (apply is idempotent by spec §1).

**Error path:** provider throws `ReconcileError` → `toErrorEnvelope` returns error envelope; workingStore + StateEvent NÃO escritos (fail-safe — partial state evitado).

## 3. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | `provider.apply` já é idempotent por contract (v2 Bloco A §F1.3). Re-call sem mudança = no-op. |
| 3 | Fail-safe, never fail-deleting | Apply NÃO deleta (provider.apply spec proíbe destrutivo). Erro → workingStore intact (no half-write). |
| 4 | Secrets at apply only | Apply IS o boundary canônico; v2 spec já permite secret resolution aqui. |
| 5 | StateEvent actor | Inalterado. StateEvent ainda recorded APÓS apply success. |
| 6 | v2 Bloco A contract | Não toca contract (envelope shape, schema). Só fecha gap entre tool e provider. |

## 4. Critérios de aceite

1. **Live apply real:** `set_firewall({...,dry_run:false})` cria firewall na Hetzner (curl `/v1/firewalls?name=<name>` retorna count>=1 com rules + applied_to corretos).
2. **Idempotent re-call:** segunda chamada com mesmo `desired` → envelope `applied` (mesmo) + Hetzner sem mudança duplicada.
3. **Update path:** mudar rules existentes → `provider.apply` faz `set_rules`-replace (per provider spec).
4. **Hetzner error surface:** rate limit / 5xx / malformed → `error` envelope com class apropriada; workingStore não escrito.
5. **Existing tests verdes:** test fixture já mock'a `FirewallProvider.apply` (assert na chamada agora explícita).
6. **dry_run path unchanged:** continua não chamando apply (`planned` puro).

## 5. Fora de escopo

- `set_primary_ip` synchronous apply (mesmo gap mas não bloqueia caminho A).
- `set_load_balancer` synchronous apply (deferred F5.4, intentional).
- Wiring v2 scopes no composite-provider (option B — async reconciler convergence). Spec separada se desejado.
- **Bug #9** (apply_manifest gate consulting TOOL_POLICY per-item) — design call sobre v1 frozen invariant; precisa spec dedicada com decisão owner sobre policy semantics.

## 6. Arquivos

- `core/src/agent/v2/set-firewall.ts:297` — 5-line insertion.
- `core/src/agent/v2/set-firewall.test.ts` — assert `provider.apply` foi chamado no apply path; novo test pra error path (apply throws → error envelope, workingStore vazio).
