/**
 * core/src/providers/ssh-transports.ts
 *
 * Task 7.2 — the THREE REAL SSH-backed transports + the
 * `createSshTransports(config)` factory wired into the daemon as the
 * `EntrypointTransports` (7.1's seam, UNCHANGED). Each transport implements
 * its EXACT existing seam interface so the already-tested providers
 * (docker.ts / wireguard.ts / backup-restic.ts) work against it verbatim.
 * Every remote op runs through the shared argv-only `runSsh` (ssh-exec.ts) —
 * spawning the system `ssh` client, ZERO new npm dependency.
 *
 * REMOTE PREREQUISITES (the operator's first-deploy responsibility):
 *   - Docker: the remote host has `curl` and the SSH user can read
 *     `/var/run/docker.sock` (the no-local-forwarding Engine API path).
 *   - WireGuard: the remote host has `wg` and the SSH user may run it on the
 *     mesh interface (sudo wiring is the operator's host hardening; not ours).
 *   - restic: the remote host has the `restic` binary on PATH and AcceptEnv
 *     includes `RESTIC_PASSWORD` (so SendEnv delivers it secret-safely).
 *
 * SECRET / KEY NON-LEAK (spec 1.9/3.3/6.3 — HARD invariant): the SSH key and
 * RESTIC_PASSWORD never appear in any argv, error message, surfaced `cause`
 * or returned value. RESTIC_PASSWORD crosses to the remote ONLY via OpenSSH
 * `SendEnv` (the child env), NEVER an argv flag; `-r` carries the (non-secret)
 * repo. ssh-exec.ts already scrubs key/env material from any ssh-level error;
 * these transports add their own scrub for a non-zero REMOTE exit (a hostile
 * remote could echo a secret in stdout/stderr).
 *
 * NON-DESTRUCTIVE DISCIPLINE: the WireGuard transport's `removePeer` exists
 * because the seam declares it (a future reconciler prune — Task 2.9); the
 * wireguard PROVIDER never calls it. The restic transport has NO forget/prune
 * by construction; `restore` is the only destructive op and only the provider
 * (gated upstream by 4.3/4.4) ever calls it. The Docker transport only ever
 * issues exactly the Engine call the provider asked for.
 *
 * REAL-HOST BOUNDARY (honest — there are no real Hetzner hosts/creds here):
 * the tests prove SEAM CONFORMANCE against an injected fake `runSsh` (correct
 * argv, faithful parsing of representative curl/wg/restic output, error +
 * timeout classification, secret non-leak). Real-host validation (curl/wg/
 * restic actually present & permitted, sshd AcceptEnv, host-key TOFU) is the
 * operator's first-deploy `@live` step — it cannot be exercised in this
 * environment and is intentionally out of the deterministic suite.
 *
 * Exported API (minimal):
 *   type SshRunner               — the injectable runSsh seam (tests fake it)
 *   interface SshTransportsOptions
 *   createSshTransports(config, opts?) → EntrypointTransports
 */

import type { Config } from "../config.js";
import { classify, ReconcileError } from "../domain/errors.js";
import type { EntrypointTransports } from "../entrypoint-wiring.js";
import {
  runSsh as defaultRunSsh,
  type RunSshOptions,
  type SshConnection,
  type SshResult,
} from "./ssh-exec.js";
import type {
  DockerResponse,
  DockerTransport,
} from "./docker-transport.js";
import type {
  ResticSnapshot,
  ResticTransport,
} from "./backup-restic-transport.js";
import type {
  WgPeer,
  WireGuardController,
} from "./wireguard-transport.js";
import {
  createKubeTransport,
  type KubeTransport,
} from "./v2/kube-transport.js";

// ---------------------------------------------------------------------------
// Seams / options
// ---------------------------------------------------------------------------

/** The `runSsh` seam (default: ssh-exec.ts). Tests inject a scripted fake. */
export type SshRunner = (
  conn: SshConnection,
  remoteArgv: readonly string[],
  opts?: RunSshOptions,
) => Promise<SshResult>;

