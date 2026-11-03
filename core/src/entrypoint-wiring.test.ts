/**
 * core/src/entrypoint-wiring.test.ts
 *
 * Task 7.1 — TDD for buildBootDeps. Proves:
 *   - buildBootDeps composes the correct providers per configuration;
 *   - routes.server is conditional on MANAGED_MESH (spec §4.3);
 *   - the boot-time warning for in-process desired-state is deterministic.
 *
 * Pure unit — no real network, no real DB, no real SSH. All external
 * transports are injected as fakes.
 */

import { describe, it, expect } from "vitest";

import { buildBootDeps, type BuildOptions, type EntrypointTransports, runMain, type RunMainDeps, _validateSopsAgeConfig, _buildVolumeMountResolver } from "./entrypoint-wiring.js";
import type { State } from "./domain/entities.js";
import { loadConfig, type Config } from "./config.js";
import type { DockerTransport } from "./providers/docker-transport.js";
import type { WireGuardController } from "./providers/wireguard-transport.js";
import type { ResticTransport } from "./providers/backup-restic-transport.js";
import type { KubeTransport } from "./providers/v2/kube-transport.js";
import type { KubeManifest } from "./domain/entities-v2.js";
import type { SshResult } from "./providers/ssh-exec.js";
import { HttpClient } from "./providers/http-client.js";
import { createPinoLogger, type PinoLike } from "./observability/logger.js";
import type { BootDeps, BevoxServer } from "./server.js";
import { createSopsCliFake } from "../test/fakes/sops-cli.js";
import { createDockerHttpFake } from "../test/fakes/docker-http.js";
import { applyPlan } from "./reconciler/apply.js";
import { createApplyContext } from "./store/secrets.js";

// ---------------------------------------------------------------------------
// Capturing logger for testing boot-time warnings
// ---------------------------------------------------------------------------

