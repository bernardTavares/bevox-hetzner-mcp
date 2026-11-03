/**
 * core/src/agent/v2/run-migrations.ts
 *
 * `run_migrations` (v2 write tool) — Tasks 5.1 → 5.x.
 *
 * Single `runMigrations(input, ctx, deps)` function shared by both the
 * REST `POST /api/v2/migrations` route and the MCP `run_migrations` tool
 * call (single source of truth across transports).
 *
 * Build-up (one step per commit, all in this file):
 *
 *   5.1 — DENY-BEFORE-WRITE. Assert v2 capability FIRST. An out-of-scope
 *         call short-circuits the entire path: no parse, no plan, no
 *         StateEvent, no approval row. Mirrors `set-firewall.ts` (line 178).
 *   5.2 — Input parse via the FROZEN `RunMigrationsInput` Zod schema.
 *   5.3 — Target service resolution against the observed-services snapshot.
 *   5.4 — ALWAYS-SENSITIVE Approval Gate routing (DDL/DML on a live DB).
 *   5.5+ — Apply loop (schema_migrations init + per-migration exec).
 *
 * Spec: docs/specs/2026-05-28-migration-runner-v1.md
 * Plan: docs/superpowers/plans/2026-05-28-migration-runner-v1.md
 */

import {
  assertV2Capability,
  type VerifiedCredential,
} from "../capability.js";
import { actorOf } from "../auth.js";
import {
  buildV2WriteEnvelope,
  type WriteEnvelopeV2,
} from "./envelope-v2.js";
import { ReconcileError } from "../../domain/errors.js";
import { RunMigrationsInput as RunMigrationsInputSchema } from "../../domain/migrations-v2.js";
import type {
  MigrationReport,
  MigrationReportEntry,
} from "../../domain/migrations-v2.js";
import type { PlanItem, Service } from "../../domain/entities.js";

/**
 * Map a psql stderr string to the per-migration `error_code` enum.
 *
 * Spec §2.3 — only the SQLSTATE code drives the mapping; the stderr bytes
 * themselves are DISCARDED by the caller after this call so no PG error
 * text reaches the report/envelope/event (M2 invariant).
 *
 *   42501          → "permission" (insufficient_privilege)
 *   42xxx          → "syntax"
 *   23xxx          → "constraint"
 *   anything else  → "unknown"
 */
function classifySqlstate(
  stderr: string,
): "syntax" | "constraint" | "permission" | "unknown" {
  const m = stderr.match(/SQLSTATE:?\s+(\d{5})/);
  if (!m) return "unknown";
  const code = m[1]!;
  if (code === "42501") return "permission";
  if (code.startsWith("42")) return "syntax";
  if (code.startsWith("23")) return "constraint";
  return "unknown";
}

/**
 * Map a thrown error from `dockerExec` to a per-migration `error_code`.
 *
 * Spec §2.3: a thrown error means the container/transport itself failed
 * before psql could report a SQLSTATE. We classify on the error message
 * shape and DISCARD the original message — only the enum value is
 * surfaced downstream (M2 invariant).
 *
 *   /not running|container.*exited/i  → "container_exited"
 *   otherwise                          → "unknown"
 */
function classifyThrown(err: unknown): "container_exited" | "unknown" {
  const msg = err instanceof Error ? err.message : String(err);
  return /not running|container.*exited/i.test(msg)
    ? "container_exited"
    : "unknown";
}

/**
 * Result of a single docker-exec attempt.
 *
 *  - `{ ok: true, res }`         — exec returned (exit code may still be non-zero)
 *  - `{ ok: false, errorCode }`  — exec threw (container gone, transport down,
 *                                   per-migration timeout fired, etc.)
 */
type ExecOutcome =
  | { readonly ok: true; readonly res: { exitCode: number; stdout: string; stderr: string } }
  | { readonly ok: false; readonly errorCode: "container_exited" | "timeout" | "unknown" };
import type {
  GateContext,
  ReconcileGate,
} from "../../reconciler/reconcile.js";

// ---------------------------------------------------------------------------
// Input / context / deps
// ---------------------------------------------------------------------------