export interface SshTransportsOptions {
  /** Override the SSH runner (default: the real argv-only ssh-exec runSsh). */
  readonly run?: SshRunner;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Remote Docker Engine unix socket (the no-port-forwarding access path). */
const DOCKER_SOCK = "/var/run/docker.sock";
/** curl `-w` marker: appended AFTER the body so we can split off the status. */
const HTTP_MARKER = "__BEVOX_HTTP__";
/** The mesh interface `wg` operates on (Bevox's single private mesh). */
const WG_IFACE = "wg0";
/** restic restore lands here on the remote (operator-mountable scratch). */
const RESTORE_TARGET = "/var/lib/bevox/restore";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Build the non-secret connection record from validated Config. */
function connOf(config: Config): SshConnection {
  return {
    host: config.SSH_HOST,
    user: config.SSH_USER,
    port: config.SSH_PORT,
    privateKey: config.SSH_PRIVATE_KEY,
    hostKeyPolicy: config.SSH_HOST_KEY_POLICY,
    ...(config.SSH_KNOWN_HOSTS
      ? { knownHostsFile: config.SSH_KNOWN_HOSTS }
      : {}),
  };
}

/**
 * Redact known secrets from a bounded remote-output excerpt before it can
 * reach a ReconcileError. Mirrors ssh-exec.ts's scrub for the REMOTE-exit
 * path (a hostile/buggy remote could echo the password/key in stdout/stderr).
 */
function scrub(raw: string, secrets: readonly string[]): string {
  let s = raw.slice(0, 400);
  for (const sec of secrets) {
    if (sec.length > 0 && s.includes(sec)) s = s.split(sec).join("[redacted]");
  }
  return s.trim();
}

// ---------------------------------------------------------------------------
// Docker — Engine API over `curl --unix-socket` on the remote (no shell)
// ---------------------------------------------------------------------------

function makeDocker(
  config: Config,
  run: SshRunner,
): DockerTransport {
  const conn = connOf(config);
  const secrets = [config.SSH_PRIVATE_KEY];

  return {
    async request(
      method: string,
      path: string,
      body?: unknown,
      headers?: Readonly<Record<string, string>>,
    ): Promise<DockerResponse> {
      const hasBody = body !== undefined;
      const hasHeaders = headers !== undefined && Object.keys(headers).length > 0;
      // Bug 11 secret-boundary guard: a sensitive header rides on STDIN via
      // `curl --config -`, and a body rides on STDIN via `--data-binary @-` —
      // both claim stdin. No v1 caller needs both (`/images/create` is
      // header-only, `/containers/create` is body-only); forbid the combo so a
      // future caller can never be forced to put the secret onto argv.
      if (hasBody && hasHeaders) {
        throw new ReconcileError(
          "precondition",
          "Docker transport: body+sensitive-header combination is unsupported",
          { entity: `service:${conn.host}` },
        );
      }
      const payload = hasBody ? JSON.stringify(body) : undefined;
      // argv-only curl: status appended after the body via `-w` so we can
      // split it back out. The Engine path is a literal argv token (no shell,
      // no interpolation). Body (may carry resolved secrets) → stdin, NEVER
      // argv (docker-transport.ts secret-boundary contract).
      const argv = [
        "curl",
        "--silent",
        "--show-error",
        "--unix-socket",
        DOCKER_SOCK,
        "-X",
        method.toUpperCase(),
        "-w",
        `\n${HTTP_MARKER}%{http_code}`,
      ];
      if (hasBody) {
        argv.push(
          "-H",
          "Content-Type: application/json",
          "--data-binary",
          "@-",
        );
      }
      // Bug 11: sensitive headers (e.g. X-Registry-Auth) travel on STDIN as a
      // `curl --config -` file — one `header = "K: V"` line each — so the
      // value NEVER lands on an argv token (`ps aux`). Safe because this path
      // is header-only (no body ⇒ stdin is free).
      let stdin = payload;
      if (hasHeaders) {
        argv.push("--config", "-");
        stdin = Object.entries(headers)
          .map(([k, v]) => `header = "${k}: ${v}"`)
          .join("\n");
      }
      argv.push(`http://localhost${path}`);

      // DEFENSE-IN-DEPTH: the header value is secret-equivalent (base64 ≠
      // encryption) — add it to the per-call scrub set so any accidental
      // stderr echo is redacted, alongside the SSH key.
      const callSecrets = hasHeaders
        ? [...secrets, ...Object.values(headers)]
        : secrets;

      let res: SshResult;
      try {
        res = await run(conn, argv, {
          ...(stdin !== undefined ? { stdin } : {}),
        });
      } catch (e) {
        if (e instanceof ReconcileError) throw e; // already scrubbed
        // Non-ReconcileError from the runner seam — classify transient.
        throw new ReconcileError(
          classify({ kind: "network-error" }),
          `Docker transport: ssh exec failed for ${conn.host}`,
          { entity: `service:${conn.host}` },
        );
      }

      // curl exit ≠ 0 (and not an HTTP status we captured): a transport-level
      // failure — classify transient, NEVER echo the body or any secret.
      const text = res.stdout;
      const mi = text.lastIndexOf(HTTP_MARKER);
      if (res.code !== 0 && mi < 0) {
        throw new ReconcileError(
          classify({ code: "econnrefused", kind: "network-error" }),
          `Docker transport: remote curl failed (exit ${res.code}) on ` +
            `${conn.host}: ${scrub(res.stderr, callSecrets)}`,
          { entity: `service:${conn.host}` },
        );
      }
      if (mi < 0) {
        // No status marker — malformed transport output (precondition).
        throw new ReconcileError(
          "precondition",
          `Docker transport: malformed Engine response from ${conn.host}`,
          { entity: `service:${conn.host}` },
        );
      }
      const status = Number(text.slice(mi + HTTP_MARKER.length).trim());
      // Body is everything before the marker (trailing newline we added).
      let bodyText = text.slice(0, mi);
      if (bodyText.endsWith("\n")) bodyText = bodyText.slice(0, -1);
      let json: unknown = null;
      const trimmed = bodyText.trim();
      if (trimmed.length > 0) {
        try {
          json = JSON.parse(trimmed);
        } catch {
          // NDJSON stream (e.g. POST /images/create returns one JSON object per
          // line). Parse line-by-line into an ARRAY so the provider can inspect
          // per-line `{"status"}` / `{"error"}` (the Engine reports pull errors
          // in-stream at HTTP 200). Falls back to a structured envelope if the
          // body is neither a single JSON value nor clean NDJSON — NEVER the
          // raw body verbatim (could carry resolved secrets on create).
          const lines = trimmed
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l.length > 0);
          const parsed: unknown[] = [];
          let ndjsonOk = lines.length > 0;
          for (const line of lines) {
            try {
              parsed.push(JSON.parse(line));
            } catch {
              ndjsonOk = false;
              break;
            }
          }
          json = ndjsonOk
            ? parsed
            : { message: `non-JSON Engine response (status ${status})` };
        }
      }
      return { status, json };
    },
  };
}

