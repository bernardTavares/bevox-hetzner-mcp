# bevox-hetzner-mcp — apply_manifest multi-scope reconcile + destroy execution

- **Data:** 2026-06-01
- **Status:** Aceita (2026-06-01) — §5 confirmado pelo operador: (1) caller-retry, (2) v1 só `service`, (3) `Provider.destroy()` separado (apply(destroy) segue no-op).
- **Autor:** Bernard (bug report do deploy real) + Claude Code
- **Tipo:** Bug-fix (Bug 7, reconcile multi-scope) + **feature destrutiva approval-gated** (Bug 8, destroy execution). Bug 8 adiciona o PRIMEIRO caminho destrutivo do código — governado pela invariante fail-safe.
- **Motivação concreta:** Após os fixes de Docker (Bugs 1-6, deploy `abdde10`), o apply de um manifesto completo (6 services + 1 network + 1 server + 3 volumes) não converge (Bug 7), e `destroy` aprovado não remove nada (Bug 8).
- **Invariantes:** fail-safe nunca fail-deleting — Bug 8 NÃO afrouxa isso: o caminho de reconcile (`apply(op:"destroy")`/orphans) continua no-op; a remoção SÓ ocorre por um destroy **explicitamente solicitado E aprovado** (a exceção sancionada por `.claude/rules/fail-safe.md` §"Approval Gate gates destruction"). Idempotência; StateEvent com actor; secrets inalterados.

## 0. Escopo

| # | Sintoma | Tipo | Causa-raiz (confirmada) |
|---|---|---|---|
| 7 | manifesto multi-scope não converge; só 1 service residual | **bug** | (a) `reconcileToEnvelope` reconcilia UM scope por chamada (`tools.ts:404`); (b) `UPSTREAM_DEPS["service"]` = `["server","network"]` — falta `"volume"` (`desired-state-seam.ts:44`), mas `plan()` deriva dep de volume de `svc.volumes` (`plan.ts:162`) → validação cross-kind do scope `service` falha → `plan()` throw precondition → services nunca aplicam |
| 8 | destroy aprovado não remove o container | **feature ausente** | `doGatedOp` aprovado faz `return applied()` (`tools.ts:766`) SEM executar; `apply(op:"destroy")` é no-op fail-safe; não há path de remoção no provider |

**Out-of-scope:** reconciler-sweep que consome approvals em background (mantém-se o modelo caller-retry, igual provision); destroy de server/volume/network na Hetzner (Bug 8 v1 cobre **service** = remover containers Docker; outros kinds = follow-up); restore execution (mesmo padrão, follow-up).

## 1. Bug 7 — apply_manifest multi-scope

### 1.1 `UPSTREAM_DEPS["service"]` += `"volume"`
`desired-state-seam.ts`: serviços referenciam volumes (`svc.volumes` → `key("volume", vol)` em `plan.ts:162`). O merged view do scope `service` precisa incluir os volumes:
```ts
service: ["server", "network", "volume"],
```
(Atualizar o comentário §38-40 que só menciona `server_selector → server → network`.)

### 1.2 apply_manifest reconcilia TODOS os scopes do manifesto
`doApplyManifest` hoje fan-out writeDesired (✓) mas reconcilia só `scope`. Passa a reconciliar, **em ordem de dependência** (`network → server → volume → service`; `backup`/`dns` independentes ao fim), cada scope presente no manifesto, agregando num único envelope:
- qualquer scope withhold → `pending_approval` (primeiro pendente, com id correto via `pendingApprovals`);
- qualquer scope falha → propaga o erro (fail-safe; o que já aplicou fica);
- senão → `applied` com a soma das contagens.
Reusa `reconcileToEnvelope` por scope (já existe); a agregação é nova. Ordem determinística por um `MANIFEST_SCOPE_ORDER`.

## 2. Bug 8 — destroy execution (approval-gated, fail-safe)

### 2.1 Princípio
A invariante "nunca fail-deleting" PERMITE destruição quando **explicitamente solicitada via destroy E aprovada pelo Approval Gate** (`.claude/rules/fail-safe.md` §"Approval Gate gates destruction"). O caminho de RECONCILE (plan/apply/orphan-drift) permanece intocado — `apply(op:"destroy")` continua no-op, orphans continuam `drift` (nunca deletados). A remoção vive num path NOVO, separado, só alcançável após aprovação.

