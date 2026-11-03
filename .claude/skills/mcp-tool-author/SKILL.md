---
name: mcp-tool-author
description: |
  How to add a tool to the bevox-hetzner-mcp catalog. Distinguishes
  the FROZEN v1 catalog (12 tools, in core/src/agent/) from the v2
  Bloco-A catalog (7 tools, in core/src/agent/v2/). Covers: Zod
  input/output schemas, capability vocabulary, REST mirror, the
  console contract.ts / contract-v2.ts oracle update, MCP server
  registration, the contract-conformance test, and the per-tool
  policy entry (approval sensitivity). Use BEFORE editing
  core/src/agent/.
when_to_invoke: |
  - A spec or plan calls for a new MCP tool (read or write).
  - A v2 tool needs to be added under core/src/agent/v2/.
  - A maintainer is tempted to inline tool logic in REST or MCP
    transport code instead of using the shared catalog.
  DO NOT use for: tweaks to an existing tool that do not change its
  I/O schema or policy.
inputs:
  - Catalog: v1 (frozen 12) or v2 (Bloco-A, additive).
  - Tool name (snake_case): e.g. `set_firewall`, `expose_service`.
  - Sensitivity policy: `read` | `none` | `conditional` | `always`.
  - Capability vocabulary (which actor scope unlocks it).
  - I/O shape: Zod input + Zod output (must mirror the console
    contract oracle).
outputs:
  - Tool implementation file under core/src/agent/ or
    core/src/agent/v2/.
  - Capability vocabulary entry in core/src/agent/capability.ts.
  - Policy entry in TOOL_POLICY (v1) or v2 sensitivity wiring.
  - REST route mirror (core/src/agent/rest.ts or v2 routes).
  - MCP registration update (core/src/agent/mcp.ts).
  - Console contract oracle entry (console/src/api/contract.ts or
    contract-v2.ts).
  - Tests: unit + contract-conformance.
references:
  - references/tool-catalog.md
---

# Skill: mcp-tool-author

## Read the catalog first

Open `references/tool-catalog.md` (in this skill) for the current
v1 + v2 inventory with one-line descriptions and policy per tool.
Confirm your tool is NOT already present.

## V1 vs V2 — the two catalogs

### V1 — FROZEN

Defined in `core/src/agent/capability.ts` as `ALL_TOOLS`:

```
get_state, diff, events, health,
provision_server, deploy_service, scale_service, set_dns,
snapshot, restore, destroy, apply_manifest
```

Policy lives in `core/src/agent/tools.ts` as
`TOOL_POLICY: Record<ToolName, ToolPolicy>`.

**You almost never add a v1 tool.** The 12-tool surface is frozen by
the console contract oracle (`console/src/api/contract.ts`) and the
4.6 contract-conformance test in `core/src/agent/contract-conformance.test.ts`.
Adding to v1 means a spec revision under `docs/specs/` AND a
coordinated update to the console oracle. If asked to add a v1 tool,
push back first: is it really v1?

### V2 — additive, Bloco A

Defined in `core/src/agent/capability.ts` as `V2_TOOLS`:

```
resolve_selector, set_firewall, set_primary_ip, set_certificate,
set_load_balancer, set_ingress, expose_service
```

Each v2 tool has its own file under `core/src/agent/v2/<tool>.ts`
plus its own `<tool>.test.ts`. Conformance lives in
`core/src/agent/v2/contract-v2-conformance.test.ts`. Console oracle
is `console/src/api/contract-v2.ts`. Adding a v2 tool is the
COMMON path.

## Procedure

### 1. Preparatory reading

- `core/src/agent/tools.ts` (v1 catalog factory + TOOL_POLICY + the
  authzAndRecord spine — read the file header in full).
- `core/src/agent/envelope.ts` (WriteEnvelope shape: planned |
  pending_approval | applied | error). Mutating tools MUST return a
  WriteEnvelope built ONLY via the builders here.
- `core/src/agent/capability.ts` (ALL_TOOLS, V2_TOOLS, ToolName,
  VerifiedCredential).
- `core/src/agent/auth.ts` (authorizeAndRecord — every tool routes
  through it; do NOT reimplement auth).
- `core/src/agent/approval-gate.ts` (gate lifecycle; the same gate
  used by the reconciler is reused here).
- For v2: read TWO existing v2 tools as templates — pick the closest
  shape:
  - Read-shaped: `core/src/agent/v2/resolve-selector.ts`
  - Write composite: `core/src/agent/v2/set_ingress.ts`
  - Synthesized PlanItems: `core/src/agent/v2/set_load_balancer.ts`
- For the console oracle: `console/src/api/contract.ts` and
  `contract-v2.ts`. Match Zod schema EXACTLY — the conformance test
  byte-compares names + shapes.
- The contract-conformance test you will extend:
  - v1: `core/src/agent/contract-conformance.test.ts`
  - v2: `core/src/agent/v2/contract-v2-conformance.test.ts`

### 2. Design decisions (answer before code)

