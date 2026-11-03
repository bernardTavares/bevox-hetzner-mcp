/**
 * core/test/fakes/ssh-exec-recorder.ts
 *
 * Task 4.2 — in-memory `SshRunner` fake. The migration runner (5.x) talks
 * to the remote Docker host through the `SshRunner` seam declared in
 * `core/src/providers/ssh-transports.ts` — (conn, remoteArgv, opts?) →
 * Promise<SshResult>. This recorder IMPLEMENTS that seam (type-only import
 * below); it does not declare it. It is per-instance, resettable, and
 * deterministic — no process spawn, no SSH, no network.
 *
 * Two responsibilities, both minimal:
 *
 *   1. SCRIPT outcomes. `setResult(result)` sets a default `SshResult` for
 *      every call; `setResultByMatcher(predicate, result)` registers a
 *      predicate over the remote argv → result mapping. Predicates are
 *      tried in registration order; first match wins. Absent any match and
 *      any explicit default, the fall-through is `{code: 0, stdout: "",
 *      stderr: ""}` (so a test that only cares about argv shape can omit
 *      the setter entirely).
 *
 *   2. RECORD argv (and stdin). Every call's `(conn, remoteArgv, opts.stdin)`
 *      lands in `calls` (read-only externally) so tests can assert the
 *      runner's `docker exec … psql -c "<sql>"` invocations token-by-token
 *      (argv-only — no shell interpolation; the production seam contracts
 *      argv ↔ shell-safe) AND that a piped body (e.g. a kubectl manifest)
 *      travels on `stdin`, never on argv.
 *
 * SEAM OWNERSHIP: `SshRunner`, `SshResult`, `SshConnection` are OWNED by the
 * production tree (core/src/providers/ssh-{exec,transports}.ts) —
 * port-ownership discipline: src/ must not import from test/.
 */

import type { SshRunner } from "../../src/providers/ssh-transports.js";
import type { SshConnection, SshResult } from "../../src/providers/ssh-exec.js";

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

export interface SshExecCall {
  readonly conn: SshConnection;
  readonly remoteArgv: readonly string[];
  /** stdin bytes passed via opts.stdin, if any. */
  readonly stdin?: string;
}

export interface SshExecRecorder {
  /** Drop-in `SshRunner` for any production code under test. */
  readonly run: SshRunner;
  /** Read-only audit log of every call the runner has made. */
  readonly calls: ReadonlyArray<SshExecCall>;
  /** Set the default `SshResult` returned when no matcher matches. */
  setResult(result: SshResult): void;
  /**
   * Register a remote-argv predicate → result mapping. Predicates are tried
   * in registration order; the first match wins, else the default applies.
   */
  setResultByMatcher(
    predicate: (argv: readonly string[]) => boolean,
    result: SshResult,
  ): void;
  /** Clear calls, default result and matchers. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const FALLTHROUGH: SshResult = { code: 0, stdout: "", stderr: "" };

export function createSshExecRecorder(): SshExecRecorder {
  // --- per-instance state (closure; no global/static) --------------------
  const calls: SshExecCall[] = [];
  let defaultResult: SshResult = FALLTHROUGH;
  const matchers: Array<{
    predicate: (argv: readonly string[]) => boolean;
    result: SshResult;
  }> = [];

  const run: SshRunner = (conn, remoteArgv, opts) => {
    const call: SshExecCall = {
      conn,
      remoteArgv: [...remoteArgv],
      ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}),
    };
    calls.push(call);
    const matched = matchers.find((m) => m.predicate(remoteArgv));
    const result = matched ? matched.result : defaultResult;
    return Promise.resolve({ ...result });
  };

  return {
    run,
    calls,
    setResult(result) {
      defaultResult = { ...result };
    },
    setResultByMatcher(predicate, result) {
      matchers.push({ predicate, result: { ...result } });
    },
    reset() {
      calls.length = 0;
      defaultResult = FALLTHROUGH;
      matchers.length = 0;
    },
  };
}
