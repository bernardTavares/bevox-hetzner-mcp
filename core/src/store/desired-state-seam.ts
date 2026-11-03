/**
 * core/src/store/desired-state-seam.ts
 *
 * In-process desired-state seam: a scope-keyed `Map<string, DesiredState>`
 * with cross-scope read union + write strip-to-own.
 *
 * Spec docs/specs/2026-05-26-apply-manifest-silo-fanout.md §4.5 (rev b).
 *
 * - Each scope (`server`, `network`, ...) owns exactly one `DesiredState`
 *   slice (per `OWN_SLICE`).
 * - On read, cross-scope upstream dependencies are unioned in (per
 *   `UPSTREAM_DEPS`) so `plan()` validates references like `server.network`
 *   or `volume.server` against the merged view.
 * - On write, only the own-slice key is persisted; foreign slices are
 *   discarded (strip-to-own). Subsequent reads re-union from upstream
 *   silos — no duplication.
 * - The synthetic `scope === "manifest"` returns a union of ALL silos
 *   (used by dry_run / reconcile-of-manifest callers).
 *
 * Pure in-process v1 backend (YAGNI per spec-mãe). Durable git/manifest
 * persistence is the manifest-repo's concern.
 */

import type { DesiredState } from "../domain/desired-state.js";

/** Scope → the single DesiredState slice the scope owns. */
const OWN_SLICE: Readonly<Record<string, keyof DesiredState>> = {
  backup: "backups",
  dns: "dns",
  network: "networks",
  server: "servers",
  service: "services",
  volume: "volumes",
};

/**
 * Scope → upstream-scope deps (read-time union).
 * Mirrors reference edges in the schema:
 *   `server.network` → network; `volume.server` → server;
 *   `service.server_selector` → server → network (transitive);
 *   `service.volumes` → volume (Bug 7: plan() derives a volume dep from
 *   `svc.volumes`, so the service scope MUST merge the volume slice or the
 *   cross-kind validation throws when a service references a declared volume).
 */
const UPSTREAM_DEPS: Readonly<Record<string, readonly string[]>> = {
  server: ["network"],
  service: ["server", "network", "volume"],
  volume: ["server"],
};

export interface DesiredStateSeam {
  readonly loadDesired: (scope: string) => Promise<DesiredState>;
  readonly writeDesired: (scope: string, desired: DesiredState) => Promise<void>;
  /** The backing Map — exposed for test assertions and direct seeding. */
  readonly desiredByScope: Map<string, DesiredState>;
}

/**
 * Build a fresh in-process desired-state seam.
 *
 * Each call creates an isolated `Map`; safe to use in tests (no shared
 * state across invocations).
 */
export function createDesiredStateSeam(): DesiredStateSeam {
  const desiredByScope = new Map<string, DesiredState>();

  const loadDesired = async (scope: string): Promise<DesiredState> => {
    if (scope === "manifest") {
      return Object.assign({}, ...desiredByScope.values()) as DesiredState;
    }
    const own = desiredByScope.get(scope) ?? {};
    const deps = UPSTREAM_DEPS[scope] ?? [];
    if (deps.length === 0) return own;
    const merged: DesiredState = { ...own };
    for (const dep of deps) {
      Object.assign(merged, desiredByScope.get(dep) ?? {});
    }
    return merged;
  };

  const writeDesired = async (
    scope: string,
    desired: DesiredState,
  ): Promise<void> => {
    const ownKey = OWN_SLICE[scope];
    if (ownKey === undefined) {
      desiredByScope.set(scope, desired);
      return;
    }
    const stripped: DesiredState =
      desired[ownKey] !== undefined
        ? ({ [ownKey]: desired[ownKey] } as DesiredState)
        : {};
    desiredByScope.set(scope, stripped);
  };

  return { loadDesired, writeDesired, desiredByScope };
}