/**
 * The tool input as it arrives from REST body / MCP arguments. Re-exported
 * from the FROZEN domain schema (`domain/migrations-v2.ts`) so callers and
 * the wire contract share one type.
 */
export type { RunMigrationsInput } from "../../domain/migrations-v2.js";

/** Per-call context the caller (REST/MCP) supplies. */
export interface RunMigrationsCtx {
  readonly credential: VerifiedCredential;
  /** Reconcile scope the tool acts on (callers default to "service"). */
  readonly scope: string;
}

/**
 * Injected dependencies. Populated incrementally by Tasks 5.3 → 5.x.
 */
export interface RunMigrationsDeps {
  /**
   * Returns the FROZEN-for-this-call observed Service snapshot. Same reader
   * the reconciler uses for the `service` scope. The runner consults it to
   * resolve `target_service` to a concrete container id (precondition gate
   * for the apply loop).
   */
  readonly servicesProvider: () => Promise<readonly Service[]>;
  /**
   * Approval Gate strategy. `run_migrations` is ALWAYS sensitive per spec
   * §1.3 (DDL/DML on a live database is destructive by category, regardless
   * of the SQL contents). The CALLER wires this seam — typically with
   * `makeGate(() => true)` so every invocation routes through the real
   * Fase-4 approval-gate. The runner itself never makes a sensitivity
   * decision; it only consults `evaluate()` and follows the decision.
   */
  readonly approvalGate: ReconcileGate;
  /**
   * Per-call docker-exec runner. Returns the synchronous result of running
   * `argv` inside the target container (psql under the hood). Task 5.5+
   * uses it for the `schema_migrations` init exec AND the per-migration
   * apply exec. The runner never spawns a host shell — argv is passed
   * verbatim to Docker Engine, so no shell-interpolation surface here.
   *
   * MUST honour `opts.signal` and propagate the abort to the SSH child
   * (the host SSH transport implements the SIGTERM → grace → SIGKILL
   * kill ladder). The runner itself only fires the AbortController; the
   * actual signal delivery semantics live in `ssh-exec.ts`.
   */
  readonly dockerExec?: (
    containerId: string,
    argv: readonly string[],
    opts?: { readonly signal?: AbortSignal },
  ) => Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /**
   * Per-migration timeout in milliseconds. The caller wires this from
   * `config.MIGRATION_TIMEOUT_MS` (range [1000, 600000], default 60_000).
   * Optional in the deps shape so 5.1-5.7 tests (which never hang) can
   * omit it; when omitted, the runner does NOT impose a timeout.
   */
  readonly timeoutMs?: number;
  /**
   * StateEvent append seam. Task 5.12 — one StateEvent per migration with
   * `actor` sourced from `ApplyContext` (the `VerifiedCredential` on
   * `RunMigrationsCtx`), `scope:"service"`, `entity:"migrations:<svc>:<db>"`,
   * `op:"create"`, and `result` echoing the per-migration outcome
   * (`ok | noop | error`). Optional in the deps shape so tests that don't
   * exercise the event path (5.1-5.11) can omit it; when omitted, the
   * runner does NOT emit StateEvents (production callers MUST wire this).
   *
   * The runner NEVER includes SQL bytes in `after` (M1 invariant — spec
   * §2.3). Only filename + timing + error_code travel into the event.
   *
   * The `pool` first arg is the pg Pool/PoolClient passed through to the
   * underlying `appendEvent` in `core/src/store/state-events.ts`; typed as
   * `unknown` here to keep the runner free of a hard `pg` dependency
   * (the caller wires the real pool).
   */
  readonly appendEvent?: (
    pool: unknown,
    event: {
      readonly actor: string;
      readonly scope: "service";
      readonly entity: string;
      readonly op: "create";
      readonly result: "ok" | "noop" | "error";
      readonly after?: Record<string, unknown>;
    },
  ) => Promise<void>;
  /**
   * pg Pool/PoolClient threaded into `appendEvent`. Optional alongside
   * `appendEvent` itself — the runner passes whatever the caller provides
   * (production: the real Postgres pool; tests: `null` / a fake).
   */
  readonly pool?: unknown;
}

