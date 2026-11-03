/**
 * core/src/observability/logger.ts
 *
 * The minimal injectable STRUCTURED-LOGGER seam (Task 6.3).
 *
 * Design principles (spec §"Observability: events, health"; §"NO SECRET
 * LEAKAGE"; the determinism-seam discipline already used for fetchImpl /
 * sleep / clock / timer):
 *
 *   - PINO IS THE RATIFIED LOGGER (CLAUDE.md; `pino` IS a core/package.json
 *     dependency). The DEFAULT logger here is a thin pino-backed adapter, so
 *     production emits real structured pino JSON. We do NOT add a heavy new
 *     dependency — pino is reused.
 *
 *   - BUT LOGGING IS AN INJECTED SEAM, not a hard call to pino. Exactly like
 *     fetchImpl / sleep / clock / timer elsewhere, the logger is passed in so
 *     the test suite captures log lines IN-PROCESS (a CapturingLogger) with
 *     ZERO real stdout noise and asserts the structured fields deterministically.
 *     Tests must never depend on a real transport.
 *
 *   - STRUCTURED, MANDATORY OBSERVABILITY FIELDS. Every reconcile/apply/error
 *     log line carries `actor`, `scope`, `entity` (+ a result/error class) so
 *     the spec's observability requirement (who did what, in which scope, to
 *     which entity, with what outcome) holds in the log trail as well as in
 *     StateEvents.
 *
 *   - NO SECRET LEAKAGE (1.9 / 3.3 discipline). Call sites pass ONLY refs / ids
 *     / counts / classes — NEVER a resolved secret value, token or password.
 *     This module does not (and must not) try to scrub: it is the caller's
 *     contract to log refs not values; the no-leak sentinel test proves the
 *     reconcile call sites honour it. The pino adapter therefore performs NO
 *     interpolation of arbitrary objects beyond the fields explicitly passed.
 *
 * Exported API (minimal — only what Task 6.3 needs):
 *   interface Logger / LogFields
 *   createPinoLogger(pinoLike?)   → Logger   (default: real pino)
 *   noopLogger                    : Logger   (silent default for callers that
 *                                              do not wire one — zero noise)
 */

import pino from "pino";

// ---------------------------------------------------------------------------
// Logger contract — the minimal surface the reconciler needs
// ---------------------------------------------------------------------------

/**
 * The structured fields every reconcile/apply/error log line carries. `actor`,
 * `scope` and `entity` are MANDATORY (the spec's observability requirement).
 * Extra fields (result / errorClass / op …) are free-form but, by call-site
 * contract, MUST be refs/ids/counts/classes ONLY — never a resolved secret.
 */
export interface LogFields {
  /** The acting agent id (e.g. "agent:vox"). Mandatory. */
  readonly actor: string;
  /** The capability scope being reconciled (e.g. "server"). Mandatory. */
  readonly scope: string;
  /** The affected entity (e.g. "server:app-1", or the scope for cycle-level). Mandatory. */
  readonly entity: string;
  /** Outcome / error class / op — refs & classes ONLY, never a secret value. */
  readonly [key: string]: unknown;
}

/**
 * The injected structured logger. Two levels are enough for Task 6.3:
 * `info` for normal reconcile/apply outcomes, `error` for failures/timeouts.
 * A NAMED interface (not an inline shape) so Task 6.4/6.6 can widen it without
 * touching reconcile internals.
 */
export interface Logger {
  info(fields: LogFields, msg: string): void;
  warn(fields: LogFields, msg: string): void;
  error(fields: LogFields, msg: string): void;
}

// ---------------------------------------------------------------------------
// pino-backed default — the ratified production logger
// ---------------------------------------------------------------------------

/** The slice of a pino logger we use — so a fake pino is injectable in tests. */
export interface PinoLike {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

/**
 * Build the DEFAULT (production) logger: a thin adapter over a real pino
 * instance. The pino instance is itself injectable (`pinoLike`) so a test can
 * substitute a capturing pino without a real transport; omitted ⇒ a real pino
 * (the ratified logger). Only the explicitly-passed `fields` object is forwarded
 * to pino — no arbitrary object is spread/interpolated (no-leak discipline).
 */
export function createPinoLogger(pinoLike?: PinoLike): Logger {
  const p: PinoLike = pinoLike ?? pino({ name: "bevox-hetzner-mcp" });
  return {
    info(fields: LogFields, msg: string): void {
      p.info(fields, msg);
    },
    warn(fields: LogFields, msg: string): void {
      p.warn(fields, msg);
    },
    error(fields: LogFields, msg: string): void {
      p.error(fields, msg);
    },
  };
}

/**
 * A silent logger. The reconciler's logger parameter defaults to this so every
 * existing caller/test stays byte-identical (zero stdout noise, no behaviour
 * change) until a caller explicitly wires `createPinoLogger()` (the Task-6.6
 * daemon) or a capturing fake (the Task-6.3 tests). Additive & backward-compat.
 */
export const noopLogger: Logger = {
  info(): void {
    /* intentionally silent */
  },
  warn(): void {
    /* intentionally silent */
  },
  error(): void {
    /* intentionally silent */
  },
};
