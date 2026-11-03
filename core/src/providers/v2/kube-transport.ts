/**
 * core/src/providers/v2/kube-transport.ts
 *
 * Bloco E Task 4 — the `KubeTransport` seam (kubectl-over-SSH). OWNED BY src/,
 * not by a test fake.
 *
 * PORT-OWNERSHIP DISCIPLINE (same rule as docker-transport.ts / provider.ts
 * headers: production code must not import from `test/`). The future
 * `KubernetesProvider` (Bloco E observe/apply, Tasks 6/7/9) is written purely
 * against this seam. The contract therefore lives here, in the production tree,
 * next to its only consumer. Implementations depend INWARD on the shared
 * argv-only `runSsh` (ssh-exec.ts) via the injectable `SshRunner` seam
 * (ssh-transports.ts); every test drives the in-process `ssh-exec-recorder`
 * fake (type-compatible with the seam — the test injects it).
 *
 * THE kubectl-OVER-SSH SHAPE (why argv + stdin, not a URL):
 *
 *   The provider reaches the k3s control plane by running `kubectl` on the
 *   remote node over an SSH command channel (no kube-apiserver port forward,
 *   no public URL). Over SSH the honest seam is exactly the bytes that cross
 *   the channel: a `kubectl` argv vector (`--kubeconfig <path> <verb> …`) plus
 *   an OPTIONAL manifest body on STDIN (`kubectl apply -f -`). It mirrors
 *   DockerTransport 1:1 — "run an external command over SSH, body on stdin,
 *   argv-only, no shell". The kubeconfig defaults to the k3s server path
 *   (`/etc/rancher/k3s/k3s.yaml`); it is configurable per call-site.
 *
 * SECRET-BOUNDARY CONTRACT (mirrors docker-transport.ts; binds every
 * implementation): the manifest `stdin` may carry RESOLVED secret values
 * (resolved at apply only — secrets-resolution.md). Implementations MUST NOT
 * include the stdin body — in whole or in part — nor any arg that could carry
 * a secret in error messages, promise rejections, retry logs, or debug logs.
 * The body crosses ONLY via `opts.stdin`, NEVER as an argv token (so it never
 * lands on a `ps`-visible command line). On any failure or diagnostic path,
 * surface ONLY the (non-secret) host identifier + a SCRUBBED exit signal.
 *
 * THE RAW HOST-EXEC SHAPE (`run`, Bloco E Task 16): the host axis
 * (`EnsureK3sProvider`, Tasks 16/17) needs to run NON-kubectl host commands
 * (`k3s --version`, `systemctl is-active k3s`) over the SAME SSH command
 * channel. `run(argv, stdin?)` runs that argv VERBATIM on the remote node —
 * WITHOUT the `kubectl --kubeconfig <path>` prefix — and returns the remote
 * `{code,stdout,stderr}`. It is argv-only, no shell, exactly like `kubectl`;
 * the caller maps the command's own status / parses stdout. The SECRET-BOUNDARY
 * contract below binds `run` identically: on any failure path it surfaces ONLY
 * the (non-secret) host identifier + a SCRUBBED exit signal (the SSH key is
 * still redacted). The host commands `run` carries today take NO secret stdin,
 * so a scrubbed-stderr excerpt on failure is acceptable (mirrors `kubectl`'s
 * `!hasBody` path). `run` is READ-ONLY at the seam in the same sense as
 * `kubectl`: it executes only the argv it is given and adds no destructive
 * behaviour of its own (fail-safe.md).
 *
 * THIS SEAM ONLY RUNS THE argv IT IS GIVEN (fail-safe.md): it adds no
 * delete/destroy behaviour; destructive verbs (if any) are the caller's
 * responsibility and are gated upstream by the Approval Gate.
 *
 * Exported API:
 *   interface KubeTransport         — the seam the KubernetesProvider drives
 *   interface KubeTransportOptions  — the SshRunner + SshConnection + kubeconfig
 *   createKubeTransport(opts)        — the factory wiring runSsh
 */

import { classify, ReconcileError } from "../../domain/errors.js";
import type { SshConnection, SshResult } from "../ssh-exec.js";
import type { SshRunner } from "../ssh-transports.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default kubeconfig on a k3s server node (the operator's first-deploy path). */
const DEFAULT_KUBECONFIG = "/etc/rancher/k3s/k3s.yaml";