// ---------------------------------------------------------------------------
// runMigrations — the single dispatch
// ---------------------------------------------------------------------------

/**
 * Execute the `run_migrations` tool. NEVER throws — every failure (authz,
 * parse, precondition, gate) is captured into a contract-shaped v2 error
 * envelope. Returns `WriteEnvelopeV2`.
 */
export async function runMigrations(
  input: unknown,
  ctx: RunMigrationsCtx,
  deps: RunMigrationsDeps,
): Promise<WriteEnvelopeV2> {
  // (1) DENY-BEFORE-WRITE. Throws fatal on out-of-scope / forged credential
  // BEFORE any parse/precondition/write — no StateEvent, no approval row.
  try {
    assertV2Capability(ctx.credential, "run_migrations");
  } catch (err) {
    return toErrorEnvelope(err);
  }

  // (2) Parse the input through the FROZEN `RunMigrationsInput` schema.
  // VALUE-FREE error message: the precondition envelope must NOT echo any
  // input field value (ground rule I4 — secrets/log hygiene; same posture
  // even though this payload carries no secrets, to keep the contract
  // uniform with the rest of the v2 surface).
  let parsed: ReturnType<typeof RunMigrationsInputSchema.parse>;
  try {
    parsed = RunMigrationsInputSchema.parse(input);
  } catch {
    return toErrorEnvelope(
      new ReconcileError("precondition", "invalid run_migrations input", {
        entity: "migrations",
      }),
    );
  }

  // (3) Resolve `target_service` against the observed-services snapshot.
  // Precondition gate before the always-sensitive Approval Gate (5.4):
  //   - service absent from the desired/observed slice ⇒ precondition,
  //   - service present but no live container ⇒ precondition.
  // Entity tag mirrors the spec format: `migrations:<service>:<db>`.
  const entity = `migrations:${parsed.target_service}:${parsed.database}`;
  let services: readonly Service[];
  try {
    services = await deps.servicesProvider();
  } catch (err) {
    return toErrorEnvelope(err);
  }
  const svc = services.find((s) => s.name === parsed.target_service);
  if (!svc || !svc.container_ids || svc.container_ids.length === 0) {
    return toErrorEnvelope(
      new ReconcileError("precondition", "target service not running", {
        entity,
      }),
    );
  }
  // (The first live container_id is read inside the apply loop below —
  // post-gate — so a pending_approval path NEVER touches Docker.)

  // (4) Always-sensitive Approval Gate (spec §1.3). Synthesise a single
  // PlanItem(op="create", entity="migrations:<svc>:<db>") and route it
  // through the SAME `ReconcileGate.evaluate()` the v1 catalog uses for
  // destroy/restore. The runner itself NEVER makes a sensitivity
  // decision — sensitivity is the CALLER's wiring contract
  // (`makeGate(() => true)`). On any denial we surface the gate's
  // pending approval id; NOTHING is written to the DB or applied to the
  // container (fail-safe — a pending approval ⇒ NO mutation).
  const actor = actorOf(ctx.credential);
  const item: PlanItem = {
    op: "create",
    entity,
    change: `run ${parsed.migrations.length} migration(s) against ${entity}`,
    impact:
      "applies DDL/DML inside the target Postgres — approval required",
  };
  const gateCtx: GateContext = {
    scope: `agent:${actor}:${ctx.scope}`,
    actor,
  };
  let approvalId: string | undefined;
  try {
    const decision = await deps.approvalGate.evaluate([item], gateCtx);
    if (decision.denied.length > 0) {
      const picked = (decision.pendingApprovals ?? []).find(
        (p) => p.entity === entity && p.op === "create",
      );
      approvalId = picked?.approvalId;
    }
  } catch (err) {
    return toErrorEnvelope(err);
  }
  if (approvalId !== undefined) {
    return buildV2WriteEnvelope({
      status: "pending_approval",
      approval_id: approvalId,
    });
  }

  // (5) Apply loop (Task 5.5) — schema_migrations init + per-migration
  // SELECT/apply.
  //
  // Docker-exec seam is optional in `RunMigrationsDeps` so the 5.1-5.4
  // tests (which never reach this branch) need not wire it; here we
  // require it. A missing seam past the gate is a wiring bug, surfaced
  // as a `fatal` envelope (no partial side-effect, no StateEvent).
  if (deps.dockerExec === undefined) {
    return toErrorEnvelope(
      new ReconcileError("fatal", "run_migrations: dockerExec dep missing", {
        entity,
      }),
    );
  }
  const containerId = svc.container_ids[0]!;
  const dockerExec = deps.dockerExec;
  const timeoutMs = deps.timeoutMs;
  // Wrap every exec so throws map to ExecOutcome.ok=false with a
  // classified error_code. The original Error message is DISCARDED —
  // only the enum value reaches the report (M2 invariant).
  //
  // When `deps.timeoutMs` is set, each exec is bounded by an
  // AbortController whose timer fires `controller.abort()`. The
  // transport is contractually obliged to honour `opts.signal` and
  // propagate the abort to its SSH child (SIGTERM → grace → SIGKILL
  // ladder lives in `ssh-exec.ts`). Whether the eventual rejection
  // comes back to us as the controller's abort reason or as the
  // transport's own "aborted"-style Error, the controller's
  // `signal.aborted` flag tells us authoritatively whether the
  // failure was the timer firing.
  const safeExec = async (argv: readonly string[]): Promise<ExecOutcome> => {
    const controller =
      timeoutMs !== undefined ? new AbortController() : undefined;
    const timer =
      controller !== undefined
        ? setTimeout(() => controller.abort(), timeoutMs)
        : undefined;
    try {
      const res = await dockerExec(
        containerId,
        argv,
        controller !== undefined ? { signal: controller.signal } : undefined,
      );
      return { ok: true, res };
    } catch (err) {
      if (controller !== undefined && controller.signal.aborted) {
        return { ok: false, errorCode: "timeout" };
      }
      return { ok: false, errorCode: classifyThrown(err) };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  // Set up the report up-front so init/SELECT failures (which happen
  // "before" migration N starts) can still synthesize a per-migration
  // entry for the first un-attempted file (spec §2.3 — container_exited
  // surfaces in `report.applied[]`, not in the envelope status).
  const report: MigrationReport = { applied: [] };
  const firstFile = parsed.migrations[0]!.filename; // Zod-min(1) guarantees ≥1

  // Task 5.12 — StateEvent emission seam. One event per per-migration
  // entry pushed into `report.applied[]`. `after` carries filename +
  // timing + (optionally) error_code; NEVER the SQL bytes (M1 invariant).
  // `actor` is sourced from `ApplyContext` above (state-event-actor rule).
  const appendEventDep = deps.appendEvent;
  const pool = deps.pool ?? null;
  const pushAndEmit = async (
    entry: MigrationReportEntry,
  ): Promise<void> => {
    report.applied.push(entry);
    if (appendEventDep === undefined) return;
    const after: Record<string, unknown> = { filename: entry.filename };
    if (entry.duration_ms !== undefined) after.duration_ms = entry.duration_ms;
    if (entry.error_code !== undefined) after.error_code = entry.error_code;
    await appendEventDep(pool, {
      actor,
      scope: "service",
      entity,
      op: "create",
      result: entry.result,
      after,
    });
  };

  // 5a. Init schema_migrations (idempotent — CREATE TABLE IF NOT EXISTS).
  const initSql =
    "CREATE TABLE IF NOT EXISTS schema_migrations(filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());";
  const initT0 = Date.now();
  const initOut = await safeExec(buildPsqlArgv(parsed.database, initSql));
  if (!initOut.ok) {
    // Container/transport died before any migration ran — surface as a
    // per-migration error on the first file and STOP (M8 fail-safe).
    await pushAndEmit({
      filename: firstFile,
      result: "error",
      error_code: initOut.errorCode,
      duration_ms: Date.now() - initT0,
    });
    return buildV2WriteEnvelope({ status: "applied", report });
  }
  if (initOut.res.exitCode !== 0) {
    return toErrorEnvelope(
      new ReconcileError("fatal", "schema_migrations init failed", {
        entity,
      }),
    );
  }

  // 5b. Per-migration loop.
  for (const mig of parsed.migrations) {
    const t0 = Date.now();
    // Already applied?  `filename` is Zod-validated against
    // /^[a-zA-Z0-9_.-]+\.sql$/, so direct interpolation here is safe
    // (no quote/escape vector). The `sql` body is NEVER interpolated
    // outside the apply exec — it travels as `argv -c <sql>` directly.
    const checkSql = `SELECT 1 FROM schema_migrations WHERE filename='${mig.filename}';`;
    const checkOut = await safeExec(buildPsqlArgv(parsed.database, checkSql));
    if (!checkOut.ok) {
      await pushAndEmit({
        filename: mig.filename,
        result: "error",
        error_code: checkOut.errorCode,
        duration_ms: Date.now() - t0,
      });
      break;
    }
    const checkRes = checkOut.res;
    if (checkRes.exitCode !== 0) {
      return toErrorEnvelope(
        new ReconcileError("fatal", "schema_migrations lookup failed", {
          entity,
        }),
      );
    }
    // 5.6: row hit ⇒ already applied ⇒ noop (skip BEGIN/INSERT/COMMIT).
    // psql's default aligned output for a SELECT-1-row result includes
    // "(1 row)" at the end; that's the most reliable marker across
    // banner widths and locale-dependent header formatting. The check
    // is intentionally lenient — false-positive noops are safe (we
    // re-converge on the next batch); false-negative would re-apply,
    // which is what schema_migrations(filename PK) UNIQUE prevents
    // anyway.
    if (/\(1 row\)/.test(checkRes.stdout)) {
      await pushAndEmit({
        filename: mig.filename,
        result: "noop",
        duration_ms: Date.now() - t0,
      });
      continue;
    }
    const applySql = `BEGIN; ${mig.sql}; INSERT INTO schema_migrations(filename) VALUES ('${mig.filename}'); COMMIT;`;
    const applyOut = await safeExec(buildPsqlArgv(parsed.database, applySql));
    if (!applyOut.ok) {
      await pushAndEmit({
        filename: mig.filename,
        result: "error",
        error_code: applyOut.errorCode,
        duration_ms: Date.now() - t0,
      });
      break;
    }
    const applyRes = applyOut.res;
    if (applyRes.exitCode !== 0) {
      // Per spec §2.3: per-migration apply failure is DATA — envelope stays
      // `applied`, the report carries `result:"error" + error_code`. Stop
      // the batch on first failure (spec §3 M8 — fail-safe).
      // stderr is classified-then-DISCARDED so no PG error text leaks (M2).
      const errorCode = classifySqlstate(applyRes.stderr);
      await pushAndEmit({
        filename: mig.filename,
        result: "error",
        error_code: errorCode,
        duration_ms: Date.now() - t0,
      });
      break;
    }
    await pushAndEmit({
      filename: mig.filename,
      result: "ok",
      duration_ms: Date.now() - t0,
    });
  }

  return buildV2WriteEnvelope({ status: "applied", report });
}

/**
 * Build the psql argv for `docker exec`. `$POSTGRES_USER` is a LITERAL
 * string here — the Docker provider injects the env var inside the
 * container so psql sees the resolved value. ZERO host-side shell is
 * involved (the argv is passed verbatim to Docker Engine).
 */
function buildPsqlArgv(database: string, sql: string): readonly string[] {
  return [
    "psql",
    "-U",
    "$POSTGRES_USER",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ];
}

// ---------------------------------------------------------------------------
// Internal: error envelope (no-leak)
// ---------------------------------------------------------------------------

function toErrorEnvelope(err: unknown): WriteEnvelopeV2 {
  if (err instanceof ReconcileError) {
    return buildV2WriteEnvelope({
      status: "error",
      error: err.toApiError(),
    });
  }
  return buildV2WriteEnvelope({
    status: "error",
    error: new ReconcileError("fatal", "run_migrations failed", {
      entity: "migrations",
    }).toApiError(),
  });
}