function capturingPino(): {
  pino: PinoLike;
  lines: Array<{ level: string; obj: object; msg?: string }>;
} {
  const lines: Array<{ level: string; obj: object; msg?: string }> = [];
  return {
    lines,
    pino: {
      info(obj, msg) {
        lines.push({ level: "info", obj, msg });
      },
      warn(obj, msg) {
        lines.push({ level: "warn", obj, msg });
      },
      error(obj, msg) {
        lines.push({ level: "error", obj, msg });
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Fake transports (all no-op)
// ---------------------------------------------------------------------------

function createFakeDockerTransport(): DockerTransport {
  return {
    request: async () => ({ status: 200, json: null }),
  };
}

function createFakeWireGuardController(): WireGuardController {
  return {
    listPeers: async () => [],
    setPeer: async () => undefined,
    removePeer: async () => undefined,
  };
}

function createFakeResticTransport(): ResticTransport {
  return {
    snapshots: async () => [],
    backup: async () => ({ id: "", time: "" }),
    restore: async () => undefined,
  };
}

/** A no-op `KubeTransport` fake — every call resolves a benign zero-exit result. */
function createFakeKubeTransport(): KubeTransport {
  const ok: SshResult = { code: 0, stdout: "", stderr: "" };
  return {
    kubectl: async () => ok,
    run: async () => ok,
  };
}

/**
 * A RECORDING `KubeTransport` fake — captures every `kubectl` argv + the
 * OPTIONAL stdin body so a test can assert what (if anything) reached the
 * piped stdin. `observe`-style `get` returns empty stdout (object absent ⇒
 * apply runs); `apply -f -` records the stdin body and reports zero-exit.
 * `run` is benign (unused on the kube-apply path under test).
 */
function createRecordingKubeTransport(): {
  transport: KubeTransport;
  calls: Array<{ args: readonly string[]; stdin?: string }>;
} {
  const ok: SshResult = { code: 0, stdout: "", stderr: "" };
  const calls: Array<{ args: readonly string[]; stdin?: string }> = [];
  return {
    calls,
    transport: {
      kubectl: async (args: readonly string[], stdin?: string) => {
        calls.push(stdin !== undefined ? { args, stdin } : { args });
        return ok;
      },
      run: async () => ok,
    },
  };
}

const fakeTransports: EntrypointTransports = {
  docker: () => createFakeDockerTransport(),
  wireguard: () => createFakeWireGuardController(),
  restic: () => createFakeResticTransport(),
};

// ---------------------------------------------------------------------------
// Minimal Config for testing
// ---------------------------------------------------------------------------

function baseConfig(): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgresql://user:pass@localhost/test",
    HCLOUD_TOKEN: "test-token",
    HCLOUD_DNS_TOKEN: "test-dns-token",
    RESTIC_REPO: "sftp:user@host:/backup",
    RESTIC_PASSWORD: "test-restic-pw",
    SSH_HOST: "10.0.0.1",
    SSH_USER: "deploy",
    SSH_PRIVATE_KEY: "-----BEGIN OPENSSH PRIVATE KEY-----\ntest\n-----END OPENSSH PRIVATE KEY-----",
    AGENT_CREDENTIALS: '{"test":{"actor":"agent:test","capabilities":["read"]}}',
    // Task 5.2 — sops-age resolver paths (placeholders).
    SECRETS_FILE: "/tmp/secrets.yaml",
    SOPS_AGE_KEY_FILE: "/tmp/age.key",
    PORT: "8787",
    RECONCILE_INTERVAL_MS: "60000",
    LOG_LEVEL: "info",
  };
}

// ---------------------------------------------------------------------------
// Task 5.3 — `buildBootDeps` is now async and calls `_validateSopsAgeConfig`
// before opening any resource. The existing tests pass `/tmp/secrets.yaml`
// and `/tmp/age.key` paths that don't exist as proper-perm regular files on
// the developer's box, so they need an injected fs+spawn pair to pass the
// boot validation. `defaultBuildOpts()` returns the matching `BuildOptions`
// — fs stats both paths as 0o600 regular files owned by the current uid;
// spawn returns exit 0 for `sops --version`. The few tests that need a
// different posture (e.g. validation failure) override per-call.
// ---------------------------------------------------------------------------

function defaultBuildOpts(): BuildOptions {
  const fakeFs = makeFakeFs({
    "/tmp/secrets.yaml": { isFile: true, mode: 0o600, uid: process.getuid!() },
    "/tmp/age.key": { isFile: true, mode: 0o600, uid: process.getuid!() },
  });
  const fakeSpawn = createSopsCliFake();
  fakeSpawn.setResponse({
    exitCode: 0,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
  });
  return { fs: fakeFs, spawn: fakeSpawn.spawn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("7.1 entrypoint-wiring — buildBootDeps", () => {
  describe("routes.server conditional on MANAGED_MESH (spec §4.3)", () => {
    it("MANAGED_MESH='on' (default) wires routes.server as [hetznerCloud, wireguard]", async () => {
      const env = baseConfig();
      env.MANAGED_MESH = "on";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      const route = deps.providers!.server;
      expect(Array.isArray(route)).toBe(true);
      expect(route).toHaveLength(2);
      expect(route[0]!.name).toBe("hetzner-cloud");
      expect(route[1]!.name).toBe("wireguard");
    });

    it("MANAGED_MESH='off' wires routes.server with only hetznerCloud", async () => {
      const env = baseConfig();
      env.MANAGED_MESH = "off";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      const route = deps.providers!.server;
      expect(Array.isArray(route)).toBe(true);
      expect(route).toHaveLength(1);
      expect(route[0]!.name).toBe("hetzner-cloud");
      // Assert wireguard is NOT present
      expect(route.every((p) => p.name !== "wireguard")).toBe(true);
    });

    it("MANAGED_MESH defaults to 'on' when absent", async () => {
      const env = baseConfig();
      delete env.MANAGED_MESH;
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      const route = deps.providers!.server;
      expect(Array.isArray(route)).toBe(true);
      expect(route).toHaveLength(2);
      expect(route[1]!.name).toBe("wireguard");
    });
  });

  describe("buildBootDeps integration", () => {
    it("constructs all required provider routes", async () => {
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.providers!.network).toBeDefined();
      expect(deps.providers!.network.name).toBe("hetzner-cloud");

      expect(deps.providers!.volume).toBeDefined();
      expect(deps.providers!.volume.name).toBe("hetzner-cloud");

      expect(deps.providers!.service).toBeDefined();
      expect(deps.providers!.service!.name).toBe("docker");

      expect(deps.providers!.dns).toBeDefined();
      expect(deps.providers!.dns!.name).toBe("hetzner-dns");

      expect(deps.providers!.backup).toBeDefined();
      expect(deps.providers!.backup!.name).toBe("backup-restic");
    });

    // Bug fix / feature: resolveVolumeMount wired to the observed VOLUME
    // store. spec: 2026-06-01-volume-hetzner-bind-automount.md §3/§F4.
    describe("_buildVolumeMountResolver (observed-store seam)", () => {
      const emptyState: State = {
        servers: [],
        networks: [],
        volumes: [],
        services: [],
        dns: [],
        backups: [],
      };

      it("resolves a declared+observed volume to /mnt/HC_Volume_<hcloud_id>", async () => {
        const read = async (): Promise<State> => ({
          ...emptyState,
          volumes: [{ name: "pg-data", size: "20Gi", fs: "ext4", hcloud_id: 42 }],
        });
        const resolve = _buildVolumeMountResolver(read);
        expect(await resolve("pg-data")).toBe("/mnt/HC_Volume_42");
      });

      it("returns undefined for a volume not present in observed state", async () => {
        const read = async (): Promise<State> => emptyState;
        const resolve = _buildVolumeMountResolver(read);
        expect(await resolve("absent")).toBeUndefined();
      });

      it("returns undefined when the volume row has no hcloud_id (first cycle)", async () => {
        const read = async (): Promise<State> => ({
          ...emptyState,
          volumes: [{ name: "pg-data", size: "20Gi", fs: "ext4" }],
        });
        const resolve = _buildVolumeMountResolver(read);
        expect(await resolve("pg-data")).toBeUndefined();
      });
    });

    it("provides loadDesired and writeDesired functions", async () => {
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(typeof deps.loadDesired).toBe("function");
      expect(typeof deps.writeDesired).toBe("function");
    });

    it("provides a logger", async () => {
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.logger).toBeDefined();
      expect(typeof deps.logger!.info).toBe("function");
      expect(typeof deps.logger!.warn).toBe("function");
      expect(typeof deps.logger!.error).toBe("function");
    });

    // Spec docs/specs/2026-05-27-wire-v2-set-firewall.md §2.3: buildBootDeps
    // exposes the v2 Bloco A set_firewall cabling pieces (v2 HTTP client +
    // in-memory working store). server.ts assembles the SetFirewallDeps with
    // the pool-bound serversProvider + the local approvalGate.
    it("provides setFirewallPieces with v2Http + workingStore", async () => {
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.setFirewallPieces).toBeDefined();
      expect(deps.setFirewallPieces!.v2Http).toBeDefined();
      // Sanity: the http client exposes the firewalls resource per
      // HetznerV2HttpClient contract.
      expect(deps.setFirewallPieces!.v2Http.firewalls).toBeDefined();
      // Working store contract — minimal write/read surface.
      expect(typeof deps.setFirewallPieces!.workingStore.put).toBe("function");
      expect(typeof deps.setFirewallPieces!.workingStore.get).toBe("function");
    });

    // Spec docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.3:
    // buildBootDeps maps STRICT_MANIFEST_APPROVAL config to a boolean
    // on BootDeps. Default false (v1 FROZEN preservation).
    it("strictManifestApproval false by default (STRICT_MANIFEST_APPROVAL omitted)", async () => {
      const env = baseConfig();
      delete env.STRICT_MANIFEST_APPROVAL;
      const deps = await buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts());
      expect(deps.strictManifestApproval).toBe(false);
    });

    it("strictManifestApproval true when STRICT_MANIFEST_APPROVAL=on", async () => {
      const env = baseConfig();
      env.STRICT_MANIFEST_APPROVAL = "on";
      const deps = await buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts());
      expect(deps.strictManifestApproval).toBe(true);
    });

    it("throws precondition error if transports is missing", async () => {
      const config = loadConfig(baseConfig());

      await expect(
        buildBootDeps(
          config,
          undefined as unknown as EntrypointTransports,
          defaultBuildOpts(),
        ),
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Task 5.3 — sops-age secret resolver wiring
    //
    // buildBootDeps is now async and (a) calls `_validateSopsAgeConfig` BEFORE
    // any resource is opened, then (b) instantiates the real
    // `createSopsAgeSecretResolver` bound to the validated paths +
    // SECRETS_TIMEOUT_MS. The stub (createStubSecretResolver) export is
    // preserved as a test-only seam (spec §0.6); production wiring lives here.
    // -----------------------------------------------------------------------

    it("buildBootDeps: wires sops-age resolver after validate succeeds", async () => {
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(
        config,
        fakeTransports,
        defaultBuildOpts(),
      );

      // The wired resolver MUST satisfy the SecretResolver shape (describe +
      // describeSchema + resolve). The factory tests prove the leak invariants;
      // here we only assert the wiring carried through.
      expect(deps.secretResolver).toBeDefined();
      expect(typeof deps.secretResolver!.describe).toBe("function");
      expect(typeof deps.secretResolver!.describeSchema).toBe("function");
      expect(typeof deps.secretResolver!.resolve).toBe("function");
    });

    // -----------------------------------------------------------------------
    // Bug 10 — the docker (service) provider MUST be wired with the
    // secretResolver, or every `secret:<ref>` env binding is silently dropped
    // at apply (POSTGRES_PASSWORD never reaches the container → crashloop).
    // The golden secret-apply.test.ts constructs the provider WITH a resolver
    // directly, so it cannot catch a composition-root wiring gap — this test
    // drives the provider that buildBootDeps actually produces.
    // spec: 2026-05-28-secret-resolver-real-v1.md (apply-only resolution) +
    //       2026-06-01-docker-provider-bootstrap-and-verify.md (service apply).
    // -----------------------------------------------------------------------
    it("buildBootDeps: the wired service provider resolves secret:<ref> env at apply (Bug 10)", async () => {
      const SECRET_VALUE = "resolved-pg-password";
      const dockerFake = createDockerHttpFake();
      const recordingTransports: EntrypointTransports = {
        docker: () => dockerFake.transport,
        wireguard: () => createFakeWireGuardController(),
        restic: () => createFakeResticTransport(),
      };
      // One sops fake serves BOTH the boot `sops --version` check (exit 0,
      // stdout ignored) and the apply-time `--extract` resolve (stdout = value).
      const fakeFs = makeFakeFs({
        "/tmp/secrets.yaml": { isFile: true, mode: 0o600, uid: process.getuid!() },
        "/tmp/age.key": { isFile: true, mode: 0o600, uid: process.getuid!() },
      });
      const fakeSpawn = createSopsCliFake();
      fakeSpawn.setResponse({
        exitCode: 0,
        stdout: Buffer.from(SECRET_VALUE),
        stderr: Buffer.alloc(0),
      });

      const env = baseConfig();
      env.MANAGED_SERVICES = "on";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, recordingTransports, {
        fs: fakeFs,
        spawn: fakeSpawn.spawn,
      });

      const service = deps.providers!.service;
      expect(service, "MANAGED_SERVICES=on must wire a service provider").toBeDefined();

      const SVC = {
        name: "postgres-backend",
        image: "postgres:16",
        replicas: 1,
        env: { POSTGRES_DB: "bevox", POSTGRES_PASSWORD: "secret:pg-backend-pw" },
      };
      const report = await applyPlan(
        service!,
        [
          {
            op: "create" as const,
            entity: "service:postgres-backend",
            change: "create service:postgres-backend",
            impact: "x",
          },
        ],
        {
          desiredPayloads: new Map([["service:postgres-backend", SVC]]),
          applyContext: createApplyContext(),
        },
      );
      expect(report.failed).toEqual([]);

      // The resolved value MUST land in the running container's Engine Env.
      // Before the wiring fix the secretResolver is undefined → resolveSecretEnv
      // early-returns empty → POSTGRES_PASSWORD is dropped entirely (red).
      const list = await dockerFake.transport.request("GET", "/containers/json");
      const items = list.json as { Id: string; Names: readonly string[] }[];
      const found = items.find((c) => c.Names[0] === "/postgres-backend-0");
      expect(found, "container postgres-backend-0 must exist").toBeDefined();
      const insp = (
        await dockerFake.transport.request("GET", `/containers/${found!.Id}/json`)
      ).json as { Config: { Env: readonly string[] } };
      expect(insp.Config.Env).toContain(`POSTGRES_PASSWORD=${SECRET_VALUE}`);
      expect(insp.Config.Env).toContain("POSTGRES_DB=bevox");
      // The raw ref must NEVER reach Docker Env (3.2 channel: label only).
      expect(insp.Config.Env).not.toContain(
        "POSTGRES_PASSWORD=secret:pg-backend-pw",
      );
    });

    // -----------------------------------------------------------------------
    // Task 5 (spec 2026-06-01-docker-private-registry-auth): REGISTRY_AUTH_REFS
    // is parsed + shape-validated at boot, fail-closed and VALUE-FREE (the
    // content could carry a ref). Absent ⇒ ok (no auth wired).
    // -----------------------------------------------------------------------
    it("buildBootDeps: malformed REGISTRY_AUTH_REFS JSON ⇒ fatal, value-free (Bug 11)", async () => {
      const env = baseConfig();
      env.REGISTRY_AUTH_REFS = "{not valid json";
      await expect(
        buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts()),
      ).rejects.toThrow(/REGISTRY_AUTH_REFS is not valid JSON/);
    });

    it("buildBootDeps: non-{host:ref} REGISTRY_AUTH_REFS shape ⇒ fatal (Bug 11)", async () => {
      const env = baseConfig();
      env.REGISTRY_AUTH_REFS = '{"ghcr.io": 5}'; // value not a string
      await expect(
        buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts()),
      ).rejects.toThrow(/REGISTRY_AUTH_REFS must be a \{host: ref\} string map/);
    });

    it("buildBootDeps: absent REGISTRY_AUTH_REFS ⇒ ok (no auth wired) (Bug 11)", async () => {
      const env = baseConfig();
      delete env.REGISTRY_AUTH_REFS;
      const deps = await buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts());
      expect(deps.providers!.service ?? deps.providers!.network).toBeDefined();
    });

    // -----------------------------------------------------------------------
    // Task 7 (spec 2026-06-02-observed-state-adapter): buildBootDeps MUST wire
    // the REAL observedAdapter. Never setting it (the root-cause regression,
    // same class as Bug 10) made server.ts fall back to a constant-empty State
    // ⇒ get_state/diff structurally empty. Mirror the Bug 10 wiring guard: the
    // wired adapter turns a probe slice into a NON-EMPTY State.
    // -----------------------------------------------------------------------
    it("buildBootDeps: wires the REAL observedAdapter (non-empty State, not the stub)", async () => {
      const deps = await buildBootDeps(
        loadConfig(baseConfig()),
        fakeTransports,
        defaultBuildOpts(),
      );
      expect(deps.observedAdapter).toBeDefined();
      const state = deps.observedAdapter!({
        scope: "server",
        entities: [
          {
            key: "server:web",
            payload: {
              name: "web",
              type: "cpx22",
              location: "nbg1",
              image: "ubuntu-24.04",
              ssh_keys: [],
              labels: {},
              network: "bevox-priv",
            },
          },
        ],
      });
      // The empty-stub fallback would return []; the real adapter populates it.
      expect(state.servers.map((s) => s.name)).toEqual(["web"]);
    });

    it("buildBootDeps: validate failure aborts before any provider is built", async () => {
      // Empty fs ⇒ SECRETS_FILE lstat → ENOENT → fatal "secrets file not found"
      // BEFORE any HttpClient / transport factory / desired-state seam runs.
      const failingOpts: BuildOptions = { fs: makeFakeFs({}) };
      const config = loadConfig(baseConfig());

      await expect(
        buildBootDeps(config, fakeTransports, failingOpts),
      ).rejects.toThrow(/secrets file not found/);
    });

    // Spec docs/specs/2026-05-28-migration-runner-v1.md §6 — buildBootDeps
    // exposes the v2 `run_migrations` cabling pieces (per-migration timeout
    // + docker-exec adapter over the SSH-backed Docker transport).
    // server.ts assembles the full RunMigrationsDeps (approvalGate +
    // servicesProvider closure over the pool + appendEvent + pool) — same
    // precedent as setFirewallPieces / SetFirewallDeps.
    it("buildBootDeps wires runMigrations pieces (timeoutMs + dockerExec adapter)", async () => {
      const env = baseConfig();
      env.MIGRATION_TIMEOUT_MS = "30000";
      const deps = await buildBootDeps(loadConfig(env), fakeTransports, defaultBuildOpts());

      expect(deps.runMigrationsPieces).toBeDefined();
      expect(deps.runMigrationsPieces?.timeoutMs).toBe(30_000);
      expect(typeof deps.runMigrationsPieces?.dockerExec).toBe("function");
    });

    // -----------------------------------------------------------------------
    // Task 21 (spec 2026-06-12-bloco-e-kubernetes-k3s-provider §"kube()
    // transport factory") — buildBootDeps invokes `transports.kube(config)`
    // ONCE and exposes the kube/k3s cabling pieces on BootDeps so server.ts
    // (Task 23) can assemble the `kubectl_apply` deps (Task 14:
    // resolveHost/getProvider/namespaceExists) AND the analogous `ensure_k3s`
    // deps. Mirrors the runMigrationsPieces / setFirewallPieces precedent: the
    // SSH-backed transport is the INJECTED seam (tests pass a fake; production
    // plugs the ssh2-backed one). Q-c: the host-config resolver resolves the
    // SSH connection SERVER-SIDE — the credential is NEVER in the tool input.
    // -----------------------------------------------------------------------
    it("buildBootDeps invokes transports.kube(config) exactly once", async () => {
      const config = loadConfig(baseConfig());
      let kubeCalls = 0;
      let sawConfig = false;
      const transports: EntrypointTransports = {
        ...fakeTransports,
        kube: (cfg) => {
          kubeCalls += 1;
          // Q-c: the SSH connection is sourced SERVER-SIDE from the same
          // validated Config the docker transport uses (SSH_HOST/SSH_USER/
          // SSH_PRIVATE_KEY) — never from the manifest/tool input.
          sawConfig = cfg.SSH_HOST === "10.0.0.1";
          return createFakeKubeTransport();
        },
      };
      await buildBootDeps(config, transports, defaultBuildOpts());

      expect(kubeCalls).toBe(1);
      expect(sawConfig).toBe(true);
    });

    it("buildBootDeps exposes kubePieces (transport + host-config resolver + provider factories + namespaceExists)", async () => {
      const config = loadConfig(baseConfig());
      const transport = createFakeKubeTransport();
      const transports: EntrypointTransports = {
        ...fakeTransports,
        kube: () => transport,
      };
      const deps = await buildBootDeps(config, transports, defaultBuildOpts());

      expect(deps.kubePieces).toBeDefined();
      // The transport built once by buildBootDeps (the same instance the
      // provider factories close over).
      expect(deps.kubePieces!.transport).toBe(transport);
      // Q-c host-config resolver — a named `host` ref → a SERVER-SIDE config
      // carrying ONLY the non-secret host identifier (no SSH key/connection
      // material in the returned shape).
      expect(typeof deps.kubePieces!.resolveHost).toBe("function");
      const hostCfg = await deps.kubePieces!.resolveHost("k3s-server-1");
      expect(hostCfg.host).toBe("k3s-server-1");
      // No secret material leaks into the resolved config (Q-c): the SSH key
      // lives behind the transport, never in the resolved host config shape.
      expect(Object.values({ ...hostCfg })).not.toContain(
        config.SSH_PRIVATE_KEY,
      );
      // Provider factories the two tools' deps drive (Task 23 assembles them).
      expect(typeof deps.kubePieces!.getProvider).toBe("function");
      expect(deps.kubePieces!.getProvider(hostCfg).name).toBe("kubernetes");
      expect(typeof deps.kubePieces!.getEnsureK3sProvider).toBe("function");
      expect(deps.kubePieces!.getEnsureK3sProvider(hostCfg).name).toBe(
        "ensure-k3s",
      );
      // Q-d namespace precondition reader (read-only; never creates a ns).
      expect(typeof deps.kubePieces!.namespaceExists).toBe("function");
    });

    it("buildBootDeps omits kubePieces when transports.kube is absent (backward-compatible)", async () => {
      // The existing SSH transports factory does not yet supply a kube seam
      // (it lands with the production wiring in Task 23). Until then, the
      // kube/k3s tools simply stay un-cabled — mirrors the optional-dep
      // contract of setFirewallPieces / runMigrationsPieces.
      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());
      expect(deps.kubePieces).toBeUndefined();
    });

    // -----------------------------------------------------------------------
    // Task 26 — the kube provider buildBootDeps produces (via kubePieces.
    // getProvider) MUST be wired with the SAME secretResolver the docker
    // (service) provider gets, or every `secret:<ref>` token in a kube
    // manifest body is piped to the cluster as the LITERAL `secret:...` string
    // (never resolved). The provider's apply() resolves correctly only when a
    // secretResolver AND a valid ApplyContext are present; the kube factory
    // was constructed WITHOUT the resolver (RED), so this drives the provider
    // buildBootDeps actually produces — the composition-root wiring gap a
    // direct unit test cannot catch (mirrors the Bug-10 docker guard above).
    // spec: 2026-06-12-bloco-e-kubernetes-k3s-provider.md §2.3/§2.4 (resolve
    //       at apply) + 2026-05-28-secret-resolver-real-v1.md (apply-only).
    // -----------------------------------------------------------------------
    it("buildBootDeps: the wired kube provider resolves secret:<ref> in the manifest body at apply (Task 26)", async () => {
      const SENTINEL = "S3CR3T-26-must-never-leak-kubewire";
      const recording = createRecordingKubeTransport();
      const transports: EntrypointTransports = {
        ...fakeTransports,
        kube: () => recording.transport,
      };
      // One sops fake serves BOTH the boot `sops --version` check (exit 0,
      // stdout ignored) and the apply-time `--extract` resolve (stdout =
      // the sentinel value). This is the SAME real-resolver path the docker
      // service provider is wired with (createSopsAgeSecretResolver), proving
      // the production resolver — not an invented one — flows into the kube
      // factory.
      const fakeFs = makeFakeFs({
        "/tmp/secrets.yaml": { isFile: true, mode: 0o600, uid: process.getuid!() },
        "/tmp/age.key": { isFile: true, mode: 0o600, uid: process.getuid!() },
      });
      const fakeSpawn = createSopsCliFake();
      fakeSpawn.setResponse({
        exitCode: 0,
        stdout: Buffer.from(SENTINEL),
        stderr: Buffer.alloc(0),
      });

      const config = loadConfig(baseConfig());
      const deps = await buildBootDeps(config, transports, {
        fs: fakeFs,
        spawn: fakeSpawn.spawn,
      });

      expect(deps.kubePieces).toBeDefined();
      const hostCfg = await deps.kubePieces!.resolveHost("k3s-server-1");
      const provider = deps.kubePieces!.getProvider(hostCfg);

      const manifest: KubeManifest = {
        host: "k3s-server-1",
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "pg-secret" },
        namespace: "default",
        body:
          "apiVersion: v1\nkind: Secret\nmetadata:\n  name: pg-secret\n" +
          "stringData:\n  password: secret:pg-backend-pw\n",
      };

      // Drive apply with a REAL ApplyContext (the only key that unlocks
      // resolution). observed=null ⇒ hash mismatch ⇒ apply runs.
      const result = await provider.apply(manifest, null, createApplyContext());
      expect(result.changed).toBe(true);

      // The `kubectl apply -f -` call MUST have piped the manifest body with
      // the ref RESOLVED to the sentinel. Before the wiring fix the resolver
      // is undefined → the ref stays literal → the sentinel is absent (RED).
      const applyCall = recording.calls.find(
        (c) => c.args[0] === "apply" && c.stdin !== undefined,
      );
      expect(applyCall, "an `apply -f -` call with stdin must have run").toBeDefined();
      expect(applyCall!.stdin).toContain(SENTINEL);
      expect(applyCall!.stdin).not.toContain("secret:pg-backend-pw");

      // LEAK INVARIANT: the resolved sentinel appears ONLY on the piped stdin —
      // NEVER in the returned result, NEVER in a recorded argv vector.
      expect(JSON.stringify(result)).not.toContain(SENTINEL);
      for (const c of recording.calls) {
        expect(JSON.stringify(c.args)).not.toContain(SENTINEL);
      }
    });
  });

  describe("BootDeps.scopes effective filter on MANAGED_SERVICES (spec 2026-05-26 §3)", () => {
    it("MANAGED_SERVICES='on' → BootDeps.scopes is undefined (server.ts uses DEFAULT_SCOPES)", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "on";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      // Default behavior: scopes is undefined, server.ts falls back to
      // DEFAULT_SCOPES = ["network","server","service","volume"]. This
      // keeps every pre-2.3 path byte-identical (backwards-compatible).
      expect(deps.scopes).toBeUndefined();
    });

    it("MANAGED_SERVICES='off' → BootDeps.scopes excludes 'service'", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "off";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.scopes).toBeDefined();
      expect(deps.scopes!).not.toContain("service");
      expect(deps.scopes!).toContain("network");
      expect(deps.scopes!).toContain("server");
      expect(deps.scopes!).toContain("volume");
    });
  });

  describe("routes.service conditional on MANAGED_SERVICES (spec 2026-05-26 §3)", () => {
    it("MANAGED_SERVICES='on' (default) wires routes.service as Docker provider", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "on";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.providers!.service).toBeDefined();
      expect(deps.providers!.service!.name).toBe("docker");
    });

    it("MANAGED_SERVICES='off' wires routes.service as undefined", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "off";
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.providers!.service).toBeUndefined();
    });

    it("MANAGED_SERVICES defaults to 'on' when absent (routes.service defined)", async () => {
      const env = baseConfig();
      delete env.MANAGED_SERVICES;
      const config = loadConfig(env);
      const deps = await buildBootDeps(config, fakeTransports, defaultBuildOpts());

      expect(deps.providers!.service).toBeDefined();
      expect(deps.providers!.service!.name).toBe("docker");
    });
  });

  describe("boot-time warn when MANAGED_MESH='off'", () => {
    it("emits exactly one warn entry when MANAGED_MESH='off'", async () => {
      const env = baseConfig();
      env.MANAGED_MESH = "off";

      const cap = capturingPino();
      const capturedLogger = createPinoLogger(cap.pino);

      let serverStarted = false;
      const mockServer: Partial<BevoxServer> = {
        stop: async () => {
          serverStarted = false;
        },
      };

      const runMainDeps: RunMainDeps = {
        env,
        transports: fakeTransports,
        buildOpts: defaultBuildOpts(),
        start: async () => {
          serverStarted = true;
          return mockServer as BevoxServer;
        },
        log: () => {}, // swallow console output
        exit: () => {}, // prevent exit in test
        wrapBootDeps: (deps: BootDeps) => ({
          ...deps,
          logger: capturedLogger,
        }),
        onStarted: () => {
          // Resolve immediately so we don't wait indefinitely
        },
        waitForShutdown: async () => {
          // Resolve immediately
        },
      };

      await runMain(runMainDeps);

      // Should have exactly 2 warn entries: desired-state in-process + managed-mesh off
      const warnEntries = cap.lines.filter((line) => line.level === "warn");
      expect(warnEntries).toHaveLength(2);

      // Find the MANAGED_MESH warn entry
      const managedMeshWarn = warnEntries.find(
        (w) =>
          typeof w.obj === "object" &&
          w.obj !== null &&
          (w.obj as Record<string, unknown>).subsystem === "managed-mesh",
      );

      expect(managedMeshWarn).toBeDefined();
      expect(managedMeshWarn?.obj).toEqual(
        expect.objectContaining({
          actor: "system:boot",
          scope: "daemon",
          entity: "config",
          subsystem: "managed-mesh",
          managedMesh: "off",
        }),
      );
      expect(managedMeshWarn?.msg).toMatch(/WireGuard|MANAGED_MESH=off/i);
    });

    it("emits exactly one managed-services warn when MANAGED_SERVICES='off' (spec 2026-05-26 §3)", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "off";

      const cap = capturingPino();
      const capturedLogger = createPinoLogger(cap.pino);

      const mockServer: Partial<BevoxServer> = {
        stop: async () => {},
      };

      const runMainDeps: RunMainDeps = {
        env,
        transports: fakeTransports,
        buildOpts: defaultBuildOpts(),
        start: async () => mockServer as BevoxServer,
        log: () => {},
        exit: () => {},
        wrapBootDeps: (deps: BootDeps) => ({
          ...deps,
          logger: capturedLogger,
        }),
        onStarted: () => {},
        waitForShutdown: async () => {},
      };

      await runMain(runMainDeps);

      const warnEntries = cap.lines.filter((line) => line.level === "warn");
      // Should have at least the desired-state warn + managed-services warn.
      // (MANAGED_MESH='on' by baseConfig, so no managed-mesh warn here.)
      const managedServicesWarn = warnEntries.find(
        (w) =>
          typeof w.obj === "object" &&
          w.obj !== null &&
          (w.obj as Record<string, unknown>).subsystem === "managed-services",
      );

      expect(managedServicesWarn).toBeDefined();
      expect(managedServicesWarn?.obj).toEqual(
        expect.objectContaining({
          actor: "system:boot",
          scope: "daemon",
          entity: "config",
          subsystem: "managed-services",
          managedServices: "off",
        }),
      );
      expect(managedServicesWarn?.msg).toMatch(/Docker|MANAGED_SERVICES=off/i);
    });

    it("does NOT emit a managed-services warn when MANAGED_SERVICES='on' (default)", async () => {
      const env = baseConfig();
      env.MANAGED_SERVICES = "on";

      const cap = capturingPino();
      const capturedLogger = createPinoLogger(cap.pino);

      const mockServer: Partial<BevoxServer> = {
        stop: async () => {},
      };

      const runMainDeps: RunMainDeps = {
        env,
        transports: fakeTransports,
        buildOpts: defaultBuildOpts(),
        start: async () => mockServer as BevoxServer,
        log: () => {},
        exit: () => {},
        wrapBootDeps: (deps: BootDeps) => ({
          ...deps,
          logger: capturedLogger,
        }),
        onStarted: () => {},
        waitForShutdown: async () => {},
      };

      await runMain(runMainDeps);

      const warnEntries = cap.lines.filter((line) => line.level === "warn");
      const managedServicesWarn = warnEntries.find(
        (w) =>
          typeof w.obj === "object" &&
          w.obj !== null &&
          (w.obj as Record<string, unknown>).subsystem === "managed-services",
      );
      expect(managedServicesWarn).toBeUndefined();
    });

    it("does NOT emit a managed-mesh warn when MANAGED_MESH='on'", async () => {
      const env = baseConfig();
      env.MANAGED_MESH = "on";

      const cap = capturingPino();
      const capturedLogger = createPinoLogger(cap.pino);

      let serverStarted = false;
      const mockServer: Partial<BevoxServer> = {
        stop: async () => {
          serverStarted = false;
        },
      };

      const runMainDeps: RunMainDeps = {
        env,
        transports: fakeTransports,
        buildOpts: defaultBuildOpts(),
        start: async () => {
          serverStarted = true;
          return mockServer as BevoxServer;
        },
        log: () => {}, // swallow console output
        exit: () => {}, // prevent exit in test
        wrapBootDeps: (deps: BootDeps) => ({
          ...deps,
          logger: capturedLogger,
        }),
        onStarted: () => {
          // Resolve immediately so we don't wait indefinitely
        },
        waitForShutdown: async () => {
          // Resolve immediately
        },
      };

      await runMain(runMainDeps);

      // Should have exactly 1 warn entry: only desired-state in-process (NOT managed-mesh)
      const warnEntries = cap.lines.filter((line) => line.level === "warn");
      expect(warnEntries).toHaveLength(1);

      // Verify the warn is the desired-state in-process warning
      expect(warnEntries[0]?.obj).toEqual(
        expect.objectContaining({
          subsystem: "desired-state",
        }),
      );

      // Verify there is NO managed-mesh warn
      const managedMeshWarn = warnEntries.find(
        (w) =>
          typeof w.obj === "object" &&
          w.obj !== null &&
          (w.obj as Record<string, unknown>).subsystem === "managed-mesh",
      );
      expect(managedMeshWarn).toBeUndefined();
    });
  });

  describe("desired-state seam (spec §4.5 — cross-scope read union + strip-to-own)", () => {
    it("loadDesired performs cross-scope union for scopes with upstream deps", async () => {
      const deps = await buildBootDeps(loadConfig(baseConfig()), fakeTransports, defaultBuildOpts());
      // buildBootDeps always provides these; non-null assertions are safe here.
      const { loadDesired, writeDesired } = deps;
      if (!loadDesired || !writeDesired) throw new Error("missing seams");
      await writeDesired("network", {
        networks: [
          { name: "net-a", ip_range: "10.0.0.0/16", subnets: [] },
        ],
      });
      await writeDesired("server", {
        servers: [
          {
            name: "app-1",
            type: "cx22",
            location: "nbg1",
            network: "net-a",
          },
        ],
      });
      const merged = await loadDesired("server");
      // Own slice present.
      expect(merged.servers?.[0]?.name).toBe("app-1");
      // Upstream dep merged in (the cross-scope read union fix).
      expect(merged.networks?.[0]?.name).toBe("net-a");
    });

    it("writeDesired persists only the scope's own slice (strip-to-own)", async () => {
      const deps = await buildBootDeps(loadConfig(baseConfig()), fakeTransports, defaultBuildOpts());
      const { loadDesired, writeDesired } = deps;
      if (!loadDesired || !writeDesired) throw new Error("missing seams");
      await writeDesired("network", {
        networks: [
          { name: "net-a", ip_range: "10.0.0.0/16", subnets: [] },
        ],
      });
      // Simulate provision_server's mergeDesired writing back a union.
      // The write SHOULD strip networks (they belong in scope=network silo).
      await writeDesired("server", {
        servers: [
          {
            name: "app-1",
            type: "cx22",
            location: "nbg1",
            network: "net-a",
          },
        ],
        networks: [
          { name: "net-a", ip_range: "10.0.0.0/16", subnets: [] },
          // Sentinel that would pollute scope=server silo if strip-to-own
          // were NOT enforced.
          { name: "WRONG-PLACE", ip_range: "10.99.0.0/16", subnets: [] },
        ],
      });
      // After strip-to-own: scope=server silo has only {servers}.
      // loadDesired("server") cross-unions: {servers} + network silo (net-a only).
      // The sentinel must NOT appear anywhere in the merged view.
      const serverView = await loadDesired("server");
      expect(serverView.networks?.map((n) => n.name)).not.toContain(
        "WRONG-PLACE",
      );
      // Cross-read into the network silo: sentinel MUST NOT be there either.
      const networkView = await loadDesired("network");
      expect(networkView.networks?.map((n) => n.name)).toEqual(["net-a"]);
      expect(networkView.networks?.map((n) => n.name)).not.toContain(
        "WRONG-PLACE",
      );
    });

    it("loadDesired('manifest') unions all per-kind silos (synthetic meta-scope)", async () => {
      const deps = await buildBootDeps(loadConfig(baseConfig()), fakeTransports, defaultBuildOpts());
      const { loadDesired, writeDesired } = deps;
      if (!loadDesired || !writeDesired) throw new Error("missing seams");
      await writeDesired("network", {
        networks: [{ name: "net-a", ip_range: "10.0.0.0/16", subnets: [] }],
      });
      await writeDesired("server", {
        servers: [
          {
            name: "app-1",
            type: "cx22",
            location: "nbg1",
            network: "net-a",
          },
        ],
      });
      const manifest = await loadDesired("manifest");
      expect(manifest.servers?.[0]?.name).toBe("app-1");
      expect(manifest.networks?.[0]?.name).toBe("net-a");
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2.1 — _validateSopsAgeConfig: async skeleton + happy path
//
// The helper validates boot-time preconditions for the real (sops+age) secret
// resolver: SECRETS_FILE + SOPS_AGE_KEY_FILE existence, ownership, perms, and
// `sops --version` reachability. Tasks 2.2-2.5 land the 4 validation steps
// one-by-one (red → green per step). Task 2.1 only proves the happy path
// resolves with the async shape (SpawnFn returns Promises, so the helper is
// async from the start to avoid a sync→async pivot later).
// ---------------------------------------------------------------------------

/**
 * Minimal in-memory fake of the subset of `node:fs` the `_validateSopsAgeConfig`
 * helper uses. Task 2.1 only needs `lstatSync(path) → {isFile(), mode, uid}`;
 * Tasks 2.2-2.5 may extend the shape as the validation steps land.
 *
 * Returns a fake with:
 *   - `lstatSync(path)` — the production seam, with ENOENT for unstaged paths.
 *   - `setEntry(path, entry)` — staging mutator for per-test setup / failure
 *     paths (Tasks 2.2-2.5 will add e.g. wrong-uid, wrong-mode, symlink cases).
 *   - `reset()` — clears entries + calls; lets a single `beforeEach`-style
 *     pattern keep tests isolated without copy-pasted fresh factory literals.
 *   - `calls` — shallow-copied call log for "did we touch lstat at all?"
 *     style assertions (mirrors the `sops-cli` fake's `callLog`).
 */
interface FakeFsStat {
  readonly isFile: boolean;
  readonly mode: number;
  readonly uid: number;
}
interface FakeFs {
  lstatSync: (path: string) => { isFile(): boolean; mode: number; uid: number };
  reset(): void;
  setEntry(path: string, entry: FakeFsStat): void;
  readonly calls: ReadonlyArray<{ method: string; path: string }>;
}
function makeFakeFs(initial: Record<string, FakeFsStat>): FakeFs {
  let table: Record<string, FakeFsStat> = { ...initial };
  let calls: Array<{ method: string; path: string }> = [];
  return {
    lstatSync(path: string) {
      calls.push({ method: "lstatSync", path });
      const entry = table[path];
      if (!entry) {
        const err = Object.assign(new Error(`ENOENT: no such file ${path}`), {
          code: "ENOENT",
        });
        throw err;
      }
      return {
        isFile: () => entry.isFile,
        mode: entry.mode,
        uid: entry.uid,
      };
    },
    reset(): void {
      table = { ...initial };
      calls = [];
    },
    setEntry(path: string, entry: FakeFsStat): void {
      table[path] = entry;
    },
    get calls() {
      // Shallow copy: `ReadonlyArray<…>` is a compile-time fiction; at
      // runtime, consumers could otherwise mutate the internal array.
      return [...calls];
    },
  };
}

describe("2.1 _validateSopsAgeConfig — async skeleton + happy path", () => {
  it("happy path resolves and calls lstatSync(SECRETS_FILE) exactly once", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      "/s/key": { isFile: true, mode: 0o600, uid: process.getuid!() },
    });
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setResponse({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
        { fs: fakeFs, spawn: fakeSpawn.spawn },
      ),
    ).resolves.toBeUndefined();
    // Task 2.3: steps 1+2 are the SECRETS_FILE + SOPS_AGE_KEY_FILE lstats.
    // Happy path stats both, in order. Tasks 2.4-2.5 will append more
    // entries as the next validation steps land — that delta is the signal
    // each step is actually exercised, not just declared.
    expect(fakeFs.calls).toEqual([
      { method: "lstatSync", path: "/s/file" },
      { method: "lstatSync", path: "/s/key" },
    ]);
    // Task 2.5: step 4 invokes `sops --version` exactly once after all fs
    // checks pass. Was 0 in Task 2.1's skeleton (no spawn yet); now 1.
    expect(fakeSpawn.callLog).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Task 2.2 — _validateSopsAgeConfig: SECRETS_FILE lstat (missing → fatal)
//
// First of four validation steps (spec docs/specs/2026-05-28-secret-resolver-
// real-v1.md §1.4 step 1). `lstatSync` — NOT `statSync` — rejects ENOENT,
// "is dir", and symlinks in one pass (L7 invariant: symlink_to_file → lstat
// returns isFile()===false, blocking the symlink-swap class of attack).
// ---------------------------------------------------------------------------

describe("2.2 _validateSopsAgeConfig — SECRETS_FILE lstat", () => {
  it("SECRETS_FILE missing → fatal 'secrets file not found'", async () => {
    const fakeFs = makeFakeFs({}); // empty — lstatSync throws ENOENT
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/nope", SOPS_AGE_KEY_FILE: "/k" },
        { fs: fakeFs },
      ),
    ).rejects.toThrow(/secrets file not found/);
  });
});

// ---------------------------------------------------------------------------
// Task 2.3 — _validateSopsAgeConfig: SOPS_AGE_KEY_FILE lstat (missing → fatal)
//
// Second of four validation steps (spec docs/specs/2026-05-28-secret-resolver-
// real-v1.md §1.4 step 2). Mirror of step 1 against the age key path. Same
// L7 invariant: `lstatSync` rejects ENOENT, "is dir", and symlinks uniformly.
// ---------------------------------------------------------------------------

describe("2.3 _validateSopsAgeConfig — SOPS_AGE_KEY_FILE lstat", () => {
  it("SOPS_AGE_KEY_FILE missing → fatal 'age key file not found'", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      // SOPS_AGE_KEY_FILE missing
    });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/nope" },
        { fs: fakeFs },
      ),
    ).rejects.toThrow(/age key file not found/);
  });
});

