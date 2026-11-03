/**
 * core/src/providers/ssh-exec.ts
 *
 * Task 7.2 — the minimal SHARED SSH command-runner the three real transports
 * (Docker / WireGuard / restic) drive. It spawns the SYSTEM `ssh` client via
 * `node:child_process` in ARGV form and returns the remote command's
 * {code,stdout,stderr}. ZERO new npm dependency (Task-0 discipline: native
 * primitives only; minimal CVE surface in a security-sensitive control plane —
 * no `ssh2`, no shell library).
 *
 * SECURITY MODEL (spec 1.9 / 3.3 / 6.3 — non-negotiable):
 *
 *   - NO SHELL, ARGV ONLY. We call `spawn("ssh", [...argv], {shell:false})`.
 *     The remote command is appended AFTER a literal `--` as a plain argv
 *     vector — it is NEVER interpolated into a shell string, so there is no
 *     command-injection surface from a host/path/peer value.
 *
 *   - INJECTABLE SPAWN. `runSsh` takes a `spawn` seam (default the real
 *     `node:child_process.spawn`); every test drives an in-process fake — no
 *     real `ssh`, host, socket, network or wall-clock dependency.
 *
 *   - KEY HANDLING. The configured SSH private key is written to a 0600 temp
 *     file (an injectable key-file seam; the default uses `fs.mkdtemp` +
 *     `writeFile(mode:0o600)`), passed via `-i`, and DELETED in a `finally`
 *     on EVERY exit path (success / remote failure / ssh-auth failure /
 *     timeout). The key bytes are never logged and never in argv.
 *
 *   - HOST-KEY TRUST, NO MITM HOLE. `StrictHostKeyChecking` is ALWAYS
 *     explicit and is NEVER "no". The caller passes a policy of "accept-new"
 *     (TOFU: accept a new key on first contact, refuse a CHANGED one) or
 *     "yes" (require it pre-known). An optional known_hosts file is wired via
 *     `-o UserKnownHostsFile=`. `-o BatchMode=yes` and `-o IdentitiesOnly=yes`
 *     prevent prompts/agent ambiguity (no hangs, deterministic auth).
 *
 *   - SECRET NON-LEAK (HARD INVARIANT). The SSH key, any `sendEnv` value
 *     (e.g. RESTIC_PASSWORD) and any caller payload appear in NO thrown
 *     `ReconcileError` message, NO surfaced `cause`, NO returned field. On an
 *     ssh-level failure we surface ONLY host (non-secret), exit code and a
 *     SCRUBBED stderr excerpt (secret substrings redacted). `sendEnv` values
 *     are forwarded ONLY through the child process env (OpenSSH `SendEnv`),
 *     never as an argv token.
 *
 *   - CONNECT TIMEOUT. `-o ConnectTimeout=` plus an injectable kill-after
 *     watchdog bound the runner: a dead host fails `transient` (network
 *     class) rather than hanging. Tests inject a 1ms timeout against a
 *     never-closing fake — deterministic, no real sleep.
 *
 * FAILURE CLASSIFICATION (domain/errors.ts `classify`):
 *   - timeout / spawn `error` (ENOENT etc.) / transient ssh blip → transient.
 *   - ssh exit 255 (connection refused / auth / host-key) → classified from
 *     a scrubbed stderr signal; auth/host-key → fatal, refused/reset →
 *     transient. A NON-255 remote exit is RETURNED (the transport maps the
 *     remote tool's own status), never thrown here.
 *
 * REAL-HOST BOUNDARY (honest): this environment has no real Hetzner host or
 * creds. The tests prove argv assembly, key/host-key handling, parsing,
 * classification and secret non-leak against the INJECTED fake. Real-host
 * behaviour (the `@live` boundary) is the operator's first-deploy step.
 *
 * Exported API (minimal):
 *   type SpawnLike            — the narrow child_process.spawn seam
 *   interface SshConnection   — non-secret host/user/port + key + policy
 *   interface KeyFileSeam     — injectable 0600 temp-key write/remove
 *   interface RunSshOptions   — per-call argv/stdin/env/timeout + seams
 *   interface SshResult       — { code, stdout, stderr } of the remote cmd
 *   runSsh(conn, remoteArgv, opts) → Promise<SshResult>
 */

