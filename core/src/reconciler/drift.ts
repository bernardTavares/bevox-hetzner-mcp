/**
 * core/src/reconciler/drift.ts
 *
 * The observed-side drift detector (Task 2.9): a PURE function that reports
 * every observed resource ABSENT from the desired manifest as a drift item.
 * This is the SINGLE source of truth for observed→desired orphan detection;
 * plan.ts consumes it to emit its `op:"drift"` PlanItems (no orphan logic is
 * duplicated — DRY). It is the dedicated detector that FEEDS plan.ts.
 *
 * Design principles (spec §5):
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. An observed resource not declared in
 *     desired is REPORTED as drift ONLY. This module NEVER converts it into a
 *     `remove`/`destroy`/delete intent and performs NO mutation — the orphan
 *     is left for explicit operator review (the explicit promote/delete path
 *     is a later phase, never an automatic consequence of detection).
 *
 *   - DRIFT IS DESCRIBED, NEVER SILENTLY CORRECTED. detectDrift only DESCRIBES
 *     divergence. It has no I/O, no DB, no network; it does not mutate its
 *     arguments. Identical-membership inputs ⇒ empty array.
 *
 *   - CONSISTENT WITH THE FASE-1 PRECEDENT. The drift item mirrors
 *     manifest-repo.ts's `ManifestDriftItem` field-for-field where applicable
 *     (key / entityKind / kind / errorClass:"conflict" / the divergent value).
 *     The only `kind` is `present-only-in-observed` — the observed-side analog
 *     of manifest-repo's `present-only-in-git`/`present-only-in-working`.
 *     Drift is classified `conflict` (errors.ts: observed/desired divergence
 *     requiring operator review) — same class as the manifest working×git
 *     drift, so the whole codebase reports drift with one class/shape.
 *
 *   - DETERMINISTIC. Items are sorted by their stable entity key so the result
 *     is byte-reproducible across runs (matches plan.ts orphan ordering).
 *
 *   - KEY-CONSISTENT. Keys are built with the shared store-escaped `entityKey`
 *     (state-store-helper.ts) — the SAME builder plan.ts and the State Store
 *     use — so a `:`-bearing name cannot alias and an orphan cannot be masked
 *     by a key mismatch between the desired and observed sides.
 *
 * SCOPE (DRY/YAGNI): Fase-2 entities only — networks, servers, volumes,
 * services. DNS/backups are Fase-5 (their drift detector arrives with their
 * planner); auto-remediation/circuit-breaker are Fase-6. Out of scope here.
 *
 * Exported API (ONLY these):
 *   detectDrift(desired, observed) → DriftItem[]
 *   driftEventSpecs(observed, git) → DriftEventSpec[]   (Task 6.1)
 *   type DriftItem
 *   type DriftKind
 *   type DriftEventSpec
 */

import type { DesiredState } from "../domain/desired-state.js";
import type { State } from "../domain/entities.js";
import type { ErrorClass } from "../domain/errors.js";
import type { ManifestDriftItem } from "../store/manifest-repo.js";
import { entityKey } from "../store/state-store-helper.js";

// ---------------------------------------------------------------------------
// Drift model — mirrors manifest-repo.ts's ManifestDriftItem precedent
// ---------------------------------------------------------------------------

/**
 * The nature of an observed-side divergence.
 *
 *   - `present-only-in-observed`: the orphan case (observed but not desired).
 *     The canonical drift kind from Task 2.9: an observed resource the manifest
 *     does not declare.
 *
 *   - `disappeared-from-observed`: the OBSERVED-SURFACE-SHRINK case (Task 5.1,
 *     spec `2026-05-26-server-scope-transport-decoupling.md` §4.3). An entity
 *     that the PRIOR observed-state snapshot recorded for this scope is no
 *     longer surfaced by `observe()` — typically because a provider previously
 *     in the scope's fan-out was removed (the `MANAGED_MESH=on→off` flip is
 *     the canonical trigger: `routes.server` shrinks from `[hetznerCloud,
 *     wireguard]` to `[hetznerCloud]`, so peer-derived `server:<name>`
 *     entities the WireGuard provider used to surface vanish from observe).
 *     FAIL-SAFE: this kind is the ONLY signal — the reconciler NEVER deletes
 *     the underlying resource (e.g. the WG peer remains on the device); the
 *     operator's audit trail learns of the divergence and acts out-of-band.
 *
 * The kind is a named union — not an inline literal — exactly as manifest-
 * repo's `ManifestDriftKind` is structured, so future kinds can be added
 * without reshaping consumers.
 */
export type DriftKind =
  | "present-only-in-observed"
  | "disappeared-from-observed";

/**
 * One structural divergence: a resource observed in reality that the desired
 * manifest does not declare.
 *
 * Field-for-field consistent with manifest-repo.ts's `ManifestDriftItem`
 * (key / entityKind / kind / errorClass) — `observed` is the observed-side
 * analog of that type's `git`/`working` divergent-value fields. Carries enough
 * for an operator to act; performs NO action itself (fail-safe).
 */
