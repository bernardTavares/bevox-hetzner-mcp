/**
 * core/src/entrypoint-wiring.ts
 *
 * Task 7.1 — the PURE, testable daemon wiring (the bridge from the completed,
 * tested core to a runnable process). It owns NOTHING new: no policy, no
 * provider logic, no endpoint, no convergence — it WIRES the already-built
 * pieces into the `BootDeps` `server.ts` (6.6) consumes, and nothing else
 * (the minimal-change discipline). `main.ts` is the thin process shell;
 * everything unit-testable lives HERE so the suite is deterministic with NO
 * real network / SSH / signals / process.
 *
 * What it composes (every piece reused verbatim):
 *
 *   - Hetzner Cloud + DNS go GENUINELY LIVE: each is constructed over a REAL
 *     HttpClient (http-client.ts — native global `fetch`, production-ready,
 *     already tested) with the CONFIGURED token (config.ts) and the CORRECT
 *     real base URL. The Cloud API and the hcloud DNS API are SEPARATE
 *     origins; each provider gets its own client + its own token. The token
 *     reaches ONLY the Authorization header — never a log/error (http-client
 *     + the providers already guarantee this; this module never logs config).
 *
 *   - Docker / WireGuard / restic are SSH-backed. Task 7.1 does NOT implement
 *     the real ssh2 transports (that is Task 7.2). They are built from an
 *     INJECTED transport-factory seam (`EntrypointTransports`): tests pass
 *     in-memory fakes; Task 7.2 plugs the real ssh2-backed implementations in
 *     UNCHANGED (same factory shape). A production boot WITHOUT a transports
 *     factory FAILS FAST with a value-free precondition NAMING the missing
 *     piece — never a silent no-op backend (fail-safe; spec §"fail-safe,
 *     nunca fail-deleting").
 *
 *   - `loadDesired` / `writeDesired`: server.ts (6.6) requires these because
 *     `State` (observed entity shape, entities.ts) and `DesiredState`
 *     (manifest intent shape, desired-state.ts) are genuinely DIFFERENT
 *     schemas with no runtime adapter — so the deploy supplies them. The v1
 *     daemon backs them with a scope-keyed in-process `DesiredState` store,
 *     EXACTLY the shape every existing call-site uses (tools.test.ts /
 *     server.test.ts: `loadDesired → DesiredState`, default `{}`). Durable
 *     git/manifest persistence is the manifest-repo's concern and is
 *     deliberately OUT OF Task-7.1 scope (YAGNI — the entrypoint only wires;
 *     no new persistence subsystem here).
 *
 *   - The logger is the ratified pino (logger.ts) at the configured
 *     LOG_LEVEL. Structured, value-free (logger.ts forwards ONLY the explicit
 *     fields; this module passes none derived from secrets).
 *
 * Design principles (CLAUDE.md non-negotiables):
 *   - THIN PROCESS SHELL, TESTABLE WIRING. `buildBootDeps` is pure (no I/O,
 *     no process, no real socket) → fully unit-tested. `runMain` is the
 *     minimal process orchestration with every environmental seam injected.
 *   - FAIL-FAST, VALUE-FREE, NO LEAK. A missing transports factory or a
 *     loadConfig failure aborts with a value-free precondition + non-zero
 *     exit; no secret/token/password/SSH-key reaches any stream.
 *   - GRACEFUL, ALL-OR-NOTHING LIFECYCLE. server.ts already owns the
 *     all-or-nothing boot + idempotent graceful stop(); runMain only installs
 *     ONE shutdown path and never swallows a boot error silently.
 *
 * Exported API (minimal surface — only what Task 7.1 needs):
 *   interface EntrypointTransports — the SSH transport-factory seam (7.2)
 *   interface BuildOptions         — test-only HttpClient seam override
 *   buildBootDeps(config, transports, opts?) → BootDeps   (PURE)
 *   interface RunMainDeps          — injected process seams
 *   runMain(deps) → Promise<number>   (the thin process orchestration)
 */

import type { Config } from "./config.js";
import { loadConfig } from "./config.js";
import type { BootDeps, BevoxServer } from "./server.js";
import { HttpClient } from "./providers/http-client.js";
import { createHetznerCloudProvider } from "./providers/hetzner-cloud.js";
import { createHetznerDnsProvider } from "./providers/hetzner-dns.js";
import { createDockerProvider } from "./providers/docker.js";
import { observedAdapter } from "./reconciler/observed-adapter.js";
import { createWireGuardProvider } from "./providers/wireguard.js";
import { createBackupProvider } from "./providers/backup-restic.js";
import type { DockerTransport } from "./providers/docker-transport.js";
import type { WireGuardController } from "./providers/wireguard-transport.js";
import type { ResticTransport } from "./providers/backup-restic-transport.js";
import type { KubeTransport } from "./providers/v2/kube-transport.js";
import {
  createKubernetesProvider,
  type KubernetesProvider,
} from "./providers/v2/kube-apply.js";
import {
  createEnsureK3sProvider,
  type EnsureK3sProvider,
} from "./providers/v2/ensure-k3s.js";
import type { KubeHostConfig } from "./agent/v2/kubectl-apply.js";
import type { DesiredState } from "./domain/desired-state.js";
import { createDesiredStateSeam } from "./store/desired-state-seam.js";
// v2 Bloco A — set_firewall cabling pieces (spec
// docs/specs/2026-05-27-wire-v2-set-firewall.md §2.3). Only the static
// pieces are built here; server.ts assembles serversProvider + provider.
import { createHetznerV2HttpClient } from "./providers/v2/hetzner-cloud-v2-http.js";
import { createInMemoryWorkingFirewallStore } from "./agent/v2/set-firewall.js";
import { createDockerExecOverSsh } from "./providers/docker-exec-adapter.js";
import type { DockerExecFn } from "./providers/docker-exec-adapter.js";
import { createPinoLogger, type Logger } from "./observability/logger.js";
import { z } from "zod";
import { ReconcileError } from "./domain/errors.js";
import {
  createSopsAgeSecretResolver,
  realSpawnWrapper,
} from "./store/secrets.js";
import type { SecretResolver } from "./store/secrets.js";
import type pg from "pg";
import { createPool } from "./store/db.js";
import { getState } from "./store/observed-store.js";
import type { State } from "./domain/entities.js";
import pino from "pino";

