/**
 * core/src/agent/strict-manifest-sensitivity.ts
 *
 * STRICT_MANIFEST_APPROVAL=on sensitivity predicate (spec
 * docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.2).
 *
 * `apply_manifest`'s default behavior uses `defaultIsSensitive` — only
 * destroy/remove/restore ops gate. The strict-mode predicate consults
 * `TOOL_POLICY` per-entity-kind so apply_manifest matches the policy
 * of the equivalent stand-alone tool. Example: `create server:*` lifts
 * to `provision_server` ("always") → server creates require approval
 * even when declared via a bulk manifest.
 *
 * Pure, dependency-free, sync. Used only when ToolDeps.strictManifestApproval
 * is true (opt-in via STRICT_MANIFEST_APPROVAL=on env).
 */

import type { PlanItem } from "../domain/entities.js";
import { defaultIsSensitive } from "./approval-gate.js";
import type { ToolName } from "./capability.js";
import { TOOL_POLICY } from "./tools.js";

/**
 * Map a manifest PlanItem to the v1 tool whose policy governs the same
 * effective action. Returns `undefined` when no dedicated tool exists —
 * caller falls back to `defaultIsSensitive`.
 *
 * Op precedence: destructive ops (destroy/remove/restore/snapshot) map
 * directly to the matching v1 tool regardless of kind, mirroring the
 * stand-alone tool semantics.
 */
export function ownerToolFor(item: PlanItem): ToolName | undefined {
  if (item.op === "destroy" || item.op === "remove") return "destroy";
  if (item.op === "restore") return "restore";
  if (item.op === "snapshot") return "snapshot";
  const kind = item.entity.split(":", 1)[0] ?? "";
  switch (kind) {
    case "server":
      return "provision_server"; // policy: "always"
    case "service":
      return "deploy_service"; // policy: "conditional"
    case "dns":
      return "set_dns"; // policy: "none"
    case "network":
    case "volume":
    case "backup":
    default:
      return undefined;
  }
}

/**
 * Sensitivity predicate when STRICT_MANIFEST_APPROVAL=on. Per item:
 *   - find the owning v1 tool (ownerToolFor);
 *   - "always"      → always sensitive (withhold for approval);
 *   - "none"        → never sensitive (apply immediately);
 *   - "conditional" → fall back to defaultIsSensitive (destroy/remove/restore);
 *   - undefined     → fall back to defaultIsSensitive.
 *
 * Spec docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.2.
 */
export function strictManifestIsSensitive(item: PlanItem): boolean {
  // Informational ops (noop/drift) never gate — they have no side effect.
  // Withholding them would create a pending approval for a no-op, which is
  // confusing UX. (apply.ts already skips noop/drift in the apply loop.)
  if (item.op === "noop" || item.op === "drift") return false;
  const tool = ownerToolFor(item);
  if (tool === undefined) return defaultIsSensitive(item);
  const policy = TOOL_POLICY[tool];
  if (policy === "always") return true;
  if (policy === "none") return false;
  // policy === "conditional" OR "read" → fall back to op-based default.
  return defaultIsSensitive(item);
}
