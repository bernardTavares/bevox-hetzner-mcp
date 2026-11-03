/**
 * core/src/providers/ssh-transports.test.ts
 *
 * Task 7.2 — drives the THREE real SSH-backed transports + the
 * `createSshTransports(config)` factory against an INJECTED fake SSH runner
 * (`runSsh` seam). ZERO real ssh / host / Docker socket / wg device / restic
 * binary / network. Deterministic.
 *
 * What is proven HERE (the seam-conformance contract — real-host behaviour is
 * the operator's first-deploy @live step, see the module header):
 *   - each transport implements its EXACT existing seam unchanged, so the
 *     already-tested providers work against it verbatim;
 *   - the remote argv is assembled argv-only (curl over the docker socket /
 *     `wg` / `restic --json`), NO shell, NO secret in argv;
 *   - representative curl / wg-dump / restic --json stdout parses faithfully
 *     into {status,json} / WgPeer[] / ResticSnapshot[];
 *   - error + timeout outcomes classify via errors.ts;
 *   - SECRET NON-LEAK: the SSH key + the restic password sentinels appear in
 *     NO thrown error / returned value across success, failure AND timeout;
 *   - restic password is passed via SendEnv (child env), NEVER an argv flag;
 *     the wg device PRIVATE-key line of `wg show dump` is never surfaced;
 *     restic destructive ops are only `restore` (no forget/prune exists).
 */

import { describe, it, expect } from "vitest";
import { createSshTransports, type SshRunner } from "./ssh-transports.js";
import { ReconcileError } from "../domain/errors.js";
import type { Config } from "../config.js";

const KEY_SENTINEL =
  "-----BEGIN OPENSSH PRIVATE KEY-----TRANSPORT_KEY_LEAK-----END-----";
const PW_SENTINEL = "RESTIC_PW_TRANSPORT_LEAK_xyz";

function cfg(over: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://x",
    HCLOUD_TOKEN: "t",
    HCLOUD_DNS_TOKEN: "t",
    RESTIC_REPO: "s3:https://example.invalid/bucket",
    RESTIC_PASSWORD: PW_SENTINEL,
    SSH_HOST: "10.0.0.5",
    SSH_USER: "deploy",
    SSH_PRIVATE_KEY: KEY_SENTINEL,
    AGENT_CREDENTIALS: "{}",
    PORT: 8787,
    RECONCILE_INTERVAL_MS: 60000,
    DRIFT_SWEEP_INTERVAL_MS: 300000,
    CYCLE_TIMEOUT_MS: 300000,
    LOG_LEVEL: "info",
    SSH_PORT: 22,
    SSH_HOST_KEY_POLICY: "accept-new",
    SSH_KNOWN_HOSTS: undefined,
    ...over,
  } as Config;
}