// ---------------------------------------------------------------------------
// Real Hetzner base URLs — the Cloud API and the hcloud DNS API are SEPARATE
// origins (a single shared base would silently send DNS calls to the Cloud
// API). Named constants = one source of truth; the providers default to the
// same values, set here EXPLICITLY so the live wiring is unambiguous & tested.
// ---------------------------------------------------------------------------

const HCLOUD_API_BASE_URL = "https://api.hetzner.cloud/v1";
const HCLOUD_DNS_API_BASE_URL = "https://dns.hetzner.com/api/v1";

// ---------------------------------------------------------------------------
// The SSH transport-factory seam (Task 7.2 plugs real impls in unchanged)
// ---------------------------------------------------------------------------

/**
 * The factory the daemon constructs the SSH-backed providers from. Each entry
 * receives the validated `Config` (SSH_HOST/SSH_USER/SSH_PRIVATE_KEY for
 * Docker+WG; RESTIC_REPO/RESTIC_PASSWORD for restic) and returns the concrete
 * transport/controller seam the provider is written against.
 *
 * Task 7.1 has NO real implementation (the providers' transport seams are
 * out-of-scope here): tests inject in-memory fakes; Task 7.2 supplies the
 * real ssh2-backed implementations behind THIS SAME interface, unchanged.
 */
export interface EntrypointTransports {
  docker(config: Config): DockerTransport;
  wireguard(config: Config): WireGuardController;
  restic(config: Config): ResticTransport;
  /**
   * Bloco E (Phase 2) — the kubectl-over-SSH `KubeTransport` (kube-transport.ts).
   * OPTIONAL (additive, backward-compatible): the existing `createSshTransports`
   * factory predates the kube seam and does not supply it; the production
   * SSH-backed `kube` factory is plugged in alongside docker/wireguard/restic
   * in a follow-up (Task 23 wiring). When absent, `buildBootDeps` simply omits
   * the kube/k3s cabling pieces (the two tools stay un-cabled) — the same
   * optional-dep contract as `setFirewallPieces` / `runMigrationsPieces`.
   *
   * Sources its SSH connection SERVER-SIDE from the SAME validated `Config` the
   * docker transport uses (SSH_HOST / SSH_USER / SSH_PRIVATE_KEY); the SSH key /
   * connection material is NEVER present in the manifest/tool input (Q-c).
   */
  kube?(config: Config): KubeTransport;
}

/** Test-only seam: override how a token → HttpClient is constructed. */
export interface BuildOptions {
  /**
   * Build the HttpClient for a given Hetzner token. Default: a real
   * HttpClient over the global `fetch` (production — genuinely live). Tests
   * inject a capturing fetch to assert token/baseUrl WITHOUT real network.
   */
  readonly httpFor?: (token: string) => HttpClient;
  /**
   * Test-only seam: `node:fs` substitute consumed by `_validateSopsAgeConfig`
   * to validate SECRETS_FILE + SOPS_AGE_KEY_FILE without a real disk. Production
   * omits this ⇒ falls back to the real `node:fs`.
   */
  readonly fs?: ValidateSopsFs;
  /**
   * Test-only seam: `SpawnFn` substitute consumed by both
   * `_validateSopsAgeConfig` (boot `sops --version` check) and the
   * `createSopsAgeSecretResolver` factory wired below. Production omits this
   * ⇒ falls back to `realSpawnWrapper` (the `node:child_process.spawn` adapter).
   */
  readonly spawn?: SpawnFn;
  /**
   * Test-only seam: observed-VOLUME-state reader backing the DockerProvider's
   * `resolveVolumeMount`. Production omits this ⇒ falls back to a lazily
   * opened, cached read pool over `getState(pool, "volume")`. Tests inject a
   * fake reader so the resolver is exercised without a real DB.
   * spec: 2026-06-01-volume-hetzner-bind-automount.md §3.
   */
  readonly observedVolumeReader?: (scope: string) => Promise<State>;
}

/**
 * TEST-ONLY EXPORT (Rule 8 `_`-prefix). Build the DockerProvider's
 * `resolveVolumeMount` from an observed-VOLUME-state reader.
 * spec: 2026-06-01-volume-hetzner-bind-automount.md §3.
 *
 * Given a declared volume NAME, find it in the observed volume snapshot and
 * map it to its Hetzner automount path `/mnt/HC_Volume_<hcloud_id>`. A missing
 * volume, or a volume row that has not yet been assigned an `hcloud_id` (first
 * cycle, before the create persists), resolves to `undefined` ⇒ the bind goes
 * AS-IS and converges on the NEXT cycle (accepted, spec §7.4 — NOT atomic).
 *
 * Decoupled by construction: it reads the observed VOLUME store, never the
 * Hetzner provider. Production wires `read` to `getState(pool, "volume")`;
 * tests inject a fake reader (fakes-only).
 */
export function _buildVolumeMountResolver(
  read: (scope: string) => Promise<State>,
): (volumeName: string) => Promise<string | undefined> {
  return async (volumeName: string): Promise<string | undefined> => {
    const { volumes } = await read("volume");
    const v = volumes.find((x) => x.name === volumeName);
    if (v?.hcloud_id === undefined) return undefined;
    return `/mnt/HC_Volume_${v.hcloud_id}`;
  };
}

// ---------------------------------------------------------------------------
// buildBootDeps — PURE wiring (no process, no real socket)
// ---------------------------------------------------------------------------