import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { classify, ReconcileError } from "../domain/errors.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** A spawned child as `runSsh` minimally uses it (subset of ChildProcess). */
export interface ChildLike {
  readonly stdout: { on(ev: "data", cb: (c: unknown) => void): void };
  readonly stderr: { on(ev: "data", cb: (c: unknown) => void): void };
  readonly stdin: {
    write(chunk: string): void;
    end(): void;
  };
  on(ev: "error", cb: (e: unknown) => void): void;
  on(ev: "close", cb: (code: number | null) => void): void;
  kill(): void;
}

/**
 * The narrow `node:child_process.spawn` surface. Default = the real spawn;
 * tests inject an in-process fake. `shell` is ALWAYS false (argv-only).
 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { shell: false; env: Record<string, string> },
) => ChildLike;

/** Injectable 0600 temp-key seam (default = real fs; tests inject a fake). */
export interface KeyFileSeam {
  /** Write `content` to a fresh 0600 file; return its path. */
  write(content: string, mode: number): Promise<string>;
  /** Best-effort remove (never throws fatally; cleanup is finally-only). */
  remove(path: string): Promise<void>;
}

/** Non-secret connection params + the (secret) key + the host-key policy. */
export interface SshConnection {
  /** Remote host (non-secret — may appear in errors). */
  readonly host: string;
  /** Remote SSH user (non-secret). */
  readonly user: string;
  /** Remote SSH port. */
  readonly port: number;
  /** SSH private key PEM. SECRET — written to a 0600 file, never logged. */
  readonly privateKey: string;
  /** Host-key trust policy. NEVER "no" (silent MITM is not an option). */
  readonly hostKeyPolicy: "accept-new" | "yes";
  /** Optional explicit known_hosts path (-o UserKnownHostsFile=). */
  readonly knownHostsFile?: string;
}

export interface RunSshOptions {
  /** spawn seam (default: node:child_process.spawn). */
  readonly spawn?: SpawnLike;
  /** 0600 temp-key seam (default: real fs). */
  readonly keyFile?: KeyFileSeam;
  /** Bytes to write to the remote command's stdin (then EOF). */
  readonly stdin?: string;
  /**
   * Env vars forwarded to the REMOTE command via OpenSSH `SendEnv`. The
   * value is placed in the child process env ONLY — never an argv token
   * (secret-safe). The remote sshd must `AcceptEnv` these names.
   */
  readonly sendEnv?: Readonly<Record<string, string>>;
  /** Overall deadline (ms) — a dead host fails transient, never hangs. */
  readonly timeoutMs?: number;
}

/** The remote command's outcome (NOT the ssh wrapper's). */
export interface SshResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
/** ssh's own connect deadline (s) — kept just under the wrapper timeout. */
function connectTimeoutSecs(timeoutMs: number): number {
  return Math.max(1, Math.floor(timeoutMs / 1000) || 1);
}

/** Real fs-backed 0600 key file (production default). */
const realKeyFile: KeyFileSeam = {
  async write(content, mode) {
    const dir = await mkdtemp(join(tmpdir(), "bevox-ssh-"));
    const path = join(dir, "id");
    await writeFile(path, content, { mode });
    return path;
  },
  async remove(path) {
    // Best-effort: a cleanup failure must never flip a result or leak a path.
    try {
      // Remove the parent mkdtemp dir (id file lives inside it).
      await rm(path, { force: true });
      await rm(join(path, ".."), { recursive: true, force: true });
    } catch {
      /* swallow — cleanup is finally-only, never fatal */
    }
  },
};