// ---------------------------------------------------------------------------
// WireGuard — `wg show <if> dump` / `wg set <if> peer …` over ssh (no shell)
// ---------------------------------------------------------------------------

/**
 * Parse `wg show <if> dump`. The FIRST line is the INTERFACE row
 * (`<privkey>\t<pubkey>\t<listen-port>\t<fwmark>`) — it carries the device
 * PRIVATE key and is DROPPED ENTIRELY (never parsed, never surfaced). Each
 * subsequent line is a peer:
 *   <pubkey> <psk> <endpoint> <allowed-ips> <handshake> <rx> <tx> <keepalive>
 * Volatile fields (handshake/rx/tx) are intentionally NOT modelled (the
 * WgPeer seam omits them — comparing them would flap convergence). A real
 * `wg` device has NO tag channel, so `tags` is correctly absent here
 * (WgPeer.tags is optional). This is NOT a fidelity gap: wireguard.ts's
 * managed-set and convergence are DESIRED-DERIVED — a managed peer is
 * identified by its PUBLIC KEY being in the deterministic `derivePeer`
 * (`wgpub:<name>`) namespace, NOT by reading a tag back. So a tagless peer
 * parsed here that matches the derived public key + allowed IPs + endpoint
 * IS converged (no flap), and observe() recovers the managed entity from the
 * public key — correct real-host behaviour, not a documented flap.
 */
function parseWgDump(stdout: string): WgPeer[] {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  const peers: WgPeer[] = [];
  for (let i = 1; i < lines.length; i++) {
    // skip line 0 (interface/private key)
    const cols = lines[i]!.split("\t");
    if (cols.length < 4) continue;
    const publicKey = cols[0]!.trim();
    const endpoint = cols[2]!.trim();
    const allowed = cols[3]!.trim();
    const allowedIps =
      allowed === "(none)" || allowed === ""
        ? []
        : allowed.split(",").map((a) => a.trim());
    const peer: WgPeer = {
      publicKey,
      allowedIps,
      ...(endpoint !== "(none)" && endpoint !== ""
        ? { endpoint }
        : {}),
    };
    peers.push(peer);
  }
  return peers;
}