/**
 * Construct the `BootDeps` `createServer(config, deps)` consumes:
 *   - providers: Hetzner Cloud + DNS LIVE (real HttpClient + configured
 *     token + correct real base URL); Docker/WG/restic from `transports`.
 *   - secretResolver: the real sops+age resolver bound to config paths +
 *     SECRETS_TIMEOUT_MS, validated boot-time via `_validateSopsAgeConfig`.
 *   - loadDesired/writeDesired: scope-keyed in-process DesiredState (v1).
 *   - logger: real pino at config.LOG_LEVEL.
 *
 * A missing `transports` is a value-free fail-fast precondition (the SSH
 * transports are required for a live daemon and arrive in Task 7.2) — never
 * a silent no-op backend.
 *
 * Async because `_validateSopsAgeConfig` awaits `sops --version` (SpawnFn
 * returns Promises). Validation runs FIRST — before any pg pool / http
 * client / transport is opened — so a missing sops binary or insecure age
 * key file aborts boot with a value-free fatal envelope and zero resources
 * leaked.
 */
export async function buildBootDeps(
  config: Config,
  transports: EntrypointTransports,
  opts: BuildOptions = {},
): Promise<BootDepsWithKube> {
  if (
    !transports ||
    typeof transports.docker !== "function" ||
    typeof transports.wireguard !== "function" ||
    typeof transports.restic !== "function"
  ) {
    // The SSH transports (Docker/WireGuard/restic) are required for a live
    // daemon; Task 7.1 does not implement them (they arrive in Task 7.2).
    // Fail fast & value-free — NEVER silently no-op a backend (fail-safe).
    throw new ReconcileError(
      "precondition",
      "boot: an SSH transport factory is required (transports.docker / " +
        "transports.wireguard / transports.restic) — the real ssh2-backed " +
        "transports are supplied by Task 7.2; the daemon never runs with a " +
        "silent no-op backend",
      { entity: "config" },
    );
  }

  // --- sops+age secret resolver: boot-time validation FIRST ----------------
  // Per spec docs/specs/2026-05-28-secret-resolver-real-v1.md §1.4, the
  // resolver's 4 preconditions (SECRETS_FILE lstat, SOPS_AGE_KEY_FILE lstat,
  // perm/uid/symlink L7, `sops --version` exit 0) are checked HERE — before
  // any pg pool / http client / SSH transport is opened. A failure throws a
  // value-free fatal ReconcileError and zero resources leak.
  await _validateSopsAgeConfig(
    {
      SECRETS_FILE: config.SECRETS_FILE,
      SOPS_AGE_KEY_FILE: config.SOPS_AGE_KEY_FILE,
    },
    {
      ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
      ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
    },
  );

  const httpFor =
    opts.httpFor ??
    ((token: string): HttpClient =>
      new HttpClient({
        defaultHeaders: { Authorization: `Bearer ${token}` },
      }));

  // --- Hetzner Cloud + DNS: GENUINELY LIVE ---------------------------------
  // Real HttpClient (native fetch), CONFIGURED token, CORRECT real base URL.
  // Two distinct clients/tokens/origins — the APIs are separate.
  const hetznerCloud = createHetznerCloudProvider({
    token: config.HCLOUD_TOKEN,
    baseUrl: HCLOUD_API_BASE_URL,
    http: httpFor(config.HCLOUD_TOKEN),
  });
  const hetznerDns = createHetznerDnsProvider({
    token: config.HCLOUD_DNS_TOKEN,
    baseUrl: HCLOUD_DNS_API_BASE_URL,
    http: httpFor(config.HCLOUD_DNS_TOKEN),
  });

  // --- SSH-backed providers: built from the injected transport seam --------
  // Build the Docker transport ONCE and share between the provider and the
  // run_migrations docker-exec adapter (one transport per host, not two —
  // matches the existing main.test.ts call-count invariant).
  const dockerTransport = transports.docker(config);
  // resolveVolumeMount reads the observed VOLUME store to map a declared
  // volume NAME → its Hetzner automount path. buildBootDeps runs before
  // server.ts owns the daemon pool, so the resolver lazily opens ONE cached
  // read pool the first time it is consulted (a reconcile-cycle event, never
  // at boot). Test reader injectable via opts.observedVolumeReader.
  // spec: 2026-06-01-volume-hetzner-bind-automount.md §3.
  let resolverPool: pg.Pool | undefined;
  const observedVolumeReader =
    opts.observedVolumeReader ??
    ((scope: string): Promise<State> => {
      if (resolverPool === undefined) resolverPool = createPool(config.DATABASE_URL);
      return getState(resolverPool, scope);
    });
  // --- sops+age secret resolver (real) -------------------------------------
  // Spec docs/specs/2026-05-28-secret-resolver-real-v1.md. The stub
  // (createStubSecretResolver) is preserved as an export for tests/golden
  // (spec §0.6); production wires the real resolver here, bound to the
  // validated SECRETS_FILE + SOPS_AGE_KEY_FILE paths and the configured
  // SECRETS_TIMEOUT_MS bound. `opts.spawn` (when present) is the test seam;
  // omitted ⇒ the resolver falls back to `realSpawnWrapper`. Built BEFORE the
  // Docker provider so it can be threaded into the factory — without it,
  // resolveSecretEnv early-returns and every `secret:<ref>` env binding is
  // silently dropped at apply (Bug 10).
  const secretResolver = createSopsAgeSecretResolver({
    secretsFile: config.SECRETS_FILE,
    ageKeyFile: config.SOPS_AGE_KEY_FILE,
    timeoutMs: config.SECRETS_TIMEOUT_MS,
    ...(opts.spawn !== undefined ? { spawn: opts.spawn } : {}),
  });

  // Bug 11 (spec 2026-06-01-docker-private-registry-auth §1.5): parse +
  // shape-validate the OPTIONAL REGISTRY_AUTH_REFS host→secret-ref map at
  // boot. Fail-closed and VALUE-FREE — the JSON could carry a ref, so neither
  // the parse error nor the shape error ever echoes the content. No boot-scan
  // that each ref exists in SECRETS_FILE (consistent with 2026-05-28 §10) —
  // the first apply that needs it resolves and fail-closes. Absent / "" ⇒ {}
  // ⇒ no auth wired ⇒ ensureImage never sends X-Registry-Auth.
  let registryAuthRefs: Record<string, string> = {};
  if (config.REGISTRY_AUTH_REFS !== undefined && config.REGISTRY_AUTH_REFS !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(config.REGISTRY_AUTH_REFS);
    } catch {
      throw new ReconcileError("fatal", "REGISTRY_AUTH_REFS is not valid JSON");
    }
    const shape = z.record(z.string(), z.string()).safeParse(parsed);
    if (!shape.success) {
      throw new ReconcileError(
        "fatal",
        "REGISTRY_AUTH_REFS must be a {host: ref} string map",
      );
    }
    registryAuthRefs = shape.data;
  }

  const docker = createDockerProvider({
    transport: dockerTransport,
    resolveVolumeMount: _buildVolumeMountResolver(observedVolumeReader),
    // Bug 10: the apply-only secret resolver. Its absence here is what made
    // POSTGRES_PASSWORD (and every other `secret:<ref>` env) vanish from the
    // running container. The per-apply ApplyContext token is minted by the
    // reconciler (reconcile.ts) and threaded via action.applyContext.
    secretResolver,
    // Bug 11: host→secret-ref map for private-registry auth. Empty ⇒ no
    // X-Registry-Auth ever sent (public pulls unchanged). The ref resolves
    // AT APPLY via secretResolver, behind the same ApplyContext gate.
    registryAuthRefs,
  });
  const wireguard = createWireGuardProvider({
    controller: transports.wireguard(config),
  });
  const backup = createBackupProvider({
    transport: transports.restic(config),
  });

  // --- ProviderRoutes: kind → provider(s), matching composite-provider.ts --
  // server.ts (6.6) routes: network/volume → hetzner-cloud; server →
  // [hetzner-cloud, wireguard] (host + mesh peer fan-out); service → docker;
  // dns → hetzner-dns; backup → restic.
  // spec 2026-05-26-server-scope-transport-decoupling.md §4.3: routes.server
  // conditional on MANAGED_MESH knob.
  // spec 2026-05-26-tolerant-meta-scope-and-managed-services.md §3:
  // routes.service conditional on MANAGED_SERVICES knob.
  const providers: BootDeps["providers"] = {
    network: hetznerCloud,
    server:
      config.MANAGED_MESH === "on"
        ? [hetznerCloud, wireguard]
        : [hetznerCloud],
    volume: hetznerCloud,
    ...(config.MANAGED_SERVICES === "on" ? { service: docker } : {}),
    dns: hetznerDns,
    backup,
  };

  // --- loadDesired / writeDesired: scope-keyed in-process DesiredState -----
  // v1 daemon backend (YAGNI). The seam — cross-scope read union +
  // write strip-to-own — lives in `store/desired-state-seam.ts` per spec
  // §4.5 (rev b) so the same logic is reachable from test harnesses
  // (rest.test.ts / tools.test.ts) without duplicating the slice/deps
  // tables. Durable git/manifest persistence is the manifest-repo's
  // concern (out of v1 scope).
  const { loadDesired, writeDesired } = createDesiredStateSeam();

  // --- logger: ratified pino at the configured level ----------------------
  const logger: Logger = createPinoLogger(
    pino({ name: "bevox-hetzner-mcp", level: config.LOG_LEVEL }),
  );

  // --- effective scopes ----------------------------------------------------
  // Spec 2026-05-26 (tolerant-meta-scope-and-managed-services) §3:
  // MANAGED_SERVICES='off' must filter the periodic reconcile cycle to
  // exclude "service" (no Docker backend wired). MANAGED_SERVICES='on'
  // leaves scopes undefined so server.ts falls back to DEFAULT_SCOPES
  // (= ["network","server","service","volume"]) — backwards-compatible.
  const scopes: readonly string[] | undefined =
    config.MANAGED_SERVICES === "on"
      ? undefined
      : ["network", "server", "volume"];

  // --- v2 Bloco A: set_firewall cabling pieces (spec
  // docs/specs/2026-05-27-wire-v2-set-firewall.md §2.3). Build the static
  // pieces here — the V2 HTTP client bound to HCLOUD_TOKEN + the in-memory
  // working store. server.ts then assembles the SetFirewallDeps with the
  // pool-bound serversProvider closure + the local approvalGate.
  const setFirewallPieces = {
    v2Http: createHetznerV2HttpClient({
      token: config.HCLOUD_TOKEN,
      baseUrl: "https://api.hetzner.cloud/v1",
    }),
    workingStore: createInMemoryWorkingFirewallStore(),
  };

  // --- v2 run_migrations cabling pieces (spec
  // docs/specs/2026-05-28-migration-runner-v1.md §6). Build the static
  // pieces here — the per-migration timeout (config.MIGRATION_TIMEOUT_MS)
  // + the slim docker-exec adapter over the SSH-backed Docker transport.
  // server.ts then assembles the full RunMigrationsDeps with the
  // pool-bound servicesProvider closure + the always-sensitive approval
  // gate + the appendEvent seam (same precedent as setFirewallPieces).
  const runMigrationsPieces = {
    timeoutMs: config.MIGRATION_TIMEOUT_MS,
    dockerExec: createDockerExecOverSsh(dockerTransport, config) as DockerExecFn,
  };

  // --- Bloco E (Phase 2): kube/k3s cabling pieces (spec
  // 2026-06-12-bloco-e-kubernetes-k3s-provider §"kube() transport factory").
  // Build the kubectl-over-SSH transport ONCE from the INJECTED `kube` seam
  // (tests pass a fake; production plugs the ssh2-backed one) and expose the
  // pieces server.ts (Task 23) assembles the `kubectl_apply` (Task 14) +
  // `ensure_k3s` deps from — mirrors the runMigrationsPieces precedent.
  //
  // OPTIONAL: when `transports.kube` is absent (the existing SSH-transports
  // factory predates the seam), the pieces are omitted ⇒ the two kube/k3s
  // tools stay un-cabled (same optional-dep contract as the pieces above).
  //
  // Task 26 (spec 2026-06-12 §2.3/§2.4): thread the SAME apply-only
  // `secretResolver` the docker (service) provider is wired with (built above)
  // into the kube provider factory, so a `secret:<ref>` in a kube manifest body
  // resolves AT APPLY behind the per-call ApplyContext — instead of being piped
  // to the cluster as the literal `secret:...` string. Same instance, same
  // production resolver seam (no invented resolver).
  const kubePieces = buildKubePieces(transports, config, secretResolver);

  return {
    providers,
    loadDesired,
    writeDesired,
    logger,
    secretResolver,
    // Bug fix (spec 2026-06-02-observed-state-adapter §1.5): wire the REAL
    // provider→State adapter. This field was NEVER set, so server.ts fell back
    // to a constant-empty State and get_state/diff were structurally empty.
    observedAdapter,
    ...(scopes ? { scopes } : {}),
    setFirewallPieces,
    runMigrationsPieces,
    ...(kubePieces ? { kubePieces } : {}),
    strictManifestApproval: config.STRICT_MANIFEST_APPROVAL === "on",
  };
}

