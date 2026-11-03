/**
 * core/src/store/secrets.ts
 *
 * Secret REFERENCE model — metadata only, apply-gated resolution (Task 1.9).
 *
 * Design principles (spec §"Fora de escopo": key handling / decryption are
 * DEFERRED; spec §5: fail-safe, every action audited; YAGNI):
 *
 *   - A secret is referenced in manifests purely as the string form
 *     "secret:<name>" (preserved verbatim by desired-state.ts — never
 *     expanded there). `SecretRef` is the Zod brand for that string.
 *
 *   - describe(ref) returns ONLY the metadata shape {name,keys,used_by}.
 *     The metadata schema is `.strict()`, which makes it STRUCTURALLY
 *     IMPOSSIBLE for a secret value to ride along: an extra `value` key is
 *     rejected by parse, and the inferred type has no value field. describe
 *     never opens a file, never decrypts, never touches any value.
 *
 *   - resolve(ref, ctx) is gated behind an `ApplyContext` token. The token
 *     is an opaque, module-private branded object created ONLY by the
 *     exported `createApplyContext()` factory. A plain `{}` or the string
 *     "apply" CANNOT satisfy the gate (the brand symbol is module-private
 *     and never exported), so a plan / dry_run code path that never holds a
 *     real ApplyContext can never reach a secret value. A missing/invalid
 *     token throws ReconcileError("fatal") — auth/permission failure, the
 *     same class errors.ts assigns to 401/403.
 *
 *   - v1 stub: actual decryption is OUT OF SCOPE (keys deferred). Once past
 *     the gate, the stub does NOT throw — it RETURNS a value-free
 *     `{ status: "deferred" }` marker, so callers distinguish "forbidden"
 *     (gate threw ReconcileError("fatal")) from "not yet built" (deferred).
 *     No error message ever contains secret material (there is none yet).
 *
 * Exported API (minimal surface — nothing else):
 *   SecretRef                  — Zod schema/brand for "secret:<name>"
 *   ApplyContext               — opaque token type (cannot be constructed
 *                                outside this module)
 *   createApplyContext()       — the ONLY way to mint an ApplyContext
 *   SecretResolver             — resolver interface
 *   createStubSecretResolver() — v1 inert stub factory
 */

import { spawn as nodeSpawn } from "node:child_process";
import { z } from "zod";

import { ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// SecretRef — the "secret:<name>" string form
//
// <name> is a single path segment: lowercase letters, digits, '-' and '_',
// at least one char, no spaces, no '/'. This matches how manifests name
// secrets (e.g. "secret:bevox-harness") and rejects anything ambiguous.
// ---------------------------------------------------------------------------

const SECRET_REF_RE = /^secret:[a-z0-9][a-z0-9_-]*$/;

export const SecretRef = z
  .string()
  .regex(SECRET_REF_RE, 'must be of the form "secret:<name>"')
  .brand<"SecretRef">();

export type SecretRef = z.infer<typeof SecretRef>;

/** Extract the bare <name> from a validated "secret:<name>" ref. */
function refName(ref: string): string {
  return ref.slice("secret:".length);
}

/**
 * Parse-or-throw a SecretRef as a ReconcileError("precondition").
 * A malformed ref is a manifest precondition violation, consistent with
 * desired-state.ts which classifies manifest defects as "precondition".
 * The message contains only the (already non-secret) ref string.
 */
function requireRef(ref: string): SecretRef {
  const r = SecretRef.safeParse(ref);
  if (!r.success) {
    throw new ReconcileError(
      "precondition",
      `secret ref invalid: expected "secret:<name>", got ${JSON.stringify(ref)}`,
      { entity: "secret" },
    );
  }
  return r.data;
}

// ---------------------------------------------------------------------------
// Secret metadata shape — {name,keys,used_by}, STRICT, NO value ever
//
// .strict() is the security boundary: parse() rejects any extra key
// (notably `value`), and z.infer gives a type that cannot carry a value.
// ---------------------------------------------------------------------------

const SecretMetaSchema = z
  .object({
    /** The bare secret name (no "secret:" prefix). */
    name: z.string().min(1),
    /** Declared key names inside the secret — names ONLY, never values. */
    keys: z.array(z.string()),
    /** Entities (e.g. "service:bevox-harness") that reference this secret. */
    used_by: z.array(z.string()),
  })
  .strict();

export type SecretMeta = z.infer<typeof SecretMetaSchema>;

// ---------------------------------------------------------------------------
// ApplyContext — unforgeable apply-only capability token
//
// The brand is a module-private unique symbol. It is NEVER exported, so no
// external caller can construct an object that carries it. `createApplyContext`
// is the sole mint. A bare {} or "apply" lacks the brand → gate rejects it.
// `Object.freeze` prevents post-hoc tampering of an issued token.
// ---------------------------------------------------------------------------

const APPLY_BRAND: unique symbol = Symbol("bevox.secrets.applyContext");

export interface ApplyContext {
  readonly [APPLY_BRAND]: true;
}

/**
 * Mint an ApplyContext. This MUST only be called from a genuine apply path
 * (the Approval-gated Apply step of the reconciler, Fase 4). Plan / dry_run
 * code paths must never call this, and therefore can never reach resolve().
 */
export function createApplyContext(): ApplyContext {
  return Object.freeze({ [APPLY_BRAND]: true as const });
}

function isApplyContext(v: unknown): v is ApplyContext {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as Record<symbol, unknown>)[APPLY_BRAND] === true
  );
}