export interface DriftItem {
  /** Stable store-escaped entity key, e.g. "server:ghost-1". Also the sort key. */
  readonly key: string;
  /** Entity collection this item belongs to (servers→"server", …). */
  readonly entityKind: string;
  /** Nature of the divergence. */
  readonly kind: DriftKind;
  /** Spec error class for drift — always "conflict" (errors.ts). */
  readonly errorClass: ErrorClass;
  /** The observed resource value that is absent from desired. */
  readonly observed: unknown;
}

// The Fase-2 collections compared. `prefix` is the kind passed to the shared
// `entityKey` builder; `keyOf` is the natural id (same name-keying plan.ts and
// state-store-helper.ts use for these kinds).
const COLLECTIONS: ReadonlyArray<{
  field: "servers" | "networks" | "volumes" | "services";
  prefix: string;
  keyOf: (item: Record<string, unknown>) => string;
}> = [
  { field: "servers", prefix: "server", keyOf: (s) => String(s.name) },
  { field: "networks", prefix: "network", keyOf: (n) => String(n.name) },
  { field: "volumes", prefix: "volume", keyOf: (v) => String(v.name) },
  { field: "services", prefix: "service", keyOf: (s) => String(s.name) },
];

/**
 * Compute the observed-side drift between the desired manifest and observed
 * State: every observed resource whose stable key is absent from desired.
 *
 * PURE: no side effects, does not mutate its arguments. Identical-membership
 * inputs yield an empty array. The result is deterministically ordered by the
 * stable entity `key` so it is reproducible across runs (and byte-aligned with
 * plan.ts's orphan ordering, since both use the same key + sort).
 *
 * This function ONLY describes divergence — it NEVER corrects, reconciles, or
 * deletes anything, and never produces a remove/destroy intent (fail-safe).
 *
 * @param desired  The declared desired manifest.
 * @param observed The observed reality (provider snapshot, adapted to State).
 * @returns Drift items (each `conflict`-class), sorted by key.
 */