// ---------------------------------------------------------------------------
// Bloco E (Phase 2) — kube/k3s cabling pieces (spec
// 2026-06-12-bloco-e-kubernetes-k3s-provider §"kube() transport factory").
// ---------------------------------------------------------------------------

/**
 * The static kube/k3s cabling `buildBootDeps` exposes on `BootDeps` so server.ts
 * (Task 23) can assemble BOTH the `kubectl_apply` (Task 14) and `ensure_k3s`
 * tools' deps. Mirrors the `runMigrationsPieces` shape: server.ts adds the
 * pool-bound / gate / actor pieces; here we provide the transport-backed,
 * pure-wiring seam.
 *
 *   - `transport`     — the kubectl-over-SSH `KubeTransport`, built ONCE here.
 *   - `resolveHost`   — Q-c: a named `host` ref → a SERVER-SIDE `KubeHostConfig`
 *                       carrying ONLY the non-secret host identifier. The SSH
 *                       key / connection material was resolved server-side when
 *                       `transports.kube(config)` built the transport from
 *                       `config.SSH_*`; it is NEVER present in the tool input or
 *                       in this resolver's return shape.
 *   - `getProvider`   — build a `KubernetesProvider` over the shared transport,
 *                       wired with the SAME apply-only `secretResolver` the
 *                       docker provider gets, so a `secret:<ref>` in the manifest
 *                       body resolves AT APPLY behind the per-call ApplyContext
 *                       (the `kubectl_apply` apply step drives it).
 *   - `getEnsureK3sProvider` — build an `EnsureK3sProvider` over the same
 *                       transport (the `ensure_k3s` apply step drives it).
 *   - `namespaceExists` — Q-d: read-only namespace precondition. The tool NEVER
 *                       creates a namespace (fail-safe).
 */