// ---------------------------------------------------------------------------
// SecretResolveResult — v1 deferred marker (NO value field, by construction)
//
// Modelled as a discriminated union so the eventual real resolver can add a
// `{ status: "ok"; ... }` variant WITHOUT this v1 stub ever being able to
// produce a value. The "deferred" variant is value-free by definition.
// ---------------------------------------------------------------------------

export type SecretResolveResult =
  | {
      readonly status: "deferred";
      /** The bare secret name the (future) resolver would have resolved. */
      readonly name: string;
    }
  | {
      /**
       * APPLY-ONLY, GATE-GUARDED resolved value. Only a NON-STUB resolver,
       * past a valid ApplyContext, may produce this. It MUST NEVER appear in
       * plan / dry_run / observe / logs / StateEvents / error messages.
       *
       * Task 3.3 ADDITIVE SEAM: this variant lets a real resolver (e.g. the
       * apply-time injector, or a future SOPS-age backend) return a value
       * behind the SAME unforgeable ApplyContext gate. It is reachable ONLY
       * past `isApplyContext(ctx)`; a plan/dry_run path holding no real
       * ApplyContext can never obtain it. The v1 stub
       * (createStubSecretResolver) is UNCHANGED — it still only ever returns
       * the value-free "deferred" variant; `describe()` is unaffected.
       */
      readonly status: "ok";
      readonly name: string;
      readonly value: string;
    };

// ---------------------------------------------------------------------------
// SecretResolver interface
// ---------------------------------------------------------------------------

export interface SecretResolver {
  /**
   * Return metadata for a secret ref. METADATA ONLY — never a value.
   * @throws ReconcileError("precondition") if the ref is malformed.
   */
  describe(ref: string): SecretMeta;

  /** The strict metadata Zod schema (exposed for contract assertions). */
  describeSchema(): typeof SecretMetaSchema;

  /**
   * Resolve a secret to its value. APPLY-GATED. ASYNC: real resolution
   * (later phase) is I/O-bound (SOPS/age), so the contract is a Promise
   * now — an invalid token rejects the returned promise rather than
   * throwing synchronously.
   * @throws ReconcileError("fatal") (rejected) if `ctx` is not a real
   *         ApplyContext (missing / forged plain object / forged string) —
   *         a plan or dry_run path can never satisfy this.
   * @throws ReconcileError("precondition") (rejected) if the ref is malformed.
   *
   * v1: decryption is DEFERRED / out of scope (keys deferred). Once PAST
   * the gate the stub does NOT throw an auth/precondition error — instead
   * it resolves to a clearly-marked deferred result `{ status: "deferred" }`
   * carrying NO value field, so callers can distinguish "forbidden"
   * (rejected) from "not yet built" (resolved deferred). The real resolver
   * (later phase) will return the resolved key→value map here.
   */
  resolve(ref: string, ctx: ApplyContext): Promise<SecretResolveResult>;
}

/**
 * Spawn-shaped seam — NOT `node:child_process.spawn` raw. Production passes a
 * thin wrapper around `child_process.spawn` that collects stdout/stderr into
 * Buffers (instead of exposing streams) and resolves exit code as a Promise.
 * Tests pass a fake with the same shape. The wrapper is ~30 lines, lives in
 * the same file as `createSopsAgeSecretResolver`, never logs, never writes
 * to disk.
 *
 * NOT EXPORTED publicly — type is module-internal. Both the resolver and the
 * boot-validation helper take an OPTIONAL `spawn` param of this shape; tests
 * inject a fake, production omits → real wrapper used.
 *
 * NO stdin: the subprocess is always invoked argv-only (no piping into
 * the child). If a future use case needs stdin, this seam must be extended
 * deliberately — silent passthrough is a misuse vector.
 *
 * exitCode coercion: `node:child_process.spawn` resolves `code: number | null`
 * (null on signal kill). The wrapper coerces `null → -1` deliberately so
 * downstream callers can branch on `code !== 0` without null-checks.
 */