export function detectDrift(
  desired: DesiredState,
  observed: State,
): DriftItem[] {
  const items: DriftItem[] = [];

  for (const { field, prefix, keyOf } of COLLECTIONS) {
    // The set of desired keys for this kind (membership test only — the
    // *value* divergence of managed entities is plan()'s update concern, not
    // observed-side drift; Task 2.9 is strictly the orphan detector).
    const desiredKeys = new Set<string>();
    for (const d of (desired[field] ?? []) as Array<Record<string, unknown>>) {
      desiredKeys.add(entityKey(prefix, keyOf(d)));
    }

    for (const o of (observed[field] ?? []) as Array<Record<string, unknown>>) {
      const key = entityKey(prefix, keyOf(o));
      if (!desiredKeys.has(key)) {
        items.push({
          key,
          entityKind: prefix,
          kind: "present-only-in-observed",
          errorClass: "conflict",
          observed: o,
        });
      }
    }
  }

  // Deterministic ordering: sort by the stable entity key (matches plan.ts).
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// Task 5.1 — observed-surface shrinkage detector (PURE; fail-safe by
// construction; spec `2026-05-26-server-scope-transport-decoupling.md` §4.3 / I3)
// ---------------------------------------------------------------------------

/**
 * Compute the set of entities that were present in the PREVIOUS observed-state
 * snapshot for a scope but are absent from the CURRENT observed snapshot — the
 * canonical signal that the scope's observe surface SHRUNK between cycles.
 *
 * The motivating case (spec §4.3): an operator flips `MANAGED_MESH` from
 * `"on"` to `"off"` on a deploy that already carries WireGuard peers.
 * `routes.server` shrinks from `[hetznerCloud, wireguard]` to `[hetznerCloud]`,
 * so peer-derived `server:<name>` entities the WireGuard provider used to
 * surface vanish from the new `observe(scope='server')` call. The prior
 * observed-store row for the vanished entity is deleted by `putState`
 * (full-replace semantics) — without this detector, the operator would have
 * no audit trail trace that the peer existed and remained on the device.
 *
 * Design principles (mirrors {@link detectDrift}; spec §5):
 *
 *   - PURE. No I/O, no DB, no network. Does not mutate either argument.
 *     Identical-membership inputs ⇒ empty array.
 *
 *   - FAIL-SAFE ABSOLUTE. The result is a REPORT, not an action. There is no
 *     code path here (and none added in the reconciler that consumes this
 *     function) that DELETES the underlying resource. A WireGuard peer that
 *     "disappeared from observed" remains on the device; cleanup is operator
 *     opt-in, out-of-band, NEVER automatic.
 *
 *   - KEY-CONSISTENT. Uses the SAME shared store-escaped {@link entityKey}
 *     builder used by `detectDrift`, plan.ts, and the State Store — a
 *     `:`-bearing name cannot alias and a vanished entity cannot be masked
 *     by a key mismatch.
 *
 *   - DETERMINISTIC. Items are sorted by their stable entity key (matches
 *     `detectDrift` ordering).
 *
 * The errorClass is `"conflict"` — same as `detectDrift`: previous/new
 * observed disagree in a way requiring operator review.
 *
 * @param previous The observed-state snapshot from before THIS reconcile cycle
 *                 (typically returned by `getObservedState(pool, scope)` at
 *                 the start of Observe).
 * @param current  The observed-state snapshot computed by THIS cycle's
 *                 Observe step (the value about to be written to the store).
 * @returns        Drift items naming each entity present in `previous` and
 *                 absent from `current`. Empty array when no shrinkage.
 */
export function detectObservedShrinkage(
  previous: State,
  current: State,
): DriftItem[] {
  const items: DriftItem[] = [];

  for (const { field, prefix, keyOf } of COLLECTIONS) {
    // Build the set of CURRENT keys for this kind so a previous entity is
    // flagged ONLY when its store-escaped key is genuinely absent from the
    // new snapshot (a renamed-but-same-shape entity is not "disappeared").
    const currentKeys = new Set<string>();
    for (const c of (current[field] ?? []) as Array<Record<string, unknown>>) {
      currentKeys.add(entityKey(prefix, keyOf(c)));
    }

    for (const p of (previous[field] ?? []) as Array<Record<string, unknown>>) {
      const key = entityKey(prefix, keyOf(p));
      if (!currentKeys.has(key)) {
        items.push({
          key,
          entityKind: prefix,
          kind: "disappeared-from-observed",
          errorClass: "conflict",
          // The PREVIOUS observed value is carried (the entity that vanished),
          // mirroring `detectDrift`'s `observed` field. Per the no-leak rule
          // the reconciler MUST NOT include this value in any persisted
          // `StateEvent.payload` — the consumer (reconcile.ts) records only
          // entity/op/scope/result, never the value. This is the SAME
          // discipline `driftEventSpecs` enforces for the periodic sweep.
          observed: p,
        });
      }
    }
  }

  // Deterministic ordering: sort by the stable entity key (matches
  // `detectDrift` and plan.ts).
  items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return items;
}

// ---------------------------------------------------------------------------
// Task 6.1 — drift→event normalizer (PURE; no-leak; never a mutating op)
// ---------------------------------------------------------------------------

/**
 * The ref-only, append-only StateEvent payload shape the PERIODIC drift sweep
 * (Task 6.1) emits for ONE divergence. It is deliberately a strict, value-free
 * projection of a DriftItem / ManifestDriftItem:
 *
 *   - `op` is ALWAYS the literal `"drift"` and `result` ALWAYS the literal
 *     `"drift"`. The periodic sweep ONLY observes + reports — it NEVER emits a
 *     `create`/`update`/`remove`/`destroy` op (fail-safe absolute: drift is
 *     reported, never silently corrected, never auto-promoted; spec §5).
 *   - `entity` is the SHARED store-escaped key and `kind` is the structural
 *     drift kind — entity/op/scope/kind ONLY. The divergent VALUES
 *     (observed/working/git) are intentionally NOT carried: 1.9/3.3/4.x
 *     no-leak discipline (a `secret:` ref or any value never enters the trail
 *     via drift). This is the SINGLE place that converts a drift item to an
 *     event, so the no-leak rule cannot be bypassed per-call-site.
 */
export interface DriftEventSpec {
  /** Stable store-escaped entity key, e.g. "server:ghost-1". */
  readonly entity: string;
  /** ALWAYS "drift" — the periodic sweep never emits a mutating op. */
  readonly op: "drift";
  /** ALWAYS "drift" — informational outcome only. */
  readonly result: "drift";
  /** Where the divergence sits + its structural shape (value-free). */
  readonly source: "observed" | "working-vs-git";
  readonly kind: string;
}

/**
 * Project the two drift detectors' output into the value-free, append-only
 * StateEvent specs the periodic sweep records. PURE: no I/O, does not mutate
 * its arguments, deterministic order (by entity key, stable within source).
 *
 * It NEVER produces a mutating op and NEVER carries a divergent value — so the
 * periodic sweep physically cannot correct drift or leak a secret through the
 * audit trail (fail-safe + no-leak, by construction).
 *
 * @param observed Observed-side orphans from {@link detectDrift}.
 * @param git      Working×git divergences from `diffManifest` (manifest-repo).
 */
export function driftEventSpecs(
  observed: readonly DriftItem[],
  git: readonly ManifestDriftItem[],
): DriftEventSpec[] {
  const specs: DriftEventSpec[] = [
    ...observed.map(
      (d): DriftEventSpec => ({
        entity: d.key,
        op: "drift",
        result: "drift",
        source: "observed",
        kind: d.kind,
      }),
    ),
    ...git.map(
      (d): DriftEventSpec => ({
        entity: d.key,
        op: "drift",
        result: "drift",
        source: "working-vs-git",
        kind: d.kind,
      }),
    ),
  ];
  return specs;
}