export interface KubePieces {
  readonly transport: KubeTransport;
  readonly resolveHost: (host: string) => Promise<KubeHostConfig>;
  readonly getProvider: (cfg: KubeHostConfig) => KubernetesProvider;
  readonly getEnsureK3sProvider: (cfg: KubeHostConfig) => EnsureK3sProvider;
  readonly namespaceExists: (
    cfg: KubeHostConfig,
    namespace: string,
  ) => Promise<boolean>;
}

/**
 * `BootDeps` + the OPTIONAL Bloco-E kube/k3s cabling. `buildBootDeps` returns
 * this superset so it can expose `kubePieces` WITHOUT yet touching `server.ts`'s
 * `BootDeps` (Task 23 consumes the field there). The intersection is structurally
 * assignable to `BootDeps`, so every existing call-site (`runMain` →
 * `deps.start(config, bootDeps)`, which expects `BootDeps`) is unaffected.
 */
export type BootDepsWithKube = BootDeps & {
  readonly kubePieces?: KubePieces;
};

/**
 * Assemble the kube/k3s pieces from the injected `transports.kube` seam +
 * validated `Config`. Returns `undefined` when the seam is absent (the existing
 * SSH-transports factory predates it) so the kube/k3s tools stay un-cabled —
 * the same optional-dep contract as `setFirewallPieces` / `runMigrationsPieces`.
 *
 * PURE: builds the transport (an injected factory — no real socket) and closes
 * read-only / construction-only seams over it. No I/O runs here at build time;
 * `namespaceExists` only touches the cluster when server.ts actually invokes it
 * (a tool-call event), never at boot.
 *
 * Q-c SECRET BOUNDARY: the transport binds the SSH key SERVER-SIDE from
 * `config.SSH_PRIVATE_KEY` (inside `transports.kube(config)`); `resolveHost`
 * returns ONLY the non-secret host identifier — no key/connection material
 * crosses into the tool input or any returned shape. v1 serves a single host
 * (`config.SSH_HOST`), so the named `host` ref resolves to that one transport;
 * the named ref is carried back purely for identity/observability.
 */
function buildKubePieces(
  transports: EntrypointTransports,
  config: Config,
  secretResolver: SecretResolver,
): KubePieces | undefined {
  if (typeof transports.kube !== "function") return undefined;

  // Built ONCE: the production SSH-backed transport sources its connection from
  // `config.SSH_*` server-side (Q-c). The provider factories below close over
  // this same instance (one transport per host, mirroring the docker pattern).
  const transport = transports.kube(config);
  void config; // SSH connection already resolved inside transports.kube(config).

  return {
    transport,
    // Q-c: resolve the named `host` to a SERVER-SIDE config. v1 binds the single
    // operator host; we surface ONLY the non-secret host identifier — the SSH
    // key/connection lives behind the transport, never in this return shape.
    resolveHost: async (host: string): Promise<KubeHostConfig> => ({ host }),
    // Task 26: wire the SAME apply-only `secretResolver` the docker provider
    // gets (threaded from buildBootDeps) so a `secret:<ref>` in the manifest
    // body resolves AT APPLY, behind the per-call ApplyContext (kube-apply.ts
    // resolves ONLY when BOTH the resolver AND a valid ApplyContext are present;
    // plan/dry_run/observe hold no ApplyContext ⇒ refs stay verbatim).
    getProvider: (_cfg: KubeHostConfig): KubernetesProvider =>
      createKubernetesProvider({ transport, secretResolver }),
    getEnsureK3sProvider: (_cfg: KubeHostConfig): EnsureK3sProvider =>
      createEnsureK3sProvider({ transport }),
    // Q-d: read-only namespace precondition. `kubectl get namespace <ns>
    // --ignore-not-found` exits 0 with EMPTY stdout when the namespace is
    // absent (deterministic), so non-empty stdout ⇒ exists. NEVER creates a
    // namespace (fail-safe.md).
    namespaceExists: async (
      _cfg: KubeHostConfig,
      namespace: string,
    ): Promise<boolean> => {
      const res = await transport.kubectl([
        "get",
        "namespace",
        namespace,
        "--ignore-not-found",
      ]);
      return res.stdout.trim() !== "";
    },
  };
}