### 2.2 Modelo de consumo: caller-retry (igual provision)
O sistema é caller-retry, não reconciler-consume (provision_server funciona assim):
1. `POST /api/destroy {entity}` → `doGatedOp` → gate pending → `pending_approval(id)`.
2. `POST /api/approvals/{id}/approve` → approved.
3. **Re-`POST /api/destroy {entity}`** → `gate.evaluate` retorna approved (não denied) → **executa a remoção** → `applied`.

(Documenta-se isto — a expectativa do operador de "reconciler consome" não é o modelo; o reconciler não destrói por design.)

### 2.3 Execução
`doGatedOp`, no branch aprovado (decision sem denied), para `op:"destroy"`: invoca uma capability de destruição do provider. Provider port ganha método OPCIONAL aditivo:
```ts
interface Provider {
  observe(...); apply(...); verify(...);
  destroy?(action: PlanAction): Promise<ApplyResult>; // approved-destroy ONLY
}
```
- `DockerProvider.destroy(action)`: resolve as réplicas do service (`replicasOf` com `all=true`), `DELETE /containers/{id}?force=true` cada uma, idempotente (ausente → no-op, `changed:false`). NÃO toca nada fora do `entity` solicitado.
- `apply(op:"destroy")` permanece no-op (caminho de reconcile fail-safe inalterado).
- `doGatedOp` só chama `destroy()` quando `provider.destroy` existe E a decisão foi aprovada; senão mantém `applied()` (back-compat para providers sem destroy / ops restore/snapshot ainda stub).

### 2.4 StateEvent + actor
A remoção emite StateEvent (`op:"destroy"`, `result:"ok"`, actor do `doGatedOp`/credential) via o canal de Record. Nenhum secret no payload.

### 2.5 Fake
`docker-http` fake: `DELETE /containers/{id}` (e `?force=true`) remove do mapa; 404 se ausente (idempotente do lado do provider).

## 3. Testes (TDD, fakes-only)

| Layer | Arquivo | Cobertura |
|---|---|---|
| Bug 7 seam | `desired-state-seam.test.ts` ou `apply-manifest-silo-fanout*.test.ts` | `loadDesired("service")` inclui `volumes` |
| Bug 7 plan | `plan.test.ts` | service referenciando volume declarado valida (não throw) quando o merged view tem o volume |
| Bug 7 apply | `tools.test.ts` / `rest.test.ts` | apply de manifesto multi-scope reconcilia todos os scopes; envelope agrega; ordem de dependência; um withhold → pending |
| Bug 8 provider | `docker.test.ts` | `destroy()` remove réplicas (DELETE force); idempotente (ausente → no-op); `apply(op:"destroy")` AINDA no-op (fail-safe property intacta) |
| Bug 8 gate | `tools.test.ts` / `approval-gate*.test.ts` | destroy: 1ª chamada pending; após approve, re-chamada executa (remove) + `applied`; StateEvent com actor |
| Idempotency property | `idempotency.property.test.ts` | inalterada/estendida; apply(destroy)=no-op property preservada |
| Fail-safe property | `reconciler/idempotency*.property.test.ts` | orphan/observed-extra NUNCA deletado pelo reconcile (Bug 8 não regride) |

## 4. Acceptance criteria

- [ ] typecheck sem novos erros; suíte verde.
- [ ] Bug 7: `UPSTREAM_DEPS["service"]` inclui volume; apply de manifesto completo (network+server+volume+service) converge num apply (todos os scopes), envelope agrega.
- [ ] Bug 8: destroy aprovado (caller-retry) remove os containers do service; idempotente; `apply(op:"destroy")` e orphan-drift continuam no-op (fail-safe property intacta); StateEvent com actor.
- [ ] Provider.destroy é additive/opcional — providers sem ele e ops restore/snapshot inalterados.
- [ ] `CHANGELOG.md` + docs (modelo caller-retry do destroy; cheatsheet se aplicável).

## 5. Decisões a confirmar no review

1. **Bug 8 model:** caller-retry (re-POST destroy após approve) vs reconciler-sweep. Proposto: caller-retry (consistente com provision; reconciler-sweep é follow-up).
2. **Bug 8 escopo de kinds:** v1 só `service` (remove containers). server/volume/network destroy = follow-up. OK?
3. **Provider.destroy opcional vs apply(op:"destroy") executar:** proposto método separado `destroy()` para NÃO afrouxar a property de que `apply(destroy)` é no-op. OK?

## 6. Non-goals
Reconciler-sweep de approvals; destroy de recursos Hetzner (server/volume/network); restore/snapshot execution; rollback automático.
