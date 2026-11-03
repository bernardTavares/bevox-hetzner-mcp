/**
 * core/test/fakes/sops-cli.ts
 *
 * In-memory, per-instance fake of the sops CLI as a `SpawnFn`-shaped seam.
 * Sole job: be a deterministic substitute for `node:child_process.spawn`
 * (wrapped) so the secret-resolver-real-v1 resolver + boot validation can
 * exercise the full happy / error / timeout / spawn-error paths with ZERO
 * process spawning and ZERO filesystem access.
 *
 * ⚠ THIS IS NOT A TEST OF SOPS and is NOT a sops emulator. It models only
 * what the resolver's `SpawnFn` seam invokes:
 *   - exitCode / stdout / stderr Promises
 *   - synchronous kill(signal?) recording
 *   - configurable response, timeout, and spawn-error behaviours
 *
 * Design mirrors `core/test/fakes/hetzner-http.ts`:
 *   - PER-INSTANCE, RESETTABLE — `createSopsCliFake()` returns a fresh
 *     isolated instance; all state lives in the closure. `reset()` returns
 *     it to pristine.
 *   - DETERMINISTIC FAULTS — `setSpawnError({code})` and `setTimeout()`
 *     drive the resolver's error paths predictably.
 *   - CALL LOG — every `spawn` invocation is captured for assertion.
 *
 * Shape-compatibility note: `spawn` is shaped exactly like `SpawnFn` declared
 * module-internal in `core/src/store/secrets.ts` §1.2 (lines 226–235). That
 * type is NOT EXPORTED publicly (per the spec's "module-internal" decision),
 * so this fake duplicates the shape locally instead of importing it. If the
 * canonical `SpawnFn` changes, this local duplicate MUST be kept in sync.
 */

// ---------------------------------------------------------------------------
// Local duplicate of `SpawnFn` — shape-compatible with SpawnFn in
// store/secrets.ts §1.2. See header note for the "do not import" rationale.
// ---------------------------------------------------------------------------

/**
 * Shape-compatible with `SpawnFn` in `core/src/store/secrets.ts` §1.2. The
 * canonical type is module-internal; this is a deliberate local duplicate so
 * the fake can be imported by test files without touching the resolver's
 * private surface.
 */
type SpawnFnShape = (
  cmd: string,
  args: readonly string[],
  opts: { readonly shell: false; readonly env: Readonly<Record<string, string>> },
) => {
  stdout: Promise<Buffer>;
  stderr: Promise<Buffer>;
  exitCode: Promise<number>;
  kill: (signal?: NodeJS.Signals) => void;
};

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** One captured `spawn` invocation. */
export interface SopsCliCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts: { readonly shell: false; readonly env: Readonly<Record<string, string>> };
}