// ---------------------------------------------------------------------------
// Task 2.4 — _validateSopsAgeConfig: perm/uid/symlink L7 defense
//
// Third of four validation steps (spec docs/specs/2026-05-28-secret-resolver-
// real-v1.md §1.4 step 3). The age key file MUST be mode 0600 owned by the
// daemon user. `(mode & 0o077) === 0` rejects any group/world bits. Symlinks
// are already rejected by step 2's `lstat + isFile()` (lstat does not follow
// symlinks, so `isFile()` returns false for a symlink-to-file) — defense in
// depth, no explicit symlink branch needed in step 3.
// ---------------------------------------------------------------------------

describe("2.4 _validateSopsAgeConfig — perm/uid/symlink L7", () => {
  it("validateSopsAgeConfig: key file mode 0644 → fatal insecure perms/ownership", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      "/s/key": { isFile: true, mode: 0o644, uid: process.getuid!() }, // group readable
    });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
        { fs: fakeFs },
      ),
    ).rejects.toThrow(/age key file has insecure permissions or ownership/);
  });

  it("validateSopsAgeConfig: key file owned by other uid → fatal insecure perms/ownership", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      "/s/key": { isFile: true, mode: 0o600, uid: process.getuid!() + 1 }, // wrong owner
    });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
        { fs: fakeFs },
      ),
    ).rejects.toThrow(/age key file has insecure permissions or ownership/);
  });

  it("validateSopsAgeConfig: key file is symlink → fatal age key file not found (step 2 catches)", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      "/s/key": { isFile: false, mode: 0o600, uid: process.getuid!() }, // not a regular file
    });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
        { fs: fakeFs },
      ),
    ).rejects.toThrow(/age key file not found/); // step 2 catches !isFile() with lstat
  });
});