// ---------------------------------------------------------------------------
// _validateSopsAgeConfig — boot-time precondition for the real (sops+age)
// secret resolver. Validates SECRETS_FILE + SOPS_AGE_KEY_FILE existence,
// ownership/perms, and `sops --version` reachability before the daemon
// starts. Test-only export (_-prefix); production reaches it via
// buildBootDeps. Async because SpawnFn returns Promises.
// ---------------------------------------------------------------------------

/**
 * Shape-compatible with `SpawnFn` in `core/src/store/secrets.ts` §1.2. The
 * canonical type is module-internal; this is a deliberate local duplicate so
 * the helper can accept the seam without exporting the resolver's private
 * surface. Mirrors the same pattern used by `core/test/fakes/sops-cli.ts`
 * (the fake duplicates the shape verbatim — see its header note for the
 * "do not import" rationale). If the canonical `SpawnFn` changes, this
 * local duplicate MUST be kept in sync.
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

/** Minimal subset of `node:fs` the helper consumes (Tasks 2.2-2.5 extend). */
interface ValidateSopsFs {
  lstatSync(path: string): { isFile(): boolean; mode: number; uid: number };
}

/** The config slice the helper validates (only the two sops/age paths). */
interface ValidateSopsConfig {
  readonly SECRETS_FILE: string;
  readonly SOPS_AGE_KEY_FILE: string;
}

/** Optional injected seams (default to production `node:fs` / real spawn). */
interface ValidateSopsDeps {
  readonly fs?: ValidateSopsFs;
  readonly spawn?: SpawnFn;
}

/**
 * Test-only export (prefix `_`). Production code reaches this via
 * `buildBootDeps` (Task 5.3); the helper is NOT part of the public API and
 * the `_` prefix marks it as such. Tasks 2.2-2.5 add the 4 validation steps
 * (SECRETS_FILE lstat, SOPS_AGE_KEY_FILE lstat, perm/uid/symlink/L7,
 * `sops --version`); Task 2.2 lands step 1.
 */
export async function _validateSopsAgeConfig(
  config: ValidateSopsConfig,
  deps?: ValidateSopsDeps,
): Promise<void> {
  const fs = deps?.fs ?? (await import("node:fs"));

  // Step 1 (spec §1.4): SECRETS_FILE must exist as a regular file.
  // L7 invariant: use `lstatSync`, NOT `statSync`. `lstat` does not follow
  // symlinks, so `isFile()` returns false for a symlink-to-file — rejecting
  // the symlink-swap attack class in the same check that rejects ENOENT and
  // "is a directory". One call, three failure modes covered.
  let stat: { isFile(): boolean };
  try {
    stat = fs.lstatSync(config.SECRETS_FILE);
  } catch {
    throw new ReconcileError("fatal", "secrets file not found", {
      entity: "config",
    });
  }
  if (!stat.isFile()) {
    throw new ReconcileError("fatal", "secrets file not found", {
      entity: "config",
    });
  }

  // Step 2 (spec §1.4): SOPS_AGE_KEY_FILE must exist as a regular file.
  // Same L7 invariant as step 1: `lstatSync` does not follow symlinks, so
  // ENOENT, "is a directory", and symlink-to-file all funnel through the
  // single isFile()===false / catch pair — symlink-swap attack class blocked.
  let keyStat: { isFile(): boolean; mode: number; uid: number };
  try {
    keyStat = fs.lstatSync(config.SOPS_AGE_KEY_FILE);
  } catch {
    throw new ReconcileError("fatal", "age key file not found", {
      entity: "config",
    });
  }
  if (!keyStat.isFile()) {
    throw new ReconcileError("fatal", "age key file not found", {
      entity: "config",
    });
  }

  // Step 3 (spec §1.4): L7 invariant — age key file MUST be mode 0600 owned
  // by the daemon user. `(mode & 0o077) === 0` rejects any group/world bits.
  // Symlinks already rejected by step 2 (lstat + isFile() returns false on a
  // symlink-to-file), so no explicit symlink branch here — defense in depth.
  // Linux-only: process.getuid() exists on Linux (our deploy target). On
  // Windows the daemon doesn't run (no ssh-exec, no Docker-over-SSH path),
  // so `process.getuid?.()` returning undefined is unreachable in production.
  const daemonUid = process.getuid?.();
  if ((keyStat.mode & 0o077) !== 0 || keyStat.uid !== daemonUid) {
    throw new ReconcileError(
      "fatal",
      "age key file has insecure permissions or ownership",
      { entity: "config" },
    );
  }

  // Step 4 (spec §1.4): sops binary must be on PATH and `sops --version` must
  // exit 0. ENOENT (binary missing) → child.on('error') → exitCode Promise
  // REJECTS — caught below. Non-zero exit also funnels through the same
  // ReconcileError("fatal","sops binary not found"), matching the spec §2.1
  // error taxonomy (one fatal envelope per validation step).
  //
  // Env hygiene: pass ONLY PATH + HOME — never the full process env. PATH is
  // required for the binary lookup itself; HOME enables age-plugin-* binaries
  // discovery (sops looks for ~/.config/sops, plugin lookups, etc.). Spec L8
  // (resolver env hygiene) lands in Task 3.10 for the resolve path; the same
  // discipline is applied here for symmetry — there is no boot-time reason to
  // leak DB_URL/HCLOUD_TOKEN/etc. into a `sops --version` invocation.
  //
  // `deps.spawn` is optional in the signature so the step 1-3 failure tests
  // don't need to inject a stub (those tests throw BEFORE reaching step 4).
  // Production omits the seam ⇒ falls back to `realSpawnWrapper` (the
  // `node:child_process.spawn` adapter exported from store/secrets.ts), so
  // the daemon boot validates `sops --version` against the real binary on
  // PATH without any wiring-site precondition.
  const spawn: SpawnFn = deps?.spawn ?? realSpawnWrapper;
  let exitCode: number;
  try {
    const child = spawn("sops", ["--version"], {
      shell: false,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      },
    });
    exitCode = await child.exitCode;
  } catch {
    // child.on('error') (ENOENT, EACCES, etc.) surfaces here via the rejected
    // exitCode Promise. The Error payload may contain the binary path — we do
    // NOT propagate it; emit the spec-mandated fatal envelope instead.
    throw new ReconcileError("fatal", "sops binary not found", {
      entity: "config",
    });
  }
  if (exitCode !== 0) {
    throw new ReconcileError("fatal", "sops binary not found", {
      entity: "config",
    });
  }
}