// ---------------------------------------------------------------------------
// Seam
// ---------------------------------------------------------------------------

/**
 * The seam the KubernetesProvider is written against. `kubectl(args, stdin?)`
 * runs `kubectl --kubeconfig <path> <args>` on the remote node over SSH and
 * returns the remote command's `{code,stdout,stderr}` (the caller maps the
 * verb's own status / parses stdout — observe/Task 6, NOT here). The OPTIONAL
 * `stdin` is the manifest body for `apply -f -`; it crosses ONLY via stdin,
 * NEVER an argv token (secret-boundary).
 */
export interface KubeTransport {
  kubectl(args: readonly string[], stdin?: string): Promise<SshResult>;
  /**
   * RAW host exec (Bloco E Task 16) — runs `args` VERBATIM on the remote node
   * over the same SSH channel, WITHOUT the `kubectl --kubeconfig <path>` prefix.
   * Returns the remote command's `{code,stdout,stderr}` (the caller maps the
   * command's own status / parses stdout — e.g. `EnsureK3sProvider.observe`).
   * The OPTIONAL `stdin` crosses ONLY via stdin, NEVER an argv token
   * (secret-boundary). Today's callers pass no secret stdin.
   */
  run(args: readonly string[], stdin?: string): Promise<SshResult>;
}

export interface KubeTransportOptions {
  /** The injectable SSH runner (default seam: ssh-exec.ts runSsh). */
  readonly run: SshRunner;
  /** Non-secret host/user/port + the (secret) key + host-key policy. */
  readonly conn: SshConnection;
  /** kubeconfig path on the remote node (default: k3s server path). */
  readonly kubeconfig?: string;
}

// ---------------------------------------------------------------------------
// Secret scrubbing — never let key/stdin material reach an error/log
// ---------------------------------------------------------------------------

/**
 * Redact known secrets from a bounded remote-output excerpt before it can
 * reach a ReconcileError. Mirrors ssh-transports.ts's scrub for the REMOTE-exit
 * path: a hostile/verbose kubectl could echo material back in stderr/stdout.
 * We redact the SSH key. Host/user/port are NOT secret and may remain.
 *
 * NOTE: the stdin manifest body is NOT redacted via substring matching here —
 * a resolved secret is a FRAGMENT of the body, and kubectl's error echoes that
 * fragment, not the verbatim multi-line manifest, so substring scrubbing can
 * NOT catch it. When a body was piped, the caller suppresses the excerpt
 * ENTIRELY (see `kubectl` below) rather than risk a partial leak.
 */
