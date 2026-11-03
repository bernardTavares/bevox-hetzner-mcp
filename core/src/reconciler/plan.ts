/**
 * core/src/reconciler/plan.ts
 *
 * Pure planner: diff a declarative DesiredState against the observed State and
 * emit a topologically-ordered PlanItem[] the apply step (Task 2.6) consumes.
 *
 * Design principles (spec §5):
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. An observed entity absent from desired
 *     is emitted as a `drift` PlanItem ONLY. This module NEVER emits
 *     `remove`/`destroy` for an unmanaged/orphan observed resource. The
 *     orphan/observed-side detection itself is single-sourced in drift.ts
 *     (Task 2.9, the dedicated detector) and CONSUMED here — plan() maps each
 *     reported DriftItem to its `op:"drift"` PlanItem; no orphan logic is
 *     duplicated in two places (DRY).
 *
 *   - DETERMINISM. Identical (desired, observed) inputs yield an identical
 *     plan: a stable topological order with a stable tie-break by entity key.
 *     No nondeterministic iteration.
 *
 *   - DEPENDENCY DAG. Order respects references: a network before a server
 *     that joins it, a volume/service after the server it attaches to,
 *     containers (services) last. A dependency cycle, or a referenced
 *     dependency missing from desired, is a manifest *precondition* failure
 *     (ReconcileError("precondition")) — never a crash (consistent with 2.4).
 *
 *   - PURE. function(desired, observed) → PlanItem[]. No I/O, DB, or network.
 *     Does not mutate its arguments.
 *
 * Op vocabulary is the canonical entities.ts PlanOpEnum (the by-value mirror of
 * the frozen console contract). Diff semantics:
 *   desired absent in observed            → create
 *   desired present & structurally equal  → noop
 *   desired present & changed             → update
 *   observed present & absent from desired→ drift   (fail-safe; never remove)
 *
 * Exported API (ONLY these):
 *   plan(desired, observed)    → PlanItem[]
 *   dependencyEdges(desired)   → Map<entityKey, depKeys[]>
 *   desiredPayloads(desired)   → Map<entityKey, desiredEntity>
 *
 * `desiredPayloads` is an ADDITIVE, backward-compatible accessor (it does NOT
 * change plan()'s behaviour). PlanItem intentionally carries no payload (it is
 * the console-frozen shape); the apply step needs the concrete desired entity
 * to hand a real Provider. This exposes the SAME per-entity desired payload
 * plan() diffs against, single-sourced from buildNodes() so the planner and
 * the applier cannot disagree on "what is desired for this entity" (DRY).
 * Task 2.7 threads this into PlanAction.desired.
 *
 * `dependencyEdges` is an ADDITIVE, backward-compatible accessor (it does NOT
 * change plan()'s behaviour). It exposes the SAME reference-derived dependency
 * DAG plan() builds internally so the apply step (Task 2.6) can propagate
 * "skip the dependents of a failed item" using ONE authoritative edge source.
 * Re-deriving the same edges independently in apply.ts would risk the two
 * drifting apart and silently mis-skipping an independent item — this keeps the
 * edge derivation DRY and single-sourced.
 */

import type { DesiredState } from "../domain/desired-state.js";
import type { State, PlanItem, PlanOp } from "../domain/entities.js";
import { ReconcileError } from "../domain/errors.js";
import { entityKey } from "../store/state-store-helper.js";
import { normalizeDependsOn } from "../providers/docker-depends-on.js";
import { detectDrift } from "./drift.js";
import type { WorkingStore } from "../agent/v2/working-store.js";

// ---------------------------------------------------------------------------
// Entity-kind ordering
//
// The kind rank gives the coarse topological tier (network → server →
// volume → service/container). Within a tier, and for the cross-entity
// reference edges (server→network, volume→server, service→server/volume),
// an explicit DAG + topological sort produces the fine-grained order with a
// stable tie-break by entity key.
// ---------------------------------------------------------------------------

const KIND_RANK: Readonly<Record<string, number>> = {
  network: 0,
  server: 1,
  volume: 2,
  service: 3,
};

