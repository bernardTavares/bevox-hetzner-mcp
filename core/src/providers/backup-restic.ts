/**
 * core/src/providers/backup-restic.ts
 *
 * Task 5.3 — BackupProvider: the concrete `Provider` (provider.ts) for the
 * declarative BackupPolicy entity (entities.ts). It is the ONLY translation
 * seam between a declarative backup policy and the restic CLI surface, driving
 * every restic operation through an injected `ResticTransport` (the
 * restic-CLI-shaped seam from backup-restic-transport.ts). The provider is
 * transport-agnostic: it never learns whether it speaks to the in-process
 * fake or a future real `restic`-CLI-backed transport — only restic ops.
 *
 * THE BACKUP MODEL (spec §"idempotência por design"; §"fail-safe, nunca
 * fail-deleting"; §"non-objetivos" — no secret rotation; YAGNI):
 *
 *   The DESIRED entity is the BACKUP POLICY/target (entity key
 *   `backup:<target>`, scope `backup`). Its convergence is "this target's
 *   repo is initialised AND at least one snapshot exists for it" — i.e. the
 *   policy is actually being honoured (a configured-but-never-run backup is
 *   not converged; it would silently protect nothing). apply() therefore:
 *
 *     - OBSERVES BEFORE IT WRITES: lists the target's snapshots; if one
 *       already exists, apply() is a NO-OP (no `backup` call, changed:false).
 *     - Only when ZERO snapshots exist does it take the INITIAL snapshot
 *       (one `backup` call) so the policy is honoured. It does NOT take a new
 *       snapshot on every apply — that would flap convergence forever and
 *       break the Fase-2 idempotency property (conformanceHarness is the
 *       oracle, wired directly in the test, with observe-scope teeth).
 *
 *   On-demand `snapshot(target)` is the IMPERATIVE op the catalog/endpoint
 *   calls (Task 5.4 wires it): it ALWAYS appends a new snapshot and requires
 *   NO approval (the provider has zero approval logic anyway — snapshot is
 *   none-policy per the 4.4 contract table). It is intentionally NOT the same
 *   as `apply` (which is idempotent state-convergence).
 *
 *   `restore(target,id)` is the only intentionally-DESTRUCTIVE op. The
 *   provider performs the restore MECHANICS via the seam; it does NOT
 *   self-approve. The destructive→approval routing is the EXISTING Task 4.3
 *   gate / 4.4 catalog path (restore = always-approval); Task 5.4 wires the
 *   endpoint. This provider never forks or duplicates that gate.
 *
 * Design principles:
 *
 *   - FAIL-SAFE, NEVER FAIL-DELETING. NO code path here forgets/prunes/deletes
 *     a snapshot or any unmanaged repo data — the seam has no `forget`/`prune`
 *     by construction, so the provider is STRUCTURALLY unable to delete repo
 *     data. An orphan/expired snapshot is the reconciler's drift concern
 *     (Task 2.9), never auto-removed here. A destructive plan `op`
 *     (remove/destroy) is a deliberate NO-OP returning `changed:false`
 *     (consistent with docker.ts / wireguard.ts / hetzner-dns.ts). `restore`
 *     is the SOLE intentionally-destructive op and it is explicit + (one
 *     layer up) approval-gated; it is never reached from apply/observe/verify.
 *
 *   - IDEMPOTENCY (Fase-2 exit criterion, must keep holding). isConverged is
 *     STABLE-FIELDS-ONLY: "≥1 snapshot exists for the target". It does NOT
 *     compare volatile snapshot ids/timestamps/sizes — comparing them would
 *     flap. So a converged backup target re-applied = changed:false with ZERO
 *     transport writes (a re-converge flap test pins this).
 *
 *   - PRECONDITION BEFORE WRITE. Malformed BackupPolicy desired (fails the
 *     entities.ts BackupPolicySchema, or empty target) is a
 *     ReconcileError("precondition"), never a crash, raised before any restic
 *     write. An unknown scope/kind is likewise "precondition".
 *
 *   - ERROR MAPPING via domain/errors.ts ONLY. A transport/restic failure is
 *     classified through classify() into a ReconcileError (a restic/SSH blip
 *     → transient, etc.). The restic REPOSITORY PASSWORD / credentials are
 *     secret material: they never cross the seam and are NEVER placed in any
 *     message — we never echo policy/repo into errors (1.9 / 3.3 discipline).
 *
 *   - CONTRACT CONFORMANCE. snapshot()/listing outputs are shaped to the
 *     FROZEN console contract (console/src/api/contract.ts SnapshotEntry /
 *     BackupEntry) by VALUE — core conforms to it; we do not import the
 *     console package (same boundary rule as errors.ts / provider.ts) and do
 *     not invent divergent field names. Task 5.4's conformance extension +
 *     the live 4.6 oracle are separate tasks; the shapes are correct here so
 *     5.4 is clean.
 *
 *   - MINIMAL SURFACE. One factory `createBackupProvider(opts)` returning
 *     `Provider` PLUS the two imperative ops (snapshot/restore/listing) the
 *     catalog needs, exposed via the returned object's extra methods (the
 *     `Provider` port stays exactly observe/apply/verify; the imperative ops
 *     are additive and used only by 5.4's wiring). opts inject the
 *     `ResticTransport`. Scope is backup policies only — no MCP, no endpoint,
 *     no real restic (YAGNI; that is 5.4 / a future transport).
 *
 * Exported API:
 *   createBackupProvider(opts: BackupProviderOptions): BackupProvider
 *   interface BackupProviderOptions
 *   interface BackupProvider          — Provider + snapshot/restore/list ops
 *   interface SnapshotEntry           — contract-shaped snapshot record
 *   interface BackupEntry             — contract-shaped enriched policy record
 */

