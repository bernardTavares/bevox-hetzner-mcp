# bevox-hetzner-mcp — `STRICT_MANIFEST_APPROVAL` config knob (bug #9 impl)

- **Data:** 2026-05-27
- **Status:** Aceita (2026-05-27)
- **Autor:** Bernard (impl da decisão owner em 2026-05-27-apply-manifest-approval-policy.md §6 — Opção C)
- **Tipo:** Spec-filha (cabling + behavior) — adiciona config knob opt-in
- **Spec-mãe (v1):** [2026-05-17-bevox-hetzner-mcp-design.md](./2026-05-17-bevox-hetzner-mcp-design.md) (FROZEN; default-off preserva invariante; opt-in opcional não-revisão)
- **Spec discussion:** [2026-05-27-apply-manifest-approval-policy.md](./2026-05-27-apply-manifest-approval-policy.md) (Aceita — owner escolheu C)
- **Spec irmãs (knob pattern):**
  - [2026-05-26-server-scope-transport-decoupling.md](./2026-05-26-server-scope-transport-decoupling.md) (`MANAGED_MESH` knob, PR #11)
  - [2026-05-26-tolerant-meta-scope-and-managed-services.md](./2026-05-26-tolerant-meta-scope-and-managed-services.md) (`MANAGED_SERVICES` knob, PR #13)

## 0. Escopo

Implementa Opção C da spec discussion: novo env var `STRICT_MANIFEST_APPROVAL=on|off` (default `off`). Quando `on`, `apply_manifest` consulta `TOOL_POLICY` per-entity-kind ao invés de `defaultIsSensitive` global — `create server:*` vira sensitive (per `provision_server` "always" policy), gateando approval.

Default `off` preserva 100% comportamento v1 FROZEN. Nenhuma quebra de contract.

## 1. Design

### 1.1 Config

`core/src/config.ts:ConfigSchema` ganha:
```ts
STRICT_MANIFEST_APPROVAL: z
  .preprocess((v) => (v === undefined || v === "" ? undefined : v),
              z.enum(["on", "off"]).optional())
  .transform((v) => v ?? "off"),
```

Padrão idêntico ao `MANAGED_MESH` (preprocess → enum → transform default).

### 1.2 Sensitivity predicate constructor

Novo módulo `core/src/agent/strict-manifest-sensitivity.ts`:

```ts
import type { PlanItem } from "../domain/entities.js";
import { TOOL_POLICY } from "./capability.js";
import { defaultIsSensitive } from "./approval-gate.js";

/**
 * Map a manifest plan item to the tool whose policy governs it.
 * Returns undefined when no dedicated tool exists for the (op, kind)
 * combination — caller falls back to defaultIsSensitive.
 */
function ownerToolFor(item: PlanItem): keyof typeof TOOL_POLICY | undefined {
  const kind = item.entity.split(":", 1)[0];
  if (item.op === "destroy" || item.op === "remove") return "destroy";
  if (item.op === "restore") return "restore";
  if (item.op === "snapshot") return "snapshot";
  switch (kind) {
    case "server":  return "provision_server";  // policy: "always"
    case "service": return "deploy_service";    // policy: "conditional"
    case "dns":     return "set_dns";           // policy: "none"
    case "network": return undefined;           // no dedicated tool
    case "volume":  return undefined;           // no create tool
    case "backup":  return undefined;
    default:        return undefined;
  }
}

/**
 * STRICT_MANIFEST_APPROVAL=on sensitivity predicate: classify each plan
 * item via the policy of its owning tool. Spec
 * docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.2.
 */
export function strictManifestIsSensitive(item: PlanItem): boolean {
  const tool = ownerToolFor(item);
  if (tool === undefined) return defaultIsSensitive(item);
  const policy = TOOL_POLICY[tool];
  if (policy === "always") return true;
  if (policy === "none") return false;
  // policy === "conditional" → fall back to default (destroy/remove/restore).
  return defaultIsSensitive(item);
}
```

### 1.3 Wiring

- `core/src/agent/tools.ts:ToolDeps` ganha optional `strictManifestApproval?: boolean` (default `false`).
- `createToolCatalog` destructure + uses it inside `doApplyManifest`:

```ts
async function doApplyManifest(input, scope, actor): Promise<WriteEnvelope> {
  // ... existing fan-out
  const isSensitive = strictManifestApproval
    ? strictManifestIsSensitive
    : defaultIsSensitive;
  return reconcileToEnvelope(scope, actor, isSensitive);
}
```

- `entrypoint-wiring.ts:buildBootDeps` passa `strictManifestApproval: config.STRICT_MANIFEST_APPROVAL === "on"`.
- `server.ts:createServer` forwarda pra `createToolCatalog`.

### 1.4 Boot warn (consistência com knob pattern)

`entrypoint-wiring.ts` emite warn estruturado at boot quando `on`:

```ts
function warnStrictManifestApproval(logger: Logger): void {
  logger.warn(
    {
      actor: "system:boot", scope: "daemon", entity: "config",
      subsystem: "strict-manifest-approval", strictManifestApproval: "on",
    },
    "STRICT_MANIFEST_APPROVAL=on: apply_manifest consults per-entity-kind tool policy. " +
    "Server creates require approval gate (mirrors provision_server). " +
    "Spec 2026-05-27-strict-manifest-approval-knob.md §1.4.",
  );
}
```

### 1.5 Documentation

- `CLAUDE.md` §"Stack" ganha nota sobre o knob (próximo a `MANAGED_MESH` / `MANAGED_SERVICES`).
- `deploy/README.md` ganha exemplo `.env` mostrando `STRICT_MANIFEST_APPROVAL=on` opt-in.
- `core/.env.example` (se existe) ganha entry comentado.

## 2. Invariantes preservados

| # | Invariante | Como preservamos |
|---|---|---|
| 1 | Specs first | Spec discussion (§6 owner-marker) + esta spec impl precedem o código. |
| 2 | Idempotência | `strictManifestIsSensitive` é pura/determinística. Property tests não tocados (continuam usando `defaultIsSensitive` default). |
| 3 | Fail-safe | Knob ON aumenta gate coverage (mais items withheld); zero risco de destruição adicional. Default OFF zero diff. |
| 4 | Secrets at apply only | Predicate é pura; nenhum canal de secret. |
| 5 | StateEvent actor | Inalterado. |
| 6 | v1 FROZEN | Default OFF preserva comportamento. Knob é opt-in additive — não revisa invariante. |

## 3. Critérios de aceite

1. **Default off (backward-compat):**
   - `STRICT_MANIFEST_APPROVAL` omitido OR `=off` → `apply_manifest({servers:[<new>], dry_run:false})` retorna `{status:"applied"}` (v1 unchanged).
   - Existing tests verdes sem modificação.

2. **Strict on (new behavior):**
   - `STRICT_MANIFEST_APPROVAL=on` no `.env` → restart → `apply_manifest({servers:[<new>], dry_run:false})` retorna `{status:"pending_approval", approval_id:"apr_..."}`.
   - `list_approvals` mostra pending item para o server create.
   - `approve({approval_id})` → reconciler aplica.
   - Network creates dentro do mesmo manifest (não-sensitive, owner tool é undefined → fallback default) continuam applied imediatamente.

3. **Mixed manifest (strict on):**
   - `apply_manifest({networks:[N], servers:[S]}, dry_run:false)` → network create applied (immediate), server create withheld (pending_approval). Envelope retorna `pending_approval` (priority sobre applied per existing reconcileToEnvelope semantics).

4. **DNS / Snapshot via manifest (strict on):**
   - DNS records create → não sensitive (set_dns policy = "none") → applied imediato.
   - Volume snapshot ops via manifest → snapshot policy = "none" → applied.

5. **Destroy (strict on AND off):**
   - `destroy` op sempre sensitive (existing `defaultIsSensitive` AND strict path both gate). Idempotent equivalent.

6. **Boot warn:**
   - `STRICT_MANIFEST_APPROVAL=on` no `.env` → boot log emite warn estruturado value-free com subsystem `strict-manifest-approval`.

7. **Tests:**
   - Unit `strictManifestIsSensitive`: cada combination (op + entity kind) → expected boolean.
   - Integration `apply_manifest({servers:[X]}, dry_run:false)`:
     - default off → applied.
     - strict on → pending_approval.
   - Boot warn structured emit when strict on.

## 4. Fora de escopo

- Approval batching UX (1 approval pra N items). Future spec se demanda.
- Mudar `defaultIsSensitive` global (continua destroy/remove/restore).
- Mudar `TOOL_POLICY` map.
- Tools v2 — todos têm seus próprios policies; não tocados.
- Auto-approve based on label/selector (future capability).

## 5. Migração

- **Backwards-compatible full.** `STRICT_MANIFEST_APPROVAL` omitted ⇒ default `off` ⇒ comportamento v1 unchanged.
- Operador opta-in via `.env`:
  ```
  STRICT_MANIFEST_APPROVAL=on
  ```
- Reversível: flip `off` + restart.

## 6. Arquivos antecipados

- `core/src/config.ts` — novo campo (~10 LOC).
- `core/src/agent/strict-manifest-sensitivity.ts` — NEW (~35 LOC).
- `core/src/agent/tools.ts` — `ToolDeps.strictManifestApproval?` + dispatch em `doApplyManifest` (~10 LOC).
- `core/src/entrypoint-wiring.ts` — pass through BootDeps + boot warn (~15 LOC).
- `core/src/server.ts` — `BootDeps.strictManifestApproval?` + forward to createToolCatalog (~5 LOC).
- Tests:
  - `core/src/agent/strict-manifest-sensitivity.test.ts` — NEW unit (~30 LOC).
  - `core/src/agent/tools.test.ts` — integration: strict-on + manifest server → pending_approval.
  - `core/src/entrypoint-wiring.test.ts` — knob parse + boot warn structured.
- Docs: `CLAUDE.md`, `deploy/README.md`, `core/.env.example` (se existir).