export interface SopsCliFake {
  /**
   * Drop-in `SpawnFn`-shaped handler. Never spawns a real process. The
   * returned `{ stdout, stderr, exitCode, kill }` follow the canonical
   * `SpawnFn` contract: exit-code coercion `null → -1` lives in the
   * production wrapper (`realSpawnWrapper`) for the timeout/signal-killed
   * case; the fake mirrors that by resolving `exitCode` with `-1` after
   * `kill` when in timeout mode. In `respond` mode, the test caller supplies
   * the literal `exitCode` (which may be `-1` to simulate a signal-killed
   * child whose `null` was already coerced upstream).
   */
  spawn: SpawnFnShape;
  /**
   * Configure the response for every subsequent `spawn` call until the next
   * `setResponse` / `setTimeout` / `setSpawnError` / `reset()`. Default
   * (post-reset, no setter called) is exitCode=0, empty stdout, empty stderr.
   * Subsequent setters override; mode is last-write-wins per spawn invocation.
   */
  setResponse(opts: { exitCode: number; stdout: Buffer; stderr: Buffer }): void;
  /**
   * Switch the fake into timeout mode: subsequent `spawn` calls return
   * Promises that NEVER resolve until `kill` is called on the child. After
   * `kill`, all three Promises resolve (exitCode=-1, empty stdout, empty
   * stderr). Covers Task 3.7 (resolver SIGTERM → SIGKILL escalation).
   * Subsequent setters override; mode is last-write-wins per spawn invocation.
   */
  setTimeout(): void;
  /**
   * Switch the fake into spawn-error mode: subsequent `spawn` calls return
   * a child whose `exitCode` Promise REJECTS with an Error shaped like
   * `child.on('error')` (i.e. carrying a `code` field such as "ENOENT").
   * `stdout` and `stderr` resolve with empty Buffers (no streams ever
   * opened). Covers Task 3.8 (child.on('error') wrap) and Task 2.5 boot
   * validation `sops --version` missing-binary path.
   * Subsequent setters override; mode is last-write-wins per spawn invocation.
   */
  setSpawnError(opts: { code: string; message?: string }): void;
  /** Every `spawn` invocation, in call order. Read-only by convention. */
  readonly callLog: ReadonlyArray<SopsCliCall>;
  /**
   * Every signal sent to `kill`, in call order across all `spawn` calls
   * since the last `reset()`. Used by Task 3.7 assertions to verify
   * `SIGTERM → SIGKILL` escalation timing.
   */
  readonly lastKillSignals: ReadonlyArray<NodeJS.Signals>;
  /** Clear callLog, kill signals, and any configured response / fault. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type Mode =
  | { kind: "respond"; exitCode: number; stdout: Buffer; stderr: Buffer }
  | { kind: "timeout" }
  | { kind: "spawnError"; code: string; message: string };

const DEFAULT_MODE: Mode = {
  kind: "respond",
  exitCode: 0,
  stdout: Buffer.alloc(0),
  stderr: Buffer.alloc(0),
};

export function createSopsCliFake(): SopsCliFake {
  let mode: Mode = DEFAULT_MODE;
  let callLog: SopsCliCall[] = [];
  let killSignals: NodeJS.Signals[] = [];

  function reset(): void {
    mode = DEFAULT_MODE;
    callLog = [];
    killSignals = [];
  }

  const spawn: SpawnFnShape = (cmd, args, opts) => {
    callLog.push({ cmd, args, opts });

    if (mode.kind === "spawnError") {
      const err = Object.assign(new Error(mode.message), { code: mode.code });
      // Only `exitCode` rejects. `stdout` / `stderr` resolve with empty
      // Buffers because no streams ever opened — there is no data to
      // deliver. This avoids UnhandledPromiseRejection warnings in Vitest
      // when the resolver only awaits `exitCode` (the idiomatic path).
      return {
        stdout: Promise.resolve(Buffer.alloc(0)),
        stderr: Promise.resolve(Buffer.alloc(0)),
        exitCode: Promise.reject(err),
        kill: () => {
          // No-op in spawn-error mode — the child never started.
        },
      };
    }

    if (mode.kind === "timeout") {
      // Each Promise resolves only when `kill` is invoked.
      let resolveStdout!: (b: Buffer) => void;
      let resolveStderr!: (b: Buffer) => void;
      let resolveExit!: (n: number) => void;
      const stdout = new Promise<Buffer>((r) => {
        resolveStdout = r;
      });
      const stderr = new Promise<Buffer>((r) => {
        resolveStderr = r;
      });
      const exitCode = new Promise<number>((r) => {
        resolveExit = r;
      });
      let killed = false;
      const kill = (signal?: NodeJS.Signals): void => {
        // Default to SIGTERM when undefined to match Node's real
        // `child_process.ChildProcess.kill()` default.
        killSignals.push(signal ?? "SIGTERM");
        if (killed) return;
        killed = true;
        // Coerce `null → -1` per SpawnFn contract.
        resolveStdout(Buffer.alloc(0));
        resolveStderr(Buffer.alloc(0));
        resolveExit(-1);
      };
      return { stdout, stderr, exitCode, kill };
    }

    // mode.kind === "respond"
    const resp = mode;
    return {
      stdout: Promise.resolve(resp.stdout),
      stderr: Promise.resolve(resp.stderr),
      exitCode: Promise.resolve(resp.exitCode),
      kill: (signal?: NodeJS.Signals) => {
        // Default to SIGTERM when undefined to match Node's real
        // `child_process.ChildProcess.kill()` default.
        killSignals.push(signal ?? "SIGTERM");
        // No-op on already-resolved child — matches real subprocess behaviour
        // (sending a signal to an exited child is a soft no-op).
      },
    };
  };

  return {
    spawn,
    setResponse(opts) {
      mode = { kind: "respond", exitCode: opts.exitCode, stdout: opts.stdout, stderr: opts.stderr };
    },
    setTimeout() {
      mode = { kind: "timeout" };
    },
    setSpawnError(opts) {
      mode = { kind: "spawnError", code: opts.code, message: opts.message ?? `spawn error: ${opts.code}` };
    },
    get callLog() {
      // Shallow copy: `ReadonlyArray<…>` is a compile-time fiction; at
      // runtime, consumers could otherwise mutate the internal array.
      return [...callLog];
    },
    get lastKillSignals() {
      // Shallow copy: see `callLog` rationale.
      return [...killSignals];
    },
    reset,
  };
}
