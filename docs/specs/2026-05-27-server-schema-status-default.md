# bevox-hetzner-mcp — `ServerSchema.status` defaults to `"pending"` on input

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (bug-report #8 do `bevox-meta-api` Claude Code MCP consumer)
- **Tipo:** Spec-filha (cirúrgica, defensiva) — 1-clause schema relaxation
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN — define ServerSchema observed shape + the wire-compat oracle "core-valid ⇒ console-valid")
- **Spec irmã:** [2026-05-27-hetzner-cloud-wire-translation.md](./2026-05-27-hetzner-cloud-wire-translation.md) (PR-B; revealed this gap during smoke testing of caminho A)

## 0. Escopo

1-clause permissivity em `core/src/domain/entities.ts:ServerSchema.status`: `StatusEnum` → `StatusEnum.default("pending")`. Output sempre tem `status` (default fills in). Não toca console contract (`console/src/api/contract.ts` FROZEN — output stays wire-compatible).

## 1. Contexto

`ManifestServerSchema` (`core/src/domain/desired-state.ts:35-47`) intencionalmente **omite** `status` — manifest expressa *intent*, não estado completo:

```ts
const ManifestServerSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  location: z.string().min(1),
  network: z.string().min(1),
  image: z.string().optional(),
  ssh_keys: z.array(z.string()).optional(),
  labels: z.record(z.string()).optional(),
  // NO status — intentional
});
```

`apply_manifest` parseia manifest via DesiredStateSchema (que usa ManifestServerSchema), faz fan-out (PR #14), e o reconcile dispara `provider.apply(action)` onde `action.desired = { name, type, location, network, image, ssh_keys, labels }` — sem `status`.

`HetznerCloudProvider.apply` (hetzner-cloud.ts:202, 218) chama `parseDesired(ServerSchema, action)`. `ServerSchema` (`entities.ts:31-43`) tem `status: StatusEnum` **required**. Parse falha:

```
HTTP 400 {
  "code": "precondition",
  "message": "HetznerCloudProvider: malformed desired for server:<name> (Required)",
  "entity": "server:<name>"
}
```

Mesmo problema afeta `WireGuardProvider.parseServer` (`wireguard.ts:245`) quando `MANAGED_MESH=on`.

**Por que outros kinds não afetados:**
- `NetworkSchema`: sem campo `status`. OK.
- `VolumeSchema`: `status: StatusEnum.optional()` (já optional). OK.
- `ServiceSchema`: `status: StatusEnum.optional()` (já optional). OK.
- `DnsRecord/BackupPolicy`: sem `status`. OK.

ServerSchema é o único outlier. Fix coerente: alinhar com os outros.

## 2. Design

Alterar `core/src/domain/entities.ts:ServerSchema.status` de:

```ts
status: StatusEnum,
```

para:

```ts
status: StatusEnum.default("pending"),
```

**Semântica Zod:**
- Input pode omitir `status` → default `"pending"` aplicado.
- Input com `status` válido → passa as-is.
- Output type `z.infer<typeof ServerSchema>` mantém `status: StatusEnumValue` (non-nullable — default torna optional-input mas required-output).

**Por que `.default()` ao invés de `.optional()`:**
- Output type unchanged: `status` continua sendo `StatusEnumValue` (não `StatusEnumValue | undefined`).
- Wire format preservado: serializações JSON sempre incluem `status`.
- Console contract oracle preservado: `ConsoleServer.parse(core_output)` continua passando (output sempre tem status).
- Consumers que dependiam de `status` presente no output: zero break.

**`"pending"` como default:** semântica natural para desired-state pré-apply (a entidade está pending criação real). Alinhado com o uso já existente da v1.

## 3. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Esta spec precede o código. |
| 2 | Idempotência | Default é puro/determinístico. Property tests intactos se generam server com status; sem-status agora passam com "pending" default. |
| 3 | Fail-safe | Default não introduz delete path; pure permissivity. |
| 4 | Secrets at apply only | Schema parsing puro; nenhum canal de secret. |
| 5 | StateEvent actor | Inalterado. |
| 6 | Console contract oracle | Output do core sempre tem `status` (default fills in) → `ConsoleServer.parse(output)` continua passando. FROZEN wire contract preservado at the OUTPUT level. |

## 4. Critérios de aceite

1. `ServerSchema.parse({name:"x", type:"cx22", location:"nbg1", image:"u22", ssh_keys:[], labels:{}, network:"n"})` (sem `status`) retorna objeto com `status:"pending"`.
2. `ServerSchema.parse(<server com status:"healthy">)` retorna objeto com `status:"healthy"` (passthrough).
3. `ConsoleServer.parse(<output do ServerSchema.parse sem-status>)` passa (oracle preservado).
4. `apply_manifest({manifest:{servers:[<sem status>]}, dry_run:false})` no daemon viva: passa do precondition parse; chega ao gate; gate evaluates create-server op; defaultIsSensitive(create) é false → approved → applyPlan → composite.apply → HetznerCloud.apply → POST /v1/servers (com wire shape do PR-B).
5. Existing entities.test.ts oracle teste (line 17) continua passando.
6. Existing idempotency property tests continuam passando (gerações com status preservadas; sem-status agora também).

## 5. Fora de escopo

- Mudar `console/src/api/contract.ts` (FROZEN per CLAUDE.md). Output do core continua wire-compat; nada a mudar lá.
- Schema enrichment do `ManifestServerSchema` (adicionar `status` lá criaria divergência semântica — manifest é intent, não state).
- Outros entity schemas — todos os outros já têm `status` optional ou nenhum status. Coverage automática.

## 6. Migração

- **Backwards-compatible.** Server objects WITH status: zero diff (passthrough). Sem-status: agora passam com default "pending" (antes falhavam parse).
- Sem schema migration. Pure permissivity.

## 7. Arquivos

- `core/src/domain/entities.ts:34` — 1-char edit (`StatusEnum` → `StatusEnum.default("pending")`).
- `core/src/domain/entities.test.ts` — 2 tests novos (positivo no-status + oracle).
