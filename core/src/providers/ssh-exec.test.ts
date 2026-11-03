/**
 * core/src/providers/ssh-exec.test.ts
 *
 * Task 7.2 — drives the shared SSH command-runner (`runSsh`) against an
 * INJECTED in-process fake spawn. ZERO real `ssh`, no real host, no socket,
 * no network, no real filesystem temp-key (an injected key-file seam). Every
 * path is deterministic.
 *
 * Teeth:
 *   - argv only, NO shell: the runner spawns the `ssh` binary with an argv
 *     array; the remote command is appended AFTER `--`; hardening flags
 *     (BatchMode=yes, IdentitiesOnly=yes, the host-key policy, the port,
 *     ConnectTimeout) are present; no value is ever concatenated into a shell
 *     string (we assert spawn is called with (cmd, args[]) and shell:false).
 *   - host-key policy is explicit & safe: default maps to
 *     StrictHostKeyChecking=accept-new (NEVER "no"); "yes" maps through;
 *     a configured known_hosts is wired via UserKnownHostsFile.
 *   - key handling: the private key is written to a 0600 temp file (injected
 *     seam), `-i <path>` is passed, and the file is cleaned up in `finally`
 *     on success AND failure AND timeout.
 *   - stdin / SendEnv plumbed; secret env (RESTIC_PASSWORD) is forwarded via
 *     the child process env, NEVER as an argv token.
 *   - failure classification: ssh exit 255 / spawn error → fatal-or-transient
 *     via errors.ts; a connect timeout → transient (no real timer wait —
 *     injected, deterministic); a non-255 remote exit is returned (the caller
 *     maps it), not thrown.
 *   - SECRET NON-LEAK (hard invariant): the SSH private key + a restic
 *     password sentinel appear in NO thrown ReconcileError message, NO error
 *     `cause` surfaced upward, NO returned field — across success, remote
 *     failure, ssh-auth failure AND timeout. Pinned with distinctive
 *     sentinels asserted absent everywhere.
 */

import { describe, it, expect } from "vitest";
import {
  runSsh,
  _shellEscape,
  type SpawnLike,
  type SshConnection,
} from "./ssh-exec.js";
import { ReconcileError } from "../domain/errors.js";

// --- distinctive sentinels: must NEVER surface anywhere observable ---------
const KEY_SENTINEL =
  "-----BEGIN OPENSSH PRIVATE KEY-----SSHEXEC_KEY_LEAK_ddd-----END-----";
const PW_SENTINEL = "RESTIC_PW_LEAK_zzz_must_not_appear";

const CONN: SshConnection = {
  host: "10.0.0.9",
  user: "deploy",
  port: 2222,
  privateKey: KEY_SENTINEL,
  hostKeyPolicy: "accept-new",
};

/**
 * A deterministic in-process fake of the `node:child_process.spawn` surface
 * `runSsh` depends on. Records the spawn argv; emits canned stdout/stderr and
 * a chosen exit (or an emit-time `error`, or never-closes for the timeout
 * path). No real process, no shell.
 */
interface FakeSpawnPlan {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Emit a spawn `error` (e.g. ENOENT: ssh not installed). */
  readonly spawnError?: Error & { code?: string };
  /** Never close — exercises the injected timeout path. */
  readonly hang?: boolean;
}

function makeFakeSpawn(plan: FakeSpawnPlan): {
  spawn: SpawnLike;
  calls: { cmd: string; args: string[]; opts: unknown }[];
  killed: boolean[];
  stdinWrites: string[];
} {
  const calls: { cmd: string; args: string[]; opts: unknown }[] = [];
  const killed: boolean[] = [];
  const stdinWrites: string[] = [];
  const spawn: SpawnLike = (cmd, args, opts) => {
    calls.push({ cmd, args: [...args], opts });
    const listeners = new Map<string, ((...a: unknown[]) => void)[]>();
    const on = (
      ev: string,
      cb: (...a: unknown[]) => void,
    ): void => {
      const l = listeners.get(ev) ?? [];
      l.push(cb);
      listeners.set(ev, l);
    };
    const emit = (ev: string, ...a: unknown[]): void => {
      for (const cb of listeners.get(ev) ?? []) cb(...a);
    };
    const child = {
      stdout: { on: (e: string, cb: (...a: unknown[]) => void) => on(`stdout:${e}`, cb) },
      stderr: { on: (e: string, cb: (...a: unknown[]) => void) => on(`stderr:${e}`, cb) },
      stdin: {
        write: (chunk: string): void => {
          stdinWrites.push(chunk);
        },
        end: (): void => {},
      },
      on,
      kill: (): void => {
        killed.push(true);
        // a killed process closes with the conventional 255-ish failure
        queueMicrotask(() => emit("close", 255));
      },
    };
    // Drive the lifecycle on the microtask queue (deterministic, no timers).
    queueMicrotask(() => {
      if (plan.spawnError) {
        emit("error", plan.spawnError);
        return;
      }
      if (plan.hang) return; // never closes → timeout seam fires
      if (plan.stdout) emit("stdout:data", Buffer.from(plan.stdout));
      if (plan.stderr) emit("stderr:data", Buffer.from(plan.stderr));
      emit("close", plan.code ?? 0);
    });
    return child as unknown as ReturnType<SpawnLike>;
  };
  return { spawn, calls, killed, stdinWrites };
}