/**
 * Stable entity key, delegating to the store's shared `entityKey` builder
 * (state-store-helper.ts) so the planner and the State Store produce byte-
 * identical keys. The shared builder escapes component values (`\`→`\\`,
 * `:`→`\:`) so a name containing `:` cannot collide with another entity or
 * silently bind the wrong dependency / mask an orphan. This is the single
 * source of truth for the key convention — when 2.7 wires plan() to store
 * output, both sides will key identically.
 */
function key(kind: string, name: string): string {
  return entityKey(kind, name);
}

interface Node {
  readonly entity: string;
  readonly kind: string;
  /** Entity keys this node depends on (must be applied before this node). */
  readonly deps: string[];
  readonly desired: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// plan — desired×observed diff → topo-sorted PlanItem[]
// ---------------------------------------------------------------------------

/**
 * Compute the ordered plan to converge `observed` toward `desired`.
 *
 * @throws ReconcileError("precondition") if the desired manifest contains a
 *         dependency cycle, or references a dependency it does not declare.
 */
/**
 * Build the desired-node set with each node's reference-derived dependency
 * edges. This is the SINGLE place reference edges (server→network,
 * volume→server, service→volume) are derived; both plan() and the public
 * dependencyEdges() accessor consume it so the apply step cannot drift from
 * the planner's notion of "what depends on what".
 */
function buildNodes(desired: DesiredState): Map<string, Node> {
  const nodes = new Map<string, Node>();

  const networks = desired.networks ?? [];
  const servers = desired.servers ?? [];
  const volumes = desired.volumes ?? [];
  const services = desired.services ?? [];

  for (const n of networks) {
    nodes.set(key("network", n.name), {
      entity: key("network", n.name),
      kind: "network",
      deps: [],
      desired: n,
    });
  }
  for (const s of servers) {
    nodes.set(key("server", s.name), {
      entity: key("server", s.name),
      kind: "server",
      deps: [key("network", s.network)],
      desired: s,
    });
  }
  for (const v of volumes) {
    const deps = v.server !== undefined ? [key("server", v.server)] : [];
    nodes.set(key("volume", v.name), {
      entity: key("volume", v.name),
      kind: "volume",
      deps,
      desired: v,
    });
  }
  for (const svc of services) {
    // Volume refs (cross-kind) AND intra-service depends_on edges (gap #2).
    // normalizeDependsOn is the single source for the short/object form; the
    // existing dep-exists validation + topoSort then reject a dangling ref or
    // a cycle as a precondition with no separate code path. depends_on never
    // reaches PlanAction.desired's container shape — it is ordering only.
    const deps = [
      ...(svc.volumes ?? []).map((vol) => key("volume", vol.split(":")[0] ?? vol)),
      ...normalizeDependsOn(svc.depends_on).map((dep) => key("service", dep)),
    ];
    nodes.set(key("service", svc.name), {
      entity: key("service", svc.name),
      kind: "service",
      deps,
      desired: svc,
    });
  }

  return nodes;
}

/**
 * The reference-derived dependency edges of `desired`: entity key → the entity
 * keys that MUST be applied before it (its direct dependencies). This is the
 * exact same edge set plan()'s internal topo sort uses; exposed additively so
 * apply.ts (Task 2.6) propagates "skip the transitive dependents of a failed
 * item" from one authoritative source (DRY — no re-derivation, no drift).
 *
 * NOTE: this is a PURE structural accessor of desired refs. It does NOT
 * validate that referenced deps exist nor detect cycles — that remains plan()'s
 * job (a missing/cyclic ref is still a precondition failure raised by plan()).
 * The returned map's keys are the desired entities only; a dep key may point
 * outside the key set if the manifest is malformed (plan() rejects that first).
 */
export function dependencyEdges(desired: DesiredState): Map<string, string[]> {
  const edges = new Map<string, string[]>();
  for (const node of buildNodes(desired).values()) {
    edges.set(node.entity, [...node.deps]);
  }
  return edges;
}

/**
 * The per-entity desired payload of `desired`: entity key → the concrete
 * declared entity object (the same object plan() diffs against observed).
 * Exposed additively so apply.ts (via Task 2.7's reconcile) can populate
 * PlanAction.desired with the real payload from ONE authoritative source
 * (no re-derivation, no drift from the planner's notion of desired).
 *
 * PURE structural accessor of desired; like dependencyEdges() it does NOT
 * validate refs or detect cycles — that remains plan()'s job.
 */
export function desiredPayloads(
  desired: DesiredState,
): Map<string, Record<string, unknown>> {
  const payloads = new Map<string, Record<string, unknown>>();
  for (const node of buildNodes(desired).values()) {
    payloads.set(node.entity, node.desired);
  }
  return payloads;
}

export function plan(desired: DesiredState, observed: State): PlanItem[] {
  // --- 1. Build the desired-node set + the in-desired key index. ---
  const nodes = buildNodes(desired);

  // --- 2. Validate referenced dependencies all exist in desired. ---
  for (const node of nodes.values()) {
    for (const dep of node.deps) {
      if (!nodes.has(dep)) {
        throw new ReconcileError(
          "precondition",
          `plan: "${node.entity}" references "${dep}" which is not declared ` +
            `in the desired manifest`,
          { entity: node.entity },
        );
      }
    }
  }

  // --- 3. Topological sort (deterministic: stable kind+key tie-break). ---
  const ordered = topoSort(nodes);

  // --- 4. Diff each desired node against observed. ---
  const observedIndex = indexObserved(observed);
  const items: PlanItem[] = [];

  for (const node of ordered) {
    const prior = observedIndex.get(node.entity);
    let op: PlanOp;
    let change: string;
    if (prior === undefined) {
      op = "create";
      change = `create ${node.entity}`;
    } else if (stableEqual(prior, node.desired)) {
      op = "noop";
      change = `${node.entity} already matches desired`;
    } else {
      op = "update";
      change = `update ${node.entity} to match desired`;
    }
    items.push({
      op,
      entity: node.entity,
      change,
      impact: impactFor(op, node.kind),
    });
  }

  // --- 5. Orphans: observed but absent from desired → drift ONLY. ---
  // Fail-safe: never remove/destroy a resource we were not asked to manage.
  // The orphan detection is SINGLE-SOURCED in drift.ts (Task 2.9) — plan()
  // merely maps each reported DriftItem to its `op:"drift"` PlanItem so the
  // two cannot disagree on what an orphan is (DRY). detectDrift() already
  // keys with the shared `entityKey` and returns a key-sorted result, so this
  // is byte-identical to the previous in-lined orphan loop (additive,
  // behaviour-preserving — prior 2.5 plan/reconcile/idempotency tests stay
  // green).
  const orphans: PlanItem[] = detectDrift(desired, observed).map((d) => ({
    op: "drift",
    entity: d.key,
    change: `${d.key} present in observed but absent from desired`,
    impact: "reported as drift for operator review; not modified",
  }));

  return [...items, ...orphans];
}

// ---------------------------------------------------------------------------
// Topological sort
//
// Kahn's algorithm with a deterministic frontier: at each step the available
// node with the lowest (kindRank, entityKey) is chosen. This yields the
// coarse network→server→volume→service tier order while still honouring the
// explicit reference edges, and is fully reproducible.
// ---------------------------------------------------------------------------

function topoSort(nodes: Map<string, Node>): Node[] {
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const n of nodes.values()) {
    if (!indegree.has(n.entity)) indegree.set(n.entity, 0);
    for (const dep of n.deps) {
      indegree.set(n.entity, (indegree.get(n.entity) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(n.entity);
      dependents.set(dep, list);
    }
  }

  const cmp = (a: string, b: string): number => {
    const na = nodes.get(a)!;
    const nb = nodes.get(b)!;
    const ra = KIND_RANK[na.kind] ?? Number.MAX_SAFE_INTEGER;
    const rb = KIND_RANK[nb.kind] ?? Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  };

  // Ready set = nodes with indegree 0, kept sorted on extraction.
  const ready: string[] = [];
  for (const [entity, deg] of indegree) {
    if (deg === 0) ready.push(entity);
  }

  const result: Node[] = [];
  while (ready.length > 0) {
    ready.sort(cmp);
    const entity = ready.shift()!;
    result.push(nodes.get(entity)!);
    for (const dependent of dependents.get(entity) ?? []) {
      const deg = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, deg);
      if (deg === 0) ready.push(dependent);
    }
  }

  if (result.length !== nodes.size) {
    // Remaining nodes form at least one cycle. A manifest with a dependency
    // cycle is a precondition failure (cannot be ordered), not a crash.
    const done = new Set(result.map((r) => r.entity));
    const stuck = [...nodes.keys()].filter((k) => !done.has(k)).sort();
    throw new ReconcileError(
      "precondition",
      `plan: nodes that could not be ordered (dependency cycle and/or its ` +
        `transitive dependents): [${stuck.join(", ")}] — the desired ` +
        `manifest cannot be topologically ordered`,
      { entity: stuck[0] ?? "" },
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Observed indexing + structural equality
// ---------------------------------------------------------------------------

/**
 * Index observed State by the same shared `entityKey` (store-escaped) the
 * desired nodes use, so the diff is a direct key lookup. Both sides route
 * through state-store-helper.ts's builder, so keys are byte-identical and a
 * `:`-bearing name cannot alias. Scoped to the kinds this
 * planner reasons about (servers/networks/volumes/services) — DNS/backups are
 * out of scope here (YAGNI; their planners arrive in Fase 5).
 */
function indexObserved(observed: State): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const n of observed.networks) m.set(key("network", n.name), n);
  for (const s of observed.servers) m.set(key("server", s.name), s);
  for (const v of observed.volumes) m.set(key("volume", v.name), v);
  for (const svc of observed.services) m.set(key("service", svc.name), svc);
  return m;
}

/**
 * Order-independent deep structural equality via canonical JSON.
 *
 * Only the fields the manifest *declares* are compared: observed entities
 * carry operational fields (status, hcloud_id, container_ids, …) that the
 * declarative desired form intentionally omits (see desired-state.ts). A
 * naive full compare would report every freshly-provisioned resource as
 * changed forever. We therefore project the observed value down to the
 * desired value's key set before comparing — a resource is `noop` iff every
 * declared field already matches.
 *
 * UNDEFINED/ABSENT SEMANTICS: a desired key whose value is `undefined` is
 * treated as "not declared" (the manifest is intentionally a subset of the
 * observed entity; see desired-state.ts) and is excluded from BOTH the
 * projection and the desired side of the compare. This is required for
 * correctness: `JSON.stringify` drops `undefined`-valued keys, so an optional
 * desired field that is present-but-`undefined` versus an observed entity that
 * populates that field would otherwise canonicalise equal and yield a FALSE
 * `noop` that masks real drift. Excluding such keys symmetrically keeps the
 * "observed extra operational fields ⇒ still noop" behaviour intact while
 * never reporting a false noop.
 */
function stableEqual(
  observed: Record<string, unknown>,
  desired: Record<string, unknown>,
): boolean {
  const projected: Record<string, unknown> = {};
  const declared: Record<string, unknown> = {};
  for (const k of Object.keys(desired)) {
    // A present-but-undefined desired key is "not declared" — skip on both
    // sides so it cannot canonicalise into a false noop.
    if (desired[k] === undefined) continue;
    declared[k] = desired[k];
    projected[k] = observed[k];
  }
  return canonicalJson(projected) === canonicalJson(declared);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Human-readable impact (the contract requires a non-empty string)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// F5.4 — v2 plan extension (additive; v1 plan() above is UNCHANGED)
//
// The v2 entity kinds (firewall, primary_ip, certificate, load_balancer,
// ingress) are NOT carried in DesiredState — each set-X v2 tool writes into
// its own WorkingStore<T> (per-tool seam established by F1.4–F5.3). The
// reconciler queries each store at plan time via `planV2()` and APPENDS the
// resulting PlanItems AFTER the v1 plan in this canonical order:
//
//   firewall → primary_ip → certificate → load_balancer → ingress
//
// Cross-dependencies WITHIN v2 (e.g. ingress depends on its cert + lb + fw)
// are resolved inside the IngressProvider composite, not by the planner —
// the planner only guarantees v1 is stable BEFORE v2 starts and v2 runs in
// the canonical order. A v2 entity's PlanItem carries the same `<kind>:<name>`
// entity key the working store uses; the wrapped v2 provider (v2-wrap.ts)
// receives the desired payload via plan.desiredPayloads() and dispatches
// through the composite router (no change to applyPlan dispatch).
//
// FAIL-SAFE: like v1, v2 plan items are create/update/noop only — never
// remove/destroy. The diff is observed-via-provider (per-entity); for Bloco A
// we DO NOT have a unified observed v2 snapshot, so this hook conservatively
// emits `create` for every declared v2 entity and lets the provider itself
// be the source of truth for "already converged" via the apply.ts no-op path
// (changed:false on a second apply). The wrapped provider's verify() guards
// the post-apply consistency check.
// ---------------------------------------------------------------------------

/**
 * Canonical v2 order (spec-filha Bloco A — F5.4). v1 entities run first
 * (network → server → volume → service via plan()); these v2 kinds are
 * APPENDED after v1 in this order. This is the SINGLE source of truth for
 * the v2 DAG order — reconcile() consumes it verbatim.
 */
export const V2_PLAN_ORDER: readonly string[] = [
  "firewall",
  "primary_ip",
  "certificate",
  "load_balancer",
  "ingress",
  "k3s",
  "kube",
] as const;

/**
 * One v2 working store entry: the canonical entity-kind prefix (used to build
 * the `<kind>:<name>` key) and the WorkingStore that supplies the declared
 * entities for it. The reconciler passes a map keyed by kind so the planner
 * iterates in V2_PLAN_ORDER deterministically.
 */
export interface V2WorkingSource<T extends { name: string }> {
  readonly entityKind: string;
  readonly store: WorkingStore<T>;
}

export type V2WorkingSources = Readonly<{
  [kind: string]: V2WorkingSource<{ name: string }>;
}>;

/**
 * Build the v2 plan: enumerate each working store in V2_PLAN_ORDER and emit
 * one PlanItem per declared entity. Items are op:"create" by default; the
 * provider's apply() handles idempotency (changed:false on already-converged
 * reality), so a re-run of an already-applied plan is a no-op end-to-end.
 *
 * Items WITHIN a kind are sorted by entity name (the working store's `list()`
 * already returns name-sorted output); items ACROSS kinds follow V2_PLAN_ORDER.
 * A working store absent from `sources` contributes nothing — additive: a v2
 * kind not yet wired produces zero plan items (existing tests unchanged).
 */
export async function planV2(sources: V2WorkingSources): Promise<PlanItem[]> {
  const items: PlanItem[] = [];
  for (const kind of V2_PLAN_ORDER) {
    const src = sources[kind];
    if (src === undefined) continue;
    const declared = await src.store.list();
    for (const d of declared) {
      const entity = `${src.entityKind}:${d.name}`;
      items.push({
        op: "create",
        entity,
        change: `converge ${entity} toward desired`,
        impact: impactFor("create", src.entityKind),
      });
    }
  }
  return items;
}

/**
 * Per-entity desired payloads from the v2 working stores, keyed by the SAME
 * `<kind>:<name>` entity key planV2() emits. Mirrors desiredPayloads() (v1)
 * so apply.ts populates PlanAction.desired from ONE authoritative source
 * for v2 too (the wrapped provider unpacks it back to its typed T).
 */
export async function desiredPayloadsV2(
  sources: V2WorkingSources,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  for (const kind of V2_PLAN_ORDER) {
    const src = sources[kind];
    if (src === undefined) continue;
    const declared = await src.store.list();
    for (const d of declared) {
      out.set(`${src.entityKind}:${d.name}`, d);
    }
  }
  return out;
}

function impactFor(op: PlanOp, kind: string): string {
  switch (op) {
    case "create":
      return `provision a new ${kind}`;
    case "update":
      return `mutate the existing ${kind} to match desired`;
    case "noop":
      return "none — already converged";
    case "drift":
      return "reported as drift for operator review; not modified";
    default:
      // Defensive: this planner only emits create/update/noop/drift, but
      // PlanOp is a wider union (remove/destroy/… for future planners) so we
      // keep an exhaustive fallback rather than assert unreachable.
      return `${op} ${kind}`;
  }
}