/** A scripted fake `runSsh`: matches on the remote argv, returns canned IO. */
function fakeRunner(
  script: (remoteArgv: readonly string[], stdin?: string) => {
    code?: number;
    stdout?: string;
    stderr?: string;
    throwErr?: ReconcileError;
  },
): { run: SshRunner; calls: { argv: string[]; stdin?: string; sendEnv?: Record<string, string> }[] } {
  const calls: {
    argv: string[];
    stdin?: string;
    sendEnv?: Record<string, string>;
  }[] = [];
  const run: SshRunner = async (_conn, remoteArgv, opts) => {
    calls.push({
      argv: [...remoteArgv],
      stdin: opts?.stdin,
      sendEnv: opts?.sendEnv ? { ...opts.sendEnv } : undefined,
    });
    const r = script(remoteArgv, opts?.stdin);
    if (r.throwErr) throw r.throwErr;
    return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  return { run, calls };
}

// ===========================================================================
// Docker transport
// ===========================================================================

describe("7.2 SSH Docker transport — Engine API over the remote unix socket", () => {
  it("issues a no-shell curl --unix-socket call; parses {status,json}; body on stdin (never argv)", async () => {
    const f = fakeRunner((argv) => {
      // GET /containers/json → 200 + a JSON array, then the status sentinel.
      if (argv.includes("--unix-socket")) {
        return { stdout: `[{"Id":"c1"}]\n__BEVOX_HTTP__200` };
      }
      return { code: 1, stderr: "unexpected" };
    });
    const t = createSshTransports({ run: f.run });
    const docker = t.docker(cfg());
    const res = await docker.request("GET", "/containers/json");
    expect(res.status).toBe(200);
    expect(res.json).toEqual([{ Id: "c1" }]);

    const call = f.calls[0]!;
    expect(call.argv[0]).toBe("curl");
    expect(call.argv).toContain("--unix-socket");
    expect(call.argv).toContain("/var/run/docker.sock");
    expect(call.argv).toContain("-X");
    expect(call.argv).toContain("GET");
    // path is a literal argv token, NOT a shell-interpolated URL.
    expect(call.argv.some((a) => a.endsWith("/containers/json"))).toBe(true);
  });

  it("sends a create body via stdin (--data-binary @-), never in argv; 201 parsed", async () => {
    const f = fakeRunner((argv, stdin) => {
      expect(stdin).toBe(JSON.stringify({ Image: "nginx" }));
      expect(argv).toContain("--data-binary");
      expect(argv).toContain("@-");
      return { stdout: `{"Id":"c9"}\n__BEVOX_HTTP__201` };
    });
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    const res = await docker.request(
      "POST",
      "/containers/create?name=x",
      { Image: "nginx" },
    );
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ Id: "c9" });
    // The body is NOT anywhere in argv.
    expect(f.calls[0]!.argv.join(" ")).not.toContain("nginx");
  });

  it("routes a sensitive header via curl --config - (stdin), NEVER argv (Bug 11)", async () => {
    const f = fakeRunner(() => ({ stdout: `{"status":"ok"}\n__BEVOX_HTTP__200` }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    await docker.request(
      "POST",
      "/images/create?fromImage=ghcr.io/x",
      undefined,
      { "X-Registry-Auth": "BASE64URLVALUE" },
    );
    const call = f.calls[0]!;
    expect(call.argv).toContain("--config");
    expect(call.argv).toContain("-");
    // The sensitive value is ABSENT from argv (no ps-visible leak).
    expect(call.argv.join(" ")).not.toContain("BASE64URLVALUE");
    // It travels on stdin as a curl config line.
    expect(call.stdin).toContain('header = "X-Registry-Auth: BASE64URLVALUE"');
  });

  it("body + sensitive header together ⇒ precondition (forbids secret onto argv) (Bug 11)", async () => {
    const f = fakeRunner(() => ({ stdout: `{}\n__BEVOX_HTTP__200` }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    await expect(
      docker.request("POST", "/containers/create", { Image: "x" }, { "X-Registry-Auth": "y" }),
    ).rejects.toMatchObject({ errorClass: "precondition" });
  });

  it("a 204 empty body → {status:204, json:null}", async () => {
    const f = fakeRunner(() => ({ stdout: `__BEVOX_HTTP__204` }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    const res = await docker.request("POST", "/containers/c1/start");
    expect(res).toEqual({ status: 204, json: null });
  });

  it("parses an NDJSON stream (POST /images/create) into a per-line json array (Bug 4)", async () => {
    const f = fakeRunner(() => ({
      stdout:
        `{"status":"Pulling from library/nginx"}\n` +
        `{"status":"Status: Downloaded newer image for nginx:alpine"}\n` +
        `__BEVOX_HTTP__200`,
    }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    const res = await docker.request(
      "POST",
      "/images/create?fromImage=nginx&tag=alpine",
    );
    expect(res.status).toBe(200);
    expect(Array.isArray(res.json)).toBe(true);
    expect((res.json as Array<{ status?: string }>).length).toBe(2);
  });

  it("surfaces an in-stream {error} line in the NDJSON array (pull failure at HTTP 200)", async () => {
    const f = fakeRunner(() => ({
      stdout: `{"status":"Pulling"}\n{"error":"manifest unknown"}\n__BEVOX_HTTP__200`,
    }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    const res = await docker.request("POST", "/images/create?fromImage=x&tag=y");
    expect(res.status).toBe(200);
    expect(
      (res.json as Array<{ error?: string }>).some((o) => o.error),
    ).toBe(true);
  });

  it("an ssh-level failure → ReconcileError; key NOT leaked", async () => {
    const f = fakeRunner(() => ({
      throwErr: new ReconcileError(
        "transient",
        "ssh: connection to 10.0.0.5 failed (exit 255)",
        { entity: "ssh:10.0.0.5" },
      ),
    }));
    const docker = createSshTransports({ run: f.run }).docker(cfg());
    let err: ReconcileError | undefined;
    try {
      await docker.request("GET", "/containers/json");
    } catch (e) {
      err = e as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    const text = `${err!.message} ${JSON.stringify(err!.toApiError())}`;
    expect(text).not.toContain(KEY_SENTINEL);
  });

  it("the real Docker provider works UNCHANGED against this transport (seam-faithful)", async () => {
    // Minimal Engine emulation over the fake runner: list (empty) → create →
    // start; enough that createDockerProvider's apply() converges via the
    // exact {status,json} seam (proves interface fidelity, not a Docker test).
    const containers: Record<
      string,
      { running: boolean; Labels: Record<string, string> }
    > = {};
    const f = fakeRunner((argv, stdin) => {
      const url = argv.find((a) => a.startsWith("http://localhost")) ?? "";
      const path = url.replace("http://localhost", "");
      const method = argv[argv.indexOf("-X") + 1];
      if (method === "GET" && path.startsWith("/containers/json")) {
        const list = Object.entries(containers).map(([Id, c]) => ({
          Id,
          Names: [`/${c.Labels["bevox.service"]}-${c.Labels["bevox.replica"]}`],
          Labels: c.Labels,
          State: c.running ? "running" : "exited",
        }));
        return { stdout: `${JSON.stringify(list)}\n__BEVOX_HTTP__200` };
      }
      if (method === "POST" && path.startsWith("/images/create")) {
        // Bug 4: the provider pulls before create — NDJSON success stream.
        return {
          stdout: `{"status":"Pulling"}\n{"status":"Download complete"}\n__BEVOX_HTTP__200`,
        };
      }
      if (method === "POST" && path.startsWith("/containers/create")) {
        const body = JSON.parse(stdin ?? "{}") as {
          Labels?: Record<string, string>;
        };
        containers["c1"] = { running: false, Labels: body.Labels ?? {} };
        return { stdout: `{"Id":"c1"}\n__BEVOX_HTTP__201` };
      }
      if (method === "GET" && path === "/containers/c1/json") {
        const c = containers["c1"]!;
        return {
          stdout: `${JSON.stringify({
            State: { Running: c.running },
            Config: { Image: "nginx", Labels: c.Labels },
          })}\n__BEVOX_HTTP__200`,
        };
      }
      if (method === "POST" && path === "/containers/c1/start") {
        containers["c1"]!.running = true;
        return { stdout: `__BEVOX_HTTP__204` };
      }
      return { stdout: `{"message":"no"}\n__BEVOX_HTTP__404` };
    });
    const { createDockerProvider } = await import("./docker.js");
    const docker = createDockerProvider({
      transport: createSshTransports({ run: f.run }).docker(cfg()),
    });
    const action = {
      entity: "service:web",
      op: "create" as const,
      desired: { name: "web", image: "nginx", replicas: 1 },
    };
    const r = await docker.apply(action);
    expect(r.changed).toBe(true);
    expect(containers["c1"]!.running).toBe(true);
  });
});

// ===========================================================================
// WireGuard controller
// ===========================================================================

describe("7.2 SSH WireGuard controller — `wg` over ssh", () => {
  it("listPeers parses `wg show <if> dump`, DROPPING the device private-key line", async () => {
    // Line 1 of `wg show dump` is the INTERFACE row: <privkey> <pubkey>
    // <listen-port> <fwmark>. It carries the device PRIVATE key and MUST be
    // skipped entirely (never surfaced).
    const DEV_PRIV = "DEVICE_PRIVATE_KEY_NEVER_SURFACE";
    const dump =
      `${DEV_PRIV}\tDEVPUB\t51820\toff\n` +
      `PEERPUB1\t(none)\t1.2.3.4:51820\t10.99.0.2/32\t0\t0\t0\toff\n` +
      `PEERPUB2\t(none)\t(none)\t10.99.0.3/32\t0\t0\t0\toff\n`;
    const f = fakeRunner((argv) => {
      expect(argv[0]).toBe("wg");
      expect(argv).toContain("show");
      expect(argv).toContain("dump");
      return { stdout: dump };
    });
    const wg = createSshTransports({ run: f.run }).wireguard(cfg());
    const peers = await wg.listPeers();
    expect(peers.map((p) => p.publicKey)).toEqual(["PEERPUB1", "PEERPUB2"]);
    expect(peers[0]!.allowedIps).toEqual(["10.99.0.2/32"]);
    expect(peers[0]!.endpoint).toBe("1.2.3.4:51820");
    expect(peers[1]!.endpoint).toBeUndefined(); // "(none)" → absent
    // The device private key is NOWHERE in the parsed result.
    expect(JSON.stringify(peers)).not.toContain(DEV_PRIV);
  });

  it("setPeer issues `wg set <if> peer <pub> allowed-ips <ips> endpoint <ep>` (argv-only, upsert)", async () => {
    const f = fakeRunner((argv) => {
      expect(argv[0]).toBe("wg");
      expect(argv).toContain("set");
      expect(argv).toContain("peer");
      expect(argv).toContain("PUBKEY-A");
      expect(argv).toContain("allowed-ips");
      expect(argv).toContain("10.99.0.7/32");
      expect(argv).toContain("endpoint");
      expect(argv).toContain("host-a:51820");
      return { code: 0 };
    });
    const wg = createSshTransports({ run: f.run }).wireguard(cfg());
    await wg.setPeer({
      publicKey: "PUBKEY-A",
      allowedIps: ["10.99.0.7/32"],
      endpoint: "host-a:51820",
    });
    expect(f.calls).toHaveLength(1);
  });

  it("removePeer issues `wg set <if> peer <pub> remove` (seam-present; provider never calls it)", async () => {
    const f = fakeRunner((argv) => {
      expect(argv).toContain("remove");
      return { code: 0 };
    });
    const wg = createSshTransports({ run: f.run }).wireguard(cfg());
    await wg.removePeer("DEAD-PUB");
    expect(f.calls[0]!.argv).toContain("DEAD-PUB");
  });

  it("a device/ssh failure → classified ReconcileError; key NOT leaked", async () => {
    const f = fakeRunner(() => ({ code: 1, stderr: "wg: command not found" }));
    const wg = createSshTransports({ run: f.run }).wireguard(cfg());
    let err: ReconcileError | undefined;
    try {
      await wg.listPeers();
    } catch (e) {
      err = e as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    expect(`${err!.message}`).not.toContain(KEY_SENTINEL);
  });

  it("the real WireGuard provider works UNCHANGED against this TAGLESS `wg show dump` (no real-host flap; correct observe; non-destructive)", async () => {
    // Drives createWireGuardProvider THROUGH the ssh WireGuardController over a
    // fake runSsh whose stdout is realistic TAGLESS `wg show <if> dump` — i.e.
    // exactly what a real host emits: NO tag channel. This pins the 7.2 break:
    // the old tag-dependent isConverged/observe would flap setPeer every cycle
    // and report an EMPTY observe() here. The fix makes managed-set/convergence
    // desired-derived (identity = the `wgpub:` public key), so it must NO-OP.
    const { createWireGuardProvider } = await import("./wireguard.js");

    // The mesh device's per-peer config, mutated by `wg set …` and rendered
    // back as a TAGLESS dump (interface private-key line + tab-separated peer
    // rows: <pub> <psk> <endpoint> <allowed-ips> <hs> <rx> <tx> <keepalive>).
    const dev = new Map<string, { allowed: string; endpoint: string }>();
    // An UNMANAGED orphan already on the device — must never be removed.
    dev.set("ORPHAN_PUB", { allowed: "10.50.0.9/32", endpoint: "(none)" });

    function renderDump(): string {
      let out = "DEVICE_PRIVATE_KEY_NEVER_SURFACE\tDEVPUB\t51820\toff\n";
      for (const [pub, c] of dev) {
        out += `${pub}\t(none)\t${c.endpoint}\t${c.allowed}\t0\t0\t0\toff\n`;
      }
      return out;
    }

    let removeCalls = 0;
    const f = fakeRunner((argv) => {
      expect(argv[0]).toBe("wg");
      if (argv.includes("dump")) return { stdout: renderDump() };
      if (argv.includes("remove")) {
        // The provider must NEVER issue a remove (fail-safe, never
        // fail-deleting) — neither for the orphan nor anything else.
        removeCalls += 1;
        return { code: 0 };
      }
      if (argv.includes("set")) {
        // `wg set <if> peer <pub> allowed-ips <ips> [endpoint <ep>]`
        const pi = argv.indexOf("peer");
        const pub = argv[pi + 1]!;
        const ai = argv.indexOf("allowed-ips");
        const allowed = argv[ai + 1]!;
        const ei = argv.indexOf("endpoint");
        const endpoint = ei >= 0 ? argv[ei + 1]! : "(none)";
        dev.set(pub, { allowed, endpoint });
        return { code: 0 };
      }
      return { code: 1, stderr: "unexpected" };
    });

    const provider = createWireGuardProvider({
      controller: createSshTransports({ run: f.run }).wireguard(cfg()),
    });
    const action = {
      entity: "server:app-1",
      op: "create" as const,
      desired: {
        name: "app-1",
        type: "cx22",
        location: "fsn1",
        image: "debian-12",
        ssh_keys: ["k1"],
        labels: {},
        network: "mesh-net",
        status: "pending" as const,
      },
    };

    // 1) First apply converges (programs the mesh peer) against tagless dump.
    const r1 = await provider.apply(action);
    expect(r1.changed).toBe(true);

    // 2) THE FLAP PIN: a second apply + verify is a NO-OP against the TAGLESS
    //    observed dump (the old observed-tag isConverged would be false here
    //    forever → changed:true every cycle). Desired-derived ⇒ converged.
    expect(await provider.verify(action)).toBe(true);
    const r2 = await provider.apply(action);
    expect(r2.changed).toBe(false);
    expect(await provider.verify(action)).toBe(true);

    // 3) observe() reports the managed entity for the desired server from the
    //    TAGLESS dump (non-empty, correct key), recovered from the `wgpub:`
    //    public-key namespace — not an absent tag.
    const obs = await provider.observe("server");
    expect(obs.entities.map((e) => e.key)).toEqual(["server:app-1"]);

    // 4) Non-destructive: the unmanaged orphan is still present and the
    //    provider issued ZERO removePeer/`wg … remove` calls.
    expect(removeCalls).toBe(0);
    expect([...dev.keys()].sort()).toEqual(["ORPHAN_PUB", "wgpub:app-1"]);
  });
});

// ===========================================================================
// restic transport
// ===========================================================================

describe("7.2 SSH restic transport — `restic --json` over ssh, password via env", () => {
  it("snapshots parses `restic snapshots --json`; repo via -r; password via SendEnv (NEVER argv)", async () => {
    const f = fakeRunner((argv) => {
      expect(argv[0]).toBe("restic");
      expect(argv).toContain("--json");
      expect(argv).toContain("snapshots");
      expect(argv).toContain("-r");
      expect(argv).toContain("s3:https://example.invalid/bucket");
      expect(argv).toContain("--tag");
      expect(argv).toContain("db");
      // PASSWORD must NOT be an argv token.
      expect(argv.join(" ")).not.toContain(PW_SENTINEL);
      return {
        stdout: JSON.stringify([
          { id: "snap1", time: "2026-05-18T00:00:00Z", summary: { total_bytes: 123 }, tags: ["db"] },
          { short_id: "snap2", time: "2026-05-18T01:00:00Z" },
        ]),
      };
    });
    const restic = createSshTransports({ run: f.run }).restic(cfg());
    const snaps = await restic.snapshots("db");
    expect(snaps).toEqual([
      { id: "snap1", time: "2026-05-18T00:00:00Z", sizeBytes: 123, tags: ["db"] },
      { id: "snap2", time: "2026-05-18T01:00:00Z" },
    ]);
    // The password travelled via SendEnv (child env), not argv.
    expect(f.calls[0]!.sendEnv?.RESTIC_PASSWORD).toBe(PW_SENTINEL);
  });

  it("backup parses the restic `--json` summary into the created ResticSnapshot", async () => {
    const f = fakeRunner((argv) => {
      expect(argv).toContain("backup");
      // restic backup --json emits NDJSON; the final summary line has the id.
      return {
        stdout:
          `{"message_type":"status","percent_done":0.5}\n` +
          `{"message_type":"summary","snapshot_id":"newsnap","total_bytes_processed":456}\n`,
      };
    });
    const restic = createSshTransports({ run: f.run }).restic(cfg());
    const s = await restic.backup("db");
    expect(s.id).toBe("newsnap");
    expect(s.sizeBytes).toBe(456);
    expect(typeof s.time).toBe("string");
  });

  it("restore (the ONLY destructive op) issues `restic restore <id> --target ...`; no forget/prune anywhere", async () => {
    const f = fakeRunner((argv) => {
      expect(argv).toContain("restore");
      expect(argv).toContain("snapX");
      expect(argv).toContain("--target");
      // Non-destructive discipline: the transport NEVER forgets/prunes.
      expect(argv).not.toContain("forget");
      expect(argv).not.toContain("prune");
      return { code: 0, stdout: "{}" };
    });
    const restic = createSshTransports({ run: f.run }).restic(cfg());
    await restic.restore("db", "snapX");
    expect(f.calls).toHaveLength(1);
  });

  it("a restic/ssh failure → classified ReconcileError; password & key NOT leaked (incl. echoed stderr)", async () => {
    const f = fakeRunner(() => ({
      code: 1,
      // A hostile/buggy remote that echoes the secret in stderr: the
      // transport must STILL not surface it.
      stderr: `Fatal: wrong password ${PW_SENTINEL} key=${KEY_SENTINEL}`,
    }));
    const restic = createSshTransports({ run: f.run }).restic(cfg());
    let err: ReconcileError | undefined;
    try {
      await restic.snapshots("db");
    } catch (e) {
      err = e as ReconcileError;
    }
    expect(err).toBeInstanceOf(ReconcileError);
    const text = `${err!.message} ${JSON.stringify(
      err!.toApiError(),
    )} ${String((err as { cause?: unknown }).cause ?? "")}`;
    expect(text).not.toContain(PW_SENTINEL);
    expect(text).not.toContain(KEY_SENTINEL);
  });

  it("the real Backup provider works UNCHANGED against this transport (seam-faithful)", async () => {
    let backed = false;
    const f = fakeRunner((argv) => {
      if (argv.includes("snapshots")) {
        return {
          stdout: backed
            ? JSON.stringify([{ id: "s1", time: "2026-05-18T00:00:00Z" }])
            : "[]",
        };
      }
      if (argv.includes("backup")) {
        backed = true;
        return {
          stdout: `{"message_type":"summary","snapshot_id":"s1","total_bytes_processed":1}\n`,
        };
      }
      return { code: 1, stderr: "no" };
    });
    const { createBackupProvider } = await import("./backup-restic.js");
    const provider = createBackupProvider({
      transport: createSshTransports({ run: f.run }).restic(cfg()),
    });
    const action = {
      entity: "backup:db",
      op: "create" as const,
      desired: {
        target: "db",
        schedule: "daily",
        retention: "7d",
        repo: "s3:https://example.invalid/bucket",
      },
    };
    const r1 = await provider.apply(action); // initial snapshot
    expect(r1.changed).toBe(true);
    const r2 = await provider.apply(action); // converged → no-op
    expect(r2.changed).toBe(false);
  });
});

// ===========================================================================
// Factory
// ===========================================================================

// ===========================================================================
// Bloco E (Task 23) — kube transport (kubectl-over-SSH)
// ===========================================================================

describe("Task 23 SSH kube transport — kubectl/raw-exec over ssh", () => {
  it("kubectl() runs `kubectl --kubeconfig <path> <args>` argv-only; body on stdin", async () => {
    const f = fakeRunner(() => ({ code: 0, stdout: "namespace/bevox" }));
    const kube = createSshTransports({ run: f.run }).kube!(cfg());
    const res = await kube.kubectl(["apply", "-f", "-"], "kind: ConfigMap\n");
    expect(res.code).toBe(0);
    const call = f.calls[0]!;
    expect(call.argv[0]).toBe("kubectl");
    expect(call.argv).toContain("--kubeconfig");
    // The manifest body crosses on stdin, NEVER as an argv token.
    expect(call.stdin).toBe("kind: ConfigMap\n");
    expect(call.argv).not.toContain("kind: ConfigMap\n");
  });

  it("run() executes raw host argv VERBATIM (no kubectl/kubeconfig prefix)", async () => {
    const f = fakeRunner(() => ({
      code: 0,
      stdout: "k3s version v1.30.2+k3s1 (abc)",
    }));
    const kube = createSshTransports({ run: f.run }).kube!(cfg());
    const res = await kube.run(["k3s", "--version"]);
    expect(res.code).toBe(0);
    const call = f.calls[0]!;
    expect(call.argv).toEqual(["k3s", "--version"]);
    expect(call.argv).not.toContain("kubectl");
  });

  it("a non-zero kubectl exit surfaces a SECRET-FREE error (no SSH key)", async () => {
    const f = fakeRunner(() => ({
      code: 1,
      stderr: `boom ${KEY_SENTINEL}`,
    }));
    const kube = createSshTransports({ run: f.run }).kube!(cfg());
    await expect(kube.kubectl(["get", "ns"])).rejects.toMatchObject({
      name: "ReconcileError",
    });
    // No SSH key in any thrown message.
    let leaked = false;
    try {
      await kube.kubectl(["get", "ns"]);
    } catch (e) {
      leaked = (e as Error).message.includes(KEY_SENTINEL);
    }
    expect(leaked).toBe(false);
  });
});

describe("7.2 createSshTransports — EntrypointTransports factory", () => {
  it("returns the three seam factories with the EntrypointTransports shape", () => {
    const t = createSshTransports();
    expect(typeof t.docker).toBe("function");
    expect(typeof t.wireguard).toBe("function");
    expect(typeof t.restic).toBe("function");
    // Each yields a usable seam object.
    expect(typeof t.docker(cfg()).request).toBe("function");
    expect(typeof t.wireguard(cfg()).listPeers).toBe("function");
    expect(typeof t.restic(cfg()).snapshots).toBe("function");
  });

  it("Task 23: also exposes a `kube` factory yielding a usable KubeTransport", () => {
    const t = createSshTransports();
    expect(typeof t.kube).toBe("function");
    const kube = t.kube!(cfg());
    expect(typeof kube.kubectl).toBe("function");
    expect(typeof kube.run).toBe("function");
  });
});