type SpawnFn = (
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
// realSpawnWrapper — production adapter `node:child_process.spawn` → SpawnFn
//
// EXPORTED (not module-internal) so `entrypoint-wiring.ts:_validateSopsAgeConfig`
// can default `deps.spawn` to it without duplicating the wrapper body. The
// `SpawnFn` shape itself remains module-internal per spec — callers reach this
// function via `ReturnType<typeof realSpawnWrapper>` (structurally compatible
// with the local `SpawnFn` duplicates in entrypoint-wiring.ts / sops-cli.ts).
//
// Semantics:
//   - stdout/stderr accumulate as Buffer[] on `data` events; concatenated on
//     `end` and resolved as a single Buffer. Mirrors the `SpawnFn` contract
//     (Buffer Promise, not a Stream — the resolver awaits in one shot).
//   - exitCode coerces `code: number | null` → `null → -1`, matching the
//     `SpawnFn` contract documented above (downstream branches on `!== 0`).
//   - `child.on('error')` (e.g. ENOENT, EACCES — spawn-time failures) rejects
//     the exitCode Promise with the raw Error. The resolver's catch block
//     already wraps this into a value-free `ReconcileError("fatal")` (see
//     `createSopsAgeSecretResolver` §"L5 defense-in-depth"), so the raw
//     `.message` (which may name the binary path) never reaches a caller.
//   - kill(signal = "SIGTERM") matches `ChildProcess.kill`'s default. Safe to
//     call before exit (signal delivery) and after exit (no-op on Linux).
//   - NO stdin: spawn invokes argv-only, matching the resolver's footgun
//     S5 / argv-only invariant (no piping into the child).
// ---------------------------------------------------------------------------

export function realSpawnWrapper(
  cmd: string,
  args: readonly string[],
  opts: { readonly shell: false; readonly env: Readonly<Record<string, string>> },
): ReturnType<SpawnFn> {
  const child = nodeSpawn(cmd, [...args], {
    shell: opts.shell,
    env: opts.env,
  });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  if (child.stdout) {
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
  }
  if (child.stderr) {
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
  }

  const stdout = new Promise<Buffer>((resolve, reject) => {
    if (!child.stdout) {
      resolve(Buffer.alloc(0));
      return;
    }
    child.stdout.on("end", () => resolve(Buffer.concat(stdoutChunks)));
    child.stdout.on("error", reject);
  });

  const stderr = new Promise<Buffer>((resolve, reject) => {
    if (!child.stderr) {
      resolve(Buffer.alloc(0));
      return;
    }
    child.stderr.on("end", () => resolve(Buffer.concat(stderrChunks)));
    child.stderr.on("error", reject);
  });

  const exitCode = new Promise<number>((resolve, reject) => {
    // `code: number | null` — null on signal kill → coerce to -1 per contract.
    child.on("exit", (code) => resolve(code ?? -1));
    // Spawn-time failures (ENOENT, EACCES) surface here; raw Error may name
    // the binary path. Callers (resolver / boot validator) MUST wrap before
    // re-throwing — never propagate the raw `.message`.
    child.on("error", (err) => reject(err));
  });

  return {
    stdout,
    stderr,
    exitCode,
    kill: (signal?: NodeJS.Signals) => {
      child.kill(signal ?? "SIGTERM");
    },
  };
}

// ---------------------------------------------------------------------------
// v1 stub resolver — inert (no file, no decryption, no key handling)
// ---------------------------------------------------------------------------

/**
 * Create the v1 stub SecretResolver.
 *
 * `sopsPath` is accepted for forward-compat call-site shape only; the v1
 * stub is deliberately INERT — it never opens the file, never decrypts, and
 * never holds any secret material. Decryption + key handling are explicitly
 * out of scope for Task 1.9 and deferred to a later phase.
 */
export function createStubSecretResolver(sopsPath?: string): SecretResolver {
  // sopsPath intentionally unused in v1 — referenced once to keep the
  // forward-compat parameter without a lint complaint, never opened.
  void sopsPath;

  return {
    describe(ref: string): SecretMeta {
      const valid = requireRef(ref);
      // Metadata only. The stub has no backing store yet, so keys/used_by
      // are empty arrays. NO value is ever produced or referenced here.
      return SecretMetaSchema.parse({
        name: refName(valid),
        keys: [],
        used_by: [],
      });
    },

    describeSchema() {
      return SecretMetaSchema;
    },

    async resolve(
      ref: string,
      ctx: ApplyContext,
    ): Promise<SecretResolveResult> {
      // --- apply gate FIRST: refuse before doing anything else ---
      if (!isApplyContext(ctx)) {
        throw new ReconcileError(
          "fatal",
          "secret resolve refused: a valid ApplyContext is required " +
            "(resolve is unreachable from plan/dry_run paths)",
          { entity: "secret" },
        );
      }

      // --- ref still validated even behind the gate ---
      const valid = requireRef(ref);

      // --- v1: decryption DEFERRED / OUT OF SCOPE ---
      // Return a value-free deferred marker (NOT a throw): callers can tell
      // "forbidden" (gate threw) from "not yet built" (this). No secret
      // material exists or is referenced.
      return { status: "deferred", name: refName(valid) };
    },
  };
}

// ---------------------------------------------------------------------------
// SOPS-age resolver — real v1 (incremental, see Tasks 3.1 .. 3.12)
// ---------------------------------------------------------------------------

/**
 * Config for `createSopsAgeSecretResolver`. Per spec §1.2.
 */
export interface SopsAgeResolverConfig {
  /** Absolute path to the sops-encrypted YAML file. */
  readonly secretsFile: string;
  /** Absolute path to the age private key file. */
  readonly ageKeyFile: string;
  /** Per-resolve subprocess timeout in ms. Default 5000. Range [1000, 60000]. */
  readonly timeoutMs?: number;
  /** OPTIONAL — sops binary path; defaults to "sops" (PATH lookup). */
  readonly sopsBinary?: string;
  /** OPTIONAL — spawn injection seam (tests pass a fake; prod uses real wrapper). */
  readonly spawn?: SpawnFn;
}

/**
 * Create a SecretResolver that decrypts sops-encrypted secrets via the
 * canonical `sops` binary spawned per resolve(). See spec §1.5 for the
 * full data flow + §3 for leak invariants L1-L9.
 *
 * Task 3.1: gate `isApplyContext(ctx)` only. Future commits add ref
 * validation (3.2), spawn (3.3), and error handling (3.4-3.12).
 */
export function createSopsAgeSecretResolver(
  config: SopsAgeResolverConfig,
): SecretResolver {
  // Config is captured for future tasks (3.2+); referenced here to satisfy
  // the unused-param lint without altering runtime behaviour.
  void config;

  return {
    describe(ref: string): SecretMeta {
      const valid = requireRef(ref);
      return SecretMetaSchema.parse({
        name: refName(valid),
        keys: [],
        used_by: [],
      });
    },

    describeSchema() {
      return SecretMetaSchema;
    },

    async resolve(
      ref: string,
      ctx: ApplyContext,
    ): Promise<SecretResolveResult> {
      // Gate: refuse forged/missing ApplyContext IMMEDIATELY.
      // Mirrors the stub pattern above — the brand symbol is module-private,
      // so no external caller can forge a token that satisfies this check.
      if (!isApplyContext(ctx)) {
        throw new ReconcileError(
          "fatal",
          "secret resolve refused: a valid ApplyContext is required " +
            "(resolve is unreachable from plan/dry_run paths)",
          { entity: "secret" },
        );
      }

      const validated = requireRef(ref);
      const name = refName(validated);

      // The spawn seam is OPTIONAL on the config: production omits it and
      // falls back to `realSpawnWrapper` (the `node:child_process.spawn`
      // adapter declared above); tests inject a fake (`createSopsCliFake`).
      const spawn = config.spawn ?? realSpawnWrapper;

      // Argv per spec §1.5 step 5. The `--extract` arg uses a template
      // literal with the bare name interpolated verbatim — NOT JSON.stringify
      // (spec footgun S5). `SECRET_REF_RE` already restricts `name` to
      // [a-z0-9_-], so no JSON-dangerous characters can appear.
      const args: readonly string[] = [
        "-d",
        "--extract",
        `["${name}"]`,
        "--output-type",
        "binary",
        config.secretsFile,
      ];
      // Minimal, sanitised env (spec §3 leak invariants). Only what sops
      // needs — no inherited env that could leak credentials into the child.
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        SOPS_AGE_KEY_FILE: config.ageKeyFile,
      };
      // Wrap the whole spawn+race block: any non-ReconcileError (notably
      // `child.on('error')` spawn failures like ENOENT, whose `.message`
      // carries the literal binary path) is converted to the canonical
      // "secret resolve failed: <name>" — L5 defense-in-depth, no path /
      // errno / stderr ever leaks through `.message` or `.cause`.
      try {
      const child = spawn(config.sopsBinary ?? "sops", args, {
        shell: false,
        env,
      });

      // Timeout escalation per spec §1.5: SIGTERM → 200ms grace → SIGKILL.
      // SIGTERM first so sops gets a chance to scrub key material from memory.
      // The 200ms grace is HARDCODED (spec §1.5) — not configurable.
      //
      // Race semantics: a `timedOut` flag is flipped synchronously at the
      // start of the timer callback. SIGTERM signals the child (which may
      // cause exitCode/stdout to resolve early — e.g. with -1 in the fake or
      // a coerced null from realSpawnWrapper). We do NOT want that early
      // resolution to be reported as "secret resolve failed" — once the
      // timeout has fired, the canonical error is "secret resolve timeout".
      // After SIGTERM we wait 200ms then send SIGKILL, then reject. The
      // post-race code checks `timedOut` and re-throws the timeout error if
      // the race was actually decided by the timer (even when Promise.all
      // technically "won" because the fake resolved exitCode on kill).
      const timeoutMs = config.timeoutMs ?? 5000;
      let timeoutHandle: NodeJS.Timeout | undefined;
      let timedOut = false;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(async () => {
          timedOut = true;
          child.kill("SIGTERM");
          await new Promise((r) => setTimeout(r, 200));
          child.kill("SIGKILL");
          reject(
            new ReconcileError(
              "fatal",
              `secret resolve timeout: ${name}`,
              { entity: "secret" },
            ),
          );
        }, timeoutMs);
      });

      try {
        // Race the (stdout, exitCode) completion against the timeout. If the
        // child completes naturally, Promise.all wins. If the timer fires
        // first AND the child stays alive past the 200ms grace, timeoutPromise
        // rejects and SIGKILL has been dispatched.
        const [stdoutBuf, code] = await Promise.race([
          Promise.all([child.stdout, child.exitCode]),
          timeoutPromise,
        ]);
        // If the timer flipped timedOut but the child also resolved (e.g.
        // because SIGTERM caused exitCode to resolve), surface the timeout
        // error rather than masking it as a generic exit≠0 failure. Wait for
        // the timeoutPromise so the SIGKILL escalation completes before the
        // caller sees the rejection.
        if (timedOut) {
          await timeoutPromise; // always rejects with the timeout error
        }
        // L9 — Buffer cap 64KB defense against tampered/oversized sops file OOM (spec §1.5).
        // In the fake test path, stdout arrives as a single Buffer — check length after await.
        // In production, realSpawnWrapper (Task 4.1) accumulates chunks; the cap will be
        // enforced incrementally there to avoid loading >64KB into memory upfront.
        const MAX_STDOUT_BYTES = 64 * 1024;
        if (stdoutBuf.length > MAX_STDOUT_BYTES) {
          child.kill("SIGTERM"); // best-effort cleanup; child may have already exited
          throw new ReconcileError(
            "fatal",
            `secret resolve oversized: ${name}`,
            { entity: "secret" },
          );
        }
        if (code === 0) {
          // Value passed AS-IS — no trim/strip (spec footgun S5: PEMs and
          // similar payloads depend on trailing newlines being preserved).
          const value = stdoutBuf.toString("utf8");
          return { status: "ok", name, value };
        }

        // Exit ≠ 0 — fatal. stderr DISCARDED (never logged, never thrown — L5
        // defense-in-depth: even if a future sops verbose bug leaks secret
        // material to stderr, no error path here reads or propagates it).
        // Message cites only the bare ref name, which is non-sensitive by the
        // SECRET_REF_RE regex ([a-z0-9_-]+, no values).
        // child.on('error') wrap (3.8), Buffer cap (3.12) arrive in later tasks.
        throw new ReconcileError(
          "fatal",
          `secret resolve failed: ${name}`,
          { entity: "secret" },
        );
      } finally {
        // Clear the timer on the non-timeout paths so we don't leave a
        // dangling SIGTERM/SIGKILL scheduled after a successful resolve or
        // an exit≠0 fatal. Safe to call clearTimeout on an already-fired
        // timer (no-op).
        if (timeoutHandle) clearTimeout(timeoutHandle);
      }
      } catch (err) {
        // ReconcileError from our own throws (exit≠0 fatal, timeout) is
        // already in canonical form — re-throw verbatim.
        if (err instanceof ReconcileError) throw err;
        // Anything else (notably spawn-error `child.on('error')` ENOENT with
        // its raw `/usr/bin/sops` path in `.message`) MUST be wrapped — never
        // surface upstream error material to callers.
        throw new ReconcileError(
          "fatal",
          `secret resolve failed: ${name}`,
          { entity: "secret" },
        );
      }
    },
  };
}