import { BackupPolicySchema, type BackupPolicy } from "../domain/entities.js";
import { classify, ReconcileError } from "../domain/errors.js";
import type {
  ResticSnapshot,
  ResticTransport,
} from "./backup-restic-transport.js";
import type {
  ApplyResult,
  ObservedSlice,
  PlanAction,
  Provider,
} from "./provider.js";

// ---------------------------------------------------------------------------
// Contract-shaped output types — mirrored BY VALUE from the FROZEN console
// contract (console/src/api/contract.ts SnapshotEntrySchema /
// BackupEntrySchema). We do NOT import the console package (same boundary as
// errors.ts/provider.ts). The provider test re-asserts these parse against a
// faithful mirror of the contract Zod schemas (the rest.test.ts /
// contract-conformance precedent); the live cross-package oracle is 4.6/5.4.
// ---------------------------------------------------------------------------

/** One restic snapshot entry — matches console SnapshotEntry field-for-field. */
export interface SnapshotEntry {
  readonly id: string;
  readonly timestamp: string;
  readonly size: string;
}

/**
 * Enriched backup entry — matches console BackupEntry field-for-field:
 * the declarative BackupPolicy (target/schedule/retention/repo) extended with
 * `last_run` (optional) + the `snapshots[]` list. NO secret values — only
 * non-secret operational metadata (the repo PASSWORD never appears here).
 */
export interface BackupEntry {
  readonly target: string;
  readonly schedule: string;
  readonly retention: string;
  readonly repo: string;
  readonly last_run?: string;
  readonly snapshots: readonly SnapshotEntry[];
}

// ---------------------------------------------------------------------------
// Options — the test injects the restic-CLI fake's transport here.
// ---------------------------------------------------------------------------

export interface BackupProviderOptions {
  /**
   * The restic-CLI-shaped seam (snapshots/backup/restore). Injected in tests
   * as the in-process fake; a future real `restic`-backed transport
   * implements the SAME interface unchanged, so the provider stays
   * transport-agnostic. The restic repo PASSWORD never crosses this seam.
   */
  readonly transport: ResticTransport;
}

// ---------------------------------------------------------------------------
// BackupProvider — the Provider port PLUS the imperative ops 5.4 wires.
// ---------------------------------------------------------------------------

/**
 * The `Provider` port (observe/apply/verify — idempotent policy convergence)
 * extended with the imperative catalog ops:
 *
 *   - snapshot(target): take a NEW snapshot now. NO approval (none-policy per
 *     the 4.4 contract table; the provider has zero approval logic anyway).
 *     Returns the created SnapshotEntry (contract-shaped).
 *   - restore(target,id): perform the restore MECHANICS. The provider does
 *     NOT self-approve — the destructive→approval routing is the existing
 *     4.3 gate / 4.4 catalog path (restore = always-approval), wired by 5.4.
 *   - listBackup(policy): the enriched BackupEntry (policy + last_run +
 *     snapshots[]) GET /api/backups returns. Read-only.
 *
 * Keeping these on the returned object (not the bare Provider) means the
 * reconciler still drives ONLY the port; the imperative surface is additive
 * and reached only by the agent interface (5.4).
 */