function makeWireGuard(
  config: Config,
  run: SshRunner,
): WireGuardController {
  const conn = connOf(config);
  const secrets = [config.SSH_PRIVATE_KEY];

  async function wg(
    args: readonly string[],
    entity: string,
  ): Promise<SshResult> {
    let res: SshResult;
    try {
      res = await run(conn, ["wg", ...args]);
    } catch (e) {
      if (e instanceof ReconcileError) throw e;
      throw new ReconcileError(
        classify({ kind: "network-error" }),
        `WireGuard transport: ssh exec failed for ${conn.host}`,
        { entity },
      );
    }
    if (res.code !== 0) {
      throw new ReconcileError(
        classify({ code: "econnrefused", kind: "network-error" }),
        `WireGuard transport: \`wg\` failed (exit ${res.code}) on ` +
          `${conn.host}: ${scrub(res.stderr, secrets)}`,
        { entity },
      );
    }
    return res;
  }

  return {
    async listPeers(): Promise<readonly WgPeer[]> {
      const res = await wg(["show", WG_IFACE, "dump"], "server");
      return parseWgDump(res.stdout);
    },
    async setPeer(peer: WgPeer): Promise<void> {
      // Upsert (matches `wg set peer …`). argv-only — every value a literal
      // token, never shell-interpolated. NO private key crosses the seam
      // (wireguard-transport.ts contract); only the public key is sent.
      const args = [
        "set",
        WG_IFACE,
        "peer",
        peer.publicKey,
        "allowed-ips",
        peer.allowedIps.join(","),
      ];
      if (peer.endpoint) args.push("endpoint", peer.endpoint);
      await wg(args, `server:${peer.publicKey}`);
    },
    async removePeer(publicKey: string): Promise<void> {
      // SEAM-PRESENT ONLY (future reconciler prune, Task 2.9). The wireguard
      // PROVIDER never calls this (fail-safe, never fail-deleting).
      await wg(
        ["set", WG_IFACE, "peer", publicKey, "remove"],
        `server:${publicKey}`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// restic — `restic --json …` over ssh; password via SendEnv (NEVER argv)
// ---------------------------------------------------------------------------

interface ResticJsonSnapshot {
  readonly id?: string;
  readonly short_id?: string;
  readonly time?: string;
  readonly tags?: readonly string[];
  readonly summary?: { readonly total_bytes?: number };
}

function toSnapshot(s: ResticJsonSnapshot): ResticSnapshot {
  const id = s.id ?? s.short_id ?? "";
  const out: { id: string; time: string; sizeBytes?: number; tags?: readonly string[] } =
    {
      id,
      // Faithful to backup-restic.ts's PRECONDITION: restic emits UTC; we
      // pass `time` through unchanged (it is already a uniform-offset RFC3339
      // `…Z`, so the provider's lexicographic last_run == chronological).
      time: s.time ?? "",
    };
  if (s.summary?.total_bytes !== undefined) {
    out.sizeBytes = s.summary.total_bytes;
  }
  if (s.tags !== undefined) out.tags = [...s.tags];
  return out;
}

function makeRestic(
  config: Config,
  run: SshRunner,
): ResticTransport {
  const conn = connOf(config);
  // The repo URL is NON-secret (carried via -r). The PASSWORD is secret and
  // travels ONLY via SendEnv (child env); the SSH key likewise must not leak.
  const secrets = [config.RESTIC_PASSWORD, config.SSH_PRIVATE_KEY];

  /** Run `restic <args>` with the repo via -r and the password via env. */
  async function restic(
    args: readonly string[],
    entity: string,
  ): Promise<SshResult> {
    const argv = ["restic", "-r", config.RESTIC_REPO, ...args];
    let res: SshResult;
    try {
      res = await run(conn, argv, {
        // RESTIC_PASSWORD reaches the remote ONLY through the child env via
        // OpenSSH SendEnv — NEVER an argv flag, NEVER logged.
        sendEnv: { RESTIC_PASSWORD: config.RESTIC_PASSWORD },
      });
    } catch (e) {
      if (e instanceof ReconcileError) throw e;
      throw new ReconcileError(
        classify({ kind: "network-error" }),
        `restic transport: ssh exec failed for ${conn.host}`,
        { entity },
      );
    }
    if (res.code !== 0) {
      // Scrub: a wrong-password restic error commonly echoes context; we
      // NEVER surface the password/key (asserted in the suite).
      throw new ReconcileError(
        classify({ code: "econnrefused", kind: "network-error" }),
        `restic transport: \`restic\` failed (exit ${res.code}) on ` +
          `${conn.host}: ${scrub(res.stderr || res.stdout, secrets)}`,
        { entity },
      );
    }
    return res;
  }

  return {
    async snapshots(target: string): Promise<readonly ResticSnapshot[]> {
      const res = await restic(
        ["snapshots", "--json", "--tag", target],
        `backup:${target}`,
      );
      const txt = res.stdout.trim();
      if (txt.length === 0) return [];
      let arr: ResticJsonSnapshot[];
      try {
        const parsed = JSON.parse(txt) as unknown;
        arr = Array.isArray(parsed) ? (parsed as ResticJsonSnapshot[]) : [];
      } catch {
        throw new ReconcileError(
          "precondition",
          `restic transport: malformed \`snapshots --json\` from ` +
            `${conn.host}`,
          { entity: `backup:${target}` },
        );
      }
      return arr.map(toSnapshot);
    },

    async backup(target: string): Promise<ResticSnapshot> {
      // restic backup --json emits NDJSON; the final `summary` line carries
      // the created snapshot id + total bytes. The remote target path(s) are
      // operator-provisioned under a stable base (no shell interpolation).
      const res = await restic(
        ["backup", `/var/lib/bevox/data/${target}`, "--tag", target, "--json"],
        `backup:${target}`,
      );
      let summary: { snapshot_id?: string; total_bytes_processed?: number } =
        {};
      for (const line of res.stdout.split("\n")) {
        const t = line.trim();
        if (t.length === 0) continue;
        try {
          const obj = JSON.parse(t) as {
            message_type?: string;
            snapshot_id?: string;
            total_bytes_processed?: number;
          };
          if (obj.message_type === "summary") summary = obj;
        } catch {
          /* skip non-JSON progress noise */
        }
      }
      if (!summary.snapshot_id) {
        throw new ReconcileError(
          "precondition",
          `restic transport: \`backup --json\` returned no summary from ` +
            `${conn.host}`,
          { entity: `backup:${target}` },
        );
      }
      const out: ResticSnapshot = {
        id: summary.snapshot_id,
        time: new Date().toISOString(), // restic summary omits time; UTC `Z`
        ...(summary.total_bytes_processed !== undefined
          ? { sizeBytes: summary.total_bytes_processed }
          : {}),
        tags: [target],
      };
      return out;
    },

    async restore(target: string, snapshotId: string): Promise<void> {
      // The ONLY destructive op. Approval is owned UPSTREAM (4.3 gate / 4.4
      // catalog, restore = always-approval); this only performs mechanics.
      // No forget/prune is ever issued (non-destructive discipline).
      await restic(
        [
          "restore",
          snapshotId,
          "--target",
          `${RESTORE_TARGET}/${target}`,
        ],
        `backup:${target}`,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Bloco E (Task 23) — kube transport (kubectl-over-SSH)
//
// Mirrors makeDocker/makeWireGuard/makeRestic: build the non-secret connection
// record from validated Config and hand the SAME `SshRunner` + `SshConnection`
// to `createKubeTransport` (kube-transport.ts owns the argv assembly +
// secret-free scrubbing). The SSH key is sourced SERVER-SIDE from
// `config.SSH_PRIVATE_KEY` (Q-c) — it is NEVER present in any manifest/tool
// input. The kubeconfig path defaults to the k3s server path inside
// createKubeTransport; we pass none here so the operator's first-deploy default
// applies.
// ---------------------------------------------------------------------------

function makeKube(config: Config, run: SshRunner): KubeTransport {
  return createKubeTransport({ run, conn: connOf(config) });
}

// ---------------------------------------------------------------------------
// Factory — the EntrypointTransports 7.1 wires (UNCHANGED shape)
// ---------------------------------------------------------------------------

/**
 * Build the real SSH-backed `EntrypointTransports`. `main.ts` passes this in
 * place of 7.1's `undefined` constant so a live daemon has all backends; the
 * `EntrypointTransports` interface is unchanged (zero edit to 7.1's wiring).
 * Each per-kind factory takes the validated `Config` 7.1 passes AT CALL TIME
 * (`transports.docker(config)`), so this factory needs NO config at
 * construction — keeping `main.ts` a thin shell that never parses config
 * itself (loadConfig stays runMain's value-free fail-fast, undisturbed).
 */
export function createSshTransports(
  opts: SshTransportsOptions = {},
): EntrypointTransports {
  const run = opts.run ?? (defaultRunSsh as SshRunner);
  return {
    docker: (config: Config): DockerTransport => makeDocker(config, run),
    wireguard: (config: Config): WireGuardController =>
      makeWireGuard(config, run),
    restic: (config: Config): ResticTransport => makeRestic(config, run),
    // Bloco E (Task 23): the kubectl-over-SSH KubeTransport. Plugged in
    // alongside docker/wireguard/restic so buildKubePieces (entrypoint-wiring.ts)
    // sees a non-undefined `transports.kube` in the live daemon and cables the
    // kubectl_apply + ensure_k3s tools (Q-c: the SSH key is bound server-side).
    kube: (config: Config): KubeTransport => makeKube(config, run),
  };
}
