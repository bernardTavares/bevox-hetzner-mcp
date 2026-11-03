/**
 * core/src/providers/docker-wait-healthy.ts
 *
 * Wait-for-healthy seam for the DockerProvider (gap #2, Phase 2.0). Given a
 * dependency service name, polls the Engine `State.Health.Status` of its
 * managed replica containers until they are all `healthy`, the budget elapses,
 * or a replica reports no health (image without HEALTHCHECK).
 *
 * PURE-ISH: all I/O is the injected `call` seam; `now`/`sleep` are injected so
 * tests never wall-clock-wait. The DockerProvider wires the outcome into
 * apply() (tasks 2.0.5/2.0.6): healthy ⇒ proceed; wait_skipped ⇒ degrade to
 * ordering-only; timeout ⇒ abort by return (fail-safe, nothing created/deleted).
 *
 * Spec: docs/specs/2026-05-28-manifest-schema-gaps.md (rev b §1.5).
 */

import { L_MANAGED, L_SERVICE } from "./docker.js";

/** The minimal transport seam waitForHealthy needs (same shape as docker.ts `call`). */
export interface WaitHealthyDeps {
  readonly call: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; json: unknown }>;
  /** Monotonic clock in ms (injected; tests advance it via `sleep`). */
  readonly now: () => number;
  /** Resolves after `ms` (injected; tests advance the clock instead of waiting). */
  readonly sleep: (ms: number) => Promise<void>;
}

export type WaitHealthyOutcome =
  | { readonly outcome: "healthy" }
  | { readonly outcome: "wait_skipped"; readonly reason: "no_healthcheck"; readonly dep: string }
  | {
      readonly outcome: "timeout";
      readonly dep: string;
      readonly status: string;
      readonly waited_ms: number;
    };

/** Poll cadence between health checks (ms). */
const POLL_INTERVAL_MS = 1000;

/** Default per-dep wait budget (ms) — spec §1.5: 120s (postgres cold-init). */
export const DEFAULT_WAIT_HEALTHY_MS = 120_000;

/**
 * Parse a per-dep `wait_healthy_timeout` (`"<N>s"` | `"<N>m"`) to ms. Falls back
 * to the 120s default when absent or unparseable (the schema already validates
 * the shape via `^\d+[sm]$`, so a malformed value cannot reach a real apply).
 */
export function parseWaitTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WAIT_HEALTHY_MS;
  const m = /^(\d+)([sm])$/.exec(raw);
  if (!m) return DEFAULT_WAIT_HEALTHY_MS;
  const n = Number(m[1]);
  return m[2] === "m" ? n * 60_000 : n * 1000;
}

interface ListedContainer {
  readonly Id: string;
  readonly Labels: Readonly<Record<string, string>>;
}

/** Managed replica container Ids for one service (same label filter as docker.ts). */
async function replicaIdsOf(
  dep: string,
  call: WaitHealthyDeps["call"],
): Promise<string[]> {
  const filters = JSON.stringify({ label: [`${L_MANAGED}=true`] });
  // all=true: find the dep's replicas regardless of run-state (the Engine lists
  // only running by default; a dep still starting must still be discoverable).
  const res = await call(
    "GET",
    `/containers/json?all=true&filters=${encodeURIComponent(filters)}`,
  );
  const list: ListedContainer[] = Array.isArray(res.json)
    ? (res.json as ListedContainer[])
    : [];
  return list.filter((c) => c.Labels[L_SERVICE] === dep).map((c) => c.Id);
}

/**
 * Wait until every replica of `dep` reports `State.Health.Status === "healthy"`.
 *
 * - `healthy`      — all replicas healthy (proceed with the dependent).
 * - `wait_skipped` — a replica's inspect carries no `State.Health` (image has
 *   no HEALTHCHECK) ⇒ degrade to ordering-only; returned immediately, no poll.
 * - `timeout`      — budget elapsed before all replicas were healthy.
 */
export async function waitForHealthy(
  dep: string,
  timeoutMs: number,
  deps: WaitHealthyDeps,
): Promise<WaitHealthyOutcome> {
  const start = deps.now();

  for (;;) {
    const ids = await replicaIdsOf(dep, deps.call);

    // No managed replicas for this dep ⇒ nothing to gate on. In correct topo
    // order the dep is applied first (so it exists here); if its apply failed,
    // the reconciler skips this dependent before apply. Either way there is no
    // unhealthy replica to block on — proceed (vacuously healthy).
    if (ids.length === 0) return { outcome: "healthy" };

    let lastStatus = "unknown";
    let allHealthy = true;
    for (const id of ids) {
      const insp = await deps.call("GET", `/containers/${id}/json`);
      const state = (insp.json as { State?: { Health?: { Status?: string } } })
        .State;
      const status = state?.Health?.Status;
      if (status === undefined) {
        // No HEALTHCHECK on this replica's image ⇒ cannot wait. Degrade.
        return { outcome: "wait_skipped", reason: "no_healthcheck", dep };
      }
      lastStatus = status;
      if (status !== "healthy") allHealthy = false;
    }

    if (allHealthy) return { outcome: "healthy" };

    const waited = deps.now() - start;
    if (waited >= timeoutMs) {
      return { outcome: "timeout", dep, status: lastStatus, waited_ms: waited };
    }
    await deps.sleep(POLL_INTERVAL_MS);
  }
}