// ---------------------------------------------------------------------------
// Secret scrubbing — never let key/env material reach an error/log
// ---------------------------------------------------------------------------

/**
 * Redact every known secret substring from an stderr excerpt before it can
 * cross into a ReconcileError. We redact the SSH key and every `sendEnv`
 * value (a misbehaving remote could echo them). Host/user/port are NOT
 * secret and may remain.
 */
function scrub(
  raw: string,
  secrets: readonly string[],
): string {
  let s = raw.slice(0, 600); // bounded excerpt (no unbounded echo)
  for (const sec of secrets) {
    if (sec.length > 0 && s.includes(sec)) {
      s = s.split(sec).join("[redacted]");
    }
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// argv assembly — explicit, hardened, argv-only (NO shell, NO interpolation)
// ---------------------------------------------------------------------------

function buildSshArgs(
  conn: SshConnection,
  keyPath: string,
  remoteArgv: readonly string[],
  timeoutMs: number,
  sendEnvNames: readonly string[],
): string[] {
  const args: string[] = [
    "-p",
    String(conn.port),
    "-i",
    keyPath,
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    `StrictHostKeyChecking=${conn.hostKeyPolicy}`,
    "-o",
    `ConnectTimeout=${connectTimeoutSecs(timeoutMs)}`,
  ];
  if (conn.knownHostsFile) {
    args.push("-o", `UserKnownHostsFile=${conn.knownHostsFile}`);
  }
  for (const name of sendEnvNames) {
    // SendEnv passes the NAME; the VALUE travels in the child env only.
    args.push("-o", `SendEnv=${name}`);
  }
  args.push(`${conn.user}@${conn.host}`);
  // The system `ssh` client SPACE-JOINS the post-host args into one string and
  // the remote `sshd` runs it via `$SHELL -c` — it is NOT a literal argv vector.
  // So each token MUST be shell-escaped, or a newline / space / `$` / `%{}` /
  // quote re-parses on the remote shell and corrupts the command (Bug 2: the
  // curl `-w "\n__BEVOX_HTTP__%{http_code}"` marker split across a newline).
  // Single-quote escaping makes the remote shell re-parse each token verbatim.
  args.push("--", ...remoteArgv.map(_shellEscape));
  return args;
}

/**
 * POSIX single-quote escaping for one remote-shell token. Wraps in `'…'` and
 * renders any embedded single-quote as `'\''` (close, escaped-quote, reopen).
 * Neutralises EVERY shell metacharacter — newline, space, `$`, `` ` ``, `%{}`,
 * `"`, `'` — so the remote `$SHELL -c` re-parses the token to its exact value.
 *
 * Exported test-only (`_` prefix, esm-nodenext Rule 8); production reaches it
 * solely through `buildSshArgs`.
 */
export function _shellEscape(token: string): string {
  return "'" + token.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// runSsh
// ---------------------------------------------------------------------------

/**
 * Run `remoteArgv` on `conn` over the system `ssh` client (argv-only, no
 * shell). Returns the REMOTE command's {code,stdout,stderr}. Throws a
 * classified, SECRET-FREE `ReconcileError` for an ssh-level failure (exit
 * 255 / spawn error / timeout); a non-255 remote exit is returned so the
 * transport maps the remote tool's own status faithfully.
 */
export async function runSsh(
  conn: SshConnection,
  remoteArgv: readonly string[],
  opts: RunSshOptions = {},
): Promise<SshResult> {
  const spawnFn = (opts.spawn ?? (nodeSpawn as unknown as SpawnLike));
  const keyFile = opts.keyFile ?? realKeyFile;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sendEnv = opts.sendEnv ?? {};
  const sendEnvNames = Object.keys(sendEnv);
  // Every secret that could conceivably echo back: the key + all sent values.
  const secrets = [conn.privateKey, ...Object.values(sendEnv)];

  // 0600 temp key — created BEFORE spawn, removed in finally on EVERY path.
  const keyPath = await keyFile.write(conn.privateKey, 0o600);

  try {
    const args = buildSshArgs(
      conn,
      keyPath,
      remoteArgv,
      timeoutMs,
      sendEnvNames,
    );
    // Child env: inherit nothing secret implicitly — start from process.env
    // for PATH/locale and overlay ONLY the explicit SendEnv values.
    const childEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) childEnv[k] = v;
    }
    for (const [k, v] of Object.entries(sendEnv)) childEnv[k] = v;

    return await new Promise<SshResult>((resolve, reject) => {
      let child: ChildLike;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const out: string[] = [];
      const errOut: string[] = [];

      const fail = (e: ReconcileError): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        reject(e);
      };
      const done = (r: SshResult): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(r);
      };

      try {
        child = spawnFn("ssh", args, { shell: false, env: childEnv });
      } catch (e) {
        // Synchronous spawn throw (rare) — transient, secret-free.
        fail(
          new ReconcileError(
            classify({ kind: "network-error" }),
            `ssh: failed to start the ssh client for ${conn.host}`,
            { entity: `ssh:${conn.host}` },
          ),
        );
        void e;
        return;
      }

      // Watchdog: a dead host must fail transient, not hang.
      timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        fail(
          new ReconcileError(
            classify({ code: "etimedout" }),
            `ssh: timed out after ${timeoutMs}ms connecting/executing on ` +
              `${conn.host}`,
            { entity: `ssh:${conn.host}`, retryAfterMs: 1000 },
          ),
        );
      }, timeoutMs);
      // Do not keep the event loop alive solely for the watchdog.
      (timer as { unref?: () => void }).unref?.();

      child.stdout.on("data", (c) => out.push(String(c)));
      child.stderr.on("data", (c) => errOut.push(String(c)));

      child.on("error", (e) => {
        // e.g. ENOENT: `ssh` not installed. Transient (operator-fixable);
        // the raw error (which may embed args) is NOT surfaced.
        const code =
          e && typeof e === "object" && "code" in e
            ? String((e as { code: unknown }).code)
            : undefined;
        fail(
          new ReconcileError(
            classify({ code, kind: "network-error" }),
            `ssh: could not execute the ssh client for ${conn.host}` +
              (code ? ` (${scrub(code, secrets)})` : ""),
            { entity: `ssh:${conn.host}` },
          ),
        );
      });

      child.on("close", (code) => {
        const stdout = out.join("");
        const stderr = errOut.join("");
        const exit = code ?? -1;
        if (exit === 255) {
          // ssh-WRAPPER failure (connection refused / auth / host-key).
          // Classify from a SCRUBBED stderr signal — never the raw text.
          const safe = scrub(stderr, secrets);
          const low = safe.toLowerCase();
          const authish =
            low.includes("permission denied") ||
            low.includes("host key") ||
            low.includes("authenticity") ||
            low.includes("publickey");
          fail(
            new ReconcileError(
              authish
                ? "fatal"
                : classify({ code: "econnrefused", kind: "network-error" }),
              `ssh: connection to ${conn.host} failed (exit 255)` +
                (safe ? `: ${safe}` : ""),
              { entity: `ssh:${conn.host}` },
            ),
          );
          return;
        }
        // A non-255 exit is the REMOTE command's own status — return it; the
        // transport maps the remote tool's result faithfully.
        done({ code: exit, stdout, stderr });
      });

      // stdin (if any) then EOF.
      if (opts.stdin !== undefined) {
        try {
          child.stdin.write(opts.stdin);
        } catch {
          /* a broken pipe surfaces via close/error below */
        }
      }
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
    });
  } finally {
    // ALWAYS remove the 0600 key — success, remote failure, ssh failure,
    // timeout. Best-effort; a cleanup error never flips/leaks a result.
    await keyFile.remove(keyPath);
  }
}