// ---------------------------------------------------------------------------
// One-shot boot warnings: configuration posture + v1 desired-state durability
// ---------------------------------------------------------------------------

/**
 * Emit ONE value-free boot-time warning (called once from runMain at daemon
 * start — NOT per reconcile cycle): the v1 loadDesired/writeDesired wired in
 * buildBootDeps is a scope-keyed IN-PROCESS Map, so a long-lived daemon
 * SILENTLY loses promote_manifest writes on restart. This is accepted v1
 * (YAGNI; the established seam); durable persistence is tracked follow-up #70.
 * Structured per the 6.3 logger discipline (actor/scope/entity), refs/classes
 * ONLY — NO secret/value/sentinel.
 */
function warnDesiredStateInProcess(logger: Logger): void {
  logger.warn(
    {
      actor: "system:boot",
      scope: "daemon",
      entity: "config",
      subsystem: "desired-state",
      durability: "in-process",
      followUp: 70,
    },
    "desired-state is in-process / non-durable in v1: promote_manifest writes " +
      "are lost on daemon restart (durable persistence tracked: follow-up #70)",
  );
}

/**
 * Emit ONE value-free boot-time warning when MANAGED_MESH is disabled
 * (spec 2026-05-26 §4.3). Called once from runMain when config.MANAGED_MESH === "off"
 * — logs the operator's chosen posture so they can confirm their infrastructure
 * posture (manual WireGuard, k3s/CNI, etc.). Structured per the 6.3 logger discipline
 * (actor/scope/entity), literal value only — NO secret/sensitive material.
 */
function warnManagedMeshOff(logger: Logger): void {
  logger.warn(
    {
      actor: "system:boot",
      scope: "daemon",
      entity: "config",
      subsystem: "managed-mesh",
      managedMesh: "off",
    },
    "MANAGED_MESH=off: WireGuard backend is excluded from routes.server. " +
      "SSH_* env vars are not required for server-scope reconcile. " +
      "(spec 2026-05-26 §4.3)",
  );
}

/**
 * Emit ONE value-free boot-time warning when MANAGED_SERVICES is disabled
 * (spec 2026-05-26-tolerant-meta-scope-and-managed-services §3). Called once
 * from runMain when config.MANAGED_SERVICES === "off" — logs the operator's
 * chosen posture so they can confirm their infrastructure posture (k3s/CNI
 * external; container orchestration outside the MCP). Structured per the 6.3
 * logger discipline (actor/scope/entity), literal value only — NO secret/
 * sensitive material.
 */
function warnManagedServicesOff(logger: Logger): void {
  logger.warn(
    {
      actor: "system:boot",
      scope: "daemon",
      entity: "config",
      subsystem: "managed-services",
      managedServices: "off",
    },
    "MANAGED_SERVICES=off: Docker backend is excluded from routes.service " +
      "and the periodic reconcile cycle skips the service scope. " +
      "(spec 2026-05-26 tolerant-meta-scope-and-managed-services §3)",
  );
}

/**
 * One-shot warn emitted at boot when STRICT_MANIFEST_APPROVAL=on. Opt-in
 * policy strengthening: apply_manifest consults TOOL_POLICY per-entity-kind
 * so server creates inherit provision_server's "always" gate. Default off
 * preserves v1 FROZEN behavior. Spec
 * docs/specs/2026-05-27-strict-manifest-approval-knob.md §1.4.
 */
function warnStrictManifestApprovalOn(logger: Logger): void {
  logger.warn(
    {
      actor: "system:boot",
      scope: "daemon",
      entity: "config",
      subsystem: "strict-manifest-approval",
      strictManifestApproval: "on",
    },
    "STRICT_MANIFEST_APPROVAL=on: apply_manifest consults per-entity-kind " +
      "TOOL_POLICY. Server creates declared via manifest now require approval " +
      "(mirrors provision_server policy). " +
      "(spec 2026-05-27-strict-manifest-approval-knob §1.4)",
  );
}

// ---------------------------------------------------------------------------
// runMain — the thin process orchestration (every env seam injected)
// ---------------------------------------------------------------------------

/**
 * The injected process seams. Production passes the real ones (process.env,
 * startServer, console, process.exit, signal-driven shutdown wait); tests
 * pass deterministic doubles so NO real daemon/network/signal is needed.
 */