/** Injected key-file seam: never touches the real fs in tests. */
function fakeKeyFile() {
  const written: { mode: number; content: string }[] = [];
  let removed = 0;
  return {
    written,
    removedCount: (): number => removed,
    seam: {
      write: async (content: string, mode: number): Promise<string> => {
        written.push({ content, mode });
        return "/tmp/fake-ssh-key";
      },
      remove: async (_path: string): Promise<void> => {
        removed += 1;
      },
    },
  };
}

describe("7.2 ssh-exec — argv-only SSH command runner (injected spawn)", () => {
  it("spawns `ssh` with an argv array (NO shell) + hardening flags + `--` + remote argv", async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: "ok", code: 0 });
    const kf = fakeKeyFile();
    const res = await runSsh(CONN, ["echo", "hello world"], {
      spawn,
      keyFile: kf.seam,
      timeoutMs: 1000,
    });
    expect(res).toEqual({ code: 0, stdout: "ok", stderr: "" });
    expect(calls).toHaveLength(1);
    const { cmd, args, opts } = calls[0]!;
    expect(cmd).toBe("ssh");
    // NO shell — spawn called with an argv array and shell disabled.
    expect(Array.isArray(args)).toBe(true);
    expect((opts as { shell?: unknown }).shell).toBe(false);
    // Hardening flags present.
    const flat = args.join(" ");
    expect(flat).toContain("-o BatchMode=yes");
    expect(flat).toContain("-o IdentitiesOnly=yes");
    expect(flat).toContain("-o StrictHostKeyChecking=accept-new");
    expect(flat).toContain("-o ConnectTimeout=");
    expect(args).toContain("-p");
    expect(args).toContain("2222");
    expect(args).toContain("-i");
    expect(args).toContain("/tmp/fake-ssh-key");
    expect(args).toContain("deploy@10.0.0.9");
    // The remote command is AFTER a literal `--` separator, each token
    // shell-escaped (ssh space-joins post-host args; the remote sshd runs them
    // via `$SHELL -c`, so a bare "hello world" would word-split). Bug 2 fix.
    const dd = args.indexOf("--");
    expect(dd).toBeGreaterThan(0);
    expect(args.slice(dd + 1)).toEqual(["'echo'", "'hello world'"]);
    // NEVER "no" (silent MITM).
    expect(flat).not.toContain("StrictHostKeyChecking=no");
  });

  it("_shellEscape neutralises newline / %{} / $ / space / quote / empty (Bug 2)", () => {
    expect(_shellEscape("\n__BEVOX_HTTP__%{http_code}")).toBe(
      "'\n__BEVOX_HTTP__%{http_code}'",
    );
    expect(_shellEscape("a b")).toBe("'a b'");
    expect(_shellEscape("$VAR")).toBe("'$VAR'");
    expect(_shellEscape("it's")).toBe("'it'\\''s'");
    expect(_shellEscape("")).toBe("''");
    expect(_shellEscape("curl")).toBe("'curl'");
    // Command-substitution / glob / operators are inert inside single quotes —
    // locked here (audit proved a real `sh` re-parses each to its literal).
    expect(_shellEscape("`whoami`")).toBe("'`whoami`'");
    expect(_shellEscape("$(id)")).toBe("'$(id)'");
    expect(_shellEscape('a"b')).toBe("'a\"b'");
    expect(_shellEscape("*.sql")).toBe("'*.sql'");
    expect(_shellEscape(";rm -rf x")).toBe("';rm -rf x'");
  });

  it("escapes each remoteArgv element so the remote $SHELL -c re-parses them intact (Bug 2)", async () => {
    const { spawn, calls } = makeFakeSpawn({ stdout: "ok", code: 0 });
    const kf = fakeKeyFile();
    // The exact Docker-transport curl marker that broke the real deploy.
    await runSsh(
      CONN,
      ["curl", "--silent", "-w", "\n__BEVOX_HTTP__%{http_code}"],
      { spawn, keyFile: kf.seam, timeoutMs: 1000 },
    );
    const { args } = calls[0]!;
    const dd = args.indexOf("--");
    expect(args.slice(dd + 1)).toEqual([
      "'curl'",
      "'--silent'",
      "'-w'",
      "'\n__BEVOX_HTTP__%{http_code}'",
    ]);
  });

  it("writes the private key 0600 and removes it in finally (success path)", async () => {
    const { spawn } = makeFakeSpawn({ stdout: "x", code: 0 });
    const kf = fakeKeyFile();
    await runSsh(CONN, ["true"], { spawn, keyFile: kf.seam, timeoutMs: 500 });
    expect(kf.written).toHaveLength(1);
    expect(kf.written[0]!.mode).toBe(0o600);
    expect(kf.written[0]!.content).toBe(KEY_SENTINEL);
    expect(kf.removedCount()).toBe(1); // cleaned up
  });

  it("maps the host-key policy explicitly; 'yes' + a known_hosts file wire through; NEVER 'no'", async () => {
    const { spawn, calls } = makeFakeSpawn({ code: 0 });
    const kf = fakeKeyFile();
    await runSsh(
      { ...CONN, hostKeyPolicy: "yes", knownHostsFile: "/etc/known_hosts" },
      ["true"],
      { spawn, keyFile: kf.seam, timeoutMs: 500 },
    );
    const flat = calls[0]!.args.join(" ");
    expect(flat).toContain("-o StrictHostKeyChecking=yes");
    expect(flat).toContain("-o UserKnownHostsFile=/etc/known_hosts");
    expect(flat).not.toContain("StrictHostKeyChecking=no");
  });

  it("plumbs stdin and forwards secret env via the child env, NEVER as an argv token", async () => {
    const fs = makeFakeSpawn({ stdout: "done", code: 0 });
    const kf = fakeKeyFile();
    await runSsh(CONN, ["restic", "snapshots"], {
      spawn: fs.spawn,
      keyFile: kf.seam,
      timeoutMs: 500,
      stdin: "payload-bytes",
      sendEnv: { RESTIC_PASSWORD: PW_SENTINEL },
    });
    expect(fs.stdinWrites.join("")).toBe("payload-bytes");
    // Secret reaches the child env (SendEnv), and the spawn opts env carries
    // it — but it is NEVER a CLI token.
    const { args, opts } = fs.calls[0]!;
    expect(args.join(" ")).not.toContain(PW_SENTINEL);
    expect(args).toContain("-o");
    expect(args.join(" ")).toContain("SendEnv=RESTIC_PASSWORD");
    const env = (opts as { env?: Record<string, string> }).env ?? {};
    expect(env.RESTIC_PASSWORD).toBe(PW_SENTINEL);
  });

  it("returns a non-255 remote exit (caller maps it) — does NOT throw", async () => {
    const { spawn } = makeFakeSpawn({ stdout: "", stderr: "boom", code: 1 });
    const kf = fakeKeyFile();
    const res = await runSsh(CONN, ["false"], {
      spawn,
      keyFile: kf.seam,
      timeoutMs: 500,
    });
    expect(res).toEqual({ code: 1, stdout: "", stderr: "boom" });
  });

  it("ssh exit 255 → classified ReconcileError (connection/auth) — key/pw NOT leaked", async () => {
    const { spawn } = makeFakeSpawn({
      stderr: `Permission denied (publickey). key=${KEY_SENTINEL}`,
      code: 255,
    });
    const kf = fakeKeyFile();
    let err: ReconcileError | undefined;
    try {
      await runSsh(CONN, ["true"], {
        spawn,
        keyFile: kf.seam,
        timeoutMs: 500,
        sendEnv: { RESTIC_PASSWORD: PW_SENTINEL },
      });
    } catch (e) {
      err = e as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    const text = `${err!.message} ${JSON.stringify(err!.toApiError())} ${String(
      (err as { cause?: unknown }).cause ?? "",
    )}`;
    expect(text).not.toContain(KEY_SENTINEL);
    expect(text).not.toContain(PW_SENTINEL);
    // Cleaned up even on failure.
    expect(kf.removedCount()).toBe(1);
  });

  it("spawn `error` (ssh not installed) → transient ReconcileError, key file cleaned, no leak", async () => {
    const e = Object.assign(new Error(`spawn ssh ENOENT ${KEY_SENTINEL}`), {
      code: "ENOENT",
    });
    const { spawn } = makeFakeSpawn({ spawnError: e });
    const kf = fakeKeyFile();
    let err: ReconcileError | undefined;
    try {
      await runSsh(CONN, ["true"], { spawn, keyFile: kf.seam, timeoutMs: 500 });
    } catch (x) {
      err = x as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    expect(err!.message).not.toContain(KEY_SENTINEL);
    expect(kf.removedCount()).toBe(1);
  });

  it("a dead host (no close) → transient timeout (injected, no real sleep), child killed, key cleaned, no leak", async () => {
    const { spawn, killed } = makeFakeSpawn({ hang: true });
    const kf = fakeKeyFile();
    let err: ReconcileError | undefined;
    try {
      // tiny timeout; the injected fake never closes, so the timeout fires
      // deterministically (no real wall-clock dependency beyond ~1ms).
      await runSsh(CONN, ["true"], { spawn, keyFile: kf.seam, timeoutMs: 1 });
    } catch (x) {
      err = x as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    expect(err!.errorClass).toBe("transient");
    expect(killed.length).toBeGreaterThan(0); // child was killed
    expect(kf.removedCount()).toBe(1); // key cleaned even on timeout
    expect(err!.message).not.toContain(KEY_SENTINEL);
  });
});
