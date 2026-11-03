/**
 * core/src/providers/docker-depends-on.ts
 *
 * Pure intra-`service` ordering for the manifest `services[].depends_on` field
 * (gap #2, Phase 1). NO I/O — given the declared services it returns them
 * ordered so each dependency precedes its dependent, or throws
 * ReconcileError("precondition") on a cycle or a dangling dep BEFORE returning
 * anything (fail-safe: with no I/O there is no partial mutation to undo).
 *
 * `depends_on` is desired-state ordering, NOT container shape — it never enters
 * the create body nor isConverged. This module is the single source of the
 * short/object-form normalisation, reused by the reconciler DAG (plan.ts).
 *
 * Spec: docs/specs/2026-05-28-manifest-schema-gaps.md (gap #2, Phase 1; plan task 1.5).
 */

import { ReconcileError } from "../domain/errors.js";

/** One depends_on entry: bare name (short form) or `{ name, ... }` (object). */
export type DependsOnEntry =
  | string
  | { readonly name: string; readonly wait_healthy_timeout?: string };

/** The minimal structural shape topoSortServices needs off a service. */
export interface DependsOnAware {
  readonly name: string;
  readonly depends_on?: readonly DependsOnEntry[];
}

/** Extract the dependency service names from a service's depends_on entries. */
export function normalizeDependsOn(
  depends_on: readonly DependsOnEntry[] | undefined,
): string[] {
  return (depends_on ?? []).map((d) => (typeof d === "string" ? d : d.name));
}

/**
 * Topologically order `services` so each dep precedes its dependent.
 * Stable: declaration order is preserved on a tie. DFS post-order; a back-edge
 * to a node on the current path is a cycle; a dep name absent from the service
 * set is dangling. Both are precondition errors raised before any return.
 */
export function topoSortServices<T extends DependsOnAware>(
  services: readonly T[],
): T[] {
  const byName = new Map<string, T>();
  for (const s of services) byName.set(s.name, s);

  // Validate dep references up front (dangling → precondition before sorting).
  const depsByName = new Map<string, string[]>();
  for (const s of services) {
    const names = normalizeDependsOn(s.depends_on);
    for (const d of names) {
      if (!byName.has(d)) {
        throw new ReconcileError(
          "precondition",
          `depends_on references unknown service: ${d}`,
          { entity: `service:${s.name}` },
        );
      }
    }
    depsByName.set(s.name, names);
  }

  const result: T[] = [];
  const done = new Set<string>(); // permanently placed
  const onPath = new Set<string>(); // current DFS path → cycle detection

  const visit = (name: string, path: readonly string[]): void => {
    if (done.has(name)) return;
    if (onPath.has(name)) {
      throw new ReconcileError(
        "precondition",
        `depends_on cycle: ${[...path, name].join("->")}`,
        { entity: `service:${name}` },
      );
    }
    onPath.add(name);
    for (const d of depsByName.get(name) ?? []) {
      visit(d, [...path, name]);
    }
    onPath.delete(name);
    done.add(name);
    // name came from `services`, so byName has it (invariant just walked).
    result.push(byName.get(name)!);
  };

  // Iterate in declaration order so independent nodes keep their order.
  for (const s of services) visit(s.name, []);
  return result;
}