export interface BackupProvider extends Provider {
  /** On-demand snapshot — no approval. Appends one snapshot, returns it. */
  snapshot(target: string): Promise<SnapshotEntry>;
  /**
   * Restore mechanics — destructive. Provider performs it; approval is owned
   * by the gate/catalog ABOVE (5.4 wires the always-approval route).
   */
  restore(target: string, snapshotId: string): Promise<void>;
  /** Read-only enriched BackupEntry (policy + last_run + snapshots[]). */
  listBackup(policy: BackupPolicy): Promise<BackupEntry>;
}

const SCOPE = "backup";

// ---------------------------------------------------------------------------
// Pure projection — restic snapshot → contract SnapshotEntry. NON-SECRET only.
// ---------------------------------------------------------------------------

/** restic byte size → the contract's string `size` (e.g. "1234"). */
function toSnapshotEntry(s: ResticSnapshot): SnapshotEntry {
  return {
    id: s.id,
    timestamp: s.time,
    size: s.sizeBytes === undefined ? "0" : String(s.sizeBytes),
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBackupProvider(
  opts: BackupProviderOptions,
): BackupProvider {
  if (!opts.transport) {
    // Construction-time misconfiguration is fatal, not a reconcile failure.
    throw new ReconcileError(
      "fatal",
      "BackupProvider: a ResticTransport is required",
    );
  }
  const tx = opts.transport;

  /** Narrow a "<kind>:<name>" key / scope to "backup"; else precondition. */
  function assertScope(scopeOrEntity: string): void {
    const kind = scopeOrEntity.split(":", 1)[0] ?? "";
    if (kind !== SCOPE) {
      throw new ReconcileError(
        "precondition",
        `BackupProvider: unsupported scope/kind "${kind}" ` +
          `(supported: ${SCOPE})`,
        { entity: scopeOrEntity },
      );
    }
  }

  /** Validate desired against BackupPolicySchema → precondition on failure. */
  function parsePolicy(action: PlanAction): BackupPolicy {
    const parsed = BackupPolicySchema.safeParse(action.desired);
    if (!parsed.success) {
      throw new ReconcileError(
        "precondition",
        `BackupProvider: malformed BackupPolicy desired for ${action.entity} ` +
          `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        { entity: action.entity },
      );
    }
    if (parsed.data.target.length === 0) {
      throw new ReconcileError(
        "precondition",
        `BackupProvider: BackupPolicy target must be non-empty for ` +
          `${action.entity}`,
        { entity: action.entity },
      );
    }
    return parsed.data;
  }

  /**
   * Wrap a transport call so any restic/SSH failure is mapped through
   * domain/errors.ts. The error MESSAGE is secret-free by construction: the
   * seam contract forbids the repo password/credentials in rejections, and we
   * never echo the policy/repo/target into the message (only the entity key,
   * which is non-secret).
   */
  async function guarded<T>(
    fn: () => Promise<T>,
    entity: string,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReconcileError) throw e;
      const code =
        e && typeof e === "object" && "code" in e
          ? String((e as { code: unknown }).code)
          : undefined;
      throw new ReconcileError(
        classify({ code, kind: "network-error" }),
        `BackupProvider: restic operation failed for ${entity}`,
        { entity, cause: e },
      );
    }
  }

  return {
    name: "backup-restic",

    async observe(scope: string): Promise<ObservedSlice> {
      assertScope(scope);
      // observe is per-target: scope may be the bare "backup" partition or a
      // full "backup:<target>" key. A bare scope cannot enumerate every
      // target without a manifest (the store's job), so we surface the
      // target encoded in the key when present — mirroring how the reconciler
      // derives the observe scope from an action's entity. With only the bare
      // partition we report no entities (the reconciler reconciles per
      // entity via verify(); a richer snapshot is the store's job).
      const target = scope.includes(":")
        ? scope.slice(scope.indexOf(":") + 1)
        : "";
      if (target.length === 0) {
        return { scope, entities: [] };
      }
      const snaps = await guarded(() => tx.snapshots(target), scope);
      return {
        scope,
        entities:
          snaps.length > 0
            ? [{ key: `${SCOPE}:${target}`, payload: { name: target } }]
            : [],
      };
    },

    async verify(action: PlanAction): Promise<boolean> {
      assertScope(action.entity);
      const policy = parsePolicy(action);
      // STABLE-FIELDS-ONLY convergence: the policy is honoured iff at least
      // one snapshot exists for the target. Volatile snapshot ids/timestamps/
      // sizes are intentionally NOT compared (they would flap).
      const snaps = await guarded(
        () => tx.snapshots(policy.target),
        action.entity,
      );
      return snaps.length > 0;
    },

    async apply(action: PlanAction): Promise<ApplyResult> {
      assertScope(action.entity);

      // FAIL-SAFE: destructive intents are NOT handled here. No-op, never
      // forget/prune/delete a snapshot (orphan→drift is the reconciler's
      // job, Task 2.9). The seam has no delete op anyway.
      if (action.op === "remove" || action.op === "destroy") {
        return { entity: action.entity, op: action.op, changed: false };
      }

      const policy = parsePolicy(action);

      // IDEMPOTENCY: observe-before-write. If the target already has ≥1
      // snapshot the policy is honoured → NO-OP (no backup call, no flap).
      // Only an unbackuped target triggers the INITIAL snapshot.
      const existing = await guarded(
        () => tx.snapshots(policy.target),
        action.entity,
      );
      if (existing.length > 0) {
        return { entity: action.entity, op: action.op, changed: false };
      }

      await guarded(() => tx.backup(policy.target), action.entity);
      return { entity: action.entity, op: action.op, changed: true };
    },

    // --- imperative catalog ops (5.4 wires these; reconciler never calls) ---

    async snapshot(target: string): Promise<SnapshotEntry> {
      if (target.length === 0) {
        throw new ReconcileError(
          "precondition",
          "BackupProvider: snapshot(target) requires a non-empty target",
        );
      }
      // NO approval logic here — snapshot is none-policy (4.4 contract table);
      // the provider has zero approval logic by design. ALWAYS appends a new
      // snapshot (imperative op, distinct from idempotent apply()).
      const created = await guarded(
        () => tx.backup(target),
        `${SCOPE}:${target}`,
      );
      return toSnapshotEntry(created);
    },

    async restore(target: string, snapshotId: string): Promise<void> {
      if (target.length === 0 || snapshotId.length === 0) {
        throw new ReconcileError(
          "precondition",
          "BackupProvider: restore(target,id) requires non-empty target & id",
        );
      }
      // DESTRUCTIVE. The provider performs ONLY the restore mechanics; it
      // does NOT self-approve. The destructive→approval routing is the
      // EXISTING 4.3 gate / 4.4 catalog path (restore = always-approval),
      // wired by Task 5.4. Nothing here checks/bypasses approval.
      await guarded(
        () => tx.restore(target, snapshotId),
        `${SCOPE}:${target}`,
      );
    },

    async listBackup(policy: BackupPolicy): Promise<BackupEntry> {
      const parsed = BackupPolicySchema.safeParse(policy);
      if (!parsed.success) {
        throw new ReconcileError(
          "precondition",
          `BackupProvider: malformed BackupPolicy for listBackup ` +
            `(${parsed.error.issues.map((i) => i.message).join("; ")})`,
        );
      }
      const p = parsed.data;
      const snaps = await guarded(
        () => tx.snapshots(p.target),
        `${SCOPE}:${p.target}`,
      );
      const entries = snaps.map(toSnapshotEntry);
      // last_run = the most recent snapshot timestamp (operational metadata,
      // non-secret). Absent when the target has never been backed up.
      //
      // PRECONDITION (binds every ResticTransport implementation): the
      // string `>` below is a LEXICOGRAPHIC max, which equals the
      // CHRONOLOGICAL max ONLY when every timestamp shares a uniform offset
      // (RFC3339 sorts lexicographically == chronologically iff the offset is
      // identical). restic emits UTC `...Z`, so this holds for the fake and
      // for a faithful restic transport. A real transport MUST normalise
      // every snapshot timestamp to a uniform offset (UTC `Z`) BEFORE it
      // crosses the ResticTransport seam — mixed offsets (e.g. `+00:00` vs
      // `Z`, or a local offset) would make this pick the WRONG last_run, and
      // no test would catch it (the fake only ever emits `...Z`).
      let lastRun: string | undefined;
      for (const e of entries) {
        if (lastRun === undefined || e.timestamp > lastRun) {
          lastRun = e.timestamp;
        }
      }
      const out: BackupEntry = {
        target: p.target,
        schedule: p.schedule,
        retention: p.retention,
        repo: p.repo,
        snapshots: entries,
        ...(lastRun !== undefined ? { last_run: lastRun } : {}),
      };
      return out;
    },
  };
}
