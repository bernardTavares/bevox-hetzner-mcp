/**
 * core/src/agent/v2/resolve-selector.ts
 *
 * Task 0.4 — `resolve_selector` (v2 read-only tool + shared internal helper).
 *
 * Spec-mãe §1.1 + §2.2 establish a single selector grammar that v2 reuses
 * EVERYWHERE an entity needs to point at one or more Servers/Services without
 * a nominal reference (`Firewall.applied_to`, `LoadBalancer.targets`, etc.).
 * That grammar is, value-for-value, the `Service.server_selector` syntax v1
 * already names — `{ label: X }`, `{ name: Y }`, conjunctions.
 *
 * SINGLE SOURCE OF TRUTH. This file owns the resolver. Both sides of the
 * spec-filha §1 contract consume it:
 *   - the new MCP tool / `POST /api/v2/selectors/resolve` REST endpoint
 *     (this module's external face — agent introspects impact pre-plan);
 *   - the reconciler's per-cycle resolution that the §2.2 freeze-for-the-
 *     duration-of-plan/apply invariant requires (each future Bloco A apply
 *     loop calls `resolveServerSelector` once, then operates on the frozen
 *     list). The reconciler will switch to this helper as it grows the v2
 *     entities that need it; v1 reconciler currently uses
 *     `Service.server_selector` ONLY as a passthrough label set carried into
 *     docker.ts (no resolution against Servers happens), so there is no v1
 *     resolver to extract — this module is the FIRST and ONLY home.
 *
 * GRAMMAR (the FROZEN set Bloco A exposes):
 *   { label: "<key>" }     ⇒ server must have a `labels[<key>]` entry (any
 *                             value; presence-check). Matches the plan
 *                             scenario `seedServers([{labels:{app:"x"}}, ...])
 *                             selector:{label:"app"} → ["s1"]`.
 *   { name: "<name>" }     ⇒ server with `server.name === <name>` (exact).
 *   conjunction            ⇒ multiple keys = AND. Every clause must match.
 *
 * Determinism (§2.2): same `(selector, servers)` ⇒ same output. The result is
 * sorted ascending by server name so the wire shape is byte-stable across
 * runs / pg row orders (the reconciler's freeze-the-snapshot invariant
 * depends on this).
 *
 * Fail-safe: unknown clause keys, malformed selector, or no observed servers
 * all yield `[]` — NEVER throws. Selector resolution is a pure read; it MUST
 * NOT abort an agent's pre-plan introspection.
 */

import type { Server } from "../../domain/entities.js";

/**
 * Selector input shape. Permissive on read so the tool can accept anything an
 * agent sends; unknown keys ⇒ no match (fail-safe — never throws).
 *
 * The two recognised keys are `label` (string — key-presence on
 * `server.labels`) and `name` (string — exact `server.name` match). Any
 * additional keys are treated as further presence-required label keys (an
 * extension point the spec-mãe leaves open under "conjunctions").
 */
export interface SelectorInput {
  readonly [k: string]: unknown;
}

/**
 * Resolve a selector against the supplied observed `servers` list and return
 * the matched server names, sorted ascending. Pure function — no I/O, no
 * throw.
 */
export function resolveServerSelector(
  selector: SelectorInput | null | undefined,
  servers: readonly Server[],
): string[] {
  if (selector === null || selector === undefined || typeof selector !== "object") {
    return [];
  }
  const sel = selector as Record<string, unknown>;
  const keys = Object.keys(sel);
  // An empty selector matches nothing — agents must be explicit (fail-safe:
  // an accidental `{}` cannot resolve to "every server" and then be fed into
  // a destructive action).
  if (keys.length === 0) return [];

  const matched: string[] = [];
  for (const s of servers) {
    if (matchesAll(sel, keys, s)) matched.push(s.name);
  }
  matched.sort();
  return matched;
}

function matchesAll(
  sel: Record<string, unknown>,
  keys: readonly string[],
  s: Server,
): boolean {
  for (const k of keys) {
    const v = sel[k];
    if (!matchesClause(k, v, s)) return false;
  }
  return true;
}

function matchesClause(key: string, value: unknown, s: Server): boolean {
  if (key === "name") {
    return typeof value === "string" && s.name === value;
  }
  if (key === "label") {
    // { label: "<key>" } — presence-check on the named label.
    if (typeof value !== "string") return false;
    return Object.prototype.hasOwnProperty.call(s.labels ?? {}, value);
  }
  // Any other key is treated as a required label-key presence (extension
  // point under the spec-mãe "conjunctions" allowance; value is ignored so
  // accidental `{ region: "eu" }` does NOT silently widen to "every server"
  // — it still requires the label key to exist on the server).
  return Object.prototype.hasOwnProperty.call(s.labels ?? {}, key);
}