function scrub(raw: string, secrets: readonly string[]): string {
  let s = raw.slice(0, 400); // bounded excerpt (no unbounded echo)
  for (const sec of secrets) {
    if (sec.length > 0 && s.includes(sec)) s = s.split(sec).join("[redacted]");
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a `KubeTransport` over the injected `SshRunner` + `SshConnection`.
 * Assembles `["kubectl", "--kubeconfig", <path>, ...args]` argv-only (no
 * shell, no interpolation) and pipes the manifest via `opts.stdin`. Throws a
 * SECRET-FREE `ReconcileError` for a non-zero kubectl exit / a non-ReconcileError
 * runner failure; an ssh-level `ReconcileError` from the runner (already
 * scrubbed by ssh-exec.ts) propagates verbatim.
 */
export function createKubeTransport(opts: KubeTransportOptions): KubeTransport {
  const { run, conn } = opts;
  const kubeconfig = opts.kubeconfig ?? DEFAULT_KUBECONFIG;
  const entity = `service:${conn.host}`;
  // The only reliably-scrubbable secret substring is the SSH key (a verbatim,
  // searchable string). The stdin manifest body is NOT added here: a resolved
  // secret is only a FRAGMENT of it, which substring scrubbing can't catch, so
  // when a body is piped its excerpt is SUPPRESSED entirely (see the `hasBody`
  // path below) rather than scrubbed.
  const baseSecrets = [conn.privateKey];

  return {
    async kubectl(args: readonly string[], stdin?: string): Promise<SshResult> {
      // argv-only: the kubeconfig path + every verb/flag is a literal token,
      // never shell-interpolated. The manifest body (may carry resolved
      // secrets) → stdin, NEVER argv (kube-transport.ts secret-boundary).
      const argv = ["kubectl", "--kubeconfig", kubeconfig, ...args];
      // When a manifest body was piped, a resolved secret is a FRAGMENT of it;
      // kubectl can echo that fragment in stderr, and substring scrubbing can
      // NOT reliably catch a fragment. So if there is a body, we suppress the
      // remote-output excerpt ENTIRELY on failure (host + exit code only). With
      // no body, no secret can be present, so a scrubbed excerpt is safe.
      const hasBody = stdin !== undefined;

      let res: SshResult;
      try {
        res = await run(conn, argv, {
          ...(stdin !== undefined ? { stdin } : {}),
        });
      } catch (e) {
        if (e instanceof ReconcileError) throw e; // already scrubbed
        // Non-ReconcileError from the runner seam — classify transient. NEVER
        // echo the raw error (it could embed the stdin body / a secret).
        throw new ReconcileError(
          classify({ kind: "network-error" }),
          `Kube transport: ssh exec failed for ${conn.host}`,
          { entity },
        );
      }

      if (res.code !== 0) {
        // A non-zero kubectl exit is a remote APPLICATION/exec failure (e.g.
        // exit 1 from an invalid manifest) — NOT a network error. Mirroring
        // ssh-exec.ts (which returns a non-255 remote exit as the remote
        // command's own status, never as an ssh-level network failure), we
        // classify it `fatal`: a permanent application/config failure that
        // retry will not fix. The class is KNOWN here, so we pass the literal
        // rather than rely on classify({})'s implicit default. Misclassifying
        // it as transient network would mistrigger retry / circuit-breaker
        // logic downstream. Surface ONLY host + a SCRUBBED stderr signal —
        // NEVER the manifest body or any secret. If a body was piped, suppress
        // the excerpt entirely (see hasBody).
        const excerpt = hasBody ? "" : scrub(res.stderr || res.stdout, baseSecrets);
        throw new ReconcileError(
          "fatal",
          `Kube transport: \`kubectl\` failed (exit ${res.code}) on ` +
            `${conn.host}${excerpt ? `: ${excerpt}` : ""}`,
          { entity },
        );
      }
      return res;
    },

    async run(args: readonly string[], stdin?: string): Promise<SshResult> {
      // RAW host exec — the argv crosses VERBATIM (no kubectl/kubeconfig
      // prefix). argv-only: every token is literal, never shell-interpolated.
      // An OPTIONAL body → stdin, NEVER argv (secret-boundary). Today's host
      // commands (`k3s --version`, `systemctl is-active k3s`) pass no body.
      const argv = [...args];
      // No secret stdin crosses here today; even if a body were piped, a
      // resolved secret is a FRAGMENT that substring scrubbing can't catch, so
      // suppress the excerpt entirely when a body is present (mirrors kubectl).
      const hasBody = stdin !== undefined;

      let res: SshResult;
      try {
        res = await run(conn, argv, {
          ...(stdin !== undefined ? { stdin } : {}),
        });
      } catch (e) {
        if (e instanceof ReconcileError) throw e; // already scrubbed
        // Non-ReconcileError from the runner seam — classify transient. NEVER
        // echo the raw error (it could embed any piped stdin).
        throw new ReconcileError(
          classify({ kind: "network-error" }),
          `Kube transport: ssh exec failed for ${conn.host}`,
          { entity },
        );
      }

      if (res.code !== 0) {
        // A non-zero remote exit is the host command's OWN status (e.g.
        // `k3s --version` exits non-zero when k3s is absent). The CALLER maps
        // that status (observe → installed:false); we DO NOT throw on a
        // non-zero exit here — we return the result faithfully so the caller
        // can interpret it. The KubeTransport `run` seam never invents a
        // failure from a command's own non-zero exit (fail-safe: read-only,
        // no destructive behaviour). SSH-level failures (255) still arrive as
        // a pre-scrubbed ReconcileError from the runner and propagate above.
        return res;
      }
      return res;
    },
  };
}
