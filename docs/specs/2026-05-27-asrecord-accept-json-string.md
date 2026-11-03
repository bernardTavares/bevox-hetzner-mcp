# bevox-hetzner-mcp — `asRecord` accepts JSON-encoded string input

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (bug-report bug #7 do `bevox-meta-api` Claude Code MCP consumer)
- **Tipo:** Spec-filha (cirúrgica, defensiva) — interop fix
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN — v1 §Agent Interface define tool input parsing)
- **Spec irmã:** [2026-05-27-hetzner-cloud-wire-translation.md](./2026-05-27-hetzner-cloud-wire-translation.md) (PR-B, merged `1dc3048`) — durante smoke test consumer descobriu interop gap residual.

## 0. Escopo

Cirúrgica: 3-linha mudança em `asRecord` (`core/src/agent/tools.ts:298-302`). Aceita string JSON-encoded como input para parsing antes do narrow `typeof === "object"`. Não toca v1/v2 invariantes, schemas, ou outros call sites.

## 1. Contexto

`asRecord` é o narrow defensivo usado dentro do catalog antes de cada `DesiredStateSchema.parse(asRecord(input.manifest))` (tools.ts:603) e equivalentes:

```ts
function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object"
    ? (input as Record<string, unknown>)
    : {};
}
```

**Bug observado:** alguns clientes MCP (notavelmente Claude Code) serializam tool arguments aninhados como strings JSON-encoded quando o usuário escreve um objeto literal no XML/JSON do tool call. Daemon recebe:

```json
{ "manifest": "{\"networks\":[{...}],\"servers\":[{...}]}", "dry_run": false }
```

`typeof "..." === "object"` → false → `asRecord` retorna `{}`. `DesiredStateSchema.parse({})` valida (todas as slices são `.optional()`). `manifest` chega no handler como `{}`. Fan-out (`if (manifest.networks)` etc) é falsy em tudo. `reconcileToEnvelope("manifest", ...)` roda contra o estado existente — retorna `{status:"applied"}` sem nenhuma side-effect novo.

**Consequência:** apply_manifest retorna sucesso enganoso. Idêntico em sintoma ao bug #5 pré-PR-A — só que aqui PR-A não pode surfacing nada porque não há failure (`report.failed.length === 0`; é tudo no-op).

**Não-bug do daemon:** Wire shape (PR-B) já está correto. v2 contract está correto. O problema é interop de tool-arg serialização.

## 2. Design

Modificar `asRecord` para:

```ts
function asRecord(input: unknown): Record<string, unknown> {
  // Accept JSON-encoded string input — some MCP clients (Claude Code, etc.)
  // serialize nested object args as JSON strings. Spec
  // docs/specs/2026-05-27-asrecord-accept-json-string.md §2.
  if (typeof input === "string") {
    try {
      input = JSON.parse(input);
    } catch {
      return {};
    }
  }
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
```

**Mudanças:**

1. **String pre-parse:** se `input` for string, tenta `JSON.parse`. Falha (malformed) → `{}` (preserva fail-safe atual).
2. **Array exclusion:** `typeof [] === "object"` é `true` mas cast pra `Record` é incorreto. Defensive: rejeita arrays explicitamente (`!Array.isArray(input)`).

Object input não muda de comportamento. String input agora é parseada. Array continua rejeitado (era rejeitado por accident antes — agora explicitamente).

## 3. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | `JSON.parse` é puro/determinístico. Property tests não tocados. |
| 3 | Fail-safe | Malformed JSON → `{}` (mesmo retorno do path "input não-objeto" original). |
| 4 | Secrets at apply only | `JSON.parse` é sync; não toca secrets, não toca network. |
| 5 | StateEvent actor | Inalterado. |

## 4. Critérios de aceite

1. `asRecord('{"foo":"bar"}')` retorna `{foo:"bar"}`.
2. `asRecord("{not json")` retorna `{}`.
3. `asRecord([1,2,3])` retorna `{}`.
4. `asRecord({a:1})` retorna `{a:1}` (passthrough inalterado).
5. `apply_manifest({manifest: "<JSON string>", dry_run: false})` agora funciona end-to-end equivalente a `apply_manifest({manifest: <object>, ...})`.
6. Suite completa verde sem modificação dos testes existentes.

## 5. Fora de escopo

- Outros call sites de `asRecord` no catalog (provision_server, deploy_service, etc.) automaticamente herdam o fix. Sem mudança de comportamento se input continua object.
- Outros tipos de serialização (XML, MessagePack, etc.) — string JSON apenas.
- Schemas existentes — Zod continua sendo o oracle de shape após o narrow.
- Detecção de outras MCP client quirks — only this specific failure mode.

## 6. Migração

- **Backwards-compatible.** Object input inalterado. String input passa a funcionar onde antes silenciosamente virava `{}`. Nenhum caller tinha como confiar no comportamento antigo (era um bug, não um contrato).
- Sem schema migration.

## 7. Arquivos

- `core/src/agent/tools.ts` — `asRecord` (3 linhas adicionadas).
- `core/src/agent/tools.test.ts` — 4 unit tests novos.