// ---------------------------------------------------------------------------
// Task 2.5 — _validateSopsAgeConfig: `sops --version` exit 0
//
// Fourth and final validation step (spec docs/specs/2026-05-28-secret-resolver-
// real-v1.md §1.4 step 4). The sops binary must be on PATH (ENOENT) AND must
// exit 0 when invoked with `--version`. Either failure mode → fatal "sops
// binary not found" — same message for both, matches the spec's §2.1 table
// row and the existing pattern (one fatal envelope per validation step).
// ---------------------------------------------------------------------------

describe("2.5 _validateSopsAgeConfig — sops --version", () => {
  it("validateSopsAgeConfig: sops binary ENOENT → fatal 'sops binary not found'", async () => {
    const fakeFs = makeFakeFs({
      "/s/file": { isFile: true, mode: 0o644, uid: process.getuid!() },
      "/s/key": { isFile: true, mode: 0o600, uid: process.getuid!() },
    });
    const fakeSpawn = createSopsCliFake();
    fakeSpawn.setSpawnError({ code: "ENOENT" });
    await expect(
      _validateSopsAgeConfig(
        { SECRETS_FILE: "/s/file", SOPS_AGE_KEY_FILE: "/s/key" },
        { fs: fakeFs, spawn: fakeSpawn.spawn },
      ),
    ).rejects.toThrow(/sops binary not found/);
  });
});