export interface RunMainDeps {
  /** The environment record (default real `process.env`). */
  readonly env: Record<string, string | undefined>;
  /**
   * The SSH transport factory. Production wires Task 7.2's real ssh2-backed
   * impls; absent ⇒ value-free fail-fast (never a silent no-op backend).
   */
  readonly transports: EntrypointTransports | undefined;
  /** Build + start the daemon (default: server.ts `startServer`). */
  readonly start: (
    config: Config,
    deps: BootDeps,
  ) => Promise<BevoxServer>;
  /**
   * Test-only seam: forwarded to `buildBootDeps` so unit tests can stub the
   * `_validateSopsAgeConfig` fs+spawn pair (Task 5.3) without a real disk or
   * `sops` binary. Production OMITS this ⇒ the real `node:fs` + real
   * `realSpawnWrapper` are used, validating against the operator's actual
   * SECRETS_FILE / SOPS_AGE_KEY_FILE / sops PATH.
   */
  readonly buildOpts?: BuildOptions;
  /** Value-free structured/plain logging sink (default: console). */
  readonly log: (line: string) => void;
  /** Process exit (default: process.exit). */
  readonly exit: (code: number) => void;
  /**
   * Test-only seam: transform the freshly-built BootDeps before the daemon
   * starts (production OMITS it ⇒ identity, zero behaviour change). Tests use
   * it to substitute a capturing logger so the ONE value-free boot warning
   * (in-process desired-state, follow-up #70) is asserted deterministically
   * without a real pino transport. Consistent with this module's
   * every-seam-injected discipline.
   */
  readonly wrapBootDeps?: (deps: BootDeps) => BootDeps;
  /** Called once the daemon is up (production: nothing; tests assert). */
  readonly onStarted?: () => void;
  /**
   * Resolve when a shutdown signal (SIGTERM/SIGINT) is observed. Production
   * waits on the real signals; tests resolve immediately so no daemon hangs.
   */
  readonly waitForShutdown?: () => Promise<void>;
}

/**
 * Orchestrate one daemon lifecycle and return the process exit code.
 *
 * loadConfig FIRST (value-free fail-fast BEFORE any resource) → buildBootDeps
 * (fail-fast if transports absent) → start the daemon → await the shutdown
 * signal → ONE graceful `server.stop()` (idempotent; releases locks/pool;
 * never fail-deletes) → exit 0. ANY boot failure is logged VALUE-FREE
 * (config.ts/wiring own the value-free guarantee — we never echo a Config
 * field) and exits non-zero having started nothing.
 */
export async function runMain(deps: RunMainDeps): Promise<number> {
  let config: Config;
  let bootDeps: BootDeps;
  try {
    // loadConfig is value-free on failure (it lists only key NAMES). A
    // missing transports factory is likewise a value-free precondition.
    config = loadConfig(deps.env);
    bootDeps = await buildBootDeps(
      config,
      deps.transports as EntrypointTransports,
      deps.buildOpts ?? {},
    );
    // Test-only seam (production: omitted ⇒ identity, no behaviour change).
    if (deps.wrapBootDeps) bootDeps = deps.wrapBootDeps(bootDeps);
  } catch (err) {
    // VALUE-FREE: ReconcileError messages from config.ts / this module list
    // key NAMES only — never a secret value. We surface ONLY the message
    // (never the env, never the error `cause`, never a Config field).
    const msg =
      err instanceof ReconcileError
        ? err.message
        : "boot aborted (invalid configuration or wiring precondition)";
    deps.log(`bevox daemon boot failed: ${msg}`);
    deps.exit(1);
    return 1;
  }

  // Single boot point: emit the v1 desired-state non-durability warning ONCE,
  // here (after a successful build, before the daemon starts) — never per
  // reconcile cycle. Value-free (refs/classes only); follow-up #70.
  // buildBootDeps always sets logger; BootDeps.logger is typed optional, so
  // fall back to the ratified pino (same default server.ts uses) for safety.
  const logger = bootDeps.logger ?? createPinoLogger();
  warnDesiredStateInProcess(logger);

  // Emit MANAGED_MESH posture warning when disabled (spec 2026-05-26 §4.3).
  // Helps the operator confirm their chosen infrastructure posture.
  if (config.MANAGED_MESH === "off") {
    warnManagedMeshOff(logger);
  }

  // Emit MANAGED_SERVICES posture warning when disabled (spec 2026-05-26
  // tolerant-meta-scope-and-managed-services §3). Same rationale as the
  // MANAGED_MESH warn — operator confirms the opt-out posture.
  if (config.MANAGED_SERVICES === "off") {
    warnManagedServicesOff(logger);
  }

  // Emit STRICT_MANIFEST_APPROVAL posture warning when enabled (spec
  // 2026-05-27-strict-manifest-approval-knob §1.4). Opposite default to
  // MANAGED_*: this knob's default is OFF (v1 FROZEN), so warn on opt-IN.
  if (config.STRICT_MANIFEST_APPROVAL === "on") {
    warnStrictManifestApprovalOn(logger);
  }

  let server: BevoxServer;
  try {
    server = await deps.start(config, bootDeps);
  } catch (err) {
    // server.ts boot is ALL-OR-NOTHING (it unwinds every resource on failure
    // and re-throws value-free). We MUST NOT swallow it silently: log
    // value-free + exit non-zero. No lock/pool/listener is leaked (server.ts
    // already guarantees that).
    const msg =
      err instanceof ReconcileError
        ? err.message
        : "daemon failed to start";
    deps.log(`bevox daemon start failed: ${msg}`);
    deps.exit(1);
    return 1;
  }

  deps.onStarted?.();
  deps.log("bevox daemon started (REST+MCP+reconciler)");

  // Block until a shutdown signal. server.ts (started via startServer with
  // installSignalHandlers:true) already binds SIGTERM/SIGINT → its idempotent
  // graceful stop(); we additionally await + call stop() so the process exits
  // 0 cleanly even when the caller's waitForShutdown is a test stub. stop()
  // is idempotent & concurrency-safe — a double call (its own signal handler
  // + ours) awaits the SAME shutdown completion, never fail-deletes.
  await (deps.waitForShutdown ?? defaultWaitForShutdown)();
  try {
    await server.stop();
  } catch {
    /* stop() best-effort: a shutdown error must not flip a clean exit, and
       server.ts already recorded any in-flight cycle failure as a StateEvent */
  }
  deps.log("bevox daemon stopped (graceful)");
  deps.exit(0);
  return 0;
}

/**
 * Production shutdown wait: resolve on the FIRST SIGTERM/SIGINT. server.ts
 * also binds these to its own graceful stop(); both paths converge on the
 * SAME idempotent stop() (concurrency-safe by 6.6 contract).
 */
function defaultWaitForShutdown(): Promise<void> {
  return new Promise<void>((resolve) => {
    const onSignal = (): void => resolve();
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
  });
}