| Question | Options |
|---|---|
| Catalog | v1 (push back HARD) or v2 (default for new) |
| Sensitivity | `read` (no side effect) / `none` (write, free, safe) / `conditional` (gate on per-call sensitivity predicate) / `always` (every call goes through approval) |
| Capability scope | Which capability vocabulary unlocks it? Reuse existing capability if the operation is a variant; mint a new one ONLY if the action is meaningfully distinct. |
| Returns | Read ⇒ contract entity/state/events/health shape. Write ⇒ WriteEnvelope built via envelope.ts builders. |
| Idempotency | Always. A re-submit of the same desired state ⇒ `planned` with empty plan OR `applied` with `changed:false` items. |
| Secrets | If input carries a `secret:<ref>`, it stays as a reference in the envelope. NEVER resolve a value in the tool layer. Apply-context binding only inside `applyPlan()`. |

### 3. File scaffold (absolute paths, in creation order)

For a v2 tool named `<tool>`:

1. `console/src/api/contract-v2.ts`
   — add the Zod input + output schemas FIRST. This is the oracle.
2. `core/src/agent/capability.ts`
   — append `<tool>` to `V2_TOOLS` (the const array) and to the
   capability vocabulary if it needs a new scope.
3. `core/src/agent/v2/<tool>.ts`
   — implement the tool method on the v2 catalog. Header JSDoc
   follows the style of `set-firewall.ts` (design principles,
   exported API).
4. `core/src/agent/v2/<tool>.test.ts`
   — unit tests: authz deny path, idempotency replay, approval-gate
   pending path (if `always`/`conditional`), error envelope path,
   secret-leak sentinel.
5. `core/src/agent/v2/contract-v2-conformance.test.ts`
   — extend the listed tools assertion to include `<tool>` and add
   the schema-conformance assertion.
6. `core/src/agent/rest.ts` (or
   the v2 route registrar near it) — add `POST /api/v2/<tool>` that
   pipes to the catalog method.
7. `core/src/agent/mcp.ts` — add
   the MCP `server.tool(...)` registration. The tool name MUST match
   the catalog name EXACTLY (the 4.6 / v2 oracle compares strings).

For a v1 tool (rare): same shape, but file paths are
`core/src/agent/tools.ts` (extend the catalog factory) and you MUST
update `TOOL_POLICY` AND `ALL_TOOLS` AND
`console/src/api/contract.ts` in the same commit, with a spec
revision linked in the commit body.

### 4. WriteEnvelope discipline (mutating tools)

Use ONLY the builders from `core/src/agent/envelope.ts`:

```typescript
import {
  planned,
  pendingApproval,
  applied,
  error as errorEnvelope,
} from "../envelope.js";
```

State machine: `planned` (dry-run) | `pending_approval` (gate
withheld) | `applied` (gate approved + applied) | `error`. NEVER
construct envelope objects by hand — the conformance test rejects
non-canonical shapes.

### 5. Authz spine

Every tool call goes through `authorizeAndRecord` from
`core/src/agent/auth.ts`. You do NOT call `pool.query` for audit
yourself. You do NOT re-validate the credential — `authorizeAndRecord`
does it and emits the StateEvent on success AND failure.

### 6. Verification

```
npm --prefix core run typecheck
npm --prefix core test -- agent/v2/<tool>
npm --prefix core test -- agent/v2/contract-v2-conformance
npm --prefix core test                  # full suite must stay green
```

The conformance test is the canary. If it fails, the console oracle
and the catalog disagree — fix the oracle FIRST, then the catalog.

## Checklist before declaring done

- [ ] Console contract oracle updated (Zod schema input + output).
- [ ] `V2_TOOLS` (or `ALL_TOOLS`) updated.
- [ ] `TOOL_POLICY` updated (v1) OR sensitivity injected at v2
      registration (v2).
- [ ] Capability vocabulary entry (if new scope).
- [ ] Tool method implemented; returns WriteEnvelope (mutating) or
      contract entity (read).
- [ ] Authz routes through `authorizeAndRecord` — no parallel
      audit/auth code.
- [ ] Secret-leak sentinel (`S3CR3T-*`) test added if the tool
      handles a manifest carrying `secret:` refs.
- [ ] Idempotency replay test (`apply twice ⇒ second is no-op`).
- [ ] REST mirror added.
- [ ] MCP `server.tool(...)` registration added.
- [ ] contract-(v2-)conformance test extended and green.
- [ ] Full `npm --prefix core test` green (897+ / 898+).

## Limits

- You do NOT inline tool logic in `rest.ts` or `mcp.ts`. They are
  thin transports over the catalog.
- You do NOT add a second approval mechanism. The
  `core/src/agent/approval-gate.ts` is the only gate.
- You do NOT resolve secrets in the tool layer. Resolution is
  apply-time only, via the unforgeable `ApplyContext` in
  `core/src/store/secrets.ts`.
- You do NOT modify the FROZEN 12 v1 catalog without a spec revision
  and a coordinated console oracle PR.

## Language

Comments, JSDoc, commit messages: ENGLISH.
